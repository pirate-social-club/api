import type { Env } from "../../env"
import type { Client, QueryResultRow } from "../sql-client"
import { executeFirst } from "../db-helpers"
import { numberOrNull, requiredNumber, requiredString, rowValue, stringOrNull } from "../sql-row"
import { getControlPlaneClient } from "../runtime-deps"
import {
  assertRewardsCampaignAndSettlementChainsMatch,
  resolveRewardsSettlementChainId,
} from "../communities/bookings/booking-chain-config"
import {
  resolveActiveSupportedRewardIdentity,
} from "../verification/unique-human-eligibility"
import type {
  RewardEventKind,
  RewardEventSummary,
  RewardQualificationOutcomeReason,
  RewardQualificationStatus,
  RewardQualificationSummary,
  RewardPayoutSummary,
  RewardsSummaryResponse,
  RewardVerificationState,
} from "../../types"
import { rewardPayoutPublicStage } from "./reward-payout-public-stage"

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
    settlement_stage: rewardPayoutPublicStage({
      coordinatorState: stringOrNull(rowValue(row, "coordinator_state")),
      status,
    }),
    settlement_ref: stringOrNull(rowValue(row, "settlement_ref")),
    failure_reason: stringOrNull(rowValue(row, "failure_reason")),
  }
}

function serializeRewardQualification(row: QueryResultRow): RewardQualificationSummary {
  const storedStatus = requiredString(row, "status")
  const status: RewardQualificationStatus =
    storedStatus === "reconciling"
      ? "checking"
      : storedStatus === "ineligible"
        ? "unavailable"
        : storedStatus as RewardQualificationStatus
  if (!["checking", "pending_verification", "credited", "expired", "unavailable"].includes(status)) {
    throw new Error(`unexpected_reward_qualification_status:${storedStatus}`)
  }
  return {
    id: requiredString(row, "reward_pending_qualification_id"),
    reward_qualification_event_id: requiredString(row, "reward_qualification_event_id"),
    reward_campaign_id: requiredString(row, "reward_campaign_id"),
    community_id: requiredString(row, "community_id"),
    post_id: requiredString(row, "post_id"),
    reward_period_key: requiredString(row, "reward_period_key"),
    qualification_basis: requiredString(row, "qualification_basis") as RewardQualificationSummary["qualification_basis"],
    amount_cents: requiredNumber(row, "conditional_amount_cents"),
    status,
    outcome_reason: stringOrNull(rowValue(row, "terminal_reason")) as RewardQualificationOutcomeReason | null,
    expires_at: unixSeconds(rowValue(row, "expires_at")),
    credited_reward_event_id: stringOrNull(rowValue(row, "credited_reward_event_id")),
    created_at: unixSeconds(rowValue(row, "created_at")),
    updated_at: unixSeconds(rowValue(row, "updated_at")),
  }
}

function resolveVerificationState(hasNullifier: boolean): RewardVerificationState {
  return hasNullifier ? "verified" : "unverified"
}

export function summarizePendingProviderRows(rows: QueryResultRow[]) {
  const providerRequirements = rows.map((row) => {
    const rawProvider = requiredString(row, "provider")
    if (rawProvider !== "self" && rawProvider !== "very" && rawProvider !== "zkpassport") {
      throw new Error(`unexpected_reward_identity_provider:${rawProvider}`)
    }
    const provider: "self" | "very" | "zkpassport" = rawProvider
    const earliestExpiresAt = rowValue(row, "earliest_expires_at")
    return {
      provider,
      count: requiredNumber(row, "pending_count"),
      conditional_cents: requiredNumber(row, "conditional_cents"),
      earliest_expires_at: earliestExpiresAt == null ? null : unixSeconds(earliestExpiresAt),
    }
  })
  return {
    count: providerRequirements.reduce((total, requirement) => total + requirement.count, 0),
    conditional_cents: providerRequirements.reduce(
      (total, requirement) => total + requirement.conditional_cents,
      0,
    ),
    earliest_expires_at: providerRequirements.reduce<number | null>(
      (earliest, requirement) => earliest == null
        ? requirement.earliest_expires_at
        : requirement.earliest_expires_at == null
          ? earliest
          : Math.min(earliest, requirement.earliest_expires_at),
      null,
    ),
    provider_requirements: providerRequirements,
  }
}

export async function getRewardsSummaryForUser(input: {
  env: Env
  userId: string
  client?: Client
  activityDate?: string
  recentLimit?: number
  now?: string
}): Promise<RewardsSummaryResponse> {
  const client = input.client ?? getControlPlaneClient(input.env)
  const activityDate = input.activityDate ?? todayUtc()
  const recentLimit = Math.max(1, Math.min(50, Math.trunc(input.recentLimit ?? 10)))
  const minCashoutCents = parseConfiguredCents(input.env.REWARDS_MIN_CASHOUT_CENTS, DEFAULT_REWARDS_MIN_CASHOUT_CENTS)
  assertRewardsCampaignAndSettlementChainsMatch(input.env)
  const chainId = resolveRewardsSettlementChainId(input.env)
  if (!rewardReadsEnabled(input.env)) {
    return {
      chain_id: chainId,
      balance_cents: 0,
      today_earned_cents: 0,
      recent_events: [],
      recent_qualifications: [],
      pending_verification: {
        count: 0,
        conditional_cents: 0,
        earliest_expires_at: null,
        provider_requirements: [],
      },
      cashout: {
        eligible: false,
        min_cents: minCashoutCents,
        verification_state: "unverified",
        verification_provider: null,
      },
      latest_in_flight_cashout: null,
    }
  }

  const [creditRow, payoutRow, todayRow, eventRows, qualificationRows, pendingProviderRows, latestInFlightRow, hasNullifier] = await Promise.all([
    executeFirst(client, {
      sql: `
        SELECT COALESCE(SUM(amount_cents), 0) AS credit_cents
        FROM reward_events event
        LEFT JOIN reward_ownership_transfers transfer
          ON transfer.source_user_id = event.user_id
        WHERE COALESCE(transfer.canonical_user_id, event.user_id) = ?1
      `,
      args: [input.userId],
    }),
    executeFirst(client, {
      sql: `
        SELECT COALESCE(SUM(amount_cents), 0) AS payout_cents
        FROM reward_payout_effects payout
        LEFT JOIN reward_ownership_transfers transfer
          ON transfer.source_user_id = payout.user_id
        WHERE COALESCE(transfer.canonical_user_id, payout.user_id) = ?1
          AND status IN ('submitted', 'confirmed')
      `,
      args: [input.userId],
    }),
    executeFirst(client, {
      sql: `
        SELECT COALESCE(SUM(credited_cents), 0) AS credited_cents
        FROM reward_user_days day
        LEFT JOIN reward_ownership_transfers transfer
          ON transfer.source_user_id = day.user_id
        WHERE COALESCE(transfer.canonical_user_id, day.user_id) = ?1
          AND activity_date = ?2
        GROUP BY activity_date
        LIMIT 1
      `,
      args: [input.userId, activityDate],
    }),
    client.execute({
      sql: `
        SELECT reward_event_id, COALESCE(transfer.canonical_user_id, event.user_id) AS user_id,
          community_id, post_id, activity_date, reward_kind,
          amount_cents, reward_campaign_id, reward_period_key, qualification_basis,
          event.created_at AS created_at
        FROM reward_events event
        LEFT JOIN reward_ownership_transfers transfer
          ON transfer.source_user_id = event.user_id
        WHERE COALESCE(transfer.canonical_user_id, event.user_id) = ?1
        ORDER BY event.created_at DESC, reward_event_id DESC
        LIMIT ?2
      `,
      args: [input.userId, recentLimit],
    }),
    client.execute({
      sql: `
        SELECT reward_pending_qualification_id, reward_qualification_event_id,
          reward_campaign_id, community_id, post_id, reward_period_key,
          qualification_basis, conditional_amount_cents, status, terminal_reason,
          expires_at, credited_reward_event_id, created_at, updated_at
        FROM reward_pending_qualifications
        WHERE user_id = ?1
        ORDER BY updated_at DESC, reward_pending_qualification_id DESC
        LIMIT ?2
      `,
      args: [input.userId, recentLimit],
    }),
    client.execute({
      sql: `
        SELECT campaign.reward_identity_provider AS provider,
          COUNT(*) AS pending_count,
          COALESCE(SUM(conditional_amount_cents), 0) AS conditional_cents,
          MIN(expires_at) AS earliest_expires_at
        FROM reward_pending_qualifications qualification
        JOIN reward_campaigns campaign
          ON campaign.reward_campaign_id = qualification.reward_campaign_id
        WHERE qualification.user_id = ?1
          AND qualification.status IN ('pending_verification', 'reconciling')
          AND qualification.expires_at > ?2
        GROUP BY campaign.reward_identity_provider
        ORDER BY campaign.reward_identity_provider ASC
      `,
      args: [input.userId, input.now ?? new Date().toISOString()],
    }),
    executeFirst(client, {
      sql: `
        SELECT reward_payout_effect_id, amount_cents, recipient_address, status,
          coordinator_state, settlement_ref, failure_reason
        FROM reward_payout_effects
        WHERE user_id = ?1 AND status = 'submitted'
        ORDER BY updated_at DESC, reward_payout_effect_id DESC
        LIMIT 1
      `,
      args: [input.userId],
    }),
    resolveActiveSupportedRewardIdentity(client, input.userId, Date.parse(input.now ?? new Date().toISOString())),
  ])

  const creditCents = numberOrNull(rowValue(creditRow, "credit_cents")) ?? 0
  const payoutCents = numberOrNull(rowValue(payoutRow, "payout_cents")) ?? 0
  const balanceCents = Math.max(0, creditCents - payoutCents)
  const todayEarnedCents = numberOrNull(rowValue(todayRow, "credited_cents")) ?? 0
  const pendingVerification = summarizePendingProviderRows(pendingProviderRows.rows)
  const verificationState = resolveVerificationState(Boolean(hasNullifier))

  return {
    chain_id: chainId,
    balance_cents: balanceCents,
    today_earned_cents: todayEarnedCents,
    recent_events: eventRows.rows.map(serializeRewardEvent),
    recent_qualifications: qualificationRows.rows.map(serializeRewardQualification),
    pending_verification: pendingVerification,
    cashout: {
      eligible: balanceCents >= minCashoutCents && verificationState === "verified",
      min_cents: minCashoutCents,
      verification_state: verificationState,
      verification_provider: hasNullifier?.provider ?? null,
    },
    latest_in_flight_cashout: latestInFlightRow ? serializeRewardPayout(latestInFlightRow as QueryResultRow, chainId) : null,
  }
}
