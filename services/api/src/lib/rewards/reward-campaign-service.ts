import { getAddress } from "ethers"
import type {
  PublicRewardOffer,
  RewardCampaign,
  RewardCampaignCreateRequest,
  RewardCampaignEligibleActivity,
  RewardCampaignFundingQuote,
  RewardCampaignStatus,
} from "@pirate/api-contracts"

import type { Env } from "../../env"
import { executeFirst } from "../db-helpers"
import { badRequestError, codedConflictError, conflictError, eligibilityFailed, notFoundError, rateLimited, structuredSurfaceDisabled } from "../errors"
import { classifyBookingPaymentReceipt, type BookingPaymentVerification } from "../communities/commerce/funding-proof-service"
import { hasUniqueConstraintName } from "../auth/auth-db-query-helpers"
import { makeId, nowIso } from "../helpers"
import { requiredString, rowValue, stringOrNull } from "../sql-row"
import type { Client, QueryResultRow, Transaction } from "../sql-client"
import { withTransaction } from "../transactions"
import { resolveRewardCampaignConfig, type RewardCampaignConfig } from "./reward-campaign-config"
import { assertRewardCampaignSettlementReadiness } from "./reward-campaign-settlement-readiness"
import { isPostgresControlPlaneUrl } from "../runtime-deps"
import { decodePublicCommunityId, decodePublicPostId } from "../public-ids"
import {
  KARAOKE_MIN_MEASURED_LINES,
  KARAOKE_PLATFORM_MIN_SCORE_BPS,
  KARAOKE_SCORE_SCALE,
} from "../karaoke/karaoke-qualification-policy"
import { advanceRewardCampaignLifecycle } from "./reward-campaign-lifecycle"
import {
  assertRewardsCampaignAndSettlementChainsMatch,
  resolveRewardsSettlementChainId,
} from "../communities/bookings/booking-chain-config"

/**
 * Machine-readable funding-confirmation outcomes. A money-moving client must be able to tell
 * "start over" apart from "stop, and never resubmit"; a generic `conflict` code cannot.
 *
 * Terminal (never retry the transfer):
 *   FUNDING_TRANSACTION_ALREADY_CONSUMED — the hash funded something else
 *   FUNDING_TRANSACTION_MISMATCH         — this quote is bound to a different hash
 *   refund_pending status                — treasury received funds that cannot be applied
 * Recoverable (re-quote and start a new transfer):
 *   FUNDING_QUOTE_ALREADY_CLAIMED        — the quote is spent or refunded
 *
 * A pending verification is NOT an error: confirm returns the funding resource with
 * status `confirming`, and re-calling confirm with the same hash is idempotent, so a client
 * polls by retrying rather than by interpreting a failure.
 */
const FUNDING_TRANSACTION_ALREADY_CONSUMED = "funding_transaction_already_consumed"
const FUNDING_TRANSACTION_MISMATCH = "funding_transaction_mismatch"
const FUNDING_QUOTE_ALREADY_CLAIMED = "funding_quote_already_claimed"
const ONE_LIVE = "one_live"
// Long enough for a Base Sepolia receipt/confirmation race, short enough that a
// rewarder cannot revive an abandoned schedule hours later. A late acceptance
// preserves the requested duration but starts a fresh effective window.
export const LATE_FUNDING_ACCEPTANCE_GRACE_SECONDS = 5 * 60

export const REWARD_SONG_SLOT_ACQUIRE_SQL = `
  INSERT INTO reward_song_slots (
    community_id, post_id, holder_campaign_id, reserved_until, created_at, updated_at
  )
  SELECT ?1, ?2, ?3, ?4, ?5, ?5
  WHERE NOT EXISTS (
    SELECT 1 FROM reward_campaigns c
    WHERE c.community_id = ?1 AND c.post_id = ?2
      AND c.reward_campaign_id <> ?3
      AND c.status IN ('scheduled', 'active', 'paused', 'operational_hold')
  )
  ON CONFLICT (community_id, post_id) DO UPDATE SET
    holder_campaign_id = excluded.holder_campaign_id,
    reserved_until = excluded.reserved_until,
    updated_at = excluded.updated_at
  WHERE (
    reward_song_slots.reserved_until <= ?5
    OR reward_song_slots.holder_campaign_id = excluded.holder_campaign_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM reward_campaigns c
    WHERE c.community_id = excluded.community_id AND c.post_id = excluded.post_id
      AND c.reward_campaign_id <> excluded.holder_campaign_id
      AND c.status IN ('scheduled', 'active', 'paused', 'operational_hold')
  )
  RETURNING holder_campaign_id
`

export type RewardCampaignTarget = {
  communityId: string
  postId: string
  songArtifactBundleId: string
  songOwnerUserId: string
  karaokeLineCount?: number
}

export type RewardCampaignCreateInput = RewardCampaignCreateRequest

type CampaignRow = QueryResultRow
type FundingRow = QueryResultRow

export type RewardSongOwnerPolicy = {
  community: string
  post: string
  song_owner: string
  third_party_rewards: "allowed" | "blocked"
}

const CAMPAIGN_COLUMNS = `
  reward_campaign_id, rewarder_user_id, community_id, post_id,
  song_artifact_bundle_id, song_owner_user_id, status, eligible_activity,
  min_score_bps, daily_reward_cents, milestone_7_cents, milestone_30_cents,
  reward_period_cap_cents, budget_cents, funded_cents, reserved_cents,
  credited_cents, paid_cents, refunded_cents, starts_at, ends_at,
  activated_at, exhausted_at, ended_at, canceled_at, created_at,
  (SELECT chain_id FROM reward_campaign_funding_effects
    WHERE reward_campaign_id = reward_campaigns.reward_campaign_id
      AND status = 'confirmed'
    ORDER BY confirmed_at DESC, reward_campaign_funding_effect_id DESC
    LIMIT 1) AS chain_id
`

const FUNDING_COLUMNS = `
  reward_campaign_funding_effect_id, reward_campaign_id, funder_user_id,
  chain_id, token_address, expected_amount_cents, expected_amount_atomic,
  sender_address, treasury_address, tx_hash, status, failure_reason,
  expires_at, confirmed_at, confirmed_block_number, confirmed_block_hash, created_at
`

function integer(value: unknown): number {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : 0
}

function unixSeconds(value: unknown): number | null {
  const raw = stringOrNull(value)
  if (!raw) return null
  const millis = Date.parse(raw)
  return Number.isFinite(millis) ? Math.floor(millis / 1000) : null
}

function queryResultRow(value: unknown): QueryResultRow | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as QueryResultRow
    : null
}

function campaignResource(row: CampaignRow): RewardCampaign {
  const funded = integer(rowValue(row, "funded_cents"))
  const reserved = integer(rowValue(row, "reserved_cents"))
  const credited = integer(rowValue(row, "credited_cents"))
  const refunded = integer(rowValue(row, "refunded_cents"))
  return {
    id: requiredString(row, "reward_campaign_id"),
    object: "reward_campaign",
    rewarder: requiredString(row, "rewarder_user_id"),
    community: requiredString(row, "community_id"),
    post: requiredString(row, "post_id"),
    song_artifact_bundle: requiredString(row, "song_artifact_bundle_id"),
    song_owner: requiredString(row, "song_owner_user_id"),
    status: requiredString(row, "status") as RewardCampaignStatus,
    eligible_activity: requiredString(row, "eligible_activity") as RewardCampaignEligibleActivity,
    min_score_bps: integer(rowValue(row, "min_score_bps")),
    daily_reward_cents: integer(rowValue(row, "daily_reward_cents")),
    milestone_7_cents: integer(rowValue(row, "milestone_7_cents")),
    milestone_30_cents: integer(rowValue(row, "milestone_30_cents")),
    reward_period_cap_cents: integer(rowValue(row, "reward_period_cap_cents")),
    budget_cents: integer(rowValue(row, "budget_cents")),
    funded_cents: funded,
    reserved_cents: reserved,
    credited_cents: credited,
    paid_cents: integer(rowValue(row, "paid_cents")),
    refunded_cents: refunded,
    remaining_cents: Math.max(0, funded - reserved - credited - refunded),
    starts_at: unixSeconds(rowValue(row, "starts_at")) ?? 0,
    ends_at: unixSeconds(rowValue(row, "ends_at")) ?? 0,
    activated_at: unixSeconds(rowValue(row, "activated_at")),
    exhausted_at: unixSeconds(rowValue(row, "exhausted_at")),
    ended_at: unixSeconds(rowValue(row, "ended_at")),
    canceled_at: unixSeconds(rowValue(row, "canceled_at")),
    created: unixSeconds(rowValue(row, "created_at")) ?? 0,
  }
}

function publicRewardOffer(row: CampaignRow, settlementChainId: number): PublicRewardOffer {
  return {
    eligible_activity: requiredString(row, "eligible_activity") as RewardCampaignEligibleActivity,
    min_score_bps: integer(rowValue(row, "min_score_bps")),
    daily_reward_cents: integer(rowValue(row, "daily_reward_cents")),
    chain_id: settlementChainId,
    ends_at: unixSeconds(rowValue(row, "ends_at")) ?? 0,
  }
}

function fundingResource(row: FundingRow): RewardCampaignFundingQuote {
  return {
    id: requiredString(row, "reward_campaign_funding_effect_id"),
    object: "reward_campaign_funding_quote",
    campaign: requiredString(row, "reward_campaign_id"),
    funder: requiredString(row, "funder_user_id"),
    chain_id: integer(rowValue(row, "chain_id")),
    token_address: requiredString(row, "token_address"),
    amount_cents: integer(rowValue(row, "expected_amount_cents")),
    amount_atomic: requiredString(row, "expected_amount_atomic"),
    sender_address: requiredString(row, "sender_address"),
    treasury_address: requiredString(row, "treasury_address"),
    tx_hash: stringOrNull(rowValue(row, "tx_hash")),
    status: requiredString(row, "status") as RewardCampaignFundingQuote["status"],
    failure_reason: stringOrNull(rowValue(row, "failure_reason")),
    expires_at: unixSeconds(rowValue(row, "expires_at")) ?? 0,
    confirmed_at: unixSeconds(rowValue(row, "confirmed_at")),
    created: unixSeconds(rowValue(row, "created_at")) ?? 0,
  }
}

function requireCampaignsEnabled(config: RewardCampaignConfig): void {
  if (!config.enabled) throw structuredSurfaceDisabled("Reward campaigns are disabled")
}

function nonEmpty(value: unknown, field: string, maxLength = 200): string {
  const result = typeof value === "string" ? value.trim() : ""
  if (!result || result.length > maxLength) throw badRequestError(`${field} is invalid`)
  return result
}

function cents(value: unknown, field: string, allowZero: boolean): number {
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < (allowZero ? 0 : 1)) {
    throw badRequestError(`${field} is invalid`)
  }
  return result
}

function basisPoints(value: unknown, field: string): number {
  const result = Number(value)
  if (
    !Number.isSafeInteger(result)
    || result < KARAOKE_PLATFORM_MIN_SCORE_BPS
    || result > KARAOKE_SCORE_SCALE
  ) throw badRequestError(`${field} is invalid`)
  return result
}

function validateCreateInput(input: RewardCampaignCreateInput, config: RewardCampaignConfig): RewardCampaignCreateInput {
  if (!(["study", "karaoke", "either"] as const).includes(input.eligible_activity)) {
    throw badRequestError("eligible_activity is invalid")
  }
  const normalized = {
    ...input,
    // Web routes and API serializers expose public IDs (`com_cmt_…` and
    // `post_pst_…`), while shard routing and campaign storage use raw IDs.
    // Normalize at the write boundary so callers may use either safe form.
    community: decodePublicCommunityId(nonEmpty(input.community, "community")),
    post: decodePublicPostId(nonEmpty(input.post, "post")),
    idempotency_key: nonEmpty(input.idempotency_key, "idempotency_key"),
    min_score_bps: basisPoints(input.min_score_bps, "min_score_bps"),
    daily_reward_cents: cents(input.daily_reward_cents, "daily_reward_cents", false),
    milestone_7_cents: cents(input.milestone_7_cents, "milestone_7_cents", true),
    milestone_30_cents: cents(input.milestone_30_cents, "milestone_30_cents", true),
    reward_period_cap_cents: cents(input.reward_period_cap_cents, "reward_period_cap_cents", false),
    budget_cents: cents(input.budget_cents, "budget_cents", false),
    starts_at: cents(input.starts_at, "starts_at", false),
    ends_at: cents(input.ends_at, "ends_at", false),
  }
  if (normalized.milestone_7_cents !== 0 || normalized.milestone_30_cents !== 0) {
    throw badRequestError("Campaign milestone rewards are not available yet")
  }
  if (
    normalized.daily_reward_cents > config.maxRewardCents
    || normalized.milestone_7_cents > config.maxRewardCents
    || normalized.milestone_30_cents > config.maxRewardCents
  ) throw badRequestError("Campaign reward exceeds the platform maximum")
  if (normalized.budget_cents < config.minBudgetCents || normalized.budget_cents > config.maxBudgetCents) {
    throw badRequestError("Campaign budget is outside platform guardrails")
  }
  if (normalized.budget_cents < normalized.daily_reward_cents) {
    throw badRequestError("Campaign budget cannot cover one daily reward")
  }
  if (normalized.ends_at <= Math.floor(Date.now() / 1000)) {
    throw badRequestError("Campaign must end in the future")
  }
  const duration = normalized.ends_at - normalized.starts_at
  if (duration < config.minDurationSeconds || duration > config.maxDurationSeconds) {
    throw badRequestError("Campaign duration is outside platform guardrails")
  }
  const largestMaturingCombination = normalized.daily_reward_cents
    + Math.max(normalized.milestone_7_cents, normalized.milestone_30_cents)
  if (normalized.reward_period_cap_cents < largestMaturingCombination) {
    throw badRequestError("reward_period_cap_cents must cover every configured reward combination")
  }
  return normalized
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

function termsPayload(input: RewardCampaignCreateInput, target: RewardCampaignTarget): string {
  return JSON.stringify({
    community: target.communityId,
    post: target.postId,
    song_artifact_bundle: target.songArtifactBundleId,
    song_owner: target.songOwnerUserId,
    eligible_activity: input.eligible_activity,
    min_score_bps: input.min_score_bps,
    daily_reward_cents: input.daily_reward_cents,
    milestone_7_cents: input.milestone_7_cents,
    milestone_30_cents: input.milestone_30_cents,
    reward_period_cap_cents: input.reward_period_cap_cents,
    budget_cents: input.budget_cents,
    starts_at: input.starts_at,
    ends_at: input.ends_at,
  })
}

async function selectCampaign(exec: Pick<Client | Transaction, "execute">, campaignId: string, lock = false): Promise<CampaignRow | null> {
  return queryResultRow(await executeFirst(exec, {
    sql: `SELECT ${CAMPAIGN_COLUMNS} FROM reward_campaigns WHERE reward_campaign_id = ?1${lock ? " FOR UPDATE" : ""}`,
    args: [campaignId],
  }))
}

async function selectFunding(exec: Pick<Client | Transaction, "execute">, fundingId: string, lock = false): Promise<FundingRow | null> {
  return queryResultRow(await executeFirst(exec, {
    sql: `SELECT ${FUNDING_COLUMNS} FROM reward_campaign_funding_effects WHERE reward_campaign_funding_effect_id = ?1${lock ? " FOR UPDATE" : ""}`,
    args: [fundingId],
  }))
}

async function thirdPartyRewardsAllowed(
  exec: Pick<Client | Transaction, "execute">,
  communityId: string,
  postId: string,
): Promise<boolean> {
  const row = await executeFirst(exec, {
    sql: `SELECT third_party_rewards FROM reward_song_owner_policies WHERE community_id = ?1 AND post_id = ?2 LIMIT 1`,
    args: [communityId, postId],
  })
  return stringOrNull(rowValue(row, "third_party_rewards")) !== "blocked"
}

async function requireThirdPartyRewardsAllowed(
  exec: Pick<Client | Transaction, "execute">,
  communityId: string,
  postId: string,
): Promise<void> {
  if (!await thirdPartyRewardsAllowed(exec, communityId, postId)) {
    throw eligibilityFailed("The song owner has disabled third-party rewards")
  }
}

export async function getRewardSongOwnerPolicy(input: {
  env: Env
  client: Client
  target: RewardCampaignTarget
}): Promise<RewardSongOwnerPolicy> {
  requireCampaignsEnabled(resolveRewardCampaignConfig(input.env))
  return {
    community: input.target.communityId,
    post: input.target.postId,
    song_owner: input.target.songOwnerUserId,
    third_party_rewards: await thirdPartyRewardsAllowed(input.client, input.target.communityId, input.target.postId)
      ? "allowed"
      : "blocked",
  }
}

export async function setRewardSongOwnerPolicy(input: {
  env: Env
  client: Client
  userId: string
  target: RewardCampaignTarget
  thirdPartyRewards: "allowed" | "blocked"
  now?: string
}): Promise<RewardSongOwnerPolicy> {
  requireCampaignsEnabled(resolveRewardCampaignConfig(input.env))
  if (input.userId !== input.target.songOwnerUserId) {
    throw notFoundError("Reward song policy not found")
  }
  if (!(["allowed", "blocked"] as const).includes(input.thirdPartyRewards)) {
    throw badRequestError("third_party_rewards is invalid")
  }
  const now = input.now ?? nowIso()
  await withTransaction(input.client, "write", async (tx) => {
    await tx.execute({
      sql: `
        INSERT INTO reward_song_owner_policies (
          community_id, post_id, song_owner_user_id, third_party_rewards, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
        ON CONFLICT (community_id, post_id) DO UPDATE SET
          song_owner_user_id = excluded.song_owner_user_id,
          third_party_rewards = excluded.third_party_rewards,
          updated_at = excluded.updated_at
      `,
      args: [input.target.communityId, input.target.postId, input.target.songOwnerUserId, input.thirdPartyRewards, now],
    })
    if (input.thirdPartyRewards === "blocked") {
      await tx.execute({
        sql: `
          UPDATE reward_campaigns
          SET status = 'paused', updated_at = ?3
          WHERE community_id = ?1 AND post_id = ?2 AND status IN ('scheduled', 'active')
        `,
        args: [input.target.communityId, input.target.postId, now],
      })
    }
  })
  return {
    community: input.target.communityId,
    post: input.target.postId,
    song_owner: input.target.songOwnerUserId,
    third_party_rewards: input.thirdPartyRewards,
  }
}

export async function createRewardCampaign(input: {
  env: Env
  client: Client
  userId: string
  body: RewardCampaignCreateInput
  resolveTarget: (communityId: string, postId: string) => Promise<RewardCampaignTarget>
  now?: string
}): Promise<RewardCampaign> {
  const config = resolveRewardCampaignConfig(input.env)
  requireCampaignsEnabled(config)
  const body = validateCreateInput(input.body, config)
  if (config.postAllowlist && !config.postAllowlist.has(body.post)) {
    throw eligibilityFailed("Reward campaigns are not enabled for this post")
  }
  const now = input.now ?? nowIso()
  await advanceRewardCampaignLifecycle({ client: input.client, now })
  const target = await input.resolveTarget(body.community, body.post)
  if (target.communityId !== body.community || target.postId !== body.post) {
    throw badRequestError("Campaign target resolution mismatch")
  }
  if (
    body.eligible_activity !== "study"
    && (!Number.isSafeInteger(target.karaokeLineCount) || (target.karaokeLineCount ?? 0) < KARAOKE_MIN_MEASURED_LINES)
  ) {
    throw eligibilityFailed(`Karaoke reward campaigns require at least ${KARAOKE_MIN_MEASURED_LINES} timed lyric lines`)
  }
  const termsHash = await sha256(termsPayload(body, target))
  const lockClause = isPostgresControlPlaneUrl(String(input.env.CONTROL_PLANE_DATABASE_URL ?? "")) ? " FOR UPDATE" : ""

  return await withTransaction(input.client, "write", async (tx) => {
    const replay = queryResultRow(await executeFirst(tx, {
      sql: `SELECT ${CAMPAIGN_COLUMNS}, terms_hash FROM reward_campaigns WHERE rewarder_user_id = ?1 AND creation_idempotency_key = ?2 LIMIT 1${lockClause}`,
      args: [input.userId, body.idempotency_key],
    }))
    if (replay) {
      if (requiredString(replay, "terms_hash") !== termsHash) {
        throw conflictError("Reward campaign idempotency key was reused with different terms")
      }
      return campaignResource(replay)
    }

    await requireThirdPartyRewardsAllowed(tx, target.communityId, target.postId)
    const windowStart = `${now.slice(0, 13)}:00:00.000Z`
    await tx.execute({
      sql: `
        INSERT INTO reward_campaign_creation_rate_limits (
          rewarder_user_id, window_start, request_count, updated_at
        ) VALUES (?1, ?2, 1, ?3)
        ON CONFLICT (rewarder_user_id, window_start) DO UPDATE SET
          request_count = reward_campaign_creation_rate_limits.request_count + 1,
          updated_at = excluded.updated_at
      `,
      args: [input.userId, windowStart, now],
    })
    const rateRow = await executeFirst(tx, {
      sql: `SELECT request_count FROM reward_campaign_creation_rate_limits WHERE rewarder_user_id = ?1 AND window_start = ?2`,
      args: [input.userId, windowStart],
    })
    if (integer(rowValue(rateRow, "request_count")) > 10) {
      throw rateLimited("Reward campaign creation is rate limited")
    }

    const campaignId = makeId("rcp")
    try {
      await tx.execute({
        sql: `
        INSERT INTO reward_campaigns (
          reward_campaign_id, campaign_kind, rewarder_user_id, creation_idempotency_key,
          community_id, post_id, song_artifact_bundle_id, song_owner_user_id,
          status, eligible_activity, min_score_bps, daily_reward_cents, milestone_7_cents,
          milestone_30_cents, reward_period_cap_cents, budget_cents,
          terms_version, terms_hash, starts_at, ends_at,
          requested_starts_at, requested_ends_at, created_at, updated_at
        ) VALUES (
          ?1, 'song_practice', ?2, ?3, ?4, ?5, ?6, ?7, 'draft', ?8, ?9,
          ?10, ?11, ?12, ?13, ?14, 2, ?15, ?16, ?17, ?16, ?17, ?18, ?18
        )
        ON CONFLICT (rewarder_user_id, creation_idempotency_key) DO NOTHING
      `,
        args: [
        campaignId, input.userId, body.idempotency_key, target.communityId, target.postId,
        target.songArtifactBundleId, target.songOwnerUserId, body.eligible_activity,
        body.min_score_bps, body.daily_reward_cents, body.milestone_7_cents, body.milestone_30_cents,
        body.reward_period_cap_cents, body.budget_cents, termsHash,
        new Date(body.starts_at * 1000).toISOString(), new Date(body.ends_at * 1000).toISOString(), now,
        ],
      })
    } catch (error) {
      if (
        hasUniqueConstraintName(error, "reward_campaigns_one_open_per_rewarder_song")
        || (error instanceof Error && error.message.includes("reward_campaigns.rewarder_user_id, reward_campaigns.community_id, reward_campaigns.post_id"))
      ) {
        throw conflictError("An unfinished campaign already exists for this rewarder and song")
      }
      throw error
    }
    const created = queryResultRow(await executeFirst(tx, {
      sql: `SELECT ${CAMPAIGN_COLUMNS}, terms_hash FROM reward_campaigns WHERE rewarder_user_id = ?1 AND creation_idempotency_key = ?2 LIMIT 1`,
      args: [input.userId, body.idempotency_key],
    }))
    if (!created) throw new Error("reward campaign insert did not return a row")
    if (requiredString(created, "terms_hash") !== termsHash) {
      throw conflictError("Reward campaign idempotency key was reused with different terms")
    }
    return campaignResource(created)
  })
}

export async function getRewardCampaign(input: {
  env: Env
  client: Client
  campaignId: string
  userId: string
  canModerateCommunity?: (communityId: string) => Promise<boolean>
}): Promise<RewardCampaign> {
  requireCampaignsEnabled(resolveRewardCampaignConfig(input.env))
  const row = await selectCampaign(input.client, nonEmpty(input.campaignId, "campaign_id"))
  if (!row) throw notFoundError("Reward campaign not found")
  const status = requiredString(row, "status")
  const ownsCampaign = requiredString(row, "rewarder_user_id") === input.userId
    || requiredString(row, "song_owner_user_id") === input.userId
  const isPublicOffer = status === "active"
  const canModerate = !isPublicOffer && !ownsCampaign && input.canModerateCommunity
    ? await input.canModerateCommunity(requiredString(row, "community_id"))
    : false
  if (!isPublicOffer && !ownsCampaign && !canModerate) throw notFoundError("Reward campaign not found")
  return campaignResource(row)
}

export async function getPublicActiveRewardCampaign(input: {
  env: Env
  client: Client
  campaignId: string
}): Promise<PublicRewardOffer> {
  requireCampaignsEnabled(resolveRewardCampaignConfig(input.env))
  const row = await selectCampaign(input.client, nonEmpty(input.campaignId, "campaign_id"))
  const now = Date.now()
  if (
    !row
    || requiredString(row, "status") !== "active"
    || Date.parse(requiredString(row, "starts_at")) > now
    || Date.parse(requiredString(row, "ends_at")) <= now
  ) {
    throw notFoundError("Active reward campaign not found")
  }
  assertRewardsCampaignAndSettlementChainsMatch(input.env)
  return publicRewardOffer(row, resolveRewardsSettlementChainId(input.env))
}

export async function getPublicActiveRewardCampaignForSong(input: {
  env: Env
  client: Client
  communityId: string
  postId: string
}): Promise<PublicRewardOffer> {
  requireCampaignsEnabled(resolveRewardCampaignConfig(input.env))
  const result = await input.client.execute({
    sql: `
      SELECT ${CAMPAIGN_COLUMNS}
      FROM reward_campaigns
      WHERE community_id = ?1 AND post_id = ?2 AND status = 'active'
        AND starts_at <= ?3 AND ends_at > ?3
      ORDER BY activated_at DESC, reward_campaign_id ASC
      LIMIT 1
    `,
    args: [
      nonEmpty(input.communityId, "community_id"),
      nonEmpty(input.postId, "post_id"),
      nowIso(),
    ],
  })
  const row = result.rows[0]
  if (!row) throw notFoundError("Active reward campaign not found")
  assertRewardsCampaignAndSettlementChainsMatch(input.env)
  return publicRewardOffer(row, resolveRewardsSettlementChainId(input.env))
}

async function resolveFundingSender(exec: Pick<Client | Transaction, "execute">, userId: string): Promise<string> {
  const row = await executeFirst(exec, {
    sql: `
      SELECT wa.wallet_address_display
      FROM wallet_attachments wa
      JOIN users u ON u.user_id = wa.user_id
      WHERE wa.user_id = ?1 AND wa.status = 'active'
        AND wa.chain_namespace IN ('eip155', 'eip155:1')
      ORDER BY CASE WHEN wa.wallet_attachment_id = u.primary_wallet_attachment_id THEN 0 ELSE 1 END,
        wa.attached_at ASC, wa.wallet_attachment_id ASC
      LIMIT 1
    `,
    args: [userId],
  })
  const raw = stringOrNull(rowValue(row, "wallet_address_display"))
  if (!raw) throw conflictError("Campaign funding requires an active EVM wallet")
  try {
    return getAddress(raw)
  } catch {
    throw conflictError("Campaign funding wallet is invalid")
  }
}

export async function createRewardCampaignFundingQuote(input: {
  env: Env
  client: Client
  userId: string
  campaignId: string
  amountCents: number
  idempotencyKey: string
  now?: string
}): Promise<RewardCampaignFundingQuote> {
  const config = resolveRewardCampaignConfig(input.env)
  requireCampaignsEnabled(config)
  assertRewardCampaignSettlementReadiness(input.env)
  const amountCents = cents(input.amountCents, "amount_cents", false)
  const idempotencyKey = nonEmpty(input.idempotencyKey, "idempotency_key")
  const now = input.now ?? nowIso()
  const expiresAt = new Date(Date.parse(now) + config.quoteTtlSeconds * 1000).toISOString()
  const rowLocks = isPostgresControlPlaneUrl(String(input.env.CONTROL_PLANE_DATABASE_URL ?? ""))
  const lockClause = rowLocks ? " FOR UPDATE" : ""

  return await withTransaction(input.client, "write", async (tx) => {
    const replay = queryResultRow(await executeFirst(tx, {
      sql: `SELECT ${FUNDING_COLUMNS} FROM reward_campaign_funding_effects WHERE funder_user_id = ?1 AND idempotency_key = ?2 LIMIT 1${lockClause}`,
      args: [input.userId, idempotencyKey],
    }))
    if (replay) {
      if (
        requiredString(replay, "reward_campaign_id") !== input.campaignId
        || integer(rowValue(replay, "expected_amount_cents")) !== amountCents
      ) throw conflictError("Funding quote idempotency key was reused with different terms")
      return fundingResource(replay)
    }

    const campaign = await selectCampaign(tx, input.campaignId, rowLocks)
    if (!campaign) throw notFoundError("Reward campaign not found")
    await requireThirdPartyRewardsAllowed(
      tx,
      requiredString(campaign, "community_id"),
      requiredString(campaign, "post_id"),
    )
    const status = requiredString(campaign, "status") as RewardCampaignStatus
    if (!["draft", "funding_quoted", "funding_confirming"].includes(status)) {
      throw conflictError("Reward campaign no longer accepts initial funding")
    }
    const budget = integer(rowValue(campaign, "budget_cents"))
    const funded = integer(rowValue(campaign, "funded_cents"))
    const pendingResult = await tx.execute({
      sql: `
        SELECT COALESCE(SUM(expected_amount_cents), 0) AS pending_cents
        FROM reward_campaign_funding_effects
        WHERE reward_campaign_id = ?1
          AND (
            status = 'confirming'
            OR (status = 'quoted' AND expires_at > ?2)
          )
      `,
      args: [input.campaignId, now],
    })
    const pending = integer(rowValue(pendingResult.rows[0], "pending_cents"))
    if (amountCents > budget - funded - pending) {
      throw conflictError("Funding quote exceeds the campaign's unfunded budget")
    }
    const sender = await resolveFundingSender(tx, input.userId)
    const communityId = requiredString(campaign, "community_id")
    const postId = requiredString(campaign, "post_id")
    const slot = queryResultRow(await executeFirst(tx, {
      sql: REWARD_SONG_SLOT_ACQUIRE_SQL,
      args: [communityId, postId, input.campaignId, expiresAt, now],
    }))
    if (!slot || requiredString(slot, "holder_campaign_id") !== input.campaignId) {
      throw codedConflictError(ONE_LIVE, "Another reward campaign currently holds the funding slot for this song")
    }
    const fundingId = makeId("rcf")
    await tx.execute({
      sql: `
        INSERT INTO reward_campaign_funding_effects (
          reward_campaign_funding_effect_id, reward_campaign_id, funder_user_id,
          idempotency_key, chain_id, token_address, expected_amount_cents,
          expected_amount_atomic, sender_address, treasury_address, status,
          expires_at, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'quoted', ?11, ?12, ?12)
        ON CONFLICT (funder_user_id, idempotency_key) DO NOTHING
      `,
      args: [
        fundingId, input.campaignId, input.userId, idempotencyKey, config.chainId,
        config.tokenAddress, amountCents, String(BigInt(amountCents) * 10_000n),
        sender, config.treasuryAddress, expiresAt, now,
      ],
    })
    await tx.execute({
      sql: "UPDATE reward_campaigns SET status = 'funding_quoted', updated_at = ?2 WHERE reward_campaign_id = ?1",
      args: [input.campaignId, now],
    })
    const created = queryResultRow(await executeFirst(tx, {
      sql: `SELECT ${FUNDING_COLUMNS} FROM reward_campaign_funding_effects WHERE funder_user_id = ?1 AND idempotency_key = ?2 LIMIT 1`,
      args: [input.userId, idempotencyKey],
    }))
    if (!created) throw new Error("reward funding quote insert did not return a row")
    if (
      requiredString(created, "reward_campaign_id") !== input.campaignId
      || integer(rowValue(created, "expected_amount_cents")) !== amountCents
    ) throw conflictError("Funding quote idempotency key was reused with different terms")
    return fundingResource(created)
  })
}

function normalizeTxHash(value: string): string {
  const txHash = nonEmpty(value, "tx_hash").toLowerCase()
  if (!/^0x[a-f0-9]{64}$/.test(txHash)) throw badRequestError("tx_hash must be a 32-byte hex transaction hash")
  return txHash
}

async function markFundingRefundPending(input: {
  tx: Transaction
  campaignId: string
  fundingId: string
  receivedAmountAtomic: string
  senderAddress: string
  blockNumber?: number
  blockHash?: string
  reason: string
  now: string
}): Promise<FundingRow> {
  await input.tx.execute({
    sql: `
      UPDATE reward_campaign_funding_effects
      SET status = 'refund_pending', received_amount_atomic = ?2,
          sender_address = ?3, confirmed_at = ?4, confirmed_block_number = ?5,
          confirmed_block_hash = ?6, failure_reason = ?7, updated_at = ?4
      WHERE reward_campaign_funding_effect_id = ?1
    `,
    args: [
      input.fundingId, input.receivedAmountAtomic, input.senderAddress, input.now,
      input.blockNumber ?? null, input.blockHash ?? null, input.reason,
    ],
  })
  // Custody refunds never entered campaign inventory. Keep funded/refunded campaign counters
  // untouched; campaign.refunded_cents is reserved for future refunds of funded inventory.
  await input.tx.execute({
    sql: `
      UPDATE reward_campaigns
      SET status = CASE
            WHEN EXISTS (
              SELECT 1 FROM reward_campaign_funding_effects
              WHERE reward_campaign_id = ?1
                AND (
                  status = 'confirming'
                  OR (status = 'quoted' AND expires_at > ?2)
                )
            ) THEN 'funding_quoted'
            WHEN funded_cents > 0 THEN 'funding_quoted'
            ELSE 'draft'
          END,
          updated_at = ?2
      WHERE reward_campaign_id = ?1
    `,
    args: [input.campaignId, input.now],
  })
  const refundPending = await selectFunding(input.tx, input.fundingId)
  if (!refundPending) throw new Error("refund-pending reward funding effect disappeared")
  return refundPending
}

export async function confirmRewardCampaignFunding(input: {
  env: Env
  client: Client
  userId: string
  campaignId: string
  fundingId: string
  txHash: string
  now?: string
  verify?: (expected: {
    chainId: number
    tokenAddress: string
    recipientAddress: string
    amountAtomic: bigint
    senderAddress: string
  }, txHash: string, rpcUrl: string) => Promise<BookingPaymentVerification>
}): Promise<RewardCampaignFundingQuote> {
  const config = resolveRewardCampaignConfig(input.env)
  requireCampaignsEnabled(config)
  const txHash = normalizeTxHash(input.txHash)
  const now = input.now ?? nowIso()
  const rowLocks = isPostgresControlPlaneUrl(String(input.env.CONTROL_PLANE_DATABASE_URL ?? ""))

  const claimed = await withTransaction(input.client, "write", async (tx) => {
    const effect = await selectFunding(tx, input.fundingId, rowLocks)
    if (!effect || requiredString(effect, "reward_campaign_id") !== input.campaignId) {
      throw notFoundError("Reward campaign funding quote not found")
    }
    if (requiredString(effect, "funder_user_id") !== input.userId) {
      throw notFoundError("Reward campaign funding quote not found")
    }
    const status = requiredString(effect, "status")
    const existingTx = stringOrNull(rowValue(effect, "tx_hash"))
    if (status === "confirmed") {
      if (existingTx !== txHash) {
        throw codedConflictError(
          FUNDING_TRANSACTION_MISMATCH,
          "Funding quote was confirmed with a different transaction",
        )
      }
      return effect
    }
    if (status === "failed") {
      if (existingTx !== txHash) {
        throw codedConflictError(
          FUNDING_TRANSACTION_MISMATCH,
          "Failed funding quote already claimed a different transaction",
        )
      }
      return effect
    }
    if (status === "refund_pending") {
      if (existingTx !== txHash) {
        throw codedConflictError(
          FUNDING_TRANSACTION_MISMATCH,
          "Funding quote awaiting refund already claimed a different transaction",
        )
      }
      return effect
    }
    if (status === "refunded") {
      throw codedConflictError(FUNDING_QUOTE_ALREADY_CLAIMED, "Funding quote was already refunded")
    }
    if (existingTx && existingTx !== txHash) {
      throw codedConflictError(
        FUNDING_TRANSACTION_MISMATCH,
        "Funding quote already claimed a different transaction",
      )
    }
    // Expiry is NOT judged here. A wallet can broadcast a valid transfer, have its confirm
    // request lost, and only retry after the quote lapsed — rejecting on wall-clock alone
    // would strand real USDC that reached the treasury in time. The claim proceeds and the
    // decision is made after verification against the block the transfer was MINED in, which
    // is the only honest evidence of when the money actually moved.
    const priorUse = queryResultRow(await executeFirst(tx, {
      sql: `
        SELECT reward_campaign_funding_effect_id
        FROM reward_campaign_funding_effects
        WHERE chain_id = ?1 AND tx_hash = ?2
        LIMIT 1${rowLocks ? " FOR UPDATE" : ""}
      `,
      args: [integer(rowValue(effect, "chain_id")), txHash],
    }))
    if (priorUse && requiredString(priorUse, "reward_campaign_funding_effect_id") !== input.fundingId) {
      throw codedConflictError(FUNDING_TRANSACTION_ALREADY_CONSUMED, "Funding transaction has already been consumed")
    }
    try {
      await tx.execute({
        sql: `
          UPDATE reward_campaign_funding_effects
          SET tx_hash = ?2, status = 'confirming', failure_reason = NULL, updated_at = ?3
          WHERE reward_campaign_funding_effect_id = ?1
        `,
        args: [input.fundingId, txHash, now],
      })
    } catch (error) {
      if (
        hasUniqueConstraintName(error, "reward_campaign_funding_effects_tx_unique")
        || (error instanceof Error && error.message.includes("reward_campaign_funding_effects.chain_id, reward_campaign_funding_effects.tx_hash"))
      ) {
        throw codedConflictError(FUNDING_TRANSACTION_ALREADY_CONSUMED, "Funding transaction has already been consumed")
      }
      throw error
    }
    await tx.execute({
      sql: "UPDATE reward_campaigns SET status = 'funding_confirming', updated_at = ?2 WHERE reward_campaign_id = ?1",
      args: [input.campaignId, now],
    })
    return (await selectFunding(tx, input.fundingId)) ?? effect
  })
  if (["confirmed", "failed", "refund_pending"].includes(requiredString(claimed, "status"))) {
    return fundingResource(claimed)
  }

  const expected = {
    chainId: integer(rowValue(claimed, "chain_id")),
    tokenAddress: requiredString(claimed, "token_address"),
    recipientAddress: requiredString(claimed, "treasury_address"),
    amountAtomic: BigInt(requiredString(claimed, "expected_amount_atomic")),
    senderAddress: requiredString(claimed, "sender_address"),
  }
  const verification = input.verify
    ? await input.verify(expected, txHash, config.rpcUrl)
    : await classifyBookingPaymentReceipt({
      env: input.env,
      fundingTxRef: txHash,
      expected,
      rpcUrl: config.rpcUrl,
      finality: {
        expectedChainId: config.chainId,
        fallbackConfirmations: 30,
        preferSafeBlock: true,
      },
    })
  if (verification.kind === "pending") {
    const pending = await selectFunding(input.client, input.fundingId)
    if (!pending) throw notFoundError("Reward campaign funding quote not found")
    return fundingResource(pending)
  }

  const expiresAtMs = Date.parse(requiredString(claimed, "expires_at"))
  const confirmationAfterExpiry = Date.parse(now) > expiresAtMs
  const minedAtMs = verification.kind === "verified" && typeof verification.blockTimestamp === "number"
    ? verification.blockTimestamp * 1000
    : null
  const genuinelyLateDeposit = verification.kind === "verified"
    && confirmationAfterExpiry
    && (minedAtMs === null || minedAtMs > expiresAtMs)
  const graceEndsAtMs = expiresAtMs + LATE_FUNDING_ACCEPTANCE_GRACE_SECONDS * 1000
  const lateDepositInsideGrace = genuinelyLateDeposit
    && minedAtMs !== null
    && minedAtMs <= graceEndsAtMs
    && Date.parse(now) <= graceEndsAtMs

  return await withTransaction(input.client, "write", async (tx) => {
    const effect = await selectFunding(tx, input.fundingId, rowLocks)
    if (!effect) throw notFoundError("Reward campaign funding quote not found")
    if (requiredString(effect, "status") === "confirmed") return fundingResource(effect)
    if (stringOrNull(rowValue(effect, "tx_hash")) !== txHash) {
      throw codedConflictError(
        FUNDING_TRANSACTION_MISMATCH,
        "Funding quote transaction changed during confirmation",
      )
    }
    if (verification.kind === "custody_mismatch") {
      return fundingResource(await markFundingRefundPending({
        tx,
        campaignId: input.campaignId,
        fundingId: input.fundingId,
        receivedAmountAtomic: verification.observedAmountAtomic,
        senderAddress: verification.senderAddress,
        blockNumber: verification.blockNumber,
        blockHash: verification.blockHash,
        reason: verification.reason,
        now,
      }))
    }
    if (verification.kind === "rejected") {
      await tx.execute({
        sql: `UPDATE reward_campaign_funding_effects SET status = 'failed', failure_reason = ?2, failed_at = ?3, updated_at = ?3 WHERE reward_campaign_funding_effect_id = ?1`,
        args: [input.fundingId, verification.reason, now],
      })
      await tx.execute({
        sql: `
          UPDATE reward_campaigns
          SET status = CASE
                WHEN EXISTS (
                  SELECT 1 FROM reward_campaign_funding_effects
                  WHERE reward_campaign_id = ?1
                    AND (
                      status = 'confirming'
                      OR (status = 'quoted' AND expires_at > ?2)
                    )
                ) THEN 'funding_quoted'
                WHEN funded_cents > 0 THEN 'funding_quoted'
                ELSE 'draft'
              END,
              updated_at = ?2
          WHERE reward_campaign_id = ?1
        `,
        args: [input.campaignId, now],
      })
      const failed = await selectFunding(tx, input.fundingId)
      if (!failed) throw new Error("failed reward funding effect disappeared")
      return fundingResource(failed)
    }

    const campaign = await selectCampaign(tx, input.campaignId, rowLocks)
    if (!campaign) throw notFoundError("Reward campaign not found")
    if (genuinelyLateDeposit) {
      const slot = lateDepositInsideGrace
        ? queryResultRow(await executeFirst(tx, {
            sql: REWARD_SONG_SLOT_ACQUIRE_SQL,
            args: [
              requiredString(campaign, "community_id"),
              requiredString(campaign, "post_id"),
              input.campaignId,
              new Date(graceEndsAtMs).toISOString(),
              now,
            ],
          }))
        : null
      if (!slot || requiredString(slot, "holder_campaign_id") !== input.campaignId) {
        return fundingResource(await markFundingRefundPending({
          tx,
          campaignId: input.campaignId,
          fundingId: input.fundingId,
          receivedAmountAtomic: requiredString(effect, "expected_amount_atomic"),
          senderAddress: verification.senderAddress,
          blockNumber: verification.blockNumber,
          blockHash: verification.blockHash,
          reason: "funding_confirmed_after_quote_expiry",
          now,
        }))
      }
    }
    const amount = integer(rowValue(effect, "expected_amount_cents"))
    const nextFunded = integer(rowValue(campaign, "funded_cents")) + amount
    const budget = integer(rowValue(campaign, "budget_cents"))
    if (nextFunded > budget) {
      return fundingResource(await markFundingRefundPending({
        tx,
        campaignId: input.campaignId,
        fundingId: input.fundingId,
        receivedAmountAtomic: requiredString(effect, "expected_amount_atomic"),
        senderAddress: verification.senderAddress,
        blockNumber: verification.blockNumber,
        blockHash: verification.blockHash,
        reason: "funding_campaign_budget_exceeded",
        now,
      }))
    }
    const nowMillis = Date.parse(now)
    const requestedStartMillis = Date.parse(requiredString(campaign, "starts_at"))
    const requestedEndMillis = Date.parse(requiredString(campaign, "ends_at"))
    const campaignDurationMillis = requestedEndMillis - requestedStartMillis
    const startMillis = genuinelyLateDeposit ? nowMillis : requestedStartMillis
    const endMillis = genuinelyLateDeposit ? nowMillis + campaignDurationMillis : requestedEndMillis
    const ownerAllowsRewards = await thirdPartyRewardsAllowed(
      tx,
      requiredString(campaign, "community_id"),
      requiredString(campaign, "post_id"),
    )
    const nextStatus: RewardCampaignStatus = !ownerAllowsRewards
      ? "paused"
      : nextFunded < budget
      ? "funding_quoted"
      : nowMillis < startMillis
        ? "scheduled"
        : nowMillis < endMillis
          ? "active"
          : "ended"
    await tx.execute({
      sql: `
        UPDATE reward_campaign_funding_effects
        SET status = 'confirmed', received_amount_atomic = expected_amount_atomic,
            sender_address = ?2, confirmed_at = ?3, confirmed_block_number = ?4,
            confirmed_block_hash = ?5, failure_reason = NULL, updated_at = ?3
        WHERE reward_campaign_funding_effect_id = ?1
      `,
      args: [
        input.fundingId, verification.senderAddress, now,
        verification.blockNumber ?? null, verification.blockHash ?? null,
      ],
    })
    try {
      await tx.execute({
        sql: `
          UPDATE reward_campaigns
          SET funded_cents = ?2, status = ?3,
              starts_at = CASE WHEN ?5 THEN ?6 ELSE starts_at END,
              ends_at = CASE WHEN ?5 THEN ?7 ELSE ends_at END,
              activated_at = CASE WHEN ?3 = 'active' AND activated_at IS NULL THEN ?4 ELSE activated_at END,
              ended_at = CASE WHEN ?3 = 'ended' AND ended_at IS NULL THEN ?4 ELSE ended_at END,
              updated_at = ?4
          WHERE reward_campaign_id = ?1
        `,
        args: [
          input.campaignId, nextFunded, nextStatus, now, genuinelyLateDeposit,
          new Date(startMillis).toISOString(),
          new Date(endMillis).toISOString(),
        ],
      })
    } catch (error) {
      if (hasUniqueConstraintName(error, "reward_campaigns_one_live_per_song_post")) {
        throw conflictError("Another funded campaign is already live for this song post")
      }
      throw error
    }
    const confirmed = await selectFunding(tx, input.fundingId)
    if (!confirmed) throw new Error("confirmed reward funding effect disappeared")
    return fundingResource(confirmed)
  })
}
