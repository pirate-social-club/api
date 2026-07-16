import {
  JsonRpcProvider,
  Transaction,
  Wallet,
  getAddress,
  isHexString,
  keccak256,
} from "ethers"
import { encodeFunctionData, parseAbi } from "viem"

import type { TransactionRequest } from "ethers"
import type { Env } from "../../env"
import { badRequestError } from "../errors"
import {
  resolveDirectTxFeeOverrides,
  resolveDirectTxGasPolicy,
} from "../evm-direct-tx"
import { parseExpectedEvmAddress } from "../evm-signer"
import { resolveStoryCoordinatorDirectSigner } from "./story-direct-signer"
import {
  resolveStoryChainId,
  resolveStoryRpcUrl,
} from "./story-runtime-config"
import type {
  StorySettlementChainPrimitives,
  StoryTransactionObservation,
} from "./story-settlement-wallet-coordinator-do"
import { resolveStorySettlementProtocolAddresses } from "./story-settlement-protocol-addresses"

const ERC20_BALANCE_ABI = parseAbi(["function balanceOf(address owner) view returns (uint256)"])

export interface StorySettlementProvider {
  broadcastTransaction(signedTransaction: string): Promise<unknown>
  estimateGas(transaction: TransactionRequest): Promise<bigint>
  getBlock(blockTag: string | number): Promise<{ hash: string | null; number: number } | null>
  getBlockNumber(): Promise<number>
  getFeeData(): Promise<{
    gasPrice: bigint | null
    maxFeePerGas: bigint | null
    maxPriorityFeePerGas: bigint | null
  }>
  getTransaction(transactionHash: string): Promise<unknown | null>
  getTransactionCount(address: string, blockTag: "latest" | "pending"): Promise<number>
  getTransactionReceipt(transactionHash: string): Promise<{
    status: number | null
    blockNumber: number
    blockHash: string
  } | null>
  send(method: string, params: unknown[]): Promise<unknown>
}

let testProviderFactory: ((rpcUrl: string, chainId: number) => StorySettlementProvider) | null = null

export function setStorySettlementProviderFactoryForTests(
  factory: ((rpcUrl: string, chainId: number) => StorySettlementProvider) | null,
): void {
  testProviderFactory = factory
}

function provider(env: Env): StorySettlementProvider {
  const rpcUrl = resolveStoryRpcUrl(env)
  const chainId = resolveStoryChainId(env)
  return testProviderFactory?.(rpcUrl, chainId)
    ?? new JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true })
}

function exactPolicyVersion(actual: string, configured: string | undefined, name: string): void {
  const expected = String(configured || "").trim()
  if (!expected || actual !== expected) throw badRequestError(`${name}_unsupported`)
}

function positiveInteger(raw: string | undefined, name: string, maximum: number): number {
  const normalized = String(raw || "").trim()
  const parsed = Number(normalized)
  if (!/^\d+$/.test(normalized) || !Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw badRequestError(`${name}_missing_or_invalid`)
  }
  return parsed
}

function config(env: Env, domain: { chainId: number; signerAddress: string }): {
  chainId: number
  signer: { privateKey: string; address: `0x${string}` }
} {
  const chainId = resolveStoryChainId(env)
  if (domain.chainId !== chainId) throw badRequestError("story_coordinator_chain_id_mismatch")
  const signer = resolveStoryCoordinatorDirectSigner(env)
  if (!signer.ok) throw badRequestError(signer.error)
  if (!signer.value) throw badRequestError("story_settlement_coordinator_signer_missing")
  const requestedAddress = parseExpectedEvmAddress(domain.signerAddress)
  if (!requestedAddress || getAddress(requestedAddress) !== signer.value.address) {
    throw badRequestError("story_coordinator_signer_domain_mismatch")
  }
  return { chainId, signer: signer.value }
}

function gasPolicy(env: Env) {
  const required = [
    [env.STORY_COORDINATOR_MAX_FEE_PER_GAS_WEI, "STORY_COORDINATOR_MAX_FEE_PER_GAS_WEI"],
    [env.STORY_COORDINATOR_MAX_PRIORITY_FEE_PER_GAS_WEI, "STORY_COORDINATOR_MAX_PRIORITY_FEE_PER_GAS_WEI"],
    [env.STORY_COORDINATOR_GAS_LIMIT_MAX, "STORY_COORDINATOR_GAS_LIMIT_MAX"],
    [env.STORY_COORDINATOR_GAS_ESTIMATE_BUFFER_BPS, "STORY_COORDINATOR_GAS_ESTIMATE_BUFFER_BPS"],
  ] as const
  for (const [value, field] of required) {
    if (!String(value || "").trim()) throw badRequestError(`${field}_missing`)
  }
  const resolved = resolveDirectTxGasPolicy({
    maxFeePerGasCapWeiRaw: env.STORY_COORDINATOR_MAX_FEE_PER_GAS_WEI,
    maxPriorityFeePerGasCapWeiRaw: env.STORY_COORDINATOR_MAX_PRIORITY_FEE_PER_GAS_WEI,
    gasLimitCapRaw: env.STORY_COORDINATOR_GAS_LIMIT_MAX,
    gasEstimateBufferBpsRaw: env.STORY_COORDINATOR_GAS_ESTIMATE_BUFFER_BPS,
    maxFeePerGasCapField: "STORY_COORDINATOR_MAX_FEE_PER_GAS_WEI",
    maxPriorityFeePerGasCapField: "STORY_COORDINATOR_MAX_PRIORITY_FEE_PER_GAS_WEI",
    gasLimitCapField: "STORY_COORDINATOR_GAS_LIMIT_MAX",
    gasEstimateBufferBpsField: "STORY_COORDINATOR_GAS_ESTIMATE_BUFFER_BPS",
  })
  if (!resolved.ok) throw badRequestError(resolved.error)
  return resolved.value
}

async function assertRpcChain(chainProvider: StorySettlementProvider, expectedChainId: number): Promise<void> {
  const raw = await chainProvider.send("eth_chainId", [])
  let actual: number
  try {
    actual = Number(BigInt(String(raw)))
  } catch {
    throw badRequestError("story_coordinator_rpc_chain_id_invalid")
  }
  if (!Number.isSafeInteger(actual) || actual !== expectedChainId) {
    throw badRequestError("story_coordinator_rpc_chain_id_mismatch")
  }
}

async function observation(
  env: Env,
  chainProvider: StorySettlementProvider,
  transactionHash: `0x${string}`,
  finalityPolicyVersion: string,
): Promise<StoryTransactionObservation> {
  exactPolicyVersion(
    finalityPolicyVersion,
    env.STORY_SETTLEMENT_FINALITY_POLICY_VERSION,
    "story_coordinator_finality_policy_version",
  )
  const receipt = await chainProvider.getTransactionReceipt(transactionHash)
  if (!receipt) {
    return await chainProvider.getTransaction(transactionHash)
      ? { kind: "pending" }
      : { kind: "absent" }
  }
  const canonicalBlock = await chainProvider.getBlock(receipt.blockNumber)
  if (
    !isHexString(receipt.blockHash, 32)
    || !canonicalBlock?.hash
    || !isHexString(canonicalBlock.hash, 32)
    || canonicalBlock.hash.toLowerCase() !== receipt.blockHash.toLowerCase()
  ) {
    return { kind: "absent" }
  }
  if (receipt.status !== 0 && receipt.status !== 1) {
    throw badRequestError("story_coordinator_receipt_status_invalid")
  }

  let final = false
  let safeBlockSupported = false
  if (String(env.STORY_COORDINATOR_FINALITY_PREFER_SAFE_BLOCK || "").trim().toLowerCase() === "true") {
    try {
      const safeBlock = await chainProvider.getBlock("safe")
      if (safeBlock) {
        safeBlockSupported = true
        final = safeBlock.number >= receipt.blockNumber
      }
    } catch {
      // Providers without the safe tag fall back to the configured depth.
    }
  }
  if (!final && !safeBlockSupported) {
    const confirmations = positiveInteger(
      env.STORY_COORDINATOR_FINALITY_CONFIRMATIONS,
      "STORY_COORDINATOR_FINALITY_CONFIRMATIONS",
      10_000,
    )
    const head = await chainProvider.getBlockNumber()
    final = head >= receipt.blockNumber && (head - receipt.blockNumber + 1) >= confirmations
  }
  return {
    kind: "mined",
    status: receipt.status === 1 ? "success" : "reverted",
    blockNumber: BigInt(receipt.blockNumber),
    blockHash: receipt.blockHash as `0x${string}`,
    final,
  }
}

export const storySettlementRealChain: StorySettlementChainPrimitives = {
  nativeBalance: async (env, domain) => {
    const resolved = config(env, domain)
    const chainProvider = provider(env)
    await assertRpcChain(chainProvider, resolved.chainId)
    return BigInt(String(await chainProvider.send("eth_getBalance", [resolved.signer.address, "latest"])))
  },
  wipBalance: async (env, domain) => {
    const resolved = config(env, domain)
    const chainProvider = provider(env)
    await assertRpcChain(chainProvider, resolved.chainId)
    const token = resolveStorySettlementProtocolAddresses(resolved.chainId).wipToken
    const data = encodeFunctionData({ abi: ERC20_BALANCE_ABI, functionName: "balanceOf", args: [resolved.signer.address] })
    return BigInt(String(await chainProvider.send("eth_call", [{ to: token, data }, "latest"])))
  },
  pendingNonce: async (env, domain) => {
    const resolved = config(env, domain)
    const chainProvider = provider(env)
    await assertRpcChain(chainProvider, resolved.chainId)
    return await chainProvider.getTransactionCount(resolved.signer.address, "pending")
  },
  latestNonce: async (env, domain) => {
    const resolved = config(env, domain)
    const chainProvider = provider(env)
    await assertRpcChain(chainProvider, resolved.chainId)
    return await chainProvider.getTransactionCount(resolved.signer.address, "latest")
  },
  gasParameters: async (env, input) => {
    const resolved = config(env, input)
    exactPolicyVersion(
      input.feePolicyVersion,
      env.STORY_SETTLEMENT_FEE_POLICY_VERSION,
      "story_coordinator_fee_policy_version",
    )
    const chainProvider = provider(env)
    await assertRpcChain(chainProvider, resolved.chainId)
    return await resolveDirectTxFeeOverrides({
      provider: chainProvider,
      from: resolved.signer.address,
      to: input.target,
      data: input.calldata,
      value: input.value,
      gasPolicy: gasPolicy(env),
    })
  },
  signTransaction: async (env, input) => {
    const resolved = config(env, input)
    return await new Wallet(resolved.signer.privateKey).signTransaction({
      type: 2,
      chainId: resolved.chainId,
      nonce: input.nonce,
      to: input.target,
      value: input.value,
      data: input.calldata,
      gasLimit: input.gas.gasLimit,
      maxFeePerGas: input.gas.maxFeePerGas,
      maxPriorityFeePerGas: input.gas.maxPriorityFeePerGas,
    }) as `0x${string}`
  },
  broadcastExactTransaction: async (env, input) => {
    const resolved = config(env, input)
    const parsed = Transaction.from(input.signedTransaction)
    if (
      !parsed.from
      || getAddress(parsed.from) !== resolved.signer.address
      || Number(parsed.chainId) !== resolved.chainId
    ) {
      throw badRequestError("story_coordinator_signed_transaction_domain_mismatch")
    }
    const chainProvider = provider(env)
    await assertRpcChain(chainProvider, resolved.chainId)
    try {
      await chainProvider.broadcastTransaction(input.signedTransaction)
    } catch (error) {
      const hash = keccak256(input.signedTransaction)
      if (await chainProvider.getTransaction(hash)) return
      throw error
    }
  },
  observeTransaction: async (env, input) => {
    const resolved = config(env, input)
    const chainProvider = provider(env)
    await assertRpcChain(chainProvider, resolved.chainId)
    return await observation(env, chainProvider, input.transactionHash, input.finalityPolicyVersion)
  },
}

export function parseSignedStoryCoordinatorTransaction(signedTransaction: string): Transaction {
  return Transaction.from(signedTransaction)
}
