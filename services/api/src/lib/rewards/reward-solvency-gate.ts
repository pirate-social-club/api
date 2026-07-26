import type { Env } from "../../env"
import type { Client } from "../sql-client"
import { providerUnavailable } from "../errors"
import { rowValue } from "../sql-row"

const DEFAULT_MAX_AGE_SECONDS = 15 * 60

export type RewardSolvencyGateReason =
  | "disabled"
  | "healthy"
  | "unknown_observation"
  | "stale_observation"
  | "insufficient_float"

export type RewardSolvencyGateStatus = {
  enabled: boolean
  admitting: boolean
  reason: RewardSolvencyGateReason
  observedAt: string | null
  ageSeconds: number | null
  balanceAtomic: string | null
  liabilityAtomic: string | null
}

function enabled(env: Env): boolean {
  return String(env.REWARDS_SOLVENCY_FREEZE_ENABLED ?? "").trim().toLowerCase() === "true"
}

function maxAgeSeconds(env: Env): number {
  const raw = String(env.REWARDS_SOLVENCY_MAX_OBSERVATION_AGE_SECONDS ?? "").trim()
  if (!raw) return DEFAULT_MAX_AGE_SECONDS
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 60) {
    throw providerUnavailable("Rewards solvency freshness configuration is invalid", null, false)
  }
  return value
}

export async function getRewardSolvencyGateStatus(input: {
  env: Env
  client: Client
  now?: Date
}): Promise<RewardSolvencyGateStatus> {
  if (!enabled(input.env)) {
    return {
      enabled: false,
      admitting: true,
      reason: "disabled",
      observedAt: null,
      ageSeconds: null,
      balanceAtomic: null,
      liabilityAtomic: null,
    }
  }
  const result = await input.client.execute(`
    SELECT balance_atomic, total_liability_atomic, solvent, observed_at
    FROM reward_solvency_observations
    WHERE observation_key = 'rewards_treasury'
    LIMIT 1
  `)
  const row = result.rows[0]
  if (!row) {
    return {
      enabled: true,
      admitting: false,
      reason: "unknown_observation",
      observedAt: null,
      ageSeconds: null,
      balanceAtomic: null,
      liabilityAtomic: null,
    }
  }
  const observedAt = String(rowValue(row, "observed_at") ?? "")
  const observedMs = Date.parse(observedAt)
  const nowMs = (input.now ?? new Date()).getTime()
  const ageSeconds = Number.isFinite(observedMs)
    ? Math.max(0, Math.floor((nowMs - observedMs) / 1000))
    : Number.POSITIVE_INFINITY
  const balanceAtomic = String(rowValue(row, "balance_atomic") ?? "")
  const liabilityAtomic = String(rowValue(row, "total_liability_atomic") ?? "")
  if (ageSeconds > maxAgeSeconds(input.env)) {
    return {
      enabled: true,
      admitting: false,
      reason: "stale_observation",
      observedAt,
      ageSeconds,
      balanceAtomic,
      liabilityAtomic,
    }
  }
  const solventRaw = rowValue(row, "solvent")
  const solvent = solventRaw === true || solventRaw === 1 || solventRaw === "1" || solventRaw === "true"
  return {
    enabled: true,
    admitting: solvent,
    reason: solvent ? "healthy" : "insufficient_float",
    observedAt,
    ageSeconds,
    balanceAtomic,
    liabilityAtomic,
  }
}

export async function assertRewardSolvencyAdmission(input: {
  env: Env
  client: Client
  now?: Date
}): Promise<void> {
  const status = await getRewardSolvencyGateStatus(input)
  if (status.admitting) return
  throw providerUnavailable(
    `Rewards admission frozen: ${status.reason}`,
    {
      reason: status.reason,
      observed_at: status.observedAt,
      age_seconds: status.ageSeconds,
    },
    true,
  )
}
