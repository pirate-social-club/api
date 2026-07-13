import type { Env } from "../../../env"
import { captureScheduledError, captureScheduledWarning } from "../../ops-alerts/scheduled"

const DEFAULT_FREE_ALERT_THRESHOLD = 2
const TASK_NAME = "community_d1_pool_capacity"

export function parseFreeAlertThreshold(value: string | undefined): number {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10)
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_FREE_ALERT_THRESHOLD
  return parsed
}

export function classifyD1PoolCapacity(
  stats: { total: number; allocated: number; free: number; quarantined: number },
  thresholdValue: string | undefined,
) {
  const threshold = parseFreeAlertThreshold(thresholdValue)
  return {
    ...stats,
    threshold,
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

  const capacity = classifyD1PoolCapacity(result.value, env.COMMUNITY_D1_POOL_FREE_ALERT_THRESHOLD)
  if (capacity.healthy) return

  const urgency = capacity.free === 0 ? "high" : "low"
  const { healthy: _healthy, ...stats } = capacity
  const extra = { ...stats, urgency }
  console.warn("[scheduled] community D1 pool low capacity", JSON.stringify(extra))
  await captureScheduledWarning(
    env,
    "Community D1 pool free capacity is low",
    TASK_NAME,
    extra,
    { urgency },
  )
}
