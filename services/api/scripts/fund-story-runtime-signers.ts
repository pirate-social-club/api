import { formatEther } from "ethers"
import type { Env } from "../src/types"
import {
  ALL_STORY_RUNTIME_SIGNERS,
  STORY_RUNTIME_SIGNERS,
  fundStoryRuntimeSigners,
  getStoryRuntimeSignerBalances,
  type StoryRuntimeSignerName,
} from "../src/lib/story/story-runtime-funding"
import {
  resolveStoryRuntimeSignerMinBalanceWei,
  resolveStoryRuntimeSignerTargetBalanceWei,
} from "../src/lib/story/story-runtime-config"
import { readDevVarsFromCwd, readWranglerVarsFromCwd } from "./_lib/dev-vars"

function parseSignerNames(argv: string[]): StoryRuntimeSignerName[] | null {
  const rawValues = argv
    .filter((value) => value.startsWith("--signer="))
    .map((value) => value.slice("--signer=".length).trim())
    .filter(Boolean)
  if (rawValues.length === 0) return null
  const allowed = new Set<StoryRuntimeSignerName>(ALL_STORY_RUNTIME_SIGNERS.map((entry) => entry.name))
  const signers: StoryRuntimeSignerName[] = []
  for (const value of rawValues) {
    if (!allowed.has(value as StoryRuntimeSignerName)) {
      throw new Error(`Unknown --signer value: ${value}`)
    }
    signers.push(value as StoryRuntimeSignerName)
  }
  return [...new Set(signers)]
}

function parseOptionalBigIntFlag(argv: string[], flagName: string): bigint | null {
  const raw = argv.find((value) => value.startsWith(`${flagName}=`))?.slice(flagName.length + 1).trim() || ""
  if (!raw) return null
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid ${flagName}: ${raw}`)
  }
  return BigInt(raw)
}

function parseOptionalNumberFlag(argv: string[], flagName: string): number | null {
  const raw = argv.find((value) => value.startsWith(`${flagName}=`))?.slice(flagName.length + 1).trim() || ""
  if (!raw) return null
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid ${flagName}: ${raw}`)
  }
  return parsed
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const dryRun = args.includes("--dry-run")
  const signers = parseSignerNames(args) ?? STORY_RUNTIME_SIGNERS.map((entry) => entry.name)
  const startNonce = parseOptionalNumberFlag(args, "--start-nonce")
  const maxFeePerGasWei = parseOptionalBigIntFlag(args, "--max-fee-per-gas-wei")
  const maxPriorityFeePerGasWei = parseOptionalBigIntFlag(args, "--max-priority-fee-per-gas-wei")
  const targetBalanceOverrideWei = parseOptionalBigIntFlag(args, "--target-balance-wei")
  const env = {
    ...readWranglerVarsFromCwd("wrangler.jsonc", "development"),
    ...readDevVarsFromCwd(),
    ...process.env,
  } as Env
  const minBalanceWei = resolveStoryRuntimeSignerMinBalanceWei(env)
  const targetBalanceWei = targetBalanceOverrideWei ?? resolveStoryRuntimeSignerTargetBalanceWei(env)

  console.log(JSON.stringify({
    rpcUrl: String(env.STORY_RPC_URL || "").trim() || null,
    minBalance: formatEther(minBalanceWei),
    targetBalance: formatEther(targetBalanceWei),
    signers,
    dryRun,
    startNonce,
    maxFeePerGasWei: maxFeePerGasWei?.toString() ?? null,
    maxPriorityFeePerGasWei: maxPriorityFeePerGasWei?.toString() ?? null,
    targetBalanceWeiOverride: targetBalanceOverrideWei?.toString() ?? null,
  }, null, 2))

  if (dryRun) {
    const balances = await getStoryRuntimeSignerBalances(env, signers)
    console.log(JSON.stringify({
      balances: balances.map((entry) => ({
        name: entry.name,
        address: entry.address,
        balance: formatEther(entry.balanceWei),
      })),
    }, null, 2))
    return
  }

  const results = await fundStoryRuntimeSigners({
    env,
    names: signers,
    startNonce: startNonce ?? undefined,
    maxFeePerGasWei: maxFeePerGasWei ?? undefined,
    maxPriorityFeePerGasWei: maxPriorityFeePerGasWei ?? undefined,
    targetBalanceWei: targetBalanceOverrideWei ?? undefined,
  })
  console.log(JSON.stringify({
    results: results.map((entry) => ({
      name: entry.name,
      address: entry.address,
      balanceBefore: formatEther(entry.balanceBeforeWei),
      balanceAfter: formatEther(entry.balanceAfterWei),
      targetBalance: formatEther(entry.targetBalanceWei),
      funded: formatEther(entry.fundedWei),
      txHash: entry.txHash,
    })),
  }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
