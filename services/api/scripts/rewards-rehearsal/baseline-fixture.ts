import { createHash, randomUUID } from "node:crypto"

import type { Client, QueryResultRow, Transaction } from "../../src/lib/sql-client"
import { withTransaction } from "../../src/lib/transactions"

const USER_ID_RE = /^usr_[0-9a-f]{32}$/u
const CAMPAIGN_ID_RE = /^rcp_[0-9a-f]{32}$/u

export type RehearsalBaselineFixture = {
  version: 1
  purpose: "rewards_vault_rehearsal_baseline"
  createdAt: string
  userId: string
  recipientAddress: string
  amountCents: number
  sourceCampaignId: string
  campaignId: string
  reservationId: string
  rewardEventId: string
  rewardIdentityId: string
  qualificationPolicyVersion: "rehearsal_fixture_v1"
  scope: "settlement_path_only"
}

function text(row: QueryResultRow | undefined, field: string): string {
  const value = row?.[field]
  if (typeof value !== "string" || !value.trim()) throw new Error(`baseline_fixture_missing_${field}`)
  return value
}

function integer(value: unknown, field: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`baseline_fixture_invalid_${field}`)
  return parsed
}

function id(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`
}

function fixtureTermsHash(input: {
  campaignId: string
  userId: string
  amountCents: number
  sourceCampaignId: string
}): string {
  return createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex")
}

async function first(
  tx: Transaction,
  sql: string,
  args: unknown[],
): Promise<QueryResultRow | undefined> {
  return (await tx.execute({ sql, args })).rows[0]
}

export async function seedRehearsalBaselineFixture(input: {
  client: Client
  userId: string
  sourceCampaignId: string
  amountCents: number
  now?: string
}): Promise<RehearsalBaselineFixture> {
  if (!USER_ID_RE.test(input.userId)) throw new Error("baseline_fixture_invalid_user_id")
  if (!CAMPAIGN_ID_RE.test(input.sourceCampaignId)) {
    throw new Error("baseline_fixture_invalid_source_campaign_id")
  }
  const amountCents = integer(input.amountCents, "amount_cents")
  const now = input.now ?? new Date().toISOString()
  if (!Number.isFinite(Date.parse(now))) throw new Error("baseline_fixture_invalid_now")

  return withTransaction(input.client, "write", async (tx) => {
    const user = await first(tx, `
      SELECT u.verification_state, u.verification_capabilities_json,
        (
          SELECT wallet_address_display
          FROM wallet_attachments
          WHERE user_id = u.user_id
            AND status = 'active'
            AND chain_namespace IN ('eip155', 'eip155:1')
          ORDER BY attached_at, wallet_attachment_id
          LIMIT 1
        ) AS recipient_address,
        (
          SELECT identity_nullifier_id
          FROM identity_nullifiers
          WHERE user_id = u.user_id AND status = 'active'
          ORDER BY created_at, identity_nullifier_id
          LIMIT 1
        ) AS identity_nullifier_id
      FROM users u
      WHERE u.user_id = ?1
      FOR UPDATE
    `, [input.userId])
    if (!user) throw new Error("baseline_fixture_user_not_found")
    if (text(user, "verification_state") !== "verified") {
      throw new Error("baseline_fixture_user_not_verified")
    }
    const capabilities = user.verification_capabilities_json
    const uniqueHumanState = typeof capabilities === "object"
      && capabilities !== null
      && typeof (capabilities as Record<string, unknown>).unique_human === "object"
      ? ((capabilities as { unique_human: Record<string, unknown> }).unique_human.state)
      : null
    if (uniqueHumanState !== "verified") throw new Error("baseline_fixture_unique_human_not_verified")
    const recipientAddress = text(user, "recipient_address")
    const identityNullifierId = text(user, "identity_nullifier_id")

    const source = await first(tx, `
      SELECT rewarder_user_id, community_id, post_id, song_artifact_bundle_id,
        song_owner_user_id, eligible_activity, platform_fee_bps, min_score_bps
      FROM reward_campaigns
      WHERE reward_campaign_id = ?1
      LIMIT 1
    `, [input.sourceCampaignId])
    if (!source) throw new Error("baseline_fixture_source_campaign_not_found")

    const campaignId = id("rcp")
    const reservationId = id("rcr")
    const rewardEventId = id("rew")
    const rewardIdentityId = `rwi_${createHash("sha256")
      .update(`rehearsal:${identityNullifierId}:${campaignId}`)
      .digest("hex")}`
    const termsHash = fixtureTermsHash({
      campaignId,
      userId: input.userId,
      amountCents,
      sourceCampaignId: input.sourceCampaignId,
    })
    const periodKey = now.slice(0, 10)

    await tx.execute({
      sql: `
        INSERT INTO reward_campaigns (
          reward_campaign_id, campaign_kind, rewarder_user_id, creation_idempotency_key,
          community_id, post_id, song_artifact_bundle_id, song_owner_user_id, status,
          eligible_activity, daily_reward_cents, milestone_7_cents, milestone_30_cents,
          reward_period_cap_cents, budget_cents, funded_cents, reserved_cents,
          credited_cents, paid_cents, refunded_cents, platform_fee_bps,
          platform_fee_cents, terms_version, terms_hash, starts_at, ends_at,
          activated_at, exhausted_at, created_at, updated_at, min_score_bps,
          requested_starts_at, requested_ends_at
        ) VALUES (
          ?1, 'song_practice', ?2, ?3, ?4, ?5, ?6, ?7, 'exhausted',
          ?8, ?9, 0, 0, ?9, ?9, ?9, 0, ?9, 0, 0, ?10,
          0, 1, ?11, ?12::timestamptz - INTERVAL '1 minute',
          ?12::timestamptz + INTERVAL '1 day', ?12, ?12, ?12, ?12, ?13,
          ?12::timestamptz - INTERVAL '1 minute', ?12::timestamptz + INTERVAL '1 day'
        )
      `,
      args: [
        campaignId,
        text(source, "rewarder_user_id"),
        `rehearsal-baseline:${campaignId}`,
        text(source, "community_id"),
        text(source, "post_id"),
        text(source, "song_artifact_bundle_id"),
        text(source, "song_owner_user_id"),
        text(source, "eligible_activity"),
        amountCents,
        Number(source.platform_fee_bps ?? 0),
        termsHash,
        now,
        Number(source.min_score_bps ?? 7000),
      ],
    })
    await tx.execute({
      sql: `
        INSERT INTO reward_campaign_reservations (
          reward_campaign_reservation_id, reward_campaign_id, reward_identity_id,
          user_id, reward_period_key, reward_kind, qualification_basis, amount_cents,
          status, reward_event_id, reserved_at, credited_at, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, 'campaign_practice_day', 'karaoke', ?6,
          'credited', NULL, ?7, ?7, ?7, ?7)
      `,
      args: [reservationId, campaignId, rewardIdentityId, input.userId, periodKey, amountCents, now],
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
          'reward_campaign_reconciler', ?7, ?8, ?9, ?10, ?5, 'karaoke', 1, ?11
        )
      `,
      args: [
        rewardEventId,
        input.userId,
        text(source, "community_id"),
        text(source, "post_id"),
        periodKey,
        amountCents,
        now,
        campaignId,
        reservationId,
        rewardIdentityId,
        JSON.stringify({
          min_score_bps: Number(source.min_score_bps ?? 7000),
          daily_reward_cents: amountCents,
          qualification_event_id: "rehearsal_fixture",
          qualification_policy_version: "rehearsal_fixture_v1",
        }),
      ],
    })
    await tx.execute({
      sql: `
        UPDATE reward_campaign_reservations
        SET reward_event_id = ?2, updated_at = ?3
        WHERE reward_campaign_reservation_id = ?1 AND reward_event_id IS NULL
      `,
      args: [reservationId, rewardEventId, now],
    })

    return {
      version: 1,
      purpose: "rewards_vault_rehearsal_baseline",
      createdAt: now,
      userId: input.userId,
      recipientAddress,
      amountCents,
      sourceCampaignId: input.sourceCampaignId,
      campaignId,
      reservationId,
      rewardEventId,
      rewardIdentityId,
      qualificationPolicyVersion: "rehearsal_fixture_v1",
      scope: "settlement_path_only",
    }
  })
}
