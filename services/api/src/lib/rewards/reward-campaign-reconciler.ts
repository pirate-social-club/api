import type { Env } from "../../env"
import { executeFirst } from "../db-helpers"
import { makeId, nowIso } from "../helpers"
import { isPostgresControlPlaneUrl } from "../runtime-deps"
import { rowValue, stringOrNull } from "../sql-row"
import type { Client, QueryResultRow } from "../sql-client"
import { withTransaction } from "../transactions"
import { openCommunityWriteClient } from "../communities/community-read-access"
import type { CommunityJobRepository } from "../communities/jobs/runner-types"
import { selectScheduledCommunityJobPollIds } from "../communities/jobs/runner"
import { resolveActiveRewardIdentity, resolveRewardIdentityProvider } from "../verification/unique-human-eligibility"
import { resolveRewardCampaignConfig } from "./reward-campaign-config"

export type RewardQualificationCandidate = {
  eventId: string
  userId: string
  communityId: string
  postId: string
  artifactBundleId: string
  activity: "study" | "karaoke"
  qualifiedAt: string
  periodKey: string
  policyVersion: string
}

export type RewardCampaignReconciliationSummary = {
  enabled: boolean
  scanned_communities: number
  ingested_qualifications: number
  duplicate_qualifications: number
  scanned_qualifications: number
  credited_events: number
  credited_cents: number
  skipped_identity: number
  skipped_budget: number
  skipped_cap: number
  failed_communities: number
  errors: number
}

function emptySummary(enabled: boolean): RewardCampaignReconciliationSummary {
  return {
    enabled,
    scanned_communities: 0,
    ingested_qualifications: 0,
    duplicate_qualifications: 0,
    scanned_qualifications: 0,
    credited_events: 0,
    credited_cents: 0,
    skipped_identity: 0,
    skipped_budget: 0,
    skipped_cap: 0,
    failed_communities: 0,
    errors: 0,
  }
}

function literalTrue(value: string | undefined): boolean {
  return String(value ?? "").trim().toLowerCase() === "true"
}

function text(row: QueryResultRow, key: string): string {
  const value = stringOrNull(rowValue(row, key))
  if (!value) throw new Error(`Reward qualification is missing ${key}`)
  return value
}

function qualification(row: QueryResultRow): RewardQualificationCandidate {
  const activity = text(row, "activity")
  if (activity !== "study" && activity !== "karaoke") throw new Error("Reward qualification activity is invalid")
  return {
    eventId: text(row, "reward_qualification_event_id"),
    userId: text(row, "user_id"),
    communityId: text(row, "community_id"),
    postId: text(row, "post_id"),
    artifactBundleId: text(row, "song_artifact_bundle_id"),
    activity,
    qualifiedAt: text(row, "qualified_at"),
    periodKey: text(row, "reward_period_key"),
    policyVersion: text(row, "qualification_policy_version"),
  }
}

async function ingestCommunity(input: {
  communityId: string
  communityClient: { execute: Client["execute"] }
  controlPlaneClient: Client
  limit: number
  now: string
}): Promise<{ inserted: number; duplicates: number }> {
  const checkpoint = await executeFirst(input.controlPlaneClient, {
    sql: "SELECT last_shard_sequence FROM reward_qualification_checkpoints WHERE community_id = ?1",
    args: [input.communityId],
  })
  const after = Number(rowValue(checkpoint, "last_shard_sequence") ?? 0)
  const rows = await input.communityClient.execute({
    sql: `
      SELECT sequence, event_id, user_id, community_id, post_id, song_artifact_bundle_id,
        activity, qualified_at, reward_period_key, qualification_policy_version,
        evidence_summary_json
      FROM reward_qualification_outbox
      WHERE sequence > ?1
      ORDER BY sequence ASC
      LIMIT ?2
    `,
    args: [after, input.limit],
  })
  if (rows.rows.length === 0) return { inserted: 0, duplicates: 0 }
  return withTransaction(input.controlPlaneClient, "write", async (tx) => {
    let inserted = 0
    let duplicates = 0
    let lastSequence = after
    for (const row of rows.rows) {
      const sequence = Number(rowValue(row, "sequence"))
      if (!Number.isSafeInteger(sequence) || sequence <= lastSequence) throw new Error("Reward outbox sequence is invalid")
      if (text(row, "community_id") !== input.communityId) throw new Error("Reward outbox community mismatch")
      const result = await tx.execute({
        sql: `
          INSERT INTO reward_qualification_events (
            reward_qualification_event_id, community_id, shard_sequence, user_id,
            post_id, song_artifact_bundle_id, activity, qualified_at,
            reward_period_key, qualification_policy_version, evidence_summary_json,
            ingested_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
          ON CONFLICT (community_id, shard_sequence) DO NOTHING
        `,
        args: [
          text(row, "event_id"), input.communityId, sequence, text(row, "user_id"),
          text(row, "post_id"), text(row, "song_artifact_bundle_id"), text(row, "activity"),
          text(row, "qualified_at"), text(row, "reward_period_key"),
          text(row, "qualification_policy_version"), text(row, "evidence_summary_json"), input.now,
        ],
      })
      if ((result.rowsAffected ?? result.rows.length) > 0) inserted += 1
      else duplicates += 1
      lastSequence = sequence
    }
    await tx.execute({
      sql: `
        INSERT INTO reward_qualification_checkpoints (community_id, last_shard_sequence, updated_at)
        VALUES (?1, ?2, ?3)
        ON CONFLICT (community_id) DO UPDATE SET
          last_shard_sequence = CASE
            WHEN excluded.last_shard_sequence > reward_qualification_checkpoints.last_shard_sequence
              THEN excluded.last_shard_sequence
            ELSE reward_qualification_checkpoints.last_shard_sequence
          END,
          updated_at = excluded.updated_at
      `,
      args: [input.communityId, lastSequence, input.now],
    })
    return { inserted, duplicates }
  })
}

type CreditResult = "credited" | "duplicate" | "identity" | "campaign" | "budget" | "cap"

export async function creditRewardCampaignQualification(input: {
  env: Env
  client: Client
  candidate: RewardQualificationCandidate
  now: string
}): Promise<{ result: CreditResult; amountCents: number }> {
  const provider = resolveRewardIdentityProvider(input.env.REWARDS_IDENTITY_PROVIDER)
  const identity = await resolveActiveRewardIdentity(input.client, input.candidate.userId, provider)
  if (!identity) return { result: "identity", amountCents: 0 }
  const rowLocks = isPostgresControlPlaneUrl(String(input.env.CONTROL_PLANE_DATABASE_URL ?? ""))
  return withTransaction(input.client, "write", async (tx) => {
    const campaign = await executeFirst(tx, {
      sql: `
        SELECT reward_campaign_id, eligible_activity, daily_reward_cents,
          reward_period_cap_cents, funded_cents, reserved_cents, credited_cents,
          refunded_cents, terms_version
        FROM reward_campaigns c
        WHERE c.community_id = ?1 AND c.post_id = ?2 AND c.song_artifact_bundle_id = ?3
          AND c.status IN ('active', 'ended', 'exhausted')
          AND c.starts_at <= ?4 AND c.ends_at >= ?4
          AND (c.eligible_activity = 'either' OR c.eligible_activity = ?5)
          AND NOT EXISTS (
            SELECT 1 FROM reward_song_owner_policies p
            WHERE p.community_id = c.community_id AND p.post_id = c.post_id
              AND p.third_party_rewards = 'blocked'
          )
        ORDER BY c.starts_at DESC, c.reward_campaign_id ASC
        LIMIT 1${rowLocks ? " FOR UPDATE" : ""}
      `,
      args: [
        input.candidate.communityId, input.candidate.postId, input.candidate.artifactBundleId,
        input.candidate.qualifiedAt, input.candidate.activity,
      ],
    })
    if (!campaign) return { result: "campaign", amountCents: 0 }
    const campaignRow = campaign as QueryResultRow
    const campaignId = text(campaignRow, "reward_campaign_id")
    const existing = await executeFirst(tx, {
      sql: `
        SELECT reward_campaign_reservation_id
        FROM reward_campaign_reservations
        WHERE reward_campaign_id = ?1 AND reward_identity_id = ?2
          AND reward_period_key = ?3 AND reward_kind = 'campaign_practice_day'
        LIMIT 1
      `,
      args: [campaignId, identity.id, input.candidate.periodKey],
    })
    if (existing) return { result: "duplicate", amountCents: 0 }
    const amount = Number(rowValue(campaignRow, "daily_reward_cents") ?? 0)
    const funded = Number(rowValue(campaignRow, "funded_cents") ?? 0)
    const reserved = Number(rowValue(campaignRow, "reserved_cents") ?? 0)
    const credited = Number(rowValue(campaignRow, "credited_cents") ?? 0)
    const refunded = Number(rowValue(campaignRow, "refunded_cents") ?? 0)
    if (!Number.isSafeInteger(amount) || amount <= 0 || funded - reserved - credited - refunded < amount) {
      return { result: "budget", amountCents: 0 }
    }
    const period = await executeFirst(tx, {
      sql: `
        SELECT COALESCE(SUM(amount_cents), 0) AS used_cents
        FROM reward_campaign_reservations
        WHERE reward_campaign_id = ?1 AND reward_identity_id = ?2
          AND reward_period_key = ?3 AND status IN ('reserved', 'credited')
      `,
      args: [campaignId, identity.id, input.candidate.periodKey],
    })
    const used = Number(rowValue(period, "used_cents") ?? 0)
    const cap = Number(rowValue(campaignRow, "reward_period_cap_cents") ?? 0)
    if (!Number.isSafeInteger(used) || !Number.isSafeInteger(cap) || used + amount > cap) {
      return { result: "cap", amountCents: 0 }
    }
    const reservationId = makeId("rcr")
    const rewardEventId = makeId("rew")
    await tx.execute({
      sql: `
        INSERT INTO reward_campaign_reservations (
          reward_campaign_reservation_id, reward_campaign_id, reward_identity_id,
          user_id, reward_period_key, reward_kind, qualification_basis,
          amount_cents, status, reserved_at, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, 'campaign_practice_day', ?6, ?7, 'reserved', ?8, ?8, ?8)
      `,
      args: [
        reservationId, campaignId, identity.id, input.candidate.userId,
        input.candidate.periodKey, input.candidate.activity, amount, input.now,
      ],
    })
    await tx.execute({
      sql: "UPDATE reward_campaigns SET reserved_cents = reserved_cents + ?2, updated_at = ?3 WHERE reward_campaign_id = ?1",
      args: [campaignId, amount, input.now],
    })
    await tx.execute({
      sql: `
        INSERT INTO reward_events (
          reward_event_id, user_id, community_id, post_id, activity_date,
          reward_kind, amount_cents, source, created_at, reward_campaign_id,
          reward_campaign_reservation_id, reward_identity_id, reward_period_key,
          qualification_basis, campaign_terms_version, campaign_rate_snapshot_json
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, 'campaign_practice_day', ?6,
          'reward_campaign_reconciler', ?7, ?8, ?9, ?10, ?5, ?11, ?12, ?13
        )
      `,
      args: [
        rewardEventId, input.candidate.userId, input.candidate.communityId, input.candidate.postId,
        input.candidate.periodKey, amount, input.now, campaignId, reservationId, identity.id,
        input.candidate.activity, Number(rowValue(campaignRow, "terms_version") ?? 1),
        JSON.stringify({
          daily_reward_cents: amount,
          qualification_event_id: input.candidate.eventId,
          qualification_policy_version: input.candidate.policyVersion,
        }),
      ],
    })
    await tx.execute({
      sql: `
        UPDATE reward_campaign_reservations
        SET status = 'credited', reward_event_id = ?2, credited_at = ?3, updated_at = ?3
        WHERE reward_campaign_reservation_id = ?1
      `,
      args: [reservationId, rewardEventId, input.now],
    })
    await tx.execute({
      sql: `
        UPDATE reward_campaigns
        SET reserved_cents = reserved_cents - ?2,
            credited_cents = credited_cents + ?2,
            status = CASE
              WHEN funded_cents - (reserved_cents - ?2) - (credited_cents + ?2) - refunded_cents = 0
                THEN 'exhausted'
              ELSE status
            END,
            exhausted_at = CASE
              WHEN funded_cents - (reserved_cents - ?2) - (credited_cents + ?2) - refunded_cents = 0
                THEN COALESCE(exhausted_at, ?3)
              ELSE exhausted_at
            END,
            updated_at = ?3
        WHERE reward_campaign_id = ?1
      `,
      args: [campaignId, amount, input.now],
    })
    await tx.execute({
      sql: `
        INSERT INTO reward_user_days (user_id, activity_date, credited_cents, updated_at)
        VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT (user_id, activity_date) DO UPDATE SET
          credited_cents = reward_user_days.credited_cents + excluded.credited_cents,
          updated_at = excluded.updated_at
      `,
      args: [input.candidate.userId, input.candidate.periodKey, amount, input.now],
    })
    return { result: "credited", amountCents: amount }
  })
}

export async function reconcileRewardCampaigns(input: {
  env: Env
  communityRepository: CommunityJobRepository
  controlPlaneClient: Client
  maxCommunities?: number
  maxCredits?: number
  outboxBatchSize?: number
  lookbackDays?: number
}): Promise<RewardCampaignReconciliationSummary> {
  const campaigns = resolveRewardCampaignConfig(input.env)
  const enabled = campaigns.enabled && literalTrue(input.env.REWARDS_ACCRUAL_ENABLED)
    && resolveRewardIdentityProvider(input.env.REWARDS_IDENTITY_PROVIDER) !== null
  const summary = emptySummary(enabled)
  if (!enabled) return summary
  const now = nowIso()
  const communityIds = selectScheduledCommunityJobPollIds(
    await input.communityRepository.listActiveCommunities({ requireReadyRouting: true }),
    Math.max(1, Math.trunc(input.maxCommunities ?? 50)),
  )
  for (const communityId of communityIds) {
    let db: Awaited<ReturnType<typeof openCommunityWriteClient>> | null = null
    try {
      db = await openCommunityWriteClient(input.env, input.communityRepository, communityId)
      summary.scanned_communities += 1
      const ingested = await ingestCommunity({
        communityId,
        communityClient: db.client,
        controlPlaneClient: input.controlPlaneClient,
        limit: Math.max(1, Math.min(500, Math.trunc(input.outboxBatchSize ?? 500))),
        now,
      })
      summary.ingested_qualifications += ingested.inserted
      summary.duplicate_qualifications += ingested.duplicates
    } catch (error) {
      summary.failed_communities += 1
      console.error("[reward-campaigns] qualification ingestion failed", { community_id: communityId, error })
    } finally {
      await db?.close()
    }
  }

  const since = new Date(Date.parse(now) - Math.max(1, Math.trunc(input.lookbackDays ?? 45)) * 86_400_000).toISOString()
  const maxCredits = Math.max(1, Math.trunc(input.maxCredits ?? 500))
  const pageSize = Math.min(500, maxCredits)
  let offset = 0
  while (summary.credited_events < maxCredits) {
    const rows = await input.controlPlaneClient.execute({
      sql: `
        SELECT q.reward_qualification_event_id, q.user_id, q.community_id, q.post_id,
          q.song_artifact_bundle_id, q.activity, q.qualified_at, q.reward_period_key,
          q.qualification_policy_version
        FROM reward_qualification_events q
        WHERE q.qualified_at >= ?1
          AND EXISTS (
            SELECT 1 FROM reward_campaigns c
            WHERE c.community_id = q.community_id AND c.post_id = q.post_id
              AND c.song_artifact_bundle_id = q.song_artifact_bundle_id
              AND c.status IN ('active', 'ended')
              AND c.starts_at <= q.qualified_at AND c.ends_at >= q.qualified_at
              AND (c.eligible_activity = 'either' OR c.eligible_activity = q.activity)
              AND NOT EXISTS (
                SELECT 1 FROM reward_song_owner_policies p
                WHERE p.community_id = c.community_id AND p.post_id = c.post_id
                  AND p.third_party_rewards = 'blocked'
              )
          )
          AND NOT EXISTS (
            SELECT 1
            FROM reward_campaign_reservations r
            JOIN reward_campaigns c ON c.reward_campaign_id = r.reward_campaign_id
            WHERE r.user_id = q.user_id
              AND r.reward_period_key = q.reward_period_key
              AND r.reward_kind = 'campaign_practice_day'
              AND c.community_id = q.community_id AND c.post_id = q.post_id
              AND c.song_artifact_bundle_id = q.song_artifact_bundle_id
              AND c.starts_at <= q.qualified_at AND c.ends_at >= q.qualified_at
          )
        ORDER BY q.qualified_at ASC, q.community_id ASC, q.shard_sequence ASC
        LIMIT ?2 OFFSET ?3
      `,
      args: [since, pageSize, offset],
    })
    for (const row of rows.rows) {
      summary.scanned_qualifications += 1
      try {
        const result = await creditRewardCampaignQualification({ env: input.env, client: input.controlPlaneClient, candidate: qualification(row), now })
        if (result.result === "credited") {
          summary.credited_events += 1
          summary.credited_cents += result.amountCents
        } else if (result.result === "identity") summary.skipped_identity += 1
        else if (result.result === "budget") summary.skipped_budget += 1
        else if (result.result === "cap") summary.skipped_cap += 1
      } catch (error) {
        summary.errors += 1
        console.error("[reward-campaigns] qualification credit failed", { error })
      }
      if (summary.credited_events >= maxCredits) break
    }
    if (rows.rows.length < pageSize || summary.credited_events >= maxCredits) break
    offset += rows.rows.length
  }
  return summary
}
