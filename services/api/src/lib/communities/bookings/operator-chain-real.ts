import { Contract, JsonRpcProvider, Transaction, Wallet, getAddress } from "ethers"

import type { Env } from "../../../env"
import { badRequestError } from "../../errors"
import { assertPrivateKeyMatchesExpectedAddress, parseExpectedEvmAddress } from "../../evm-signer"
import {
  resolveBookingSettlementChainId,
  resolveBookingSettlementOperatorPrivateKey,
  resolveBookingSettlementRpcUrl,
  resolveBookingSettlementUsdcTokenAddress,
  resolveRewardsSettlementChainId,
  resolveRewardsSettlementOperatorPrivateKey,
  resolveRewardsSettlementRpcUrl,
  resolveRewardsSettlementUsdcTokenAddress,
} from "./booking-chain-config"
import type { ChainPrimitives, OperatorKind } from "./operator-signing-coordinator-do"

// Real ethers-backed implementation of the coordinator's chain seam. Kept in a SEPARATE module so
// the DO module itself has no ethers import — the production worker entry registers this via
// registerOperatorChainPrimitives(), while test worker bundles omit it (and inject a fake seam),
// keeping ethers (and its `ws` transitive cycle under miniflare) out of the test bundle.

const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function balanceOf(address owner) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
] as const
const ERC20 = new Contract("0x0000000000000000000000000000000000000000", ERC20_ABI)

function resolveConfig(env: Env, operatorKind: OperatorKind = "booking"): { privateKey: string; rpcUrl: string; chainId: number; usdc: string; operatorAddressField: "PIRATE_BOOKING_SETTLEMENT_OPERATOR_ADDRESS" | "PIRATE_REWARDS_SETTLEMENT_OPERATOR_ADDRESS" } {
  const privateKey = operatorKind === "rewards"
    ? resolveRewardsSettlementOperatorPrivateKey(env)
    : resolveBookingSettlementOperatorPrivateKey(env)
  // Last-line guard on the signing path: if an operator address is configured (it names the nonce DO),
  // the key we are about to sign with MUST derive it — otherwise refuse to sign rather than broadcast
  // from a wallet whose nonce is being tracked under a different DO.
  const operatorAddressField = operatorKind === "rewards" ? "PIRATE_REWARDS_SETTLEMENT_OPERATOR_ADDRESS" : "PIRATE_BOOKING_SETTLEMENT_OPERATOR_ADDRESS"
  const expectedOperator = parseExpectedEvmAddress(env[operatorAddressField])
  if (expectedOperator) {
    assertPrivateKeyMatchesExpectedAddress({
      privateKey,
      expectedAddress: expectedOperator,
      expectedField: operatorAddressField,
    })
  }
  return {
    privateKey,
    rpcUrl: operatorKind === "rewards" ? resolveRewardsSettlementRpcUrl(env) : resolveBookingSettlementRpcUrl(env),
    chainId: operatorKind === "rewards" ? resolveRewardsSettlementChainId(env) : resolveBookingSettlementChainId(env),
    usdc: operatorKind === "rewards" ? resolveRewardsSettlementUsdcTokenAddress(env) : resolveBookingSettlementUsdcTokenAddress(env),
    operatorAddressField,
  }
}
function checksumRecipient(raw: string): string {
  const a = parseExpectedEvmAddress(raw)
  if (!a) throw badRequestError("Booking settlement recipient address is invalid")
  return getAddress(a)
}
function centsToAtomic(amountCents: number): bigint {
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw badRequestError("Booking settlement amount must be positive")
  return BigInt(amountCents) * 10_000n
}

export const realChain: ChainPrimitives = {
  pendingNonce: async (env, operatorKind) => { const c = resolveConfig(env, operatorKind); return new JsonRpcProvider(c.rpcUrl, c.chainId).getTransactionCount(new Wallet(c.privateKey).address, "pending") },
  latestNonce: async (env, operatorKind) => { const c = resolveConfig(env, operatorKind); return new JsonRpcProvider(c.rpcUrl, c.chainId).getTransactionCount(new Wallet(c.privateKey).address, "latest") },
  gasParams: async (env, operatorKind) => {
    const c = resolveConfig(env, operatorKind)
    const fee = await new JsonRpcProvider(c.rpcUrl, c.chainId).getFeeData()
    return { maxFeePerGas: fee.maxFeePerGas ?? 2_000_000_000n, maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? 1_000_000_000n, gasLimit: 100_000n }
  },
  signVerifiedTransfer: async (env, input) => {
    const c = resolveConfig(env, input.operatorKind)
    const signer = new Wallet(c.privateKey, new JsonRpcProvider(c.rpcUrl, c.chainId))
    const usdc = new Contract(c.usdc, ERC20_ABI, signer)
    const to = checksumRecipient(input.to)
    const amount = centsToAtomic(input.amountCents)
    // The amount math assumes 6 decimals — verify the token actually is, so a misconfigured token
    // address can never transfer the wrong order of magnitude.
    if (Number(await usdc.decimals()) !== 6) throw badRequestError("Booking settlement token must be USDC with 6 decimals")
    if ((await usdc.balanceOf(signer.address) as bigint) < amount) throw badRequestError("Booking settlement operator has insufficient USDC")
    const data = usdc.interface.encodeFunctionData("transfer", [to, amount])
    const signedTx = await signer.signTransaction({
      to: c.usdc, data, nonce: input.nonce, chainId: c.chainId, type: 2, value: 0,
      maxFeePerGas: input.gas.maxFeePerGas, maxPriorityFeePerGas: input.gas.maxPriorityFeePerGas, gasLimit: input.gas.gasLimit,
    })
    const parsed = Transaction.from(signedTx)
    if (!parsed.from || getAddress(parsed.from) !== signer.address) throw badRequestError("signed tx signer mismatch")
    if (Number(parsed.chainId) !== c.chainId) throw badRequestError("signed tx chainId mismatch")
    if (parsed.type !== 2) throw badRequestError("signed tx must be EIP-1559 (type 2)")
    if (parsed.value !== 0n) throw badRequestError("signed tx must not transfer native value")
    if (parsed.maxFeePerGas !== input.gas.maxFeePerGas || parsed.maxPriorityFeePerGas !== input.gas.maxPriorityFeePerGas || parsed.gasLimit !== input.gas.gasLimit) {
      throw badRequestError("signed tx gas fields mismatch")
    }
    if (!parsed.to || getAddress(parsed.to) !== getAddress(c.usdc)) throw badRequestError("signed tx token contract mismatch")
    if (Number(parsed.nonce) !== input.nonce) throw badRequestError("signed tx nonce mismatch")
    const decoded = ERC20.interface.decodeFunctionData("transfer", parsed.data)
    if (getAddress(decoded[0] as string) !== to) throw badRequestError("signed tx recipient mismatch")
    if (BigInt(decoded[1] as bigint) !== amount) throw badRequestError("signed tx amount mismatch")
    if (!parsed.hash) throw badRequestError("signed tx missing hash")
    return { signedTx, txHash: parsed.hash }
  },
  broadcast: async (env, input) => { const c = resolveConfig(env, input.operatorKind); await new JsonRpcProvider(c.rpcUrl, c.chainId).broadcastTransaction(input.signedTx) },
  txLiveness: async (env, txHash, operatorKind) => {
    const c = resolveConfig(env, operatorKind)
    const provider = new JsonRpcProvider(c.rpcUrl, c.chainId)
    const receipt = await provider.getTransactionReceipt(txHash)
    if (receipt) return receipt.status === 1 ? "success" : "failed"
    return (await provider.getTransaction(txHash)) ? "pending" : "absent"
  },
}
