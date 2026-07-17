import type { Env } from "../../env"
import type { Client, QueryResultRow } from "../sql-client"
import { executeFirst } from "../db-helpers"
import { numberOrNull, requiredNumber, requiredString, rowValue, stringOrNull } from "../sql-row"
import { getControlPlaneClient } from "../runtime-deps"
import { hasActiveUniqueHumanNullifier, resolveRewardIdentityProvider } from "../verification/unique-human-eligibility"
import type {
  RewardEventKind,
  RewardEventSummary,
  RewardPayoutSummary,
  RewardsSummaryResponse,
  RewardVerificationState,
} from "../../types"

const DEFAULT_REWARDS_MIN_CASHOUT_CENTS = 100

function rewardReadsEnabled(env: Pick<Env, "REWARDS_READS_ENABLED">): boolean {
  return String(env.REWARDS_READS_ENABLED ?? "").trim().toLowerCase() === "true"
}

function parseConfiguredCents(raw: string | undefined, fallback: number): number {
  const trimmed = String(raw ?? "").trim()
  if (!trimmed) return fallback
  const parsed = Number(trimmed)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback
}

function unixSeconds(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value)
  const parsed = Date.parse(String(value ?? ""))
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10)
}

function serializeRewardEvent(row: QueryResultRow): RewardEventSummary {
  return {
    id: requiredString(row, "reward_event_id"),
    user_id: requiredString(row, "user_id"),
    community_id: requiredString(row, "community_id"),
    post_id: requiredString(row, "post_id"),
    activity_date: requiredString(row, "activity_date"),
    reward_kind: requiredString(row, "reward_kind") as RewardEventKind,
    amount_cents: requiredNumber(row, "amount_cents"),
    reward_campaign_id: stringOrNull(rowValue(row, "reward_campaign_id")),
    reward_period_key: stringOrNull(rowValue(row, "reward_period_key")),
    qualification_basis: stringOrNull(rowValue(row, "qualification_basis")) as RewardEventSummary["qualification_basis"],
    created_at: unixSeconds(rowValue(row, "created_at")),
  }
}

function rewardChainId(env: Pick<Env, "REWARDS_CAMPAIGN_CHAIN_ID">): number {
  const chainId = Number(env.REWARDS_CAMPAIGN_CHAIN_ID)
  if (!Number.isSafeInteger(chainId) || chainId < 1) throw new Error("invalid_rewards_chain_id")
  return chainId
}

function serializeRewardPayout(row: QueryResultRow, chainId: number): RewardPayoutSummary {
  const status = requiredString(row, "status")
  if (status !== "submitted" && status !== "confirmed" && status !== "failed") {
    throw new Error(`unexpected_reward_payout_status:${status}`)
  }
  return {
    id: requiredString(row, "reward_payout_effect_id"),
    chain_id: chainId,
    amount_cents: requiredNumber(row, "amount_cents"),
    recipient_address: requiredString(row, "recipient_address"),
    status,
    settlement_ref: stringOrNull(rowValue(row, "settlement_ref")),
    failure_reason: stringOrNull(rowValue(row, "failure_reason")),
  }
}

function resolveVerificationState(hasNullifier: boolean): RewardVerificationState {
  return hasNullifier ? "verified" : "unverified"
}

export async function getRewardsSummaryForUser(input: {
  env: Env
  userId: string
  client?: Client
  activityDate?: string
  recentLimit?: number
}): Promise<RewardsSummaryResponse> {
  const client = input.client ?? getControlPlaneClient(input.env)
  const activityDate = input.activityDate ?? todayUtc()
  const recentLimit = Math.max(1, Math.min(50, Math.trunc(input.recentLimit ?? 10)))
  const minCashoutCents = parseConfiguredCents(input.env.REWARDS_MIN_CASHOUT_CENTS, DEFAULT_REWARDS_MIN_CASHOUT_CENTS)
  const chainId = rewardChainId(input.env)
  if (!rewardReadsEnabled(input.env)) {
    return {
      chain_id: chainId,
      balance_cents: 0,
      today_earned_cents: 0,
      recent_events: [],
      cashout: {
        eligible: false,
        min_cents: minCashoutCents,
        verification_state: "unverified",
      },
      latest_in_flight_cashout: null,
    }
  }

  const [creditRow, payoutRow, todayRow, eventRows, latestInFlightRow, hasNullifier] = await Promise.all([
    executeFirst(client, {
      sql: `
        SELECT COALESCE(SUM(amount_cents), 0) AS credit_cents
        FROM reward_events
        WHERE user_id = ?1
      `,
      args: [input.userId],
    }),
    executeFirst(client, {
      sql: `
        SELECT COALESCE(SUM(amount_cents), 0) AS payout_cents
        FROM reward_payout_effects
        WHERE user_id = ?1
          AND status IN ('submitted', 'confirmed')
      `,
      args: [input.userId],
    }),
    executeFirst(client, {
      sql: `
        SELECT credited_cents
        FROM reward_user_days
        WHERE user_id = ?1
          AND activity_date = ?2
        LIMIT 1
      `,
      args: [input.userId, activityDate],
    }),
    client.execute({
      sql: `
        SELECT reward_event_id, user_id, community_id, post_id, activity_date, reward_kind,
          amount_cents, reward_campaign_id, reward_period_key, qualification_basis, created_at
        FROM reward_events
        WHERE user_id = ?1
        ORDER BY created_at DESC, reward_event_id DESC
        LIMIT ?2
      `,
      args: [input.userId, recentLimit],
    }),
    executeFirst(client, {
      sql: `
        SELECT reward_payout_effect_id, amount_cents, recipient_address, status, settlement_ref, failure_reason
        FROM reward_payout_effects
        WHERE user_id = ?1 AND status = 'submitted'
        ORDER BY updated_at DESC, reward_payout_effect_id DESC
        LIMIT 1
      `,
      args: [input.userId],
    }),
    hasActiveUniqueHumanNullifier(client, input.userId, resolveRewardIdentityProvider(input.env.REWARDS_IDENTITY_PROVIDER)),
  ])

  const creditCents = numberOrNull(rowValue(creditRow, "credit_cents")) ?? 0
  const payoutCents = numberOrNull(rowValue(payoutRow, "payout_cents")) ?? 0
  const balanceCents = Math.max(0, creditCents - payoutCents)
  const todayEarnedCents = numberOrNull(rowValue(todayRow, "credited_cents")) ?? 0
  const verificationState = resolveVerificationState(hasNullifier)

  return {
    chain_id: chainId,
    balance_cents: balanceCents,
    today_earned_cents: todayEarnedCents,
    recent_events: eventRows.rows.map(serializeRewardEvent),
    cashout: {
      eligible: balanceCents >= minCashoutCents && verificationState === "verified",
      min_cents: minCashoutCents,
      verification_state: verificationState,
    },
    latest_in_flight_cashout: latestInFlightRow ? serializeRewardPayout(latestInFlightRow as QueryResultRow, chainId) : null,
  }
}
