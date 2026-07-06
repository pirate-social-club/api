import type { Env } from "../../../env"
import { captureScheduledError, captureScheduledWarning } from "../../sentry"

const DEFAULT_FREE_ALERT_THRESHOLD = 2
const TASK_NAME = "community_d1_pool_capacity"

function parseFreeAlertThreshold(value: string | undefined): number {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10)
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_FREE_ALERT_THRESHOLD
  return parsed
}

export async function checkScheduledD1PoolCapacity(env: Env): Promise<void> {
  if (!env.COMMUNITY_D1_SHARD || !env.SHARD_ADMIN_TOKEN) return

  const threshold = parseFreeAlertThreshold(env.COMMUNITY_D1_POOL_FREE_ALERT_THRESHOLD)
  const result = await env.COMMUNITY_D1_SHARD.communityD1PoolStats({ adminToken: env.SHARD_ADMIN_TOKEN })
  if (!result.ok) {
    const error = new Error(`Community D1 pool stats unavailable: ${result.code}`)
    console.error("[scheduled] community D1 pool capacity check failed", result)
    captureScheduledError(env, error, TASK_NAME)
    return
  }

  const stats = result.value
  if (stats.free > threshold) return

  const urgency = stats.free === 0 ? "high" : "low"
  const extra = { ...stats, threshold, urgency }
  console.warn("[scheduled] community D1 pool low capacity", JSON.stringify(extra))
  captureScheduledWarning(
    env,
    "Community D1 pool free capacity is low",
    TASK_NAME,
    extra,
    { urgency },
  )
}
