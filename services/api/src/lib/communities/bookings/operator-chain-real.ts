import { Contract, Interface, JsonRpcProvider, Transaction, Wallet, getAddress } from "ethers"

import type { Env } from "../../../env"
import { badRequestError } from "../../errors"
import { assertPrivateKeyMatchesExpectedAddress, parseExpectedEvmAddress } from "../../evm-signer"
import {
  resolveBookingSettlementChainId,
  resolveBookingSettlementOperatorPrivateKey,
  resolveBookingSettlementRpcUrl,
  resolveBookingSettlementUsdcTokenAddress,
  resolveRewardsSettlementChainId,
  resolveRewardsSettlementOperatorAddress,
  resolveRewardsSettlementOperatorPrivateKey,
  resolveRewardsSettlementRpcUrl,
  resolveRewardsSettlementUsdcTokenAddress,
} from "./booking-chain-config"
import type { ChainPrimitives, OperatorKind } from "./operator-signing-coordinator-do"
import { LitChipotleClient } from "../../rewards/lit-chipotle-client"
import { createProductionLitRewardVaultExecutor } from "../../rewards/lit-reward-vault-executor"
import {
  resolveRewardsSettlementBackend,
  resolveRewardVaultLitConfig,
  rewardVaultSigningDeadline,
  type RewardsSettlementBackend,
} from "../../rewards/reward-vault-lit-config"
import {
  executeAndVerifyRewardVaultTransaction,
  rewardVaultInputFromSignedEffect,
} from "../../rewards/reward-vault-transaction"
import { rewardOperationId } from "../../rewards/reward-operation-id"
import { gatherRewardVaultRevertEvidence } from "../../rewards/reward-vault-revert-evidence"

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
const REWARD_VAULT_EVENTS = new Interface([
  "event RewardPaid(bytes32 indexed operationId,address indexed recipient,uint256 amount,uint64 indexed policyVersion,uint256 epoch)",
  "event RewardRefunded(bytes32 indexed operationId,address indexed recipient,uint256 amount,uint64 indexed policyVersion,uint256 epoch)",
])
const REWARD_VAULT_CAPACITY_ABI = [
  "function epochDuration() view returns (uint64)",
] as const

export function matchRewardVaultEvent(input: {
  logs: readonly { address: string; topics: readonly string[]; data: string }[]
  vaultAddress: string
  effectKind: "reward_cashout" | "reward_funding_refund"
  operationId: string
  recipient: string
  amount: bigint
}): { status: "matched" } | { status: "missing" | "mismatch"; reason: string } {
  const expectedName = input.effectKind === "reward_cashout" ? "RewardPaid" : "RewardRefunded"
  let sameOperationWrongEvent = false
  for (const log of input.logs) {
    if (getAddress(log.address) !== getAddress(input.vaultAddress)) continue
    let parsed
    try {
      parsed = REWARD_VAULT_EVENTS.parseLog(log)
    } catch {
      continue
    }
    if (!parsed || String(parsed.args.operationId).toLowerCase() !== input.operationId) continue
    if (parsed.name !== expectedName) {
      sameOperationWrongEvent = true
      continue
    }
    if (getAddress(String(parsed.args.recipient)) !== getAddress(input.recipient)) {
      return { status: "mismatch", reason: "recipient does not match the durable effect" }
    }
    if (BigInt(parsed.args.amount) !== input.amount) {
      return { status: "mismatch", reason: "amount does not match the durable effect" }
    }
    return { status: "matched" }
  }
  return sameOperationWrongEvent
    ? { status: "mismatch", reason: "event kind does not match the durable effect" }
    : { status: "missing", reason: "matching operation event was not emitted by the vault" }
}

function resolveConfig(env: Env, operatorKind: OperatorKind = "booking"): {
  backend: RewardsSettlementBackend
  privateKey: string | null
  operatorAddress: string
  rpcUrl: string
  chainId: number
  usdc: string
  operatorAddressField: "PIRATE_BOOKING_SETTLEMENT_OPERATOR_ADDRESS" | "PIRATE_REWARDS_SETTLEMENT_OPERATOR_ADDRESS"
} {
  const backend = operatorKind === "rewards" ? resolveRewardsSettlementBackend(env) : "local"
  const privateKey = backend === "local"
    ? (operatorKind === "rewards"
        ? resolveRewardsSettlementOperatorPrivateKey(env)
        : resolveBookingSettlementOperatorPrivateKey(env))
    : null
  // Last-line guard on the signing path: if an operator address is configured (it names the nonce DO),
  // the key we are about to sign with MUST derive it — otherwise refuse to sign rather than broadcast
  // from a wallet whose nonce is being tracked under a different DO.
  const operatorAddressField = operatorKind === "rewards" ? "PIRATE_REWARDS_SETTLEMENT_OPERATOR_ADDRESS" : "PIRATE_BOOKING_SETTLEMENT_OPERATOR_ADDRESS"
  const expectedOperator = parseExpectedEvmAddress(env[operatorAddressField])
  if (expectedOperator && privateKey) {
    assertPrivateKeyMatchesExpectedAddress({
      privateKey,
      expectedAddress: expectedOperator,
      expectedField: operatorAddressField,
    })
  }
  return {
    backend,
    privateKey,
    operatorAddress: operatorKind === "rewards"
      ? resolveRewardsSettlementOperatorAddress(env)
      : (privateKey ? getAddress(new Wallet(privateKey).address) : getAddress(expectedOperator!)),
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
function transferAmount(input: { amountCents?: number; amountAtomic?: string }): bigint {
  if (input.amountAtomic != null) {
    if (input.amountCents != null) throw badRequestError("Operator transfer amount is ambiguous")
    try {
      const amount = BigInt(input.amountAtomic)
      if (amount <= 0n || amount.toString() !== input.amountAtomic) throw new Error("invalid")
      return amount
    } catch {
      throw badRequestError("Operator transfer atomic amount must be a positive canonical integer")
    }
  }
  if (input.amountCents == null) throw badRequestError("Operator transfer amount is missing")
  return centsToAtomic(input.amountCents)
}

export const realChain: ChainPrimitives = {
  pendingNonce: async (env, operatorKind) => { const c = resolveConfig(env, operatorKind); return new JsonRpcProvider(c.rpcUrl, c.chainId).getTransactionCount(c.operatorAddress, "pending") },
  latestNonce: async (env, operatorKind) => { const c = resolveConfig(env, operatorKind); return new JsonRpcProvider(c.rpcUrl, c.chainId).getTransactionCount(c.operatorAddress, "latest") },
  gasParams: async (env, operatorKind) => {
    const c = resolveConfig(env, operatorKind)
    const fee = await new JsonRpcProvider(c.rpcUrl, c.chainId).getFeeData()
    return { maxFeePerGas: fee.maxFeePerGas ?? 2_000_000_000n, maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? 1_000_000_000n, gasLimit: 100_000n }
  },
  signVerifiedTransfer: async (env, input) => {
    const c = resolveConfig(env, input.operatorKind)
    const to = checksumRecipient(input.to)
    const amount = transferAmount(input)
    if (c.backend === "lit_vault") {
      const lit = resolveRewardVaultLitConfig(env)
      const client = new LitChipotleClient({
        usageApiKey: lit.usageApiKey,
        baseUrl: lit.apiUrl,
        timeoutMs: lit.requestTimeoutMs,
        maxAttempts: lit.requestMaxAttempts,
      })
      const execute = createProductionLitRewardVaultExecutor(client, lit.actionIpfsId)
      // Deadline is intentionally created at the signing attempt, not when the
      // effect is enqueued. A stale/queued effect can be safely re-signed with
      // fresh calldata because the vault replay key remains the operation ID.
      const deadline = rewardVaultSigningDeadline(Date.now(), lit.signingDeadlineSeconds)
      const verified = await executeAndVerifyRewardVaultTransaction(execute, {
        effectKind: input.effectKind,
        effectId: input.effectId,
        recipient: to,
        amount,
        deadline,
        policyVersion: lit.policyVersion,
        vaultAddress: lit.vaultAddress,
        signerAddress: c.operatorAddress,
        chainId: c.chainId,
        nonce: input.nonce,
        gas: input.gas,
      })
      return { ...verified, operationId: rewardOperationId(input.effectId) }
    }
    if (!c.privateKey) throw badRequestError("Local settlement signer is not configured")
    const signer = new Wallet(c.privateKey, new JsonRpcProvider(c.rpcUrl, c.chainId))
    const usdc = new Contract(c.usdc, ERC20_ABI, signer)
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
    return {
      signedTx,
      txHash: parsed.hash,
      operationId: input.operatorKind === "rewards" ? rewardOperationId(input.effectId) : null,
    }
  },
  broadcast: async (env, input) => { const c = resolveConfig(env, input.operatorKind); await new JsonRpcProvider(c.rpcUrl, c.chainId).broadcastTransaction(input.signedTx) },
  txLiveness: async (env, txHash, operatorKind) => {
    const c = resolveConfig(env, operatorKind)
    const provider = new JsonRpcProvider(c.rpcUrl, c.chainId)
    const receipt = await provider.getTransactionReceipt(txHash)
    if (receipt) return receipt.status === 1 ? "success" : "failed"
    return (await provider.getTransaction(txHash)) ? "pending" : "absent"
  },
  rewardVaultFailureEvidence: async (env, input) => {
    const c = resolveConfig(env, "rewards")
    if (c.backend !== "lit_vault") {
      return {
        disposition: "reconciliation_required" as const,
        reason: "rewards backend is not lit_vault",
        retryAfterMs: null,
        compactEvidence: null,
      }
    }
    const lit = resolveRewardVaultLitConfig(env)
    const provider = new JsonRpcProvider(c.rpcUrl, c.chainId)
    try {
      const receipt = await provider.getTransactionReceipt(input.txHash)
      if (!receipt || receipt.status !== 0 || !receipt.blockHash) {
        return {
          disposition: "reconciliation_required" as const,
          reason: "failed receipt with canonical block identity is unavailable",
          retryAfterMs: null,
          compactEvidence: null,
        }
      }
      const transactionInput = rewardVaultInputFromSignedEffect({
        signedTx: input.signedTx,
        effectKind: input.effectKind,
        effectId: input.effectId,
        recipient: input.recipient,
        amount: input.amountAtomic == null
          ? BigInt(input.amountCents ?? 0) * 10_000n
          : BigInt(input.amountAtomic),
        vaultAddress: lit.vaultAddress,
        signerAddress: resolveRewardsSettlementOperatorAddress(env),
        chainId: c.chainId,
      })
      const evidence = await gatherRewardVaultRevertEvidence({
        pinnedVaultAddress: lit.vaultAddress,
        operatorKind: "rewards",
        effectKind: input.effectKind,
        signedTx: input.signedTx,
        transactionInput,
        receiptStatus: receipt.status,
        receiptTransactionHash: receipt.hash,
        receiptBlockHash: receipt.blockHash,
        tracer: {
          traceTransaction: async (txHash) => {
            const trace = await provider.send("debug_traceTransaction", [
              txHash,
              { tracer: "callTracer", timeout: "10s" },
            ]) as { to?: unknown; error?: unknown; output?: unknown }
            return {
              to: typeof trace.to === "string" ? trace.to : null,
              reverted: typeof trace.error === "string" && trace.error.length > 0,
              output: typeof trace.output === "string" ? trace.output : null,
            }
          },
        },
      })
      if (evidence.disposition !== "capacity_deferred" || !evidence.evidence) {
        return {
          disposition: "reconciliation_required" as const,
          reason: evidence.reason,
          retryAfterMs: null,
          compactEvidence: null,
        }
      }
      const block = await provider.getBlock(receipt.blockHash)
      if (!block) throw new Error("failed receipt block is unavailable")
      const vault = new Contract(lit.vaultAddress, REWARD_VAULT_CAPACITY_ABI, provider)
      const epochDuration = BigInt(await vault.epochDuration())
      if (epochDuration <= 0n) throw new Error("vault epoch duration is invalid")
      const nextEpochSeconds = ((BigInt(block.timestamp) / epochDuration) + 1n) * epochDuration
      const retryAfterMs = Number(nextEpochSeconds * 1_000n + 1_000n)
      if (!Number.isSafeInteger(retryAfterMs)) throw new Error("vault epoch retry time is invalid")
      return {
        disposition: "capacity_deferred" as const,
        reason: evidence.reason,
        retryAfterMs,
        compactEvidence: {
          method: evidence.evidence.method,
          transaction_hash: evidence.evidence.transactionHash,
          block_hash: evidence.evidence.blockHash,
          selector: evidence.evidence.selector,
          classified_at: evidence.evidence.classifiedAt,
        },
      }
    } catch {
      return {
        disposition: "reconciliation_required" as const,
        reason: "exact rewards vault failure trace was unavailable or invalid",
        retryAfterMs: null,
        compactEvidence: null,
      }
    } finally {
      void provider.destroy()
    }
  },
  rewardVaultEvent: async (env, input) => {
    const c = resolveConfig(env, "rewards")
    if (c.backend !== "lit_vault") {
      return { status: "mismatch", reason: "rewards backend is not lit_vault" }
    }
    const lit = resolveRewardVaultLitConfig(env)
    const receipt = await new JsonRpcProvider(c.rpcUrl, c.chainId).getTransactionReceipt(input.txHash)
    if (!receipt) return { status: "missing", reason: "transaction receipt is unavailable" }
    return matchRewardVaultEvent({
      logs: receipt.logs,
      vaultAddress: lit.vaultAddress,
      effectKind: input.effectKind,
      operationId: input.operationId,
      recipient: input.recipient,
      amount: transferAmount(input),
    })
  },
}
