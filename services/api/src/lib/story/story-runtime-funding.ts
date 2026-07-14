import { JsonRpcProvider, Wallet, formatEther, getAddress } from "ethers"
import type { Env } from "../../env"
import {
  DEFAULT_STORY_RPC_URL,
  resolveStoryChainId,
  resolveStoryRpcUrl,
  resolveStoryRuntimeSignerMinBalanceWei,
  resolveStoryRuntimeSignerTargetBalanceWei,
} from "./story-runtime-config"
import {
  resolveStoryCdrWriterDirectSigner,
  resolveStoryEntitlementClassConfigurerDirectSigner,
  resolveStoryOperatorDirectSigner,
  resolveStorySettlementDirectSigner,
} from "./story-direct-signer"

export const STORY_RUNTIME_SIGNERS = [
  { name: "story-operator" },
  { name: "story-entitlement-class-configurer" },
  { name: "story-cdr-writer" },
  { name: "story-settlement" },
] as const

export type StoryRuntimeSignerName = typeof STORY_RUNTIME_SIGNERS[number]["name"]

export type StoryRuntimeSignerBalance = {
  name: StoryRuntimeSignerName
  address: `0x${string}`
  balanceWei: bigint
}

export type StoryRuntimeFundingResult = {
  name: StoryRuntimeSignerName
  address: `0x${string}`
  balanceBeforeWei: bigint
  balanceAfterWei: bigint
  targetBalanceWei: bigint
  fundedWei: bigint
  txHash: string | null
}

type StoryRuntimeSignerTarget = {
  address: `0x${string}`
  names: StoryRuntimeSignerName[]
  balanceWei: bigint
}

export type StoryRuntimeSignerFundingRequirement =
  | StoryRuntimeSignerName
  | {
      name: StoryRuntimeSignerName
      minBalanceWei?: bigint
    }

const FUNDING_SUCCESS_CACHE_TTL_MS = 60_000

let fundingSuccessCache:
  | {
      cacheKey: string
      checkedAt: number
    }
  | null = null
let testFundingAssertion:
  | ((env: Env, names: readonly StoryRuntimeSignerName[]) => Promise<void>)
  | null = null

export function setStoryRuntimeFundingAssertionForTests(
  assertion: ((env: Env, names: readonly StoryRuntimeSignerName[]) => Promise<void>) | null,
): void {
  testFundingAssertion = assertion
}

function normalizePrivateKey(raw: string | null | undefined): string | null {
  const value = String(raw || "").trim()
  if (!value) return null
  const withPrefix = value.startsWith("0x") ? value : `0x${value}`
  return /^0x[a-fA-F0-9]{64}$/.test(withPrefix) ? withPrefix : null
}

function normalizeRequirements(
  requirements: readonly StoryRuntimeSignerFundingRequirement[],
): Array<{ name: StoryRuntimeSignerName; minBalanceWei: bigint | null }> {
  return requirements.map((entry) => {
    if (typeof entry === "string") {
      return { name: entry, minBalanceWei: null }
    }
    return {
      name: entry.name,
      minBalanceWei: entry.minBalanceWei ?? null,
    }
  })
}

function resolveFundingPrivateKey(env: Env): string | null {
  return normalizePrivateKey(env.STORY_RUNTIME_FUNDER_PRIVATE_KEY)
    ?? normalizePrivateKey(env.STORY_CONTRACT_OWNER_PRIVATE_KEY)
}

function resolveStoryRuntimeSignerAddress(
  env: Env,
  signerName: StoryRuntimeSignerName,
): `0x${string}` {
  if (signerName === "story-operator") {
    const signer = resolveStoryOperatorDirectSigner(env)
    if (!signer.ok) throw new Error(signer.error)
    if (!signer.value) throw new Error("STORY_OPERATOR_PRIVATE_KEY missing/invalid")
    return getAddress(signer.value.address) as `0x${string}`
  }
  if (signerName === "story-entitlement-class-configurer") {
    const signer = resolveStoryEntitlementClassConfigurerDirectSigner(env)
    if (!signer.ok) throw new Error(signer.error)
    if (!signer.value) throw new Error("STORY_ENTITLEMENT_CLASS_CONFIGURER_PRIVATE_KEY missing/invalid")
    return getAddress(signer.value.address) as `0x${string}`
  }
  if (signerName === "story-cdr-writer") {
    const signer = resolveStoryCdrWriterDirectSigner(env)
    if (!signer.ok) throw new Error(signer.error)
    if (!signer.value) throw new Error("STORY_CDR_WRITER_PRIVATE_KEY missing/invalid")
    return getAddress(signer.value.address) as `0x${string}`
  }
  const signer = resolveStorySettlementDirectSigner(env)
  if (!signer.ok) throw new Error(signer.error)
  if (!signer.value) throw new Error("MUSIC_PURCHASE_STORY_SETTLEMENT_PRIVATE_KEY missing/invalid")
  return getAddress(signer.value.address) as `0x${string}`
}

export function listStoryRuntimeSignerAddresses(
  env: Env,
  names: readonly StoryRuntimeSignerName[] = STORY_RUNTIME_SIGNERS.map((entry) => entry.name),
): Array<{ name: StoryRuntimeSignerName; address: `0x${string}` }> {
  const selected = new Set(names)
  return STORY_RUNTIME_SIGNERS
    .filter((entry) => selected.has(entry.name))
    .map((entry) => ({
      name: entry.name,
      address: resolveStoryRuntimeSignerAddress(env, entry.name),
    }))
}

function buildFundingCacheKey(env: Env, names: readonly StoryRuntimeSignerName[]): string {
  const chainId = resolveStoryChainId(env)
  const rpcUrl = resolveStoryRpcUrl(env)
  const minBalance = resolveStoryRuntimeSignerMinBalanceWei(env)
  const signerKey = listStoryRuntimeSignerAddresses(env, names)
    .map((entry) => `${entry.name}:${entry.address}`)
    .join("|")
  return `${chainId}|${rpcUrl}|${minBalance.toString()}|${signerKey}`
}

function createStoryProvider(env: Env): JsonRpcProvider {
  return new JsonRpcProvider(
    resolveStoryRpcUrl(env) || DEFAULT_STORY_RPC_URL,
    resolveStoryChainId(env),
  )
}

export async function getStoryRuntimeSignerBalances(
  env: Env,
  names: readonly StoryRuntimeSignerName[] = STORY_RUNTIME_SIGNERS.map((entry) => entry.name),
): Promise<StoryRuntimeSignerBalance[]> {
  const provider = createStoryProvider(env)
  try {
    const signers = listStoryRuntimeSignerAddresses(env, names)
    const balances = await Promise.all(signers.map(async (signer) => ({
      ...signer,
      balanceWei: await provider.getBalance(signer.address),
    })))
    return balances
  } finally {
    void provider.destroy()
  }
}

export async function assertStoryRuntimeSignerFunding(
  env: Env,
  requirements: readonly StoryRuntimeSignerFundingRequirement[] = STORY_RUNTIME_SIGNERS.map((entry) => entry.name),
): Promise<void> {
  const normalizedRequirements = normalizeRequirements(requirements)
  const names = normalizedRequirements.map((entry) => entry.name)
  if (testFundingAssertion) {
    await testFundingAssertion(env, names)
    return
  }
  const cacheKey = buildFundingCacheKey(env, names)
  if (
    fundingSuccessCache
    && fundingSuccessCache.cacheKey === cacheKey
    && (Date.now() - fundingSuccessCache.checkedAt) < FUNDING_SUCCESS_CACHE_TTL_MS
  ) {
    return
  }

  const minBalanceWei = resolveStoryRuntimeSignerMinBalanceWei(env)
  const balances = await getStoryRuntimeSignerBalances(env, names)
  const minimumByName = new Map(
    normalizedRequirements.map((entry) => [entry.name, entry.minBalanceWei ?? minBalanceWei] as const),
  )
  const underfunded = balances.filter((entry) => entry.balanceWei < (minimumByName.get(entry.name) ?? minBalanceWei))
  if (underfunded.length > 0) {
    const details = underfunded
      .map((entry) => {
        const requiredMinBalanceWei = minimumByName.get(entry.name) ?? minBalanceWei
        return `${entry.name}:${entry.address}:${formatEther(entry.balanceWei)}<${formatEther(requiredMinBalanceWei)}`
      })
      .join(", ")
    throw new Error(`Story runtime signer funding below floor: ${details}`)
  }

  fundingSuccessCache = {
    cacheKey,
    checkedAt: Date.now(),
  }
}

async function waitForTransactionReceipt(params: {
  provider: JsonRpcProvider
  txHash: string
  timeoutMs: number
}): Promise<void> {
  const startedAt = Date.now()
  while ((Date.now() - startedAt) < params.timeoutMs) {
    const receipt = await params.provider.getTransactionReceipt(params.txHash)
    if (receipt) {
      if (receipt.status !== 1) {
        throw new Error(`story_runtime_funding_tx_failed:${params.txHash}`)
      }
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500))
  }
  throw new Error(`story_runtime_funding_tx_timeout:${params.txHash}`)
}

export async function fundStoryRuntimeSigners(params: {
  env: Env
  names?: readonly StoryRuntimeSignerName[]
  timeoutMs?: number
  startNonce?: number
  maxFeePerGasWei?: bigint
  maxPriorityFeePerGasWei?: bigint
  targetBalanceWei?: bigint
}): Promise<StoryRuntimeFundingResult[]> {
  const names = params.names ?? STORY_RUNTIME_SIGNERS.map((entry) => entry.name)
  const fundingPrivateKey = resolveFundingPrivateKey(params.env)
  if (!fundingPrivateKey) {
    throw new Error("STORY_RUNTIME_FUNDER_PRIVATE_KEY or STORY_CONTRACT_OWNER_PRIVATE_KEY missing/invalid")
  }

  const provider = createStoryProvider(params.env)
  try {
    const ownerSigner = new Wallet(fundingPrivateKey, provider)
    const targetBalanceWei = params.targetBalanceWei ?? resolveStoryRuntimeSignerTargetBalanceWei(params.env)
    const signerBalances = await getStoryRuntimeSignerBalances(params.env, names)
    const targetsByAddress = new Map<string, StoryRuntimeSignerTarget>()
    for (const signer of signerBalances) {
      const key = signer.address.toLowerCase()
      const existing = targetsByAddress.get(key)
      if (existing) {
        existing.names.push(signer.name)
        if (signer.balanceWei > existing.balanceWei) {
          existing.balanceWei = signer.balanceWei
        }
        continue
      }
      targetsByAddress.set(key, {
        address: signer.address,
        names: [signer.name],
        balanceWei: signer.balanceWei,
      })
    }
    let nextNonce = params.startNonce ?? await provider.getTransactionCount(ownerSigner.address, "pending")
    const timeoutMs = params.timeoutMs ?? 120_000
    const results: StoryRuntimeFundingResult[] = []

    for (const target of targetsByAddress.values()) {
      const topUpWei = target.balanceWei >= targetBalanceWei ? 0n : (targetBalanceWei - target.balanceWei)
      let txHash: string | null = null
      if (topUpWei > 0n) {
        const tx = await ownerSigner.sendTransaction({
          to: target.address,
          value: topUpWei,
          nonce: nextNonce,
          ...(params.maxFeePerGasWei ? { maxFeePerGas: params.maxFeePerGasWei } : {}),
          ...(params.maxPriorityFeePerGasWei ? { maxPriorityFeePerGas: params.maxPriorityFeePerGasWei } : {}),
        })
        txHash = String(tx.hash || "")
        await waitForTransactionReceipt({
          provider,
          txHash,
          timeoutMs,
        })
        nextNonce += 1
      }

      const balanceAfterWei = await provider.getBalance(target.address)
      for (const name of target.names) {
        results.push({
          name,
          address: target.address,
          balanceBeforeWei: target.balanceWei,
          balanceAfterWei,
          targetBalanceWei,
          fundedWei: topUpWei,
          txHash,
        })
      }
    }

    fundingSuccessCache = null
    return results
  } finally {
    void provider.destroy()
  }
}
