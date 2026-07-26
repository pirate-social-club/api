import type { Env } from "../../env"
import type { Client, QueryResultRow } from "../sql-client"
import { rowValue } from "../sql-row"
import { resolveRewardsSettlementBackend } from "./reward-vault-lit-config"

const CENTS_TO_USDC_ATOMIC = 10_000n
const DEFAULT_CAPACITY_MAX_AGE_SECONDS = 300
const DEFAULT_MAX_WAIT_SECONDS = 86_400

export type RewardPayoutCandidate = {
  effectId: string
  amountCents: number
  createdAt: string
  communityId: string | null
  postId: string | null
  lastSelectedAt: string | null
}

export type RewardPayoutCapacity = {
  remainingAtomic: bigint
  observedAt: string
  currentEpoch: bigint
}

export function payoutMaxWaitSeconds(env: Env): number {
  return positiveInteger(env.REWARDS_PAYOUT_MAX_WAIT_SECONDS, DEFAULT_MAX_WAIT_SECONDS)
}

function capacityMaxAgeSeconds(env: Env): number {
  return positiveInteger(env.REWARDS_CAPACITY_MAX_OBSERVATION_AGE_SECONDS, DEFAULT_CAPACITY_MAX_AGE_SECONDS)
}

function positiveInteger(raw: string | undefined, fallback: number): number {
  const normalized = String(raw ?? "").trim()
  if (!normalized) return fallback
  const parsed = Number(normalized)
  if (!Number.isSafeInteger(parsed) || parsed < 60) {
    throw new Error("Reward payout scheduler freshness or wait configuration is invalid")
  }
  return parsed
}

function text(row: QueryResultRow, key: string): string | null {
  const value = rowValue(row, key)
  return value == null ? null : String(value)
}

export async function readFreshPayoutCapacity(input: {
  env: Env
  client: Client
  nowMs: number
}): Promise<RewardPayoutCapacity | null> {
  if (resolveRewardsSettlementBackend(input.env) !== "lit_vault") return null
  const result = await input.client.execute(`
    SELECT
      chain_id, vault_address, epoch_duration_seconds, current_epoch,
      payout_epoch_cap_atomic, payout_spent_atomic, observed_at
    FROM reward_vault_capacity_observations
    WHERE observation_key = 'rewards_vault'
    LIMIT 1
  `)
  const row = result.rows[0]
  if (!row) throw new Error("Reward vault payout capacity observation is missing")
  const expectedChainId = String(input.env.REWARDS_CAMPAIGN_CHAIN_ID ?? "").trim()
  const expectedVault = String(input.env.REWARDS_CAMPAIGN_TREASURY_ADDRESS ?? "").trim().toLowerCase()
  if (
    String(rowValue(row, "chain_id")) !== expectedChainId
    || String(rowValue(row, "vault_address")).toLowerCase() !== expectedVault
  ) {
    throw new Error("Reward vault payout capacity observation targets stale configuration")
  }
  const observedAt = String(rowValue(row, "observed_at") ?? "")
  const observedMs = Date.parse(observedAt)
  const maxAgeMs = capacityMaxAgeSeconds(input.env) * 1000
  if (!Number.isFinite(observedMs) || observedMs > input.nowMs + 30_000 || input.nowMs - observedMs > maxAgeMs) {
    throw new Error("Reward vault payout capacity observation is stale")
  }
  const cap = BigInt(String(rowValue(row, "payout_epoch_cap_atomic")))
  const spent = BigInt(String(rowValue(row, "payout_spent_atomic")))
  const currentEpoch = BigInt(String(rowValue(row, "current_epoch")))
  const epochDuration = BigInt(String(rowValue(row, "epoch_duration_seconds")))
  if (cap < 0n || spent < 0n || spent > cap) throw new Error("Reward vault payout capacity observation is invalid")
  if (epochDuration <= 0n || currentEpoch !== BigInt(Math.floor(input.nowMs / 1000)) / epochDuration) {
    throw new Error("Reward vault payout capacity observation is from a different epoch")
  }
  return {
    remainingAtomic: cap - spent,
    observedAt,
    currentEpoch,
  }
}

/**
 * One head per song participates in a round. A cashout spanning songs is
 * attributed to its oldest campaign-backed allocation; this preserves the
 * same FIFO order used when reserving reward-event liabilities.
 */
export async function listFairPayoutCandidates(input: {
  client: Client
  scanLimit: number
}): Promise<RewardPayoutCandidate[]> {
  const result = await input.client.execute({
    sql: `
      WITH attributed AS (
        SELECT
          payout.reward_payout_effect_id,
          payout.amount_cents,
          payout.created_at,
          campaign.community_id,
          campaign.post_id,
          scheduler.last_selected_at
        FROM reward_payout_effects payout
        LEFT JOIN reward_payout_allocations allocation
          ON allocation.reward_payout_allocation_id = (
            SELECT first_allocation.reward_payout_allocation_id
            FROM reward_payout_allocations first_allocation
            WHERE first_allocation.reward_payout_effect_id = payout.reward_payout_effect_id
              AND first_allocation.reward_campaign_id IS NOT NULL
            ORDER BY first_allocation.created_at ASC, first_allocation.reward_payout_allocation_id ASC
            LIMIT 1
          )
        LEFT JOIN reward_campaigns campaign
          ON campaign.reward_campaign_id = allocation.reward_campaign_id
        LEFT JOIN reward_payout_song_scheduler_state scheduler
          ON scheduler.community_id = campaign.community_id
         AND scheduler.post_id = campaign.post_id
        WHERE payout.status = 'submitted'
          AND payout.settlement_ref IS NULL
      ),
      ranked AS (
        SELECT
          attributed.*,
          ROW_NUMBER() OVER (
            PARTITION BY COALESCE(
              community_id || ':' || post_id,
              'legacy:' || reward_payout_effect_id
            )
            ORDER BY created_at ASC, reward_payout_effect_id ASC
          ) AS song_rank
        FROM attributed
      )
      SELECT
        reward_payout_effect_id,
        amount_cents,
        created_at,
        community_id,
        post_id,
        last_selected_at
      FROM ranked
      WHERE song_rank = 1
      ORDER BY
        CASE WHEN last_selected_at IS NULL THEN 0 ELSE 1 END ASC,
        last_selected_at ASC,
        created_at ASC,
        reward_payout_effect_id ASC
      LIMIT ?1
    `,
    args: [input.scanLimit],
  })
  const candidates = result.rows.map((row) => ({
    effectId: String(rowValue(row, "reward_payout_effect_id")),
    amountCents: Number(rowValue(row, "amount_cents")),
    createdAt: String(rowValue(row, "created_at")),
    communityId: text(row, "community_id"),
    postId: text(row, "post_id"),
    lastSelectedAt: text(row, "last_selected_at"),
  }))
  return candidates
}

export function orderSongHeads(candidates: RewardPayoutCandidate[]): RewardPayoutCandidate[] {
  const heads = new Map<string, RewardPayoutCandidate>()
  for (const candidate of candidates) {
    const key = candidate.communityId && candidate.postId
      ? `${candidate.communityId}\u0000${candidate.postId}`
      : `legacy\u0000${candidate.effectId}`
    const existing = heads.get(key)
    if (
      !existing
      || Date.parse(candidate.createdAt) < Date.parse(existing.createdAt)
      || (
        candidate.createdAt === existing.createdAt
        && candidate.effectId.localeCompare(existing.effectId) < 0
      )
    ) {
      heads.set(key, candidate)
    }
  }
  return [...heads.values()].sort((left, right) => {
    const leftSelected = left.lastSelectedAt ? Date.parse(left.lastSelectedAt) : Number.NEGATIVE_INFINITY
    const rightSelected = right.lastSelectedAt ? Date.parse(right.lastSelectedAt) : Number.NEGATIVE_INFINITY
    return leftSelected - rightSelected
      || Date.parse(left.createdAt) - Date.parse(right.createdAt)
      || left.effectId.localeCompare(right.effectId)
  })
}

export function fitsPayoutCapacity(candidate: RewardPayoutCandidate, remainingAtomic: bigint): boolean {
  return BigInt(candidate.amountCents) * CENTS_TO_USDC_ATOMIC <= remainingAtomic
}

export async function markSongSelected(input: {
  client: Client
  candidate: RewardPayoutCandidate
  selectedAt: string
}): Promise<void> {
  if (!input.candidate.communityId || !input.candidate.postId) return
  await input.client.execute({
    sql: `
      INSERT INTO reward_payout_song_scheduler_state (
        community_id, post_id, last_selected_at, last_reward_payout_effect_id, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?3)
      ON CONFLICT (community_id, post_id) DO UPDATE SET
        last_selected_at = excluded.last_selected_at,
        last_reward_payout_effect_id = excluded.last_reward_payout_effect_id,
        updated_at = excluded.updated_at
    `,
    args: [
      input.candidate.communityId,
      input.candidate.postId,
      input.selectedAt,
      input.candidate.effectId,
    ],
  })
}

export function payoutWaitSeconds(candidate: RewardPayoutCandidate, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - Date.parse(candidate.createdAt)) / 1000))
}
