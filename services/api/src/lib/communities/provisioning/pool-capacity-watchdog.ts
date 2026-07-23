import type { Env } from "../../../env"
import { captureScheduledError, captureScheduledWarning } from "../../ops-alerts/scheduled"

const DEFAULT_FREE_ALERT_THRESHOLD = 2
const DEFAULT_EXHAUSTION_ALERT_HOURS = 72
const TASK_NAME = "community_d1_pool_capacity"

function parseNonNegativeInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10)
  if (!Number.isFinite(parsed) || parsed < 0) return fallback
  return parsed
}

export function parseFreeAlertThreshold(value: string | undefined): number {
  return parseNonNegativeInteger(value, DEFAULT_FREE_ALERT_THRESHOLD)
}

export function parseExhaustionAlertHours(value: string | undefined): number {
  return parseNonNegativeInteger(value, DEFAULT_EXHAUSTION_ALERT_HOURS)
}

type PoolStats = {
  total: number
  allocated: number
  free: number
  quarantined: number
  allocatedLast24Hours?: number
  allocatedLast7Days?: number
}

export function classifyD1PoolCapacity(
  stats: PoolStats,
  thresholdValue: string | undefined,
  exhaustionAlertHoursValue?: string,
) {
  const threshold = parseFreeAlertThreshold(thresholdValue)
  const exhaustionAlertHours = parseExhaustionAlertHours(exhaustionAlertHoursValue)
  const allocatedLast24Hours = Number.isFinite(stats.allocatedLast24Hours)
    ? Math.max(0, stats.allocatedLast24Hours ?? 0)
    : null
  const allocatedLast7Days = Number.isFinite(stats.allocatedLast7Days)
    ? Math.max(0, stats.allocatedLast7Days ?? 0)
    : null
  // Use the faster observed window so a fresh spike is not diluted by the
  // seven-day average, while the longer window still catches sustained drain
  // after a quiet day. Missing fields mean an older shard is deployed; retain
  // the level-triggered watchdog until the shard catches up.
  const burnRatePerHour = allocatedLast24Hours === null || allocatedLast7Days === null
    ? null
    : Math.max(allocatedLast24Hours / 24, allocatedLast7Days / (7 * 24))
  // Quarantined bindings become allocatable after five minutes, far inside the
  // forecast horizon. Count them for exhaustion forecasting, but not for the
  // immediate fixed-threshold check.
  const forecastCapacity = stats.free + stats.quarantined
  const hoursToExhaustion = burnRatePerHour && burnRatePerHour > 0
    ? Math.round((forecastCapacity / burnRatePerHour) * 10) / 10
    : null
  const exhaustionImminent = hoursToExhaustion !== null
    && hoursToExhaustion <= exhaustionAlertHours

  return {
    ...stats,
    threshold,
    exhaustionAlertHours,
    burnRatePerHour,
    forecastCapacity,
    hoursToExhaustion,
    exhaustionImminent,
    healthy: stats.free > threshold,
  }
}

export async function checkScheduledD1PoolCapacity(env: Env): Promise<void> {
  if (!env.COMMUNITY_D1_SHARD) return
  if (!env.SHARD_ADMIN_TOKEN) {
    console.warn("[scheduled] pool watchdog misconfigured: shard bound, no admin token")
    return
  }

  const result = await env.COMMUNITY_D1_SHARD.communityD1PoolStats({ adminToken: env.SHARD_ADMIN_TOKEN })
  if (!result.ok) {
    const error = new Error(`Community D1 pool stats unavailable: ${result.code}`)
    console.error("[scheduled] community D1 pool capacity check failed", result)
    await captureScheduledError(env, error, TASK_NAME)
    return
  }

  const capacity = classifyD1PoolCapacity(
    result.value,
    env.COMMUNITY_D1_POOL_FREE_ALERT_THRESHOLD,
    env.COMMUNITY_D1_POOL_EXHAUSTION_ALERT_HOURS,
  )
  if (capacity.healthy && !capacity.exhaustionImminent) return

  const urgency = capacity.free === 0
      || (capacity.hoursToExhaustion !== null && capacity.hoursToExhaustion <= 24)
    ? "high"
    : capacity.exhaustionImminent
      ? "normal"
      : "low"
  const { healthy: _healthy, exhaustionImminent: _exhaustionImminent, ...stats } = capacity
  const extra = { ...stats, urgency }
  const message = capacity.exhaustionImminent
    ? "Community D1 pool exhaustion is imminent"
    : "Community D1 pool free capacity is low"
  console.warn("[scheduled] community D1 pool capacity warning", JSON.stringify(extra))
  await captureScheduledWarning(
    env,
    message,
    TASK_NAME,
    extra,
    { urgency },
  )
}
