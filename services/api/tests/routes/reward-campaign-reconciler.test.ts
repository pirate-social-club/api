import { afterEach, describe, expect, test } from "bun:test"
import {
  creditRewardCampaignQualification,
  isRewardQualificationExpired,
  reconcileRewardCampaigns,
  rewardQualificationExpiresAt,
} from "../../src/lib/rewards/reward-campaign-reconciler"
import { getRewardsSummaryForUser } from "../../src/lib/rewards/reward-read-service"
import { createRouteTestContext, resetRuntimeCaches } from "../helpers"
import { exchangeJwt } from "./communities/community-routes-test-helpers"
import { getCommunityRepository } from "../../src/lib/communities/db-community-repository"
import { openCommunityWriteClient } from "../../src/lib/communities/community-read-access"
import { advanceRewardCampaignLifecycle } from "../../src/lib/rewards/reward-campaign-lifecycle"

let cleanup: (() => Promise<void>) | null = null

afterEach(async () => {
  if (cleanup) await cleanup()
  cleanup = null
  resetRuntimeCaches()
})

function env() {
  return {
    REWARDS_CAMPAIGNS_ENABLED: "true",
    REWARDS_ACCRUAL_ENABLED: "true",
    REWARDS_PAYOUTS_ENABLED: "true",
    REWARDS_IDENTITY_PROVIDER: "self",
    REWARDS_CAMPAIGN_CHAIN_ID: "84532",
    PIRATE_REWARDS_SETTLEMENT_CHAIN_ID: "84532",
    REWARDS_CAMPAIGN_USDC_TOKEN_ADDRESS: "0x1000000000000000000000000000000000000001",
    REWARDS_CAMPAIGN_TREASURY_ADDRESS: "0x2000000000000000000000000000000000000002",
    REWARDS_CAMPAIGN_RPC_URL: "https://base-sepolia.example.test",
    REWARDS_CAMPAIGN_ALERT_OWNER: "reward-operator",
    REWARDS_CAMPAIGN_ALERT_DESTINATION: "ops@example.test",
    OPS_ALERT_WEBHOOK_URL: "https://ops.example.test/reward-alerts",
    REWARDS_CAMPAIGN_QUOTE_TTL_SECONDS: "900",
    REWARDS_CAMPAIGN_MIN_BUDGET_CENTS: "1",
    REWARDS_CAMPAIGN_MAX_BUDGET_CENTS: "1000000",
    REWARDS_CAMPAIGN_MAX_REWARD_CENTS: "1000",
    REWARDS_CAMPAIGN_MIN_DURATION_SECONDS: "3600",
    REWARDS_CAMPAIGN_MAX_DURATION_SECONDS: "7776000",
  }
}

const ACTIVE_SETTLEMENT_ASSET = {
  chainId: 84532,
  tokenAddress: "0x1000000000000000000000000000000000000001",
  treasuryAddress: "0x2000000000000000000000000000000000000002",
}

describe("reward campaign reconciler", () => {
  test("activates scheduled campaigns and terminally ends elapsed live campaigns", async () => {
    const ctx = await createRouteTestContext(env())
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "campaign-lifecycle-user")
    const now = "2026-07-10T12:00:00.000Z"
    await ctx.client.execute({
      sql: `
        INSERT INTO communities (
          community_id, creator_user_id, display_name, membership_mode,
          status, provisioning_state, transfer_state, created_at, updated_at
        ) VALUES ('cmt_campaign_lifecycle', ?1, 'Lifecycle', 'open', 'active', 'active', 'none', ?2, ?2)
      `,
      args: [session.userId, now],
    })
    for (const campaign of [
      { id: "rcp_due", post: "pst_due", status: "scheduled", starts: "2026-07-10T11:00:00.000Z", ends: "2026-07-10T13:00:00.000Z" },
      { id: "rcp_future", post: "pst_future", status: "scheduled", starts: "2026-07-10T14:00:00.000Z", ends: "2026-07-10T15:00:00.000Z" },
      { id: "rcp_elapsed", post: "pst_elapsed", status: "active", starts: "2026-07-10T09:00:00.000Z", ends: "2026-07-10T11:00:00.000Z" },
      { id: "rcp_paused_elapsed", post: "pst_paused_elapsed", status: "paused", starts: "2026-07-10T09:00:00.000Z", ends: "2026-07-10T11:00:00.000Z" },
    ]) {
      await ctx.client.execute({
        sql: `
          INSERT INTO reward_campaigns (
            reward_campaign_id, rewarder_user_id, creation_idempotency_key,
            community_id, post_id, song_artifact_bundle_id, song_owner_user_id,
            status, eligible_activity, min_score_bps, daily_reward_cents,
            milestone_7_cents, milestone_30_cents, reward_period_cap_cents,
            budget_cents, funded_cents, terms_hash, starts_at, ends_at,
            created_at, updated_at
          ) VALUES (?1, ?2, ?1, 'cmt_campaign_lifecycle', ?3, ?4, ?2,
            ?5, 'karaoke', 7000, 40, 0, 0, 40, 100, 100, ?1, ?6, ?7, ?8, ?8)
        `,
        args: [campaign.id, session.userId, campaign.post, `sab_${campaign.post}`, campaign.status, campaign.starts, campaign.ends, now],
      })
    }

    expect(await advanceRewardCampaignLifecycle({ client: ctx.client, now, postgres: false, activeSettlementAsset: ACTIVE_SETTLEMENT_ASSET })).toEqual({
      activated_campaigns: 1,
      canceled_draft_campaigns: 0,
      canceled_retired_funding_campaigns: 0,
      audited_retired_funding_effects: 0,
      retirement_policy_anomalies: 0,
      ended_campaigns: 2,
    })
    const rows = await ctx.client.execute(`
      SELECT reward_campaign_id, status, activated_at, ended_at
      FROM reward_campaigns
      WHERE community_id = 'cmt_campaign_lifecycle'
      ORDER BY reward_campaign_id
    `)
    expect(rows.rows).toEqual([
      { reward_campaign_id: "rcp_due", status: "active", activated_at: now, ended_at: null },
      { reward_campaign_id: "rcp_elapsed", status: "ended", activated_at: null, ended_at: now },
      { reward_campaign_id: "rcp_future", status: "scheduled", activated_at: null, ended_at: null },
      { reward_campaign_id: "rcp_paused_elapsed", status: "ended", activated_at: null, ended_at: now },
    ])
  })

  test("expires untouched drafts after 24 hours and releases only their pool slots", async () => {
    const ctx = await createRouteTestContext(env())
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "campaign-draft-expiry-user")
    const now = "2026-07-10T12:00:00.000Z"
    await ctx.client.execute({
      sql: `
        INSERT INTO communities (
          community_id, creator_user_id, display_name, membership_mode,
          status, provisioning_state, transfer_state, created_at, updated_at
        ) VALUES ('cmt_campaign_draft_expiry', ?1, 'Draft expiry', 'open', 'active', 'active', 'none', ?2, ?2)
      `,
      args: [session.userId, now],
    })
    for (const campaign of [
      { id: "rcp_stale_draft", post: "pst_stale_draft", created: "2026-07-09T12:00:00.000Z" },
      { id: "rcp_recent_draft", post: "pst_recent_draft", created: "2026-07-09T12:00:00.001Z" },
      { id: "rcp_stale_with_quote", post: "pst_stale_with_quote", created: "2026-07-09T11:00:00.000Z" },
    ]) {
      await ctx.client.execute({
        sql: `
          INSERT INTO reward_campaigns (
            reward_campaign_id, rewarder_user_id, creation_idempotency_key,
            community_id, post_id, song_artifact_bundle_id, song_owner_user_id,
            status, eligible_activity, min_score_bps, daily_reward_cents,
            milestone_7_cents, milestone_30_cents, reward_period_cap_cents,
            budget_cents, funded_cents, terms_hash, starts_at, ends_at,
            created_at, updated_at
          ) VALUES (?1, ?2, ?1, 'cmt_campaign_draft_expiry', ?3, ?4, ?2,
            'draft', 'study', 7000, 40, 0, 0, 40, 100, 0, ?1,
            '2026-07-10T13:00:00.000Z', '2026-07-12T13:00:00.000Z', ?5, ?5)
        `,
        args: [campaign.id, session.userId, campaign.post, `sab_${campaign.post}`, campaign.created],
      })
      await ctx.client.execute({
        sql: `
          INSERT INTO reward_song_pools (
            community_id, post_id, reward_campaign_id, created_at, updated_at
          ) VALUES ('cmt_campaign_draft_expiry', ?1, ?2, ?3, ?3)
        `,
        args: [campaign.post, campaign.id, campaign.created],
      })
    }
    await ctx.client.execute({
      sql: `
        INSERT INTO reward_campaign_funding_effects (
          reward_campaign_funding_effect_id, reward_campaign_id, funder_user_id,
          idempotency_key, chain_id, token_address, expected_amount_cents,
          expected_amount_atomic, sender_address, treasury_address, status,
          expires_at, created_at, updated_at
        ) VALUES (
          'rcf_stale_with_quote', 'rcp_stale_with_quote', ?1, 'stale-with-quote',
          84532, '0x1000000000000000000000000000000000000001', 100, '1000000',
          '0x3000000000000000000000000000000000000003',
          '0x2000000000000000000000000000000000000002', 'quoted',
          '2026-07-09T11:15:00.000Z', '2026-07-09T11:00:00.000Z', '2026-07-09T11:00:00.000Z'
        )
      `,
      args: [session.userId],
    })

    expect(await advanceRewardCampaignLifecycle({ client: ctx.client, now, postgres: false, activeSettlementAsset: ACTIVE_SETTLEMENT_ASSET })).toEqual({
      activated_campaigns: 0,
      canceled_draft_campaigns: 2,
      canceled_retired_funding_campaigns: 0,
      audited_retired_funding_effects: 0,
      retirement_policy_anomalies: 0,
      ended_campaigns: 0,
    })
    const campaigns = await ctx.client.execute(`
      SELECT reward_campaign_id, status, canceled_at
      FROM reward_campaigns
      WHERE community_id = 'cmt_campaign_draft_expiry'
      ORDER BY reward_campaign_id
    `)
    expect(campaigns.rows).toEqual([
      { reward_campaign_id: "rcp_recent_draft", status: "draft", canceled_at: null },
      { reward_campaign_id: "rcp_stale_draft", status: "canceled", canceled_at: now },
      { reward_campaign_id: "rcp_stale_with_quote", status: "canceled", canceled_at: now },
    ])
    const pools = await ctx.client.execute(`
      SELECT reward_campaign_id
      FROM reward_song_pools
      WHERE community_id = 'cmt_campaign_draft_expiry'
      ORDER BY reward_campaign_id
    `)
    expect(pools.rows).toEqual([
      { reward_campaign_id: "rcp_recent_draft" },
    ])
  })

  test("cancels only fully unclaimed pre-cutoff quotes covered by an explicit asset retirement", async () => {
    const ctx = await createRouteTestContext(env())
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "retired-funding-lifecycle-user")
    const now = "2026-08-06T12:00:00.000Z"
    const retiredToken = "0x036cbd53842c5426634e7929541ec2318f3dcf7e"
    const retiredTreasury = "0xc74e72ce521674bcaea66c99874fe9d5984e12be"
    await ctx.client.execute({
      sql: `
        INSERT INTO communities (
          community_id, creator_user_id, display_name, membership_mode,
          status, provisioning_state, transfer_state, created_at, updated_at
        ) VALUES ('cmt_retired_funding', ?1, 'Retired funding', 'open', 'active', 'active', 'none', ?2, ?2)
      `,
      args: [session.userId, now],
    })
    for (const id of ["eligible", "claimed", "current_chain", "wrong_treasury", "post_cutoff"]) {
      await ctx.client.execute({
        sql: `
          INSERT INTO reward_campaigns (
            reward_campaign_id, rewarder_user_id, creation_idempotency_key,
            community_id, post_id, song_artifact_bundle_id, song_owner_user_id,
            status, eligible_activity, min_score_bps, daily_reward_cents,
            milestone_7_cents, milestone_30_cents, reward_period_cap_cents,
            budget_cents, funded_cents, terms_hash, starts_at, ends_at,
            created_at, updated_at
          ) VALUES (?1, ?2, ?1, 'cmt_retired_funding', ?3, ?4, ?2,
            'funding_quoted', 'study', 7000, 40, 0, 0, 40, 1000, 0, ?1,
            '2026-08-07T00:00:00.000Z', '2026-08-14T00:00:00.000Z',
            '2026-07-29T00:00:00.000Z', '2026-07-29T00:00:00.000Z')
        `,
        args: [`rcp_retired_${id}`, session.userId, `pst_retired_${id}`, `sab_retired_${id}`],
      })
      await ctx.client.execute({
        sql: `
          INSERT INTO reward_song_pools (
            community_id, post_id, reward_campaign_id, created_at, updated_at
          ) VALUES ('cmt_retired_funding', ?1, ?2, '2026-07-29T00:00:00.000Z', '2026-07-29T00:00:00.000Z')
        `,
        args: [`pst_retired_${id}`, `rcp_retired_${id}`],
      })
    }
    for (const suffix of ["a", "b"]) {
      await ctx.client.execute({
        sql: `
          INSERT INTO reward_campaign_funding_effects (
            reward_campaign_funding_effect_id, reward_campaign_id, funder_user_id,
            idempotency_key, chain_id, token_address, expected_amount_cents,
            expected_amount_atomic, sender_address, treasury_address, status,
            expires_at, created_at, updated_at
          ) VALUES (?1, 'rcp_retired_eligible', ?2, ?1, 84532, ?3, 500, '5000000',
            '0x3000000000000000000000000000000000000003', ?4, 'quoted',
            '2026-07-30T12:00:00.000Z', '2026-07-29T12:00:00.000Z', '2026-07-29T12:00:00.000Z')
        `,
        args: [`rcf_retired_eligible_${suffix}`, session.userId, retiredToken, retiredTreasury],
      })
    }
    for (const effect of [
      { id: "claimed", chain: 84532, treasury: retiredTreasury, created: "2026-07-29T12:00:00.000Z", txHash: `0x${"1".repeat(64)}` },
      { id: "current_chain", chain: 8453, treasury: "0xe2d03cb0678449e0cc1f1ed33e5c46102ec5ab86", created: "2026-07-29T12:00:00.000Z", txHash: null },
      { id: "wrong_treasury", chain: 84532, treasury: "0x2000000000000000000000000000000000000002", created: "2026-07-29T12:00:00.000Z", txHash: null },
      { id: "post_cutoff", chain: 84532, treasury: retiredTreasury, created: "2026-08-01T12:00:00.000Z", txHash: null },
    ]) {
      await ctx.client.execute({
        sql: `
          INSERT INTO reward_campaign_funding_effects (
            reward_campaign_funding_effect_id, reward_campaign_id, funder_user_id,
            idempotency_key, chain_id, token_address, expected_amount_cents,
            expected_amount_atomic, sender_address, treasury_address, status,
            tx_hash, expires_at, created_at, updated_at
          ) VALUES (?1, ?2, ?3, ?1, ?4, ?5, 1000, '10000000',
            '0x3000000000000000000000000000000000000003', ?6, 'quoted', ?7,
            '2026-08-02T12:00:00.000Z', ?8, ?8)
        `,
        args: [
          `rcf_retired_${effect.id}`,
          `rcp_retired_${effect.id}`,
          session.userId,
          effect.chain,
          retiredToken,
          effect.treasury,
          effect.txHash,
          effect.created,
        ],
      })
    }

    expect(await advanceRewardCampaignLifecycle({ client: ctx.client, now, postgres: false, activeSettlementAsset: ACTIVE_SETTLEMENT_ASSET })).toEqual({
      activated_campaigns: 0,
      canceled_draft_campaigns: 0,
      canceled_retired_funding_campaigns: 1,
      audited_retired_funding_effects: 2,
      retirement_policy_anomalies: 1,
      ended_campaigns: 0,
    })
    const state = await ctx.client.execute(`
      SELECT campaign.reward_campaign_id, campaign.status,
        EXISTS (
          SELECT 1 FROM reward_song_pools AS pool
          WHERE pool.reward_campaign_id = campaign.reward_campaign_id
        ) AS holds_pool
      FROM reward_campaigns AS campaign
      WHERE campaign.community_id = 'cmt_retired_funding'
      ORDER BY campaign.reward_campaign_id
    `)
    expect(state.rows).toEqual([
      { reward_campaign_id: "rcp_retired_claimed", status: "funding_quoted", holds_pool: 1 },
      { reward_campaign_id: "rcp_retired_current_chain", status: "funding_quoted", holds_pool: 1 },
      { reward_campaign_id: "rcp_retired_eligible", status: "canceled", holds_pool: 0 },
      { reward_campaign_id: "rcp_retired_post_cutoff", status: "funding_quoted", holds_pool: 1 },
      { reward_campaign_id: "rcp_retired_wrong_treasury", status: "funding_quoted", holds_pool: 1 },
    ])
    const audits = await ctx.client.execute(`
      SELECT reward_campaign_funding_effect_id, reward_campaign_id, funder_user_id,
        sender_address, expected_amount_cents, expected_amount_atomic, chain_id,
        token_address, treasury_address, quote_created_at, quote_expires_at, canceled_at
      FROM reward_retired_funding_cancellations
      ORDER BY reward_campaign_funding_effect_id
    `)
    expect(audits.rows).toEqual([
      {
        reward_campaign_funding_effect_id: "rcf_retired_eligible_a",
        reward_campaign_id: "rcp_retired_eligible",
        funder_user_id: session.userId,
        sender_address: "0x3000000000000000000000000000000000000003",
        expected_amount_cents: 500,
        expected_amount_atomic: "5000000",
        chain_id: 84532,
        token_address: retiredToken,
        treasury_address: retiredTreasury,
        quote_created_at: "2026-07-29T12:00:00.000Z",
        quote_expires_at: "2026-07-30T12:00:00.000Z",
        canceled_at: now,
      },
      {
        reward_campaign_funding_effect_id: "rcf_retired_eligible_b",
        reward_campaign_id: "rcp_retired_eligible",
        funder_user_id: session.userId,
        sender_address: "0x3000000000000000000000000000000000000003",
        expected_amount_cents: 500,
        expected_amount_atomic: "5000000",
        chain_id: 84532,
        token_address: retiredToken,
        treasury_address: retiredTreasury,
        quote_created_at: "2026-07-29T12:00:00.000Z",
        quote_expires_at: "2026-07-30T12:00:00.000Z",
        canceled_at: now,
      },
    ])
    expect((await ctx.client.execute(`
      SELECT anomaly_kind, effect_created_at, quote_cutoff_at, detected_at
      FROM reward_funding_retirement_anomalies
    `)).rows).toEqual([{
      anomaly_kind: "quote_created_after_cutoff",
      effect_created_at: "2026-08-01T12:00:00.000Z",
      quote_cutoff_at: "2026-07-30T21:17:40.000Z",
      detected_at: now,
    }])

    expect(await advanceRewardCampaignLifecycle({ client: ctx.client, now, postgres: false, activeSettlementAsset: ACTIVE_SETTLEMENT_ASSET })).toMatchObject({
      canceled_retired_funding_campaigns: 0,
      audited_retired_funding_effects: 0,
      retirement_policy_anomalies: 0,
    })
  })

  test("fails closed when a retirement policy matches the active settlement asset", async () => {
    const ctx = await createRouteTestContext(env())
    cleanup = ctx.cleanup
    await ctx.client.execute({
      sql: `
        INSERT INTO reward_funding_asset_retirements (
          reward_funding_asset_retirement_id, chain_id, token_address,
          treasury_address, quote_cutoff_at, disposition, authorized_by,
          authorization_reference, authorized_at
        ) VALUES (
          'rfr_active_asset_test', ?1, ?2, ?3, '2026-08-06T00:00:00.000Z',
          'non_material_test_asset', 'test_owner', 'test-authorization',
          '2026-08-06T00:00:00.000Z'
        )
      `,
      args: [
        ACTIVE_SETTLEMENT_ASSET.chainId,
        ACTIVE_SETTLEMENT_ASSET.tokenAddress,
        ACTIVE_SETTLEMENT_ASSET.treasuryAddress,
      ],
    })

    await expect(advanceRewardCampaignLifecycle({
      client: ctx.client,
      now: "2026-08-06T12:00:00.000Z",
      postgres: false,
      activeSettlementAsset: ACTIVE_SETTLEMENT_ASSET,
    })).rejects.toThrow("Active reward settlement asset is declared retired: rfr_active_asset_test")
  })

  test("uses an exact seven-day qualified-at grace boundary across the UTC day", () => {
    for (const qualifiedAt of ["2026-07-10T00:01:00.000Z", "2026-07-10T23:59:00.000Z"]) {
      const expiresAt = rewardQualificationExpiresAt(qualifiedAt)
      expect(Date.parse(expiresAt) - Date.parse(qualifiedAt)).toBe(7 * 86_400_000)
      expect(isRewardQualificationExpired(qualifiedAt, new Date(Date.parse(expiresAt) - 1).toISOString())).toBe(false)
      expect(isRewardQualificationExpired(qualifiedAt, expiresAt)).toBe(true)
    }
  })

  test("shows an unverified qualification as conditional value and converts it after verification", async () => {
    const ctx = await createRouteTestContext(env())
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "campaign-pending-verification-user")
    const now = "2026-07-10T12:00:00.000Z"
    const candidate = {
      eventId: "rqe_pending_verification",
      userId: session.userId,
      communityId: "cmt_pending_verification",
      postId: "pst_pending_verification",
      artifactBundleId: "sab_pending_verification",
      activity: "karaoke" as const,
      qualifiedAt: now,
      periodKey: "2026-07-10",
      policyVersion: "policy-v1",
      finalScoreBps: 8600,
    }
    await ctx.client.execute({
      sql: `
        INSERT INTO communities (
          community_id, creator_user_id, display_name, membership_mode,
          status, provisioning_state, transfer_state, created_at, updated_at
        ) VALUES (?1, ?2, 'Pending rewards', 'open', 'active', 'active', 'none', ?3, ?3)
      `,
      args: [candidate.communityId, session.userId, now],
    })
    await ctx.client.execute({
      sql: `
        INSERT INTO reward_campaigns (
          reward_campaign_id, rewarder_user_id, creation_idempotency_key,
          community_id, post_id, song_artifact_bundle_id, song_owner_user_id,
          status, eligible_activity, min_score_bps, daily_reward_cents,
          default_amount_cents, max_claim_cents, payout_tiers_json,
          milestone_7_cents, milestone_30_cents, reward_period_cap_cents,
          budget_cents, funded_cents, reward_identity_provider, terms_hash, starts_at, ends_at,
          activated_at, created_at, updated_at
        ) VALUES (
          'rcp_pending_verification', ?1, 'pending-verification-create', ?2, ?3, ?4,
          ?1, 'active', 'karaoke', 7000, 80, 80, 80,
          '[]',
          0, 0, 80, 1000, 1000, 'very',
          'pending-verification-terms', '2026-07-01T00:00:00.000Z',
          '2026-07-31T00:00:00.000Z', ?5, ?5, ?5
        )
      `,
      args: [session.userId, candidate.communityId, candidate.postId, candidate.artifactBundleId, now],
    })
    await ctx.client.execute({
      sql: `
        INSERT INTO reward_campaign_funding_effects (
          reward_campaign_funding_effect_id, reward_campaign_id, funder_user_id,
          idempotency_key, chain_id, token_address, expected_amount_cents,
          expected_amount_atomic, received_amount_atomic, sender_address,
          treasury_address, tx_hash, status, expires_at, confirmed_at,
          created_at, updated_at
        ) VALUES (
          'rcf_pending_verification', 'rcp_pending_verification', ?1,
          'pending-verification-funding', 84532,
          '0x1000000000000000000000000000000000000001',
          1000, '10000000', '10000000',
          '0x3000000000000000000000000000000000000003',
          '0x2000000000000000000000000000000000000002',
          '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          'confirmed', '2026-07-10T13:00:00.000Z', ?2, ?2, ?2
        )
      `,
      args: [session.userId, now],
    })
    await ctx.client.execute({
      sql: `
        INSERT INTO reward_qualification_events (
          reward_qualification_event_id, community_id, shard_sequence, user_id,
          post_id, song_artifact_bundle_id, activity, qualified_at,
          reward_period_key, qualification_policy_version, evidence_summary_json,
          ingested_at
        ) VALUES (?1, ?2, 1, ?3, ?4, ?5, 'karaoke', ?6, ?7, ?8, ?9, ?6)
      `,
      args: [
        candidate.eventId, candidate.communityId, candidate.userId, candidate.postId,
        candidate.artifactBundleId, candidate.qualifiedAt, candidate.periodKey,
        candidate.policyVersion, JSON.stringify({ final_score_bps: candidate.finalScoreBps }),
      ],
    })
    expect(await creditRewardCampaignQualification({ env: ctx.env, client: ctx.client, candidate, now })).toEqual({
      result: "identity",
      amountCents: 0,
    })
    const beforeVerification = await getRewardsSummaryForUser({
      env: { ...ctx.env, REWARDS_READS_ENABLED: "true" },
      userId: session.userId,
      client: ctx.client,
      now,
    })
    expect(beforeVerification).toMatchObject({
      balance_cents: 0,
      pending_verification: {
        count: 1,
        conditional_cents: 80,
        provider_requirements: [{
          provider: "very",
          count: 1,
          conditional_cents: 80,
        }],
      },
      recent_qualifications: [{
        reward_qualification_event_id: candidate.eventId,
        reward_campaign_id: "rcp_pending_verification",
        post_id: candidate.postId,
        qualification_basis: "karaoke",
        amount_cents: 80,
        status: "pending_verification",
        outcome_reason: null,
      }],
      cashout: { eligible: false, verification_state: "unverified", verification_provider: null },
    })

    await ctx.client.execute({
      sql: "UPDATE users SET verification_capabilities_json = ?2 WHERE user_id = ?1",
      args: [session.userId, JSON.stringify({
        unique_human: {
          state: "verified", provider: "very", proof_type: "unique_human",
          mechanism: "session_complete", verified_at: Math.floor(Date.parse(now) / 1000),
        },
      })],
    })
    await ctx.client.execute({
      sql: `
        INSERT INTO user_attestations (
          user_attestation_id, user_id, source_verification_session_id, provider, attestation_type,
          capability_key, status, value_json, verified_at, expires_at, revoked_at, created_at, updated_at
        ) VALUES ('att_pending_verification_unique_human', ?1, NULL, 'very', 'unique_human',
          'unique_human', 'accepted', ?2, ?3, NULL, NULL, ?3, ?3)
      `,
      args: [session.userId, JSON.stringify({ state: "verified" }), now],
    })
    await ctx.client.execute({
      sql: `
        INSERT INTO identity_nullifiers (
          identity_nullifier_id, user_id, provider, mechanism, nullifier_hash,
          source_user_attestation_id, status, first_seen_at, created_at, updated_at
        ) VALUES ('idn_pending_verification', ?1, 'very', 'zk-nullifier',
          'pending-verification-human', 'att_pending_verification_unique_human', 'active', ?2, ?2, ?2)
      `,
      args: [session.userId, now],
    })
    await ctx.client.execute({
      sql: `INSERT INTO reward_identity_bindings (
        reward_identity_binding_id, user_id, identity_nullifier_id, status,
        selected_at, created_at, updated_at
      ) VALUES ('rib_pending_verification', ?1, 'idn_pending_verification',
        'active', ?2, ?2, ?2)`,
      args: [session.userId, now],
    })
    await ctx.client.execute({
      sql: `INSERT INTO verification_sessions (
        verification_session_id, user_id, provider, session_kind,
        requested_capabilities_json, status, started_at, completed_at,
        created_at, updated_at
      ) VALUES ('vss_pending_verification', ?1, 'very', 'identity',
        '["nationality"]', 'verified', ?2, ?2, ?2, ?2)`,
      args: [session.userId, now],
    })
    await ctx.client.execute({
      sql: `INSERT INTO user_attestations (
        user_attestation_id, user_id, source_verification_session_id, provider,
        attestation_type, capability_key, value_json, status, verified_at,
        created_at, updated_at,
        source_identity_nullifier_id
      ) VALUES ('att_pending_verification', ?1, 'vss_pending_verification',
        'very', 'nationality', 'nationality', ?2, 'accepted', ?3, ?3, ?3,
        'idn_pending_verification')`,
      args: [session.userId, JSON.stringify({ nationality: "VNM" }), now],
    })
    expect(await creditRewardCampaignQualification({
      // The campaign term must win over the legacy environment default.
      env: { ...ctx.env, REWARDS_IDENTITY_PROVIDER: "self" },
      client: ctx.client,
      candidate,
      now,
    })).toEqual({
      result: "credited",
      amountCents: 80,
    })
    const afterVerification = await getRewardsSummaryForUser({
      env: { ...ctx.env, REWARDS_READS_ENABLED: "true" },
      userId: session.userId,
      client: ctx.client,
      now,
    })
    expect(afterVerification).toMatchObject({
      balance_cents: 80,
      pending_verification: { count: 0, conditional_cents: 0 },
      recent_qualifications: [{
        reward_qualification_event_id: candidate.eventId,
        amount_cents: 80,
        status: "credited",
        outcome_reason: null,
        credited_reward_event_id: expect.stringMatching(/^rew_/),
      }],
      cashout: { eligible: false, verification_state: "verified", verification_provider: "very" },
    })
    const projection = await ctx.client.execute({
      sql: `
        SELECT status, conditional_amount_cents, credited_reward_event_id
        FROM reward_pending_qualifications
        WHERE reward_qualification_event_id = ?1
      `,
      args: [candidate.eventId],
    })
    expect(projection.rows).toEqual([expect.objectContaining({
      status: "credited",
      conditional_amount_cents: 80,
      credited_reward_event_id: expect.stringMatching(/^rew_/),
    })])
    const accounting = await ctx.client.execute({
      sql: `SELECT
        (SELECT resolved_amount_cents FROM reward_nationality_decisions
          WHERE reward_qualification_event_id = ?1) AS resolved_amount_cents,
        (SELECT result_key FROM reward_nationality_decisions
          WHERE reward_qualification_event_id = ?1) AS result_key,
        (SELECT COALESCE(SUM(amount_cents), 0)
          FROM reward_pending_qualification_funding_exposures) AS pending_exposure_cents,
        (SELECT COALESCE(SUM(amount_cents), 0)
          FROM reward_campaign_reservation_funding_allocations) AS allocated_cents`,
      args: [candidate.eventId],
    })
    expect(accounting.rows[0]).toMatchObject({
      resolved_amount_cents: null,
      result_key: null,
      pending_exposure_cents: 0,
      allocated_cents: 80,
    })

    const lowScoreCandidate = {
      ...candidate,
      eventId: "rqe_terminal_score",
      finalScoreBps: 6_500,
    }
    await ctx.client.execute({
      sql: `
        INSERT INTO reward_qualification_events (
          reward_qualification_event_id, community_id, shard_sequence, user_id,
          post_id, song_artifact_bundle_id, activity, qualified_at,
          reward_period_key, qualification_policy_version, evidence_summary_json,
          ingested_at
        ) VALUES (?1, ?2, 2, ?3, ?4, ?5, 'karaoke', ?6, ?7, ?8, ?9, ?6)
      `,
      args: [
        lowScoreCandidate.eventId, lowScoreCandidate.communityId, lowScoreCandidate.userId,
        lowScoreCandidate.postId, lowScoreCandidate.artifactBundleId, lowScoreCandidate.qualifiedAt,
        lowScoreCandidate.periodKey, lowScoreCandidate.policyVersion,
        JSON.stringify({ final_score_bps: lowScoreCandidate.finalScoreBps }),
      ],
    })
    expect(await creditRewardCampaignQualification({
      env: ctx.env,
      client: ctx.client,
      candidate: lowScoreCandidate,
      now,
    })).toEqual({ result: "score", amountCents: 0 })
    const terminalSummary = await getRewardsSummaryForUser({
      env: { ...ctx.env, REWARDS_READS_ENABLED: "true" },
      userId: session.userId,
      client: ctx.client,
      now,
    })
    expect(terminalSummary.recent_qualifications.find((item) =>
      item.reward_qualification_event_id === lowScoreCandidate.eventId
    )).toMatchObject({
      reward_qualification_event_id: lowScoreCandidate.eventId,
      status: "unavailable",
      outcome_reason: "score",
    })
  })

  test("fails closed unless campaign flags and alert ownership are configured", async () => {
    let listed = false
    const summary = await reconcileRewardCampaigns({
      env: { ...env(), REWARDS_CAMPAIGNS_ENABLED: "false" } as never,
      communityRepository: {
        listActiveCommunities: async () => {
          listed = true
          return []
        },
      } as never,
      controlPlaneClient: {} as never,
    })
    expect(summary.enabled).toBe(false)
    expect(listed).toBe(false)

    const withoutAlertOwnership = await reconcileRewardCampaigns({
      env: {
        ...env(),
        REWARDS_CAMPAIGN_ALERT_OWNER: undefined,
        REWARDS_CAMPAIGN_ALERT_DESTINATION: undefined,
      } as never,
      communityRepository: {
        listActiveCommunities: async () => {
          listed = true
          return []
        },
      } as never,
      controlPlaneClient: {} as never,
    })
    expect(withoutAlertOwnership.enabled).toBe(false)
    expect(listed).toBe(false)

    const withoutDeliverySink = await reconcileRewardCampaigns({
      env: { ...env(), OPS_ALERT_WEBHOOK_URL: undefined } as never,
      communityRepository: {
        listActiveCommunities: async () => {
          listed = true
          return []
        },
      } as never,
      controlPlaneClient: {} as never,
    })
    expect(withoutDeliverySink.enabled).toBe(false)
    expect(listed).toBe(false)

    const incompleteHint = await reconcileRewardCampaigns({
      env: env() as never,
      communityRepository: {
        listActiveCommunities: async () => {
          listed = true
          return []
        },
      } as never,
      controlPlaneClient: {} as never,
      communityIds: ["cmt_hint"],
      mode: "hint",
    })
    expect(incompleteHint.enabled).toBe(true)
    expect(listed).toBe(false)

  })

  test("checkpoints qualifications and atomically credits one identity/song/period reward", async () => {
    const ctx = await createRouteTestContext(env())
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "campaign-reconciler-user")
    const unverifiedSession = await exchangeJwt(ctx.env, "campaign-reconciler-unverified-user")
    const now = "2026-07-10T12:00:00.000Z"
    const reconcileNow = "2026-07-12T12:00:00.000Z"
    await ctx.client.execute({
      sql: `
        INSERT INTO communities (
          community_id, creator_user_id, display_name, membership_mode,
          status, provisioning_state, transfer_state, created_at, updated_at
        ) VALUES ('cmt_campaign_reconcile', ?1, 'Campaign', 'open', 'active', 'active', 'none', ?2, ?2)
      `,
      args: [session.userId, now],
    })
    await ctx.client.execute({
      sql: "UPDATE users SET verification_capabilities_json = ?2 WHERE user_id = ?1",
      args: [session.userId, JSON.stringify({
        unique_human: {
          state: "verified", provider: "self", proof_type: "unique_human",
          mechanism: "session_complete", verified_at: Math.floor(Date.parse(now) / 1000),
        },
      })],
    })
    await ctx.client.execute({
      sql: `
        INSERT INTO user_attestations (
          user_attestation_id, user_id, source_verification_session_id, provider, attestation_type,
          capability_key, status, value_json, verified_at, expires_at, revoked_at, created_at, updated_at
        ) VALUES ('att_campaign_reconcile', ?1, NULL, 'self', 'unique_human', 'unique_human',
          'accepted', ?2, ?3, NULL, NULL, ?3, ?3)
      `,
      args: [session.userId, JSON.stringify({ state: "verified" }), now],
    })
    await ctx.client.execute({
      sql: `
        INSERT INTO identity_nullifiers (
          identity_nullifier_id, user_id, provider, mechanism, nullifier_hash,
          source_user_attestation_id, status, first_seen_at, created_at, updated_at
        ) VALUES ('idn_campaign', ?1, 'self', 'zk-nullifier', 'campaign-human', 'att_campaign_reconcile',
          'active', ?2, ?2, ?2)
      `,
      args: [session.userId, now],
    })
    await ctx.client.execute({
      sql: `
        INSERT INTO reward_campaigns (
          reward_campaign_id, rewarder_user_id, creation_idempotency_key,
          community_id, post_id, song_artifact_bundle_id, song_owner_user_id,
          status, eligible_activity, min_score_bps, daily_reward_cents, milestone_7_cents,
          milestone_30_cents, reward_period_cap_cents, budget_cents, funded_cents,
          terms_hash, starts_at, ends_at, activated_at, created_at, updated_at
        ) VALUES (
          'rcp_reconcile', ?1, 'reconcile-create', 'cmt_campaign_reconcile',
          'pst_campaign_reconcile', 'sab_campaign_reconcile', ?1, 'active', 'either',
          8500, 40, 0, 0, 40, 120, 120, 'terms', '2026-07-01T00:00:00.000Z',
          '2026-07-31T00:00:00.000Z', ?2, ?2, ?2
        )
      `,
      args: [session.userId, now],
    })
    await ctx.client.execute({
      sql: `
        INSERT INTO reward_campaign_funding_effects (
          reward_campaign_funding_effect_id, reward_campaign_id, funder_user_id,
          idempotency_key, chain_id, token_address, expected_amount_cents,
          expected_amount_atomic, received_amount_atomic, sender_address,
          treasury_address, tx_hash, status, expires_at, confirmed_at, created_at, updated_at
        ) VALUES (
          'rcf_reconcile', 'rcp_reconcile', ?1, 'reconcile-funding', 84532,
          '0x1000000000000000000000000000000000000001', 120, '1200000', '1200000',
          '0x3000000000000000000000000000000000000003',
          '0x2000000000000000000000000000000000000002',
          '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          'confirmed', '2026-07-10T13:00:00.000Z', ?2, ?2, ?2
        )
      `,
      args: [session.userId, now],
    })

    const repository = getCommunityRepository(ctx.env)
    const jobRepository = Object.assign(Object.create(repository) as typeof repository, {
      listActiveCommunities: async () => [{ community_id: "cmt_campaign_reconcile" }],
    })
    const db = await openCommunityWriteClient(ctx.env, repository, "cmt_campaign_reconcile")
    try {
      await db.client.execute({
        sql: `
          INSERT INTO communities (
            community_id, display_name, status, artist_governance_state, membership_mode,
            default_age_gate_policy, donation_policy_mode, donation_partner_status,
            governance_mode, created_by_user_id, created_at, updated_at
          ) VALUES (
            'cmt_campaign_reconcile', 'Campaign', 'active', 'fan_run', 'open',
            'none', 'none', 'unconfigured', 'centralized', ?1, ?2, ?2
          )
        `,
        args: [session.userId, now],
      })
      await db.client.execute({
        sql: `
          INSERT INTO posts (
            post_id, community_id, author_user_id, identity_mode, post_type, status,
            song_mode, title, lyrics, source_language, rights_basis, analysis_state,
            content_safety_state, age_gate_policy, created_at, updated_at, access_mode,
            visibility, song_title, song_cover_art_ref, song_artifact_bundle_id
          ) VALUES (
            'pst_campaign_reconcile', 'cmt_campaign_reconcile', ?1, 'public', 'song',
            'published', 'original', 'Song', 'Lyrics', 'en', 'original', 'allow',
            'safe', 'none', ?2, ?2, 'public', 'public', 'Song', 'ipfs://cover',
            'sab_campaign_reconcile'
          )
        `,
        args: [session.userId, now],
      })
      for (const [eventId, activity] of [["rqo_study", "study"], ["rqo_karaoke", "karaoke"]] as const) {
        await db.client.execute({
          sql: `
            INSERT INTO reward_qualification_outbox (
              event_id, user_id, community_id, post_id, song_artifact_bundle_id,
              activity, qualified_at, reward_period_key, qualification_policy_version,
              evidence_summary_json, created_at
            ) VALUES (?1, ?2, 'cmt_campaign_reconcile', 'pst_campaign_reconcile',
              'sab_campaign_reconcile', ?3, ?4, ?6, 'policy-v1', ?5, ?4)
          `,
          args: [
            eventId,
            session.userId,
            activity,
            activity === "karaoke" ? reconcileNow : now,
            JSON.stringify(activity === "karaoke" ? { final_score_bps: 8400 } : {}),
            activity === "karaoke" ? "2026-07-12" : "2026-07-10",
          ],
        })
      }

      // The first page contains an unverified candidate that remains eligible and a
      // verified candidate that disappears after credit. A third candidate must
      // still be reached on page two; OFFSET pagination skipped it when page one
      // shrank the eligible result set.
      await ctx.client.execute({
        sql: `
          INSERT INTO reward_qualification_events (
            reward_qualification_event_id, community_id, shard_sequence, user_id,
            post_id, song_artifact_bundle_id, activity, qualified_at,
            reward_period_key, qualification_policy_version, evidence_summary_json,
            ingested_at
          ) VALUES
            ('rqe_exactly_expired', 'cmt_campaign_reconcile', 99, ?1,
              'pst_campaign_reconcile', 'sab_campaign_reconcile', 'study',
              '2026-07-05T12:00:00.000Z', '2026-07-05', 'policy-v1', '{}', ?3),
            ('rqe_unverified_cursor', 'cmt_campaign_reconcile', 100, ?1,
              'pst_campaign_reconcile', 'sab_campaign_reconcile', 'study',
              '2026-07-10T11:00:00.000Z', '2026-07-10', 'policy-v1', '{}', ?3),
            ('rqe_next_period_cursor', 'cmt_campaign_reconcile', 101, ?2,
              'pst_campaign_reconcile', 'sab_campaign_reconcile', 'study',
              '2026-07-11T12:00:00.000Z', '2026-07-11', 'policy-v1', '{}', ?3)
        `,
        args: [unverifiedSession.userId, session.userId, now],
      })

      const first = await reconcileRewardCampaigns({
        env: ctx.env,
        communityRepository: jobRepository,
        controlPlaneClient: ctx.client,
        maxCommunities: 5,
        maxCredits: 2,
        outboxBatchSize: 1,
        now: reconcileNow,
      })
      expect(first).toMatchObject({
        enabled: true,
        ingested_qualifications: 1,
        credited_events: 2,
        credited_cents: 80,
        skipped_identity: 1,
        scanned_qualifications: 3,
      })
      const effects = await ctx.client.execute(`
        SELECT r.status, r.amount_cents, r.qualification_basis, e.reward_kind,
          c.reserved_cents, c.credited_cents, c.status AS campaign_status
        FROM reward_campaign_reservations r
        JOIN reward_events e ON e.reward_event_id = r.reward_event_id
        JOIN reward_campaigns c ON c.reward_campaign_id = r.reward_campaign_id
      `)
      expect(effects.rows).toHaveLength(2)
      expect(effects.rows).toEqual(expect.arrayContaining([
        expect.objectContaining({
          status: "credited", amount_cents: 40, qualification_basis: "study",
          reward_kind: "campaign_practice_day", reserved_cents: 0,
          credited_cents: 80, campaign_status: "active",
        }),
      ]))
      const unverifiedReservations = await ctx.client.execute({
        sql: "SELECT count(*) AS count FROM reward_campaign_reservations WHERE user_id = ?1",
        args: [unverifiedSession.userId],
      })
      expect(Number(unverifiedReservations.rows[0]?.count ?? 0)).toBe(0)
      const pending = await ctx.client.execute({
        sql: `
          SELECT status, conditional_amount_cents, expires_at
          FROM reward_pending_qualifications
          WHERE user_id = ?1
        `,
        args: [unverifiedSession.userId],
      })
      expect(pending.rows).toEqual([expect.objectContaining({
        status: "pending_verification",
        conditional_amount_cents: 40,
      })])
      const pendingRewards = await getRewardsSummaryForUser({
        env: { ...ctx.env, REWARDS_READS_ENABLED: "true" },
        userId: unverifiedSession.userId,
        client: ctx.client,
        activityDate: "2026-07-10",
        now: reconcileNow,
      })
      expect(pendingRewards).toMatchObject({
        balance_cents: 0,
        pending_verification: { count: 1, conditional_cents: 40 },
        cashout: {
          eligible: false,
          verification_state: "unverified",
          verification_provider: null,
        },
      })
      let checkpoint = await ctx.client.execute("SELECT last_shard_sequence FROM reward_qualification_checkpoints")
      expect(checkpoint.rows).toEqual([{ last_shard_sequence: 1 }])
      const secondActivity = await reconcileRewardCampaigns({
        env: ctx.env,
        communityRepository: jobRepository,
        controlPlaneClient: ctx.client,
        maxCommunities: 5,
        maxCredits: 10,
        outboxBatchSize: 1,
        now: reconcileNow,
      })
      expect(secondActivity).toMatchObject({
        ingested_qualifications: 1,
        credited_events: 0,
        credited_cents: 0,
        skipped_score: 1,
      })
      checkpoint = await ctx.client.execute("SELECT last_shard_sequence FROM reward_qualification_checkpoints")
      expect(checkpoint.rows).toEqual([{ last_shard_sequence: 2 }])
      await ctx.client.execute({
        sql: `
          INSERT INTO reward_qualification_events (
            reward_qualification_event_id, community_id, shard_sequence, user_id,
            post_id, song_artifact_bundle_id, activity, qualified_at,
            reward_period_key, qualification_policy_version, evidence_summary_json,
            ingested_at
          ) VALUES (
            'rqe_exhaust_campaign', 'cmt_campaign_reconcile', 102, ?1,
            'pst_campaign_reconcile', 'sab_campaign_reconcile', 'study',
            '2026-07-12T12:00:00.000Z', '2026-07-12', 'policy-v1', '{}', ?2
          )
        `,
        args: [session.userId, now],
      })
      const replay = await reconcileRewardCampaigns({
        env: ctx.env,
        communityRepository: jobRepository,
        controlPlaneClient: ctx.client,
        maxCommunities: 5,
        maxCredits: 10,
        outboxBatchSize: 1,
        now: reconcileNow,
      })
      expect(replay).toMatchObject({ ingested_qualifications: 0, credited_events: 1, credited_cents: 40 })

      const exhausted = await reconcileRewardCampaigns({
        env: ctx.env,
        communityRepository: jobRepository,
        controlPlaneClient: ctx.client,
        maxCommunities: 5,
        maxCredits: 10,
        outboxBatchSize: 1,
        now: reconcileNow,
      })
      expect(exhausted).toMatchObject({ ingested_qualifications: 0, credited_events: 0, credited_cents: 0 })
      const exhaustedCampaign = await ctx.client.execute(
        "SELECT status, credited_cents, reserved_cents FROM reward_campaigns WHERE reward_campaign_id = 'rcp_reconcile'",
      )
      expect(exhaustedCampaign.rows).toEqual([{ status: "exhausted", credited_cents: 120, reserved_cents: 0 }])

      await db.client.execute({
        sql: `
          INSERT INTO reward_qualification_outbox (
            event_id, user_id, community_id, post_id, song_artifact_bundle_id,
            activity, qualified_at, reward_period_key, qualification_policy_version,
            evidence_summary_json, created_at
          ) VALUES
            ('rqo_hint_target', ?1, 'cmt_campaign_reconcile', 'pst_campaign_reconcile',
              'sab_campaign_reconcile', 'study', '2026-07-13T12:00:00.000Z',
              '2026-07-13', 'policy-v1', '{}', '2026-07-13T12:00:00.000Z'),
            ('rqo_hint_later', ?1, 'cmt_campaign_reconcile', 'pst_campaign_reconcile',
              'sab_campaign_reconcile', 'study', '2026-07-14T12:00:00.000Z',
              '2026-07-14', 'policy-v1', '{}', '2026-07-14T12:00:00.000Z')
        `,
        args: [session.userId],
      })
      await ctx.client.execute({
        sql: `
          INSERT INTO communities (
            community_id, creator_user_id, display_name, membership_mode,
            status, provisioning_state, transfer_state, created_at, updated_at
          ) VALUES ('cmt_untargeted_checkpoint', ?1, 'Untargeted', 'open',
            'active', 'active', 'none', ?2, ?2)
        `,
        args: [session.userId, now],
      })
      await ctx.client.execute({
        sql: `
          INSERT INTO reward_qualification_checkpoints (
            community_id, last_shard_sequence, updated_at
          ) VALUES ('cmt_untargeted_checkpoint', 77, ?1)
        `,
        args: [now],
      })
      const targeted = await reconcileRewardCampaigns({
        env: ctx.env,
        communityRepository: jobRepository,
        controlPlaneClient: ctx.client,
        communityIds: ["cmt_campaign_reconcile"],
        eventIds: ["rqo_hint_target"],
        mode: "hint",
        maxCommunities: 1,
        maxCredits: 1,
        maxScannedQualifications: 1,
        outboxBatchSize: 1,
        now: "2026-07-13T12:00:01.000Z",
      })
      expect(targeted).toMatchObject({
        activated_campaigns: 0,
        ended_campaigns: 0,
        expired_pending: 0,
        ingested_qualifications: 1,
      })
      expect(targeted.scanned_qualifications).toBeLessThanOrEqual(1)
      const targetedEvents = await ctx.client.execute({
        sql: `
          SELECT reward_qualification_event_id
          FROM reward_qualification_events
          WHERE reward_qualification_event_id IN ('rqo_hint_target', 'rqo_hint_later')
          ORDER BY reward_qualification_event_id
        `,
      })
      expect(targetedEvents.rows).toEqual([{ reward_qualification_event_id: "rqo_hint_target" }])
      const isolatedCheckpoints = await ctx.client.execute({
        sql: `
          SELECT community_id, last_shard_sequence
          FROM reward_qualification_checkpoints
          WHERE community_id IN ('cmt_campaign_reconcile', 'cmt_untargeted_checkpoint')
          ORDER BY community_id
        `,
      })
      expect(isolatedCheckpoints.rows).toEqual([
        { community_id: "cmt_campaign_reconcile", last_shard_sequence: 3 },
        { community_id: "cmt_untargeted_checkpoint", last_shard_sequence: 77 },
      ])

      await ctx.client.execute({
        sql: `
          INSERT INTO reward_song_owner_policies (
            community_id, post_id, song_owner_user_id, third_party_rewards,
            created_at, updated_at
          ) VALUES ('cmt_campaign_reconcile', 'pst_campaign_reconcile', ?1, 'blocked', ?2, ?2)
        `,
        args: [session.userId, now],
      })
      const blockedAtReservation = await creditRewardCampaignQualification({
        env: ctx.env,
        client: ctx.client,
        now,
        candidate: {
          eventId: "rqe_owner_blocked",
          userId: session.userId,
          communityId: "cmt_campaign_reconcile",
          postId: "pst_campaign_reconcile",
          artifactBundleId: "sab_campaign_reconcile",
          activity: "study",
          qualifiedAt: "2026-07-12T12:00:00.000Z",
          periodKey: "2026-07-12",
          policyVersion: "policy-v1",
        },
      })
      expect(blockedAtReservation).toEqual({ result: "owner_blocked", amountCents: 0 })
      const rewards = await getRewardsSummaryForUser({
        env: { ...ctx.env, REWARDS_READS_ENABLED: "true" },
        userId: session.userId,
        client: ctx.client,
        activityDate: "2026-07-10",
      })
      expect(rewards).toMatchObject({
        balance_cents: 120,
        today_earned_cents: 40,
      })
      expect(rewards.recent_events).toEqual(expect.arrayContaining([
          expect.objectContaining({
            reward_kind: "campaign_practice_day",
            reward_campaign_id: "rcp_reconcile",
            reward_period_key: "2026-07-12",
            qualification_basis: "study",
            amount_cents: 40,
          }),
          expect.objectContaining({
            reward_kind: "campaign_practice_day",
            reward_campaign_id: "rcp_reconcile",
            reward_period_key: "2026-07-11",
            qualification_basis: "study",
            amount_cents: 40,
          }),
          expect.objectContaining({
            reward_kind: "campaign_practice_day",
            reward_campaign_id: "rcp_reconcile",
            reward_period_key: "2026-07-10",
            qualification_basis: "study",
            amount_cents: 40,
          }),
        ]))
      const reconciliation = await ctx.client.execute("SELECT counters_match FROM reward_campaign_accounting_reconciliation")
      expect(reconciliation.rows[0]?.counters_match).toBe(1)
    } finally {
      await db.close()
      await repository.close?.()
    }
  })
})
