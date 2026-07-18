import type { Env } from "../../env"
import type { OpsAlertSeverity } from "./types"

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000
const ONE_DAY_MS = 24 * 60 * 60 * 1000
const MIN_DEDUPE_TTL_SECONDS = 3 * 60 * 60

function positiveInt(value: string | undefined): number | null {
  const parsed = Number.parseInt(value ?? "", 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

export function opsAlertBucketMs(env: Env, severity: OpsAlertSeverity): number {
  if (severity === "low") {
    return positiveInt(env.OPS_ALERT_LOW_BUCKET_MS) ?? ONE_DAY_MS
  }
  if (severity === "medium") {
    return positiveInt(env.OPS_ALERT_MEDIUM_BUCKET_MS) ?? ONE_DAY_MS
  }
  return positiveInt(env.OPS_ALERT_HIGH_BUCKET_MS)
    ?? positiveInt(env.OPS_ALERT_BUCKET_MS)
    ?? (env.ENVIRONMENT === "production" ? FOUR_HOURS_MS : ONE_DAY_MS)
}

export function opsAlertDedupeTtlSeconds(bucketMs: number): number {
  return Math.max(MIN_DEDUPE_TTL_SECONDS, Math.ceil((bucketMs * 2) / 1000))
}
