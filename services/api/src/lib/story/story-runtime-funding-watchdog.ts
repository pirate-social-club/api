// Proactive balance watchdog for the Story runtime signer wallets.
//
// The 2026-07-02 song-post incident was a silent drain: the story-operator
// signer drifted below its enforced funding floor, and every royalty
// registration then failed deterministically with no prior warning. This
// watchdog runs on the scheduled cron and emits a structured, high-severity
// event BEFORE a signer reaches the level that would start rejecting
// registrations — so an operator can top up before users are affected.
//
// Design constraints (must never destabilise the cron):
//   - Read-only RPC (getBalance); mutates nothing; needs no control-plane
//     connection, so it runs outside the scheduled DO lease.
//   - Fail-soft: any RPC/config error is logged and reported, never thrown.
//   - Internally rate-limited so a 1-minute cron does not hammer the Story RPC.
//   - Threshold is enforced-floor + N * worst-case-tx, NOT merely "below target",
//     so the warning carries real operational runway (how many more registrations
//     the wallet can fund before it hits the floor).

import { formatEther } from "ethers"
import type { Env } from "../../env"
import { resolveDirectTxGasPolicy } from "../evm-direct-tx"
import { captureScheduledError, captureScheduledWarning } from "../ops-alerts/scheduled"
import { withRequestControlPlaneClients } from "../runtime-deps"
import {
  resolveStoryChainId,
  resolveStoryRuntimeSignerMinBalanceWei,
  resolveStoryRuntimeSignerTargetBalanceWei,
} from "./story-runtime-config"
import {
  getStoryRuntimeSignerBalances,
  listStoryRuntimeSignerAddresses,
  type StoryRuntimeSignerBalance,
  type StoryRuntimeSignerName,
} from "./story-runtime-funding"

const STORY_RUNTIME_FUNDING_WATCHDOG_TASK = "story_runtime_funding_watchdog"

// Don't hit the Story RPC more than this often even though the cron fires every
// minute. A slow-draining wallet does not need sub-5-minute detection.
const DEFAULT_WATCHDOG_INTERVAL_MS = 300_000
// Warn once the wallet can fund fewer than this many worst-case registrations
// before hitting the floor. 3 gives an operator comfortable lead time.
const DEFAULT_WATCHDOG_TX_MARGIN = 3n

type StoryRuntimeFundingWatchdogSignerReport = {
  name: StoryRuntimeSignerName
  address: `0x${string}`
  explorerUrl: string | null
  balanceWei: bigint
  enforcedFloorWei: bigint
  warnThresholdWei: bigint
  worstCaseTxWei: bigint
  // How many more worst-case registrations the wallet can fund before the floor.
  // Negative means it is already below the floor (registrations WILL fail).
  txHeadroom: number
  severity: "critical" | "warning"
}

export type StoryRuntimeFundingWatchdogResult = {
  ran: boolean
  reason?: "rate_limited" | "signers_unconfigured" | "rpc_error"
  alerts: StoryRuntimeFundingWatchdogSignerReport[]
}

// Module-level so the rate-limit survives across cron invocations within an
// isolate. Isolate recycling just means an occasional earlier re-check — fine.
let lastCheckAtMs: number | null = null

export function resetStoryRuntimeFundingWatchdogStateForTests(): void {
  lastCheckAtMs = null
}

function parsePositiveIntEnv(raw: string | undefined, fallback: number): number {
  const value = Number.parseInt(String(raw ?? "").trim(), 10)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function parsePositiveBigIntEnv(raw: string | undefined, fallback: bigint): bigint {
  const trimmed = String(raw ?? "").trim()
  if (!/^\d+$/.test(trimmed)) return fallback
  const value = BigInt(trimmed)
  return value > 0n ? value : fallback
}

// Worst-case cost of a single registration tx = gasLimitCap * maxFeePerGasCap,
// reusing the exact caps the royalty-registration path enforces. If the gas
// policy can't be resolved we fall back to 0 so the threshold degrades to the
// bare floor (still warns below floor) rather than throwing.
function resolveWorstCaseTxWei(env: Env): bigint {
  const gasPolicy = resolveDirectTxGasPolicy({
    maxFeePerGasCapWeiRaw: env.STORY_DIRECT_TX_MAX_FEE_PER_GAS_WEI,
    maxPriorityFeePerGasCapWeiRaw: env.STORY_DIRECT_TX_MAX_PRIORITY_FEE_PER_GAS_WEI,
    gasLimitCapRaw: env.STORY_DIRECT_TX_GAS_LIMIT_MAX,
    gasEstimateBufferBpsRaw: env.STORY_DIRECT_TX_GAS_ESTIMATE_BUFFER_BPS,
    maxFeePerGasCapField: "STORY_DIRECT_TX_MAX_FEE_PER_GAS_WEI",
    maxPriorityFeePerGasCapField: "STORY_DIRECT_TX_MAX_PRIORITY_FEE_PER_GAS_WEI",
    gasLimitCapField: "STORY_DIRECT_TX_GAS_LIMIT_MAX",
    gasEstimateBufferBpsField: "STORY_DIRECT_TX_GAS_ESTIMATE_BUFFER_BPS",
  })
  if (!gasPolicy.ok) return 0n
  return gasPolicy.value.gasLimitCap * gasPolicy.value.maxFeePerGasCapWei
}

// The balance below which the NEXT registration is rejected. The royalty
// registration path asserts the operator against the TARGET balance (see
// story-royalty-registration-service: storyOperatorMinimumBalanceWei =
// resolveStoryRuntimeSignerTargetBalanceWei), while other signers use the MIN.
// Mirror that here so the watchdog fires against the level actually enforced.
export function resolveEnforcedFloorWei(env: Env, name: StoryRuntimeSignerName): bigint {
  return name === "story-operator"
    ? resolveStoryRuntimeSignerTargetBalanceWei(env)
    : resolveStoryRuntimeSignerMinBalanceWei(env)
}

export function resolveStorySignerExplorerUrl(
  chainId: number,
  address: `0x${string}`,
): string | null {
  if (chainId === 1315) return `https://aeneid.storyscan.io/address/${address}`
  if (chainId === 1514) return `https://www.storyscan.io/address/${address}`
  return null
}

export async function runStoryRuntimeFundingWatchdog(
  env: Env,
  options?: {
    now?: number
    force?: boolean
    // Test seam: override the RPC balance fetch so tests don't hit the network.
    fetchBalances?: (env: Env) => Promise<StoryRuntimeSignerBalance[]>
  },
): Promise<StoryRuntimeFundingWatchdogResult> {
  const now = options?.now ?? Date.now()
  const intervalMs = parsePositiveIntEnv(
    env.STORY_RUNTIME_FUNDING_WATCHDOG_INTERVAL_MS,
    DEFAULT_WATCHDOG_INTERVAL_MS,
  )
  if (!options?.force && lastCheckAtMs !== null && now - lastCheckAtMs < intervalMs) {
    return { ran: false, reason: "rate_limited", alerts: [] }
  }
  // Claim the window up front so a persistent RPC outage cannot hammer the RPC
  // once per minute — a transient failure just defers the next check by intervalMs.
  lastCheckAtMs = now

  // If signer keys aren't configured in this env (e.g. local/dev), skip quietly
  // instead of reporting an error every tick.
  try {
    listStoryRuntimeSignerAddresses(env)
  } catch {
    return { ran: false, reason: "signers_unconfigured", alerts: [] }
  }

  const marginTxCount = parsePositiveBigIntEnv(
    env.STORY_RUNTIME_FUNDING_WATCHDOG_TX_MARGIN,
    DEFAULT_WATCHDOG_TX_MARGIN,
  )
  const worstCaseTxWei = resolveWorstCaseTxWei(env)
  const chainId = resolveStoryChainId(env)
  const targetBalanceWei = resolveStoryRuntimeSignerTargetBalanceWei(env)

  const fetchBalances = options?.fetchBalances ?? getStoryRuntimeSignerBalances
  let balances
  try {
    balances = await fetchBalances(env)
  } catch (error) {
    // Fail soft: an RPC blip must never make the cron unhealthy.
    console.error(
      `[${STORY_RUNTIME_FUNDING_WATCHDOG_TASK}] balance check failed (fail-soft)`,
      JSON.stringify({ chain_id: chainId, error: error instanceof Error ? error.message : String(error) }),
    )
    await withRequestControlPlaneClients(
      () => captureScheduledError(env, error, STORY_RUNTIME_FUNDING_WATCHDOG_TASK),
    )
    return { ran: true, reason: "rpc_error", alerts: [] }
  }

  const alerts: StoryRuntimeFundingWatchdogSignerReport[] = []
  for (const balance of balances) {
    const enforcedFloorWei = resolveEnforcedFloorWei(env, balance.name)
    const warnThresholdWei = enforcedFloorWei + marginTxCount * worstCaseTxWei
    if (balance.balanceWei >= warnThresholdWei) continue

    const balanceMinusFloorWei = balance.balanceWei - enforcedFloorWei
    const txHeadroom = worstCaseTxWei > 0n
      ? Number(balanceMinusFloorWei / worstCaseTxWei)
      : (balanceMinusFloorWei < 0n ? -1 : 0)
    const severity: "critical" | "warning" = balance.balanceWei < enforcedFloorWei ? "critical" : "warning"
    const explorerUrl = resolveStorySignerExplorerUrl(chainId, balance.address)

    const report: StoryRuntimeFundingWatchdogSignerReport = {
      name: balance.name,
      address: balance.address,
      explorerUrl,
      balanceWei: balance.balanceWei,
      enforcedFloorWei,
      warnThresholdWei,
      worstCaseTxWei,
      txHeadroom,
      severity,
    }
    alerts.push(report)

    const topUpToWarnThresholdWei = warnThresholdWei > balance.balanceWei
      ? warnThresholdWei - balance.balanceWei
      : 0n
    const topUpToTargetWei = targetBalanceWei > balance.balanceWei
      ? targetBalanceWei - balance.balanceWei
      : 0n
    const structured = {
      signer: balance.name,
      address: balance.address,
      explorer_url: explorerUrl,
      chain_id: chainId,
      severity,
      balance_ip: formatEther(balance.balanceWei),
      enforced_floor_ip: formatEther(enforcedFloorWei),
      warn_threshold_ip: formatEther(warnThresholdWei),
      target_balance_ip: formatEther(targetBalanceWei),
      worst_case_tx_ip: formatEther(worstCaseTxWei),
      balance_minus_floor_ip: formatEther(balanceMinusFloorWei),
      top_up_to_warn_threshold_ip: formatEther(topUpToWarnThresholdWei),
      top_up_to_target_ip: formatEther(topUpToTargetWei),
      tx_headroom: txHeadroom,
    }
    // Distinct greppable prefix so it doesn't drown in the general cron noise.
    console.error(
      `[${STORY_RUNTIME_FUNDING_WATCHDOG_TASK}] ${severity === "critical" ? "BELOW FLOOR" : "low runway"}`,
      JSON.stringify(structured),
    )
    await withRequestControlPlaneClients(
      () => captureScheduledWarning(
        env,
        severity === "critical"
          ? `Story signer ${balance.name} is BELOW its funding floor — fund ${balance.address}`
          : `Story signer ${balance.name} funding runway is low — fund ${balance.address}`,
        STORY_RUNTIME_FUNDING_WATCHDOG_TASK,
        structured,
        { signer: balance.name, urgency: severity === "critical" ? "high" : "low" },
      ),
    )
  }

  return { ran: true, alerts }
}
