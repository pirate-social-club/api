import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { app } from "../../src/index"
import {
  reconcileSubmittedRewardPayouts,
  setRewardSettlementConfirmPollPlanForTests,
  setRewardSettlementCoordinatorForTests,
} from "../../src/lib/rewards/reward-cashout-service"
import { setPrivyAccessProofVerifierForTests } from "../../src/lib/auth/privy-auth"
import { setBookingPaymentVerifierForTests } from "../../src/lib/communities/commerce/funding-proof-service"
import {
  reconcileRewardFundingRefunds,
  setRewardFundingRefundCoordinatorForTests,
} from "../../src/lib/rewards/reward-funding-refund-reconciler"
import { getCommunityRepository } from "../../src/lib/communities/db-community-repository"
import { openCommunityWriteClient } from "../../src/lib/communities/community-read-access"
import { createRouteTestContext, json, resetRuntimeCaches } from "../helpers"
import { exchangeJwt } from "./communities/community-routes-test-helpers"

let cleanup: (() => Promise<void>) | null = null
let offerRateLimitAllows = true
let offerRateLimitCalls = 0

beforeEach(() => {
  resetRuntimeCaches()
  setRewardSettlementCoordinatorForTests(null)
  setRewardSettlementConfirmPollPlanForTests(null)
  setPrivyAccessProofVerifierForTests(null)
  setBookingPaymentVerifierForTests(null)
  setRewardFundingRefundCoordinatorForTests(null)
  offerRateLimitAllows = true
  offerRateLimitCalls = 0
})

afterEach(async () => {
  setRewardSettlementCoordinatorForTests(null)
  setRewardSettlementConfirmPollPlanForTests(null)
  setPrivyAccessProofVerifierForTests(null)
  setBookingPaymentVerifierForTests(null)
  setRewardFundingRefundCoordinatorForTests(null)
  if (cleanup) {
    await cleanup()
    cleanup = null
  }
})

function authHeaders(accessToken: string): { authorization: string } {
  return { authorization: `Bearer ${accessToken}` }
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10)
}

describe("rewards routes", () => {
  function campaignEnv(): Partial<Parameters<typeof createRouteTestContext>[0]> {
    return {
      REWARDS_CAMPAIGNS_ENABLED: "true",
      REWARDS_ACCRUAL_ENABLED: "true",
      REWARDS_PAYOUTS_ENABLED: "true",
      REWARDS_IDENTITY_PROVIDER: "self",
      REWARDS_REFUNDS_ENABLED: "true",
      REWARDS_CAMPAIGN_CHAIN_ID: "84532",
      PIRATE_REWARDS_SETTLEMENT_CHAIN_ID: "84532",
      PIRATE_REWARDS_SETTLEMENT_BACKEND: "local",
      REWARDS_CAMPAIGN_USDC_TOKEN_ADDRESS: "0x1000000000000000000000000000000000000001",
      REWARDS_CAMPAIGN_TREASURY_ADDRESS: "0xCb23683A41ec98F506B67D89dEAF0Bb52ACC97A6",
      REWARDS_CAMPAIGN_RPC_URL: "https://base-sepolia.example.test",
      PIRATE_REWARDS_SETTLEMENT_OPERATOR_ADDRESS: "0xCb23683A41ec98F506B67D89dEAF0Bb52ACC97A6",
      PIRATE_REWARDS_SETTLEMENT_OPERATOR_PRIVATE_KEY: "0x7000000000000000000000000000000000000000000000000000000000000007",
      PIRATE_REWARDS_SETTLEMENT_USDC_TOKEN_ADDRESS: "0x1000000000000000000000000000000000000001",
      PIRATE_REWARDS_SETTLEMENT_RPC_URL: "https://base-sepolia.example.test",
      PIRATE_REWARDS_SETTLEMENT_ALLOW_TOKEN_OVERRIDE: "true",
      REWARDS_CAMPAIGN_QUOTE_TTL_SECONDS: "900",
      REWARDS_CAMPAIGN_MIN_BUDGET_CENTS: "1000",
      REWARDS_CAMPAIGN_MAX_BUDGET_CENTS: "1000000",
      REWARDS_CAMPAIGN_MAX_REWARD_CENTS: "1000",
      REWARDS_CAMPAIGN_MIN_DURATION_SECONDS: "3600",
      REWARDS_CAMPAIGN_MAX_DURATION_SECONDS: "7776000",
      REWARD_OFFER_RATE_LIMITER: {
        limit: async () => {
          offerRateLimitCalls += 1
          return { success: offerRateLimitAllows }
        },
      },
    }
  }

  async function createRewardsCommunity(ctx: Awaited<ReturnType<typeof createRouteTestContext>>, userId: string, now: string): Promise<void> {
    await ctx.client.execute({
      sql: `
        INSERT INTO communities (
          community_id, creator_user_id, display_name, description, membership_mode,
          status, provisioning_state, transfer_state, created_at, updated_at
        )
        VALUES ('cmt_rewards_route', ?1, 'Rewards Test', NULL, 'open', 'active', 'active', 'none', ?2, ?2)
        ON CONFLICT (community_id) DO NOTHING
      `,
      args: [userId, now],
    })
  }

  async function addWallet(ctx: Awaited<ReturnType<typeof createRouteTestContext>>, userId: string, now: string, address = "0x1000000000000000000000000000000000000001"): Promise<void> {
    await ctx.client.execute({
      sql: `
        INSERT INTO wallet_attachments (
          wallet_attachment_id, user_id, chain_namespace, wallet_address_normalized,
          wallet_address_display, source_provider, source_subject, attachment_kind,
          is_primary, status, attached_at, detached_at, created_at, updated_at
        )
        VALUES (
          'wal_rewards_' || ?1, ?1, 'eip155', lower(?2),
          ?2, 'privy', 'did:privy:rewards', 'embedded',
          1, 'active', ?3, NULL, ?3, ?3
        )
      `,
      args: [userId, address, now],
    })
    await ctx.client.execute({
      sql: "UPDATE users SET primary_wallet_attachment_id = 'wal_rewards_' || ?1 WHERE user_id = ?1",
      args: [userId],
    })
  }

  async function addNullifier(ctx: Awaited<ReturnType<typeof createRouteTestContext>>, userId: string, now: string): Promise<void> {
    await ctx.client.execute({
      sql: `
        INSERT INTO identity_nullifiers (
          identity_nullifier_id, user_id, provider, mechanism, nullifier_hash, status,
          first_seen_at, created_at, updated_at
        )
        VALUES ('idn_rewards_' || ?1, ?1, 'self', 'zk-nullifier', 'reward-nullifier-' || ?1, 'active', ?2, ?2, ?2)
        ON CONFLICT (identity_nullifier_id) DO UPDATE
        SET status = 'active', updated_at = excluded.updated_at
      `,
      args: [userId, now],
    })
    await ctx.client.execute({
      sql: "UPDATE users SET verification_capabilities_json = ?2 WHERE user_id = ?1",
      args: [userId, JSON.stringify({
        unique_human: {
          state: "verified",
          provider: "self",
          proof_type: "unique_human",
          mechanism: "session_complete",
          verified_at: Math.floor(Date.parse(now) / 1000),
        },
      })],
    })
  }

  async function linkPrivySubject(
    ctx: Awaited<ReturnType<typeof createRouteTestContext>>,
    userId: string,
    subject: string,
    now: string,
  ): Promise<void> {
    await ctx.client.execute({
      sql: `
        INSERT INTO auth_provider_links (
          auth_provider_link_id, user_id, provider, provider_subject, provider_user_ref,
          status, linked_at, revoked_at, created_at, updated_at
        )
        VALUES ('apl_rewards_' || ?1 || '_' || ?2, ?1, 'privy', ?3, ?3, 'active', ?4, NULL, ?4, ?4)
      `,
      args: [userId, subject.replace(/[^a-zA-Z0-9_-]/g, "_"), subject, now],
    })
  }

  async function addRewardEvent(ctx: Awaited<ReturnType<typeof createRouteTestContext>>, userId: string, amountCents: number, now: string): Promise<void> {
    await createRewardsCommunity(ctx, userId, now)
    await ctx.client.execute({
      sql: `
        INSERT INTO reward_events (
          reward_event_id, user_id, community_id, post_id, activity_date,
          reward_kind, amount_cents, source, created_at
        )
        VALUES (
          'rew_cashout_' || ?1 || '_' || ?2, ?1, 'cmt_rewards_route', 'pst_reward_song_cashout',
          ?3, 'study_streak_day', ?2, 'song_engagement_reconciler', ?4
        )
      `,
      args: [userId, amountCents, todayUtc(), now],
    })
  }

  async function seedCampaignSong(
    ctx: Awaited<ReturnType<typeof createRouteTestContext>>,
    ownerUserId: string,
    postId = "pst_reward_campaign_song",
    karaokeLineCount = 5,
  ): Promise<void> {
    const now = new Date().toISOString()
    await createRewardsCommunity(ctx, ownerUserId, now)
    const handle = await openCommunityWriteClient(ctx.env, getCommunityRepository(ctx.env), "cmt_rewards_route")
    try {
      await handle.client.execute({
        sql: `
          INSERT OR IGNORE INTO communities (
            community_id, display_name, status, artist_governance_state, membership_mode,
            default_age_gate_policy, donation_policy_mode, donation_partner_status,
            governance_mode, created_by_user_id, created_at, updated_at, karaoke_enabled
          ) VALUES (
            'cmt_rewards_route', 'Rewards Test', 'active', 'fan_run', 'open',
            'none', 'none', 'unconfigured', 'centralized', ?1, ?2, ?2, 1
          )
        `,
        args: [ownerUserId, now],
      })
      await handle.client.execute({
        sql: "UPDATE communities SET karaoke_enabled = 1 WHERE community_id = 'cmt_rewards_route'",
        args: [],
      })
      await handle.client.execute({
        sql: `
          INSERT INTO posts (
            post_id, community_id, author_user_id, identity_mode, post_type,
            status, song_mode, title, lyrics, source_language, rights_basis,
            analysis_state, content_safety_state, age_gate_policy, created_at,
            updated_at, access_mode, asset_id, visibility, song_title,
            song_cover_art_ref, song_artifact_bundle_id
          ) VALUES (
            ?1, 'cmt_rewards_route', ?2, 'public', 'song', 'published',
            'original', 'Reward Song', 'Practice these lines', 'en', 'original',
            'allow', 'safe', 'none', ?3, ?3, 'public', NULL, 'public',
            'Reward Song', 'ipfs://reward-cover', ?4
          )
        `,
        args: [postId, ownerUserId, now, `sab_${postId}`],
      })
    } finally {
      await handle.close()
    }
    const timedLyrics = Array.from({ length: karaokeLineCount }, (_, index) => ({
      start_ms: index * 1_000,
      end_ms: (index + 1) * 1_000,
      text: `Practice line ${index + 1}`,
    }))
    await ctx.client.execute({
      sql: `
        INSERT INTO song_artifact_bundles (
          song_artifact_bundle_id, community_id, creator_user_id, status,
          primary_audio_json, lyrics_text, lyrics_sha256, instrumental_audio_json,
          translation_status, alignment_status, karaoke_revision_id, timed_lyrics_json,
          moderation_status, created_at, updated_at
        ) VALUES (
          ?1, 'cmt_rewards_route', ?2, 'ready', '{}', 'Practice these lines',
          'reward-lyrics-sha', ?3, 'completed', 'completed', ?4, ?5, 'completed', ?6, ?6
        )
      `,
      args: [
        postId,
        ownerUserId,
        JSON.stringify({ storage_ref: "https://media.example.test/instrumental.mp3" }),
        `krv_${postId}`,
        JSON.stringify(timedLyrics),
        now,
      ],
    })
  }

  function campaignBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const now = Math.floor(Date.now() / 1000)
    return {
      // The web client sends canonical public IDs from the page route.
      community: "com_cmt_rewards_route",
      post: "post_pst_reward_campaign_song",
      reward_identity_provider: "very",
      eligible_activity: "either",
      min_score_bps: 7000,
      daily_reward_cents: 40,
      milestone_7_cents: 0,
      milestone_30_cents: 0,
      reward_period_cap_cents: 40,
      budget_cents: 100000,
      starts_at: now - 60,
      ends_at: now + 86400,
      idempotency_key: "reward-campaign-create-1",
      ...overrides,
    }
  }

  test("campaigns fail closed independently of the legacy rewards flag", async () => {
    const legacyRewardsEnv = { REWARDS_ENABLED: "true", REWARDS_CAMPAIGNS_ENABLED: undefined }
    const ctx = await createRouteTestContext(legacyRewardsEnv)
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "reward-campaign-dark-user")
    const response = await app.request("http://pirate.test/reward_campaigns", {
      method: "POST",
      headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
      body: JSON.stringify(campaignBody()),
    }, ctx.env)
    expect(response.status).toBe(403)
    const rows = await ctx.client.execute("SELECT COUNT(*) AS count FROM reward_campaigns")
    expect(Number(rows.rows[0]?.count)).toBe(0)
  })

  test("uses the flat-bounty provider independently of the legacy cashout provider", async () => {
    const ctx = await createRouteTestContext({
      ...campaignEnv(),
      REWARDS_IDENTITY_PROVIDER: "self",
    })
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "reward-provider-compatibility")
    await addWallet(ctx, session.userId, new Date().toISOString())
    await seedCampaignSong(ctx, session.userId)

    const created = await app.request("http://pirate.test/reward_campaigns", {
      method: "POST",
      headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
      body: JSON.stringify(campaignBody({
        idempotency_key: "provider-independent-create",
        reward_identity_provider: "very",
      })),
    }, ctx.env)
    expect(created.status).toBe(201)
    const campaign = await json(created) as { id: string }

    ctx.env.REWARDS_IDENTITY_PROVIDER = "very"
    const quoted = await app.request(`http://pirate.test/reward_campaigns/${campaign.id}/funding_quotes`, {
      method: "POST",
      headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
      body: JSON.stringify({ amount_cents: 100000, idempotency_key: "provider-independent-quote" }),
    }, ctx.env)
    expect(quoted.status).toBe(201)
    const quote = await json(quoted) as { id: string }
    const txHash = `0x${"e".repeat(64)}`
    const confirmUrl = `http://pirate.test/reward_campaigns/${campaign.id}/funding_quotes/${quote.id}/confirm`

    setBookingPaymentVerifierForTests(async ({ fundingTxRef, expected }) => ({
      kind: "verified",
      senderAddress: expected.senderAddress,
      txRef: fundingTxRef,
    }))
    const confirmed = await app.request(confirmUrl, {
      method: "POST",
      headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
      body: JSON.stringify({ tx_hash: txHash }),
    }, ctx.env)
    expect(confirmed.status).toBe(200)

    const grandfatheredReplay = await app.request(confirmUrl, {
      method: "POST",
      headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
      body: JSON.stringify({ tx_hash: txHash }),
    }, ctx.env)
    expect(grandfatheredReplay.status).toBe(200)
  }, 30_000)

  test("lets only the rewarder cancel an untouched draft and atomically releases its song slot", async () => {
    const ctx = await createRouteTestContext(campaignEnv())
    cleanup = ctx.cleanup
    const owner = await exchangeJwt(ctx.env, "reward-draft-cancel-owner")
    const stranger = await exchangeJwt(ctx.env, "reward-draft-cancel-stranger")
    await seedCampaignSong(ctx, owner.userId)

    const created = await app.request("http://pirate.test/reward_campaigns", {
      method: "POST",
      headers: { ...authHeaders(owner.accessToken), "content-type": "application/json" },
      body: JSON.stringify(campaignBody({ idempotency_key: "draft-cancel-first" })),
    }, ctx.env)
    expect(created.status).toBe(201)
    const campaign = await json(created) as { id: string }

    const strangerCancel = await app.request(`http://pirate.test/reward_campaigns/${campaign.id}/cancel`, {
      method: "POST",
      headers: authHeaders(stranger.accessToken),
    }, ctx.env)
    expect(strangerCancel.status).toBe(404)

    const canceled = await app.request(`http://pirate.test/reward_campaigns/${campaign.id}/cancel`, {
      method: "POST",
      headers: authHeaders(owner.accessToken),
    }, ctx.env)
    expect(canceled.status).toBe(200)
    expect(await json(canceled)).toMatchObject({ id: campaign.id, status: "canceled" })
    const released = await ctx.client.execute({
      sql: "SELECT reward_campaign_id FROM reward_song_pools WHERE reward_campaign_id = ?1",
      args: [campaign.id],
    })
    expect(released.rows).toEqual([])

    const replay = await app.request(`http://pirate.test/reward_campaigns/${campaign.id}/cancel`, {
      method: "POST",
      headers: authHeaders(owner.accessToken),
    }, ctx.env)
    expect(replay.status).toBe(200)
    expect(await json(replay)).toMatchObject({ id: campaign.id, status: "canceled" })

    const reusedCreateKey = await app.request("http://pirate.test/reward_campaigns", {
      method: "POST",
      headers: { ...authHeaders(owner.accessToken), "content-type": "application/json" },
      body: JSON.stringify(campaignBody({ idempotency_key: "draft-cancel-first" })),
    }, ctx.env)
    expect(reusedCreateKey.status).toBe(201)
    expect(await json(reusedCreateKey)).toMatchObject({ id: campaign.id, status: "canceled" })
    expect((await ctx.client.execute({
      sql: "SELECT reward_campaign_id FROM reward_song_pools WHERE post_id = ?1",
      args: ["pst_reward_campaign_song"],
    })).rows).toEqual([])

    const replacement = await app.request("http://pirate.test/reward_campaigns", {
      method: "POST",
      headers: { ...authHeaders(owner.accessToken), "content-type": "application/json" },
      body: JSON.stringify(campaignBody({ idempotency_key: "draft-cancel-replacement" })),
    }, ctx.env)
    expect(replacement.status).toBe(201)
    const replacementCampaign = await json(replacement) as { id: string }
    expect(replacementCampaign.id).not.toBe(campaign.id)

    const replacementCanceled = await app.request(`http://pirate.test/reward_campaigns/${replacementCampaign.id}/cancel`, {
      method: "POST",
      headers: authHeaders(owner.accessToken),
    }, ctx.env)
    expect(replacementCanceled.status).toBe(200)

    const strangerReplacement = await app.request("http://pirate.test/reward_campaigns", {
      method: "POST",
      headers: { ...authHeaders(stranger.accessToken), "content-type": "application/json" },
      body: JSON.stringify(campaignBody({ idempotency_key: "draft-cancel-stranger-replacement" })),
    }, ctx.env)
    expect(strangerReplacement.status).toBe(201)
    expect((await json(strangerReplacement) as { id: string }).id).not.toBe(replacementCampaign.id)
  })

  test("refuses cancellation once funding has started or completed", async () => {
    const ctx = await createRouteTestContext(campaignEnv())
    cleanup = ctx.cleanup
    const owner = await exchangeJwt(ctx.env, "reward-draft-cancel-funded-owner")
    await addWallet(ctx, owner.userId, new Date().toISOString())
    await seedCampaignSong(ctx, owner.userId)

    const created = await app.request("http://pirate.test/reward_campaigns", {
      method: "POST",
      headers: { ...authHeaders(owner.accessToken), "content-type": "application/json" },
      body: JSON.stringify(campaignBody({ idempotency_key: "draft-cancel-funded" })),
    }, ctx.env)
    const campaign = await json(created) as { id: string }
    const quoted = await app.request(`http://pirate.test/reward_campaigns/${campaign.id}/funding_quotes`, {
      method: "POST",
      headers: { ...authHeaders(owner.accessToken), "content-type": "application/json" },
      body: JSON.stringify({ amount_cents: 100000, idempotency_key: "draft-cancel-funded-quote" }),
    }, ctx.env)
    expect(quoted.status).toBe(201)
    const quote = await json(quoted) as { id: string }

    const duringFunding = await app.request(`http://pirate.test/reward_campaigns/${campaign.id}/cancel`, {
      method: "POST",
      headers: authHeaders(owner.accessToken),
    }, ctx.env)
    expect(duringFunding.status).toBe(409)

    setBookingPaymentVerifierForTests(async ({ fundingTxRef, expected }) => ({
      kind: "verified",
      senderAddress: expected.senderAddress,
      txRef: fundingTxRef,
    }))
    const confirmed = await app.request(
      `http://pirate.test/reward_campaigns/${campaign.id}/funding_quotes/${quote.id}/confirm`,
      {
        method: "POST",
        headers: { ...authHeaders(owner.accessToken), "content-type": "application/json" },
        body: JSON.stringify({ tx_hash: `0x${"f".repeat(64)}` }),
      },
      ctx.env,
    )
    expect(confirmed.status).toBe(200)

    const afterFunding = await app.request(`http://pirate.test/reward_campaigns/${campaign.id}/cancel`, {
      method: "POST",
      headers: authHeaders(owner.accessToken),
    }, ctx.env)
    expect(afterFunding.status).toBe(409)
    const pool = await ctx.client.execute({
      sql: "SELECT reward_campaign_id FROM reward_song_pools WHERE reward_campaign_id = ?1",
      args: [campaign.id],
    })
    expect(pool.rows).toEqual([{ reward_campaign_id: campaign.id }])
  }, 30_000)

  test("allows cancellation after every funding effect is terminal or expired", async () => {
    const ctx = await createRouteTestContext(campaignEnv())
    cleanup = ctx.cleanup
    const owner = await exchangeJwt(ctx.env, "reward-draft-cancel-terminal-owner")
    await addWallet(ctx, owner.userId, new Date().toISOString())
    await seedCampaignSong(ctx, owner.userId)

    const createAndQuote = async (suffix: string) => {
      const created = await app.request("http://pirate.test/reward_campaigns", {
        method: "POST",
        headers: { ...authHeaders(owner.accessToken), "content-type": "application/json" },
        body: JSON.stringify(campaignBody({ idempotency_key: `draft-cancel-${suffix}` })),
      }, ctx.env)
      const campaign = await json(created) as { id: string }
      const quoted = await app.request(`http://pirate.test/reward_campaigns/${campaign.id}/funding_quotes`, {
        method: "POST",
        headers: { ...authHeaders(owner.accessToken), "content-type": "application/json" },
        body: JSON.stringify({ amount_cents: 100000, idempotency_key: `draft-cancel-${suffix}-quote` }),
      }, ctx.env)
      return { campaign, quote: await json(quoted) as { id: string } }
    }

    const failed = await createAndQuote("failed")
    await ctx.client.execute({
      sql: "UPDATE reward_campaign_funding_effects SET status = 'failed' WHERE reward_campaign_funding_effect_id = ?1",
      args: [failed.quote.id],
    })
    await ctx.client.execute({
      sql: "UPDATE reward_campaigns SET status = 'draft' WHERE reward_campaign_id = ?1",
      args: [failed.campaign.id],
    })
    const failedCancel = await app.request(`http://pirate.test/reward_campaigns/${failed.campaign.id}/cancel`, {
      method: "POST",
      headers: authHeaders(owner.accessToken),
    }, ctx.env)
    expect(failedCancel.status).toBe(200)

    const expired = await createAndQuote("expired")
    await ctx.client.execute({
      sql: "UPDATE reward_campaign_funding_effects SET expires_at = ?2 WHERE reward_campaign_funding_effect_id = ?1",
      args: [expired.quote.id, "2020-01-01T00:00:00.000Z"],
    })
    await ctx.client.execute({
      sql: "UPDATE reward_campaigns SET status = 'draft' WHERE reward_campaign_id = ?1",
      args: [expired.campaign.id],
    })
    const expiredCancel = await app.request(`http://pirate.test/reward_campaigns/${expired.campaign.id}/cancel`, {
      method: "POST",
      headers: authHeaders(owner.accessToken),
    }, ctx.env)
    expect(expiredCancel.status).toBe(200)
  })

  test("does not advertise or quote campaign funding without a usable settlement signer", async () => {
    const ctx = await createRouteTestContext({
      ...campaignEnv(),
      PIRATE_REWARDS_SETTLEMENT_OPERATOR_PRIVATE_KEY: undefined,
    })
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "reward-campaign-unready-signer")
    await addWallet(ctx, session.userId, new Date().toISOString())
    await seedCampaignSong(ctx, session.userId)

    const capabilities = await app.request("http://pirate.test/reward_campaign_capabilities?post_id=pst_reward_campaign_song", {
      headers: authHeaders(session.accessToken),
    }, ctx.env)
    expect(capabilities.status).toBe(200)
    expect(await json(capabilities)).toMatchObject({ enabled: false, post_eligible: false })

    const create = await app.request("http://pirate.test/reward_campaigns", {
      method: "POST",
      headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
      body: JSON.stringify(campaignBody({ idempotency_key: "unready-signer-campaign" })),
    }, ctx.env)
    expect(create.status).toBe(201)
    const campaign = await json(create) as { id: string }
    const quote = await app.request(`http://pirate.test/reward_campaigns/${campaign.id}/funding_quotes`, {
      method: "POST",
      headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
      body: JSON.stringify({ amount_cents: 100000, idempotency_key: "unready-signer-quote" }),
    }, ctx.env)
    expect(quote.status).toBe(502)
    const rows = await ctx.client.execute("SELECT COUNT(*) AS count FROM reward_campaign_funding_effects")
    expect(Number(rows.rows[0]?.count)).toBe(0)
  })

  test("reports post-specific campaign eligibility from the configured allowlist", async () => {
    const ctx = await createRouteTestContext({
      ...campaignEnv(),
      REWARDS_CAMPAIGN_POST_ALLOWLIST: "pst_reward_campaign_song",
    })
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "reward-campaign-post-eligibility")

    const allowed = await app.request(
      "http://pirate.test/reward_campaign_capabilities?post_id=pst_reward_campaign_song",
      { headers: authHeaders(session.accessToken) },
      ctx.env,
    )
    expect(allowed.status).toBe(200)
    expect(await json(allowed)).toMatchObject({ enabled: true, post_eligible: true })

    const blocked = await app.request(
      "http://pirate.test/reward_campaign_capabilities?post_id=pst_other_song",
      { headers: authHeaders(session.accessToken) },
      ctx.env,
    )
    expect(blocked.status).toBe(200)
    expect(await json(blocked)).toMatchObject({ enabled: true, post_eligible: false })

    const missing = await app.request(
      "http://pirate.test/reward_campaign_capabilities",
      { headers: authHeaders(session.accessToken) },
      ctx.env,
    )
    expect(missing.status).toBe(400)
  })

  test("persists canonical tier terms and admits funding after tier accounting activation", async () => {
    const ctx = await createRouteTestContext(campaignEnv())
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "reward-campaign-tier-owner")
    await addWallet(ctx, session.userId, new Date().toISOString())
    await seedCampaignSong(ctx, session.userId)

    const tieredBody = campaignBody({
      default_amount_cents: 40,
      reward_identity_provider: "self",
      payout_tiers: [
        { nationalities: ["vnm"], amount_cents: 60 },
        { nationalities: ["USA", "CAN"], amount_cents: 80 },
      ],
      reward_period_cap_cents: 80,
      idempotency_key: "reward-campaign-tier-create",
    })
    const createdResponse = await app.request("http://pirate.test/reward_campaigns", {
      method: "POST",
      headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
      body: JSON.stringify(tieredBody),
    }, ctx.env)
    expect(createdResponse.status).toBe(201)
    const campaign = await json(createdResponse) as {
      id: string
      daily_reward_cents: number
      default_amount_cents: number
      max_claim_cents: number
      payout_tiers: Array<{ nationalities: string[]; amount_cents: number }>
    }
    expect(campaign).toMatchObject({
      daily_reward_cents: 40,
      default_amount_cents: 40,
      max_claim_cents: 80,
      payout_tiers: [
        { nationalities: ["CAN", "USA"], amount_cents: 80 },
        { nationalities: ["VNM"], amount_cents: 60 },
      ],
    })

    const replay = await app.request("http://pirate.test/reward_campaigns", {
      method: "POST",
      headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
      body: JSON.stringify({
        ...tieredBody,
        payout_tiers: [
          { nationalities: ["CAN"], amount_cents: 80 },
          { nationalities: ["USA"], amount_cents: 80 },
          { nationalities: ["VNM"], amount_cents: 60 },
        ],
      }),
    }, ctx.env)
    expect(replay.status).toBe(201)
    expect((await json(replay) as { id: string }).id).toBe(campaign.id)

    const stored = await ctx.client.execute({
      sql: "SELECT default_amount_cents, max_claim_cents, payout_tiers_json, terms_version FROM reward_campaigns WHERE reward_campaign_id = ?1",
      args: [campaign.id],
    })
    expect(stored.rows[0]).toMatchObject({
      default_amount_cents: 40,
      max_claim_cents: 80,
      terms_version: 4,
    })

    const quote = await app.request(`http://pirate.test/reward_campaigns/${campaign.id}/funding_quotes`, {
      method: "POST",
      headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
      body: JSON.stringify({ amount_cents: 100000, idempotency_key: "tier-funding-blocked" }),
    }, ctx.env)
    expect(quote.status).toBe(201)
    expect(await json(quote)).toMatchObject({
      campaign: campaign.id,
      amount_cents: 100000,
      status: "quoted",
    })
  })

  test("rejects ambiguous or insolvent nationality tier terms", async () => {
    const ctx = await createRouteTestContext(campaignEnv())
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "reward-campaign-tier-validation")
    await seedCampaignSong(ctx, session.userId)

    const cases = [
      campaignBody({
        default_amount_cents: 41,
        idempotency_key: "tier-default-mismatch",
      }),
      campaignBody({
        payout_tiers: [
          { nationalities: ["USA"], amount_cents: 50 },
          { nationalities: ["usa"], amount_cents: 60 },
        ],
        reward_period_cap_cents: 60,
        idempotency_key: "tier-country-duplicate",
      }),
      campaignBody({
        payout_tiers: Array.from({ length: 11 }, (_, index) => ({
          nationalities: [index === 0 ? "USA" : "CAN"],
          amount_cents: 40,
        })),
        idempotency_key: "tier-count-overflow",
      }),
      campaignBody({
        payout_tiers: [{ nationalities: ["USA"], amount_cents: 80 }],
        reward_period_cap_cents: 79,
        idempotency_key: "tier-period-under-max",
      }),
      campaignBody({
        payout_tiers: [{ nationalities: ["USA"], amount_cents: 80 }],
        reward_period_cap_cents: 80,
        budget_cents: 79,
        idempotency_key: "tier-budget-under-max",
      }),
      campaignBody({
        reward_identity_provider: "very",
        payout_tiers: [{ nationalities: ["USA"], amount_cents: 80 }],
        reward_period_cap_cents: 80,
        idempotency_key: "tier-very-provider",
      }),
      campaignBody({
        reward_identity_provider: "zkpassport",
        payout_tiers: [{ nationalities: ["USA"], amount_cents: 80 }],
        reward_period_cap_cents: 80,
        idempotency_key: "tier-zkpassport-provider",
      }),
      campaignBody({
        reward_identity_provider: "self",
        idempotency_key: "flat-self-provider",
      }),
    ]
    for (const body of cases) {
      const response = await app.request("http://pirate.test/reward_campaigns", {
        method: "POST",
        headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
        body: JSON.stringify(body),
      }, ctx.env)
      expect(response.status).toBe(400)
    }
  })

  test("creates, quotes, uniquely verifies, and activates a fully funded campaign", async () => {
    const ctx = await createRouteTestContext(campaignEnv())
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "reward-campaign-owner")
    await addWallet(ctx, session.userId, new Date().toISOString())
    await seedCampaignSong(ctx, session.userId)

    const unsupportedMilestone = await app.request("http://pirate.test/reward_campaigns", {
      method: "POST",
      headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
      body: JSON.stringify(campaignBody({ milestone_7_cents: 100, reward_period_cap_cents: 140 })),
    }, ctx.env)
    expect(unsupportedMilestone.status).toBe(400)

    const underCapped = await app.request("http://pirate.test/reward_campaigns", {
      method: "POST",
      headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
      body: JSON.stringify(campaignBody({ reward_period_cap_cents: 39 })),
    }, ctx.env)
    expect(underCapped.status).toBe(400)

    const belowEmissionFloor = await app.request("http://pirate.test/reward_campaigns", {
      method: "POST",
      headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
      body: JSON.stringify(campaignBody({ min_score_bps: 6999 })),
    }, ctx.env)
    expect(belowEmissionFloor.status).toBe(400)

    await seedCampaignSong(ctx, session.userId, "pst_reward_campaign_short", 2)
    const karaokeIneligible = await app.request("http://pirate.test/reward_campaigns", {
      method: "POST",
      headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
      body: JSON.stringify(campaignBody({
        post: "pst_reward_campaign_short",
        eligible_activity: "karaoke",
        idempotency_key: "reward-campaign-short-karaoke",
      })),
    }, ctx.env)
    expect(karaokeIneligible.status).toBe(403)

    const createBody = campaignBody()
    const create = await app.request("http://pirate.test/reward_campaigns", {
      method: "POST",
      headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
      body: JSON.stringify(createBody),
    }, ctx.env)
    expect(create.status).toBe(201)
    const campaign = await json(create) as {
      id: string
      status: string
      song_owner: string
      eligible_activity: string
      min_score_bps: number
      starts_at: number
      ends_at: number
    }
    expect(campaign).toMatchObject({
      community: "cmt_rewards_route",
      post: "pst_reward_campaign_song",
      status: "draft",
      song_owner: session.userId,
      eligible_activity: "either",
      min_score_bps: 7000,
    })

    const replay = await app.request("http://pirate.test/reward_campaigns", {
      method: "POST",
      headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
      body: JSON.stringify(createBody),
    }, ctx.env)
    expect((await json(replay) as { id: string }).id).toBe(campaign.id)

    const changedReplay = await app.request("http://pirate.test/reward_campaigns", {
      method: "POST",
      headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
      body: JSON.stringify({ ...createBody, daily_reward_cents: 41, reward_period_cap_cents: 41 }),
    }, ctx.env)
    expect(changedReplay.status).toBe(409)

    const changedScoreReplay = await app.request("http://pirate.test/reward_campaigns", {
      method: "POST",
      headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
      body: JSON.stringify({ ...createBody, min_score_bps: 7500 }),
    }, ctx.env)
    expect(changedScoreReplay.status).toBe(409)

    const changedProviderReplay = await app.request("http://pirate.test/reward_campaigns", {
      method: "POST",
      headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
      body: JSON.stringify({ ...createBody, reward_identity_provider: "zkpassport" }),
    }, ctx.env)
    expect(changedProviderReplay.status).toBe(400)

    const quoteResponse = await app.request(`http://pirate.test/reward_campaigns/${campaign.id}/funding_quotes`, {
      method: "POST",
      headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
      body: JSON.stringify({ amount_cents: 100000, idempotency_key: "test-quote-one" }),
    }, ctx.env)
    expect(quoteResponse.status).toBe(201)
    const quote = await json(quoteResponse) as {
      id: string
      amount_atomic: string
      sender_address: string
      treasury_address: string
      status: string
    }
    expect(quote).toMatchObject({
      amount_atomic: "1000000000",
      sender_address: "0x1000000000000000000000000000000000000001",
      treasury_address: "0xCb23683A41ec98F506B67D89dEAF0Bb52ACC97A6",
      status: "quoted",
    })

    let verificationCalls = 0
    setBookingPaymentVerifierForTests(async ({ fundingTxRef, expected }) => {
      verificationCalls += 1
      expect(expected.amountAtomic).toBe(1_000_000_000n)
      return { kind: "verified", senderAddress: expected.senderAddress, txRef: fundingTxRef }
    })
    const txHash = `0x${"a".repeat(64)}`
    const confirmUrl = `http://pirate.test/reward_campaigns/${campaign.id}/funding_quotes/${quote.id}/confirm`
    const confirmed = await app.request(confirmUrl, {
      method: "POST",
      headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
      body: JSON.stringify({ tx_hash: txHash }),
    }, ctx.env)
    expect(confirmed.status).toBe(200)
    expect(await json(confirmed)).toMatchObject({ id: quote.id, status: "confirmed", tx_hash: txHash })

    const confirmReplay = await app.request(confirmUrl, {
      method: "POST",
      headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
      body: JSON.stringify({ tx_hash: txHash }),
    }, ctx.env)
    expect(confirmReplay.status).toBe(200)
    expect(verificationCalls).toBe(1)

    const read = await app.request(`http://pirate.test/reward_campaigns/${campaign.id}`, {
      headers: authHeaders(session.accessToken),
    }, ctx.env)
    const activeCampaign = await json(read) as {
      id: string
      status: string
      starts_at: number
      ends_at: number
      funding_tx_hash: string | null
    }
    expect(activeCampaign).toMatchObject({
      id: campaign.id,
      status: "active",
      budget_cents: 100000,
      funded_cents: 100000,
      remaining_cents: 100000,
      funding_tx_hash: txHash,
    })
    expect(activeCampaign.starts_at).toBeGreaterThan(campaign.starts_at)
    expect(activeCampaign.ends_at - activeCampaign.starts_at).toBe(campaign.ends_at - campaign.starts_at)
    const publicOffer = await app.request(`http://pirate.test/public/reward_campaigns/${campaign.id}`, {}, ctx.env)
    expect(publicOffer.status).toBe(200)
    expect(await json(publicOffer)).toEqual({
      campaign: campaign.id,
      eligible_activity: "either",
      min_score_bps: 7000,
      daily_reward_cents: 40,
      chain_id: 84532,
      ends_at: expect.any(Number),
    })
    expect(publicOffer.headers.get("cache-control")).toBe("public, max-age=0")
    expect(publicOffer.headers.get("cloudflare-cdn-cache-control")).toBe("public, max-age=15, stale-while-revalidate=15")
    const songOffer = await app.request(
      "http://pirate.test/public/reward_campaigns?community_id=com_cmt_rewards_route&post_id=post_pst_reward_campaign_song",
      {},
      ctx.env,
    )
    expect(songOffer.status).toBe(200)
    expect(await json(songOffer)).toEqual({
      campaign: campaign.id,
      eligible_activity: "either",
      min_score_bps: 7000,
      daily_reward_cents: 40,
      chain_id: 84532,
      ends_at: expect.any(Number),
    })
    await ctx.client.execute({
      sql: "UPDATE reward_campaigns SET status = 'paused' WHERE reward_campaign_id = ?1",
      args: [campaign.id],
    })
    expect((await app.request(`http://pirate.test/public/reward_campaigns/${campaign.id}`, {}, ctx.env)).status).toBe(404)
    expect((await app.request(
      "http://pirate.test/public/reward_campaigns?community_id=cmt_rewards_route&post_id=pst_reward_campaign_song",
      {}, ctx.env,
    )).status).toBe(404)
    await ctx.client.execute({
      sql: "UPDATE reward_campaigns SET status = 'active', reserved_cents = funded_cents WHERE reward_campaign_id = ?1",
      args: [campaign.id],
    })
    expect((await app.request(`http://pirate.test/public/reward_campaigns/${campaign.id}`, {}, ctx.env)).status).toBe(404)
    await ctx.client.execute({
      sql: "UPDATE reward_campaigns SET reserved_cents = 0 WHERE reward_campaign_id = ?1",
      args: [campaign.id],
    })
    expect(offerRateLimitCalls).toBe(5)
    offerRateLimitAllows = false
    const rateLimitedOffer = await app.request(
      "http://pirate.test/public/reward_campaigns?community_id=cmt_rewards_route&post_id=pst_reward_campaign_song",
      {},
      ctx.env,
    )
    expect(rateLimitedOffer.status).toBe(429)
    offerRateLimitAllows = true
    const ownerBlocksActive = await app.request(
      "http://pirate.test/reward_song_policies/cmt_rewards_route/pst_reward_campaign_song",
      {
        method: "PUT",
        headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
        body: JSON.stringify({ third_party_rewards: "blocked" }),
      },
      ctx.env,
    )
    expect(ownerBlocksActive.status).toBe(200)
    const noLongerPublic = await app.request(`http://pirate.test/public/reward_campaigns/${campaign.id}`, {}, ctx.env)
    expect(noLongerPublic.status).toBe(404)
    const noLongerDiscoverable = await app.request(
      "http://pirate.test/public/reward_campaigns?community_id=cmt_rewards_route&post_id=pst_reward_campaign_song",
      {},
      ctx.env,
    )
    expect(noLongerDiscoverable.status).toBe(404)

    await seedCampaignSong(ctx, session.userId, "pst_reward_campaign_song_two")
    const secondCreate = await app.request("http://pirate.test/reward_campaigns", {
      method: "POST",
      headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
      body: JSON.stringify(campaignBody({
        post: "pst_reward_campaign_song_two",
        idempotency_key: "reward-campaign-create-2",
      })),
    }, ctx.env)
    const secondCampaign = await json(secondCreate) as { id: string }
    const secondQuoteResponse = await app.request(`http://pirate.test/reward_campaigns/${secondCampaign.id}/funding_quotes`, {
      method: "POST",
      headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
      body: JSON.stringify({ amount_cents: 100000, idempotency_key: "test-quote-two" }),
    }, ctx.env)
    const secondQuote = await json(secondQuoteResponse) as { id: string }
    const reusedReceipt = await app.request(
      `http://pirate.test/reward_campaigns/${secondCampaign.id}/funding_quotes/${secondQuote.id}/confirm`,
      {
        method: "POST",
        headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
        body: JSON.stringify({ tx_hash: txHash }),
      },
      ctx.env,
    )
    expect(reusedReceipt.status).toBe(409)
    expect(verificationCalls).toBe(1)
  })

  test("enforces song-owner opt-out and hides non-public campaign states", async () => {
    const ctx = await createRouteTestContext(campaignEnv())
    cleanup = ctx.cleanup
    const owner = await exchangeJwt(ctx.env, "reward-policy-owner")
    const booster = await exchangeJwt(ctx.env, "reward-policy-booster")
    const outsider = await exchangeJwt(ctx.env, "reward-policy-outsider")
    await seedCampaignSong(ctx, owner.userId)
    await addWallet(ctx, booster.userId, new Date().toISOString())
    const policyUrl = "http://pirate.test/reward_song_policies/com_cmt_rewards_route/post_pst_reward_campaign_song"

    const unauthorizedPolicy = await app.request(policyUrl, {
      method: "PUT",
      headers: { ...authHeaders(outsider.accessToken), "content-type": "application/json" },
      body: JSON.stringify({ third_party_rewards: "blocked" }),
    }, ctx.env)
    expect(unauthorizedPolicy.status).toBe(404)

    const block = await app.request(policyUrl, {
      method: "PUT",
      headers: { ...authHeaders(owner.accessToken), "content-type": "application/json" },
      body: JSON.stringify({ third_party_rewards: "blocked" }),
    }, ctx.env)
    expect(block.status).toBe(200)
    expect(await json(block)).toMatchObject({ song_owner: owner.userId, third_party_rewards: "blocked" })

    const blockedCreate = await app.request("http://pirate.test/reward_campaigns", {
      method: "POST",
      headers: { ...authHeaders(booster.accessToken), "content-type": "application/json" },
      body: JSON.stringify(campaignBody({ idempotency_key: "blocked-campaign" })),
    }, ctx.env)
    expect(blockedCreate.status).toBe(403)

    await app.request(policyUrl, {
      method: "PUT",
      headers: { ...authHeaders(owner.accessToken), "content-type": "application/json" },
      body: JSON.stringify({ third_party_rewards: "allowed" }),
    }, ctx.env)
    const create = await app.request("http://pirate.test/reward_campaigns", {
      method: "POST",
      headers: { ...authHeaders(booster.accessToken), "content-type": "application/json" },
      body: JSON.stringify(campaignBody({ idempotency_key: "allowed-campaign" })),
    }, ctx.env)
    expect(create.status).toBe(201)
    const campaign = await json(create) as { id: string }
    const duplicateDraft = await app.request("http://pirate.test/reward_campaigns", {
      method: "POST",
      headers: { ...authHeaders(booster.accessToken), "content-type": "application/json" },
      body: JSON.stringify(campaignBody({ idempotency_key: "second-open-draft" })),
    }, ctx.env)
    expect(duplicateDraft.status).toBe(409)

    const hiddenDraft = await app.request(`http://pirate.test/reward_campaigns/${campaign.id}`, {
      headers: authHeaders(outsider.accessToken),
    }, ctx.env)
    expect(hiddenDraft.status).toBe(404)
    const ownerCanInspect = await app.request(`http://pirate.test/reward_campaigns/${campaign.id}`, {
      headers: authHeaders(owner.accessToken),
    }, ctx.env)
    expect(ownerCanInspect.status).toBe(200)

    const quoteResponse = await app.request(`http://pirate.test/reward_campaigns/${campaign.id}/funding_quotes`, {
      method: "POST",
      headers: { ...authHeaders(booster.accessToken), "content-type": "application/json" },
      body: JSON.stringify({ amount_cents: 100000, idempotency_key: "owner-block-inflight" }),
    }, ctx.env)
    const quote = await json(quoteResponse) as { id: string }
    await app.request(policyUrl, {
      method: "PUT",
      headers: { ...authHeaders(owner.accessToken), "content-type": "application/json" },
      body: JSON.stringify({ third_party_rewards: "blocked" }),
    }, ctx.env)
    setBookingPaymentVerifierForTests(async ({ fundingTxRef, expected }) => ({
      kind: "verified",
      senderAddress: expected.senderAddress,
      txRef: fundingTxRef,
    }))
    const confirmed = await app.request(
      `http://pirate.test/reward_campaigns/${campaign.id}/funding_quotes/${quote.id}/confirm`,
      {
        method: "POST",
        headers: { ...authHeaders(booster.accessToken), "content-type": "application/json" },
        body: JSON.stringify({ tx_hash: `0x${"b".repeat(64)}` }),
      },
      ctx.env,
    )
    expect(confirmed.status).toBe(200)
    expect(await json(confirmed)).toMatchObject({ status: "confirmed" })
    const paused = await app.request(`http://pirate.test/reward_campaigns/${campaign.id}`, {
      headers: authHeaders(booster.accessToken),
    }, ctx.env)
    expect(await json(paused)).toMatchObject({ status: "paused", funded_cents: 100000 })
  })

  test("uses one stable song pool and accepts concurrent contribution lots from different funders", async () => {
    const ctx = await createRouteTestContext(campaignEnv())
    cleanup = ctx.cleanup
    const owner = await exchangeJwt(ctx.env, "reward-slot-owner")
    const firstBooster = await exchangeJwt(ctx.env, "reward-slot-first")
    const secondBooster = await exchangeJwt(ctx.env, "reward-slot-second")
    await seedCampaignSong(ctx, owner.userId)
    await addWallet(ctx, firstBooster.userId, new Date().toISOString())
    await addWallet(ctx, secondBooster.userId, new Date().toISOString(), "0x3000000000000000000000000000000000000003")

    const firstCreate = await app.request("http://pirate.test/reward_campaigns", {
      method: "POST",
      headers: { ...authHeaders(firstBooster.accessToken), "content-type": "application/json" },
      body: JSON.stringify(campaignBody({ idempotency_key: "reward-pool-first" })),
    }, ctx.env)
    expect(firstCreate.status).toBe(201)
    const pool = await json(firstCreate) as { id: string; reward_identity_provider: string }
    expect(pool.reward_identity_provider).toBe("very")
    const duplicatePool = await app.request("http://pirate.test/reward_campaigns", {
      method: "POST",
      headers: { ...authHeaders(secondBooster.accessToken), "content-type": "application/json" },
      body: JSON.stringify(campaignBody({
        idempotency_key: "reward-pool-second",
      })),
    }, ctx.env)
    expect(duplicatePool.status).toBe(409)
    expect(await json(duplicatePool)).toMatchObject({ code: "pool_exists" })

    const quoteCampaign = (
      accessToken: string,
      campaignId: string,
      amountCents: number,
      key: string,
      provider?: string,
    ) => app.request(
      `http://pirate.test/reward_campaigns/${campaignId}/funding_quotes`,
      {
        method: "POST",
        headers: { ...authHeaders(accessToken), "content-type": "application/json" },
        body: JSON.stringify({
          amount_cents: amountCents,
          idempotency_key: key,
          ...(provider ? { reward_identity_provider: provider } : {}),
        }),
      },
      ctx.env,
    )

    const firstQuote = await quoteCampaign(firstBooster.accessToken, pool.id, 40_000, "reward-pool-quote-first")
    expect(firstQuote.status).toBe(201)
    const firstLot = await json(firstQuote) as { id: string }
    setBookingPaymentVerifierForTests(async ({ fundingTxRef, expected }) => ({
      kind: "verified",
      senderAddress: expected.senderAddress,
      txRef: fundingTxRef,
    }))
    const firstConfirmation = await app.request(
      `http://pirate.test/reward_campaigns/${pool.id}/funding_quotes/${firstLot.id}/confirm`,
      {
        method: "POST",
        headers: { ...authHeaders(firstBooster.accessToken), "content-type": "application/json" },
        body: JSON.stringify({ tx_hash: `0x${"8".repeat(64)}` }),
      },
      ctx.env,
    )
    expect(firstConfirmation.status).toBe(200)
    await ctx.client.execute({
      sql: `
        UPDATE reward_campaigns
        SET credited_cents = funded_cents, status = 'exhausted', exhausted_at = updated_at
        WHERE reward_campaign_id = ?1
      `,
      args: [pool.id],
    })
    const conflictingProviderQuote = await quoteCampaign(
      secondBooster.accessToken,
      pool.id,
      100_000,
      "reward-pool-quote-conflicting-provider",
      "zkpassport",
    )
    expect(conflictingProviderQuote.status).toBe(409)
    expect(await json(conflictingProviderQuote)).toMatchObject({
      message: "Funding provider assertion does not match the permanent song pool",
    })
    const secondQuote = await quoteCampaign(
      secondBooster.accessToken,
      pool.id,
      100_000,
      "reward-pool-quote-second",
      "very",
    )
    expect(secondQuote.status).toBe(201)
    const secondLot = await json(secondQuote) as { id: string }
    const secondConfirmation = await app.request(
      `http://pirate.test/reward_campaigns/${pool.id}/funding_quotes/${secondLot.id}/confirm`,
      {
        method: "POST",
        headers: { ...authHeaders(secondBooster.accessToken), "content-type": "application/json" },
        body: JSON.stringify({ tx_hash: `0x${"9".repeat(64)}` }),
      },
      ctx.env,
    )
    expect(secondConfirmation.status).toBe(200)
    const refilled = await app.request(`http://pirate.test/reward_campaigns/${pool.id}`, {
      headers: authHeaders(secondBooster.accessToken),
    }, ctx.env)
    expect(await json(refilled)).toMatchObject({
      status: "active",
      funded_cents: 140_000,
      budget_cents: 140_000,
      remaining_cents: 100_000,
      reward_identity_provider: "very",
    })
    const persistedProvider = await ctx.client.execute({
      sql: "SELECT reward_identity_provider FROM reward_campaigns WHERE reward_campaign_id = ?1",
      args: [pool.id],
    })
    expect(persistedProvider.rows[0]?.reward_identity_provider).toBe("very")
    const lots = await ctx.client.execute({
      sql: `
        SELECT funder_user_id, expected_amount_cents
        FROM reward_campaign_funding_effects
        WHERE reward_campaign_id = ?1
        ORDER BY expected_amount_cents
      `,
      args: [pool.id],
    })
    expect(lots.rows).toEqual([
      { funder_user_id: firstBooster.userId, expected_amount_cents: 40000 },
      { funder_user_id: secondBooster.userId, expected_amount_cents: 100000 },
    ])
  })

  test("an expired quote and its replacement can both become contribution lots without a budget ceiling", async () => {
    const ctx = await createRouteTestContext(campaignEnv())
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "reward-expired-full-budget")
    await addWallet(ctx, session.userId, new Date().toISOString())
    await seedCampaignSong(ctx, session.userId)

    const create = await app.request("http://pirate.test/reward_campaigns", {
      method: "POST",
      headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
      body: JSON.stringify(campaignBody({ idempotency_key: "expired-full-budget-campaign" })),
    }, ctx.env)
    const campaign = await json(create) as { id: string }
    const quote = async (key: string) => {
      const response = await app.request(`http://pirate.test/reward_campaigns/${campaign.id}/funding_quotes`, {
        method: "POST",
        headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
        body: JSON.stringify({ amount_cents: 100000, idempotency_key: key }),
      }, ctx.env)
      expect(response.status).toBe(201)
      return await json(response) as { id: string }
    }
    const confirm = (fundingId: string, hash: string) => app.request(
      `http://pirate.test/reward_campaigns/${campaign.id}/funding_quotes/${fundingId}/confirm`,
      {
        method: "POST",
        headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
        body: JSON.stringify({ tx_hash: hash }),
      },
      ctx.env,
    )

    const expired = await quote("expired-full-budget-first")
    const expiredAt = new Date(Date.now() - 60_000)
    await ctx.client.execute({
      sql: "UPDATE reward_campaign_funding_effects SET expires_at = ?2 WHERE reward_campaign_funding_effect_id = ?1",
      args: [expired.id, expiredAt.toISOString()],
    })

    const replacement = await quote("expired-full-budget-replacement")
    const replacementHash = `0x${"8".repeat(64)}`
    const expiredHash = `0x${"9".repeat(64)}`
    setBookingPaymentVerifierForTests(async ({ fundingTxRef, expected }) => ({
      kind: "verified",
      senderAddress: expected.senderAddress,
      txRef: fundingTxRef,
      blockTimestamp: fundingTxRef === expiredHash
        ? Math.floor(expiredAt.getTime() / 1000) - 30
        : Math.floor(Date.now() / 1000),
    }))

    expect(await json(await confirm(replacement.id, replacementHash))).toMatchObject({
      status: "confirmed",
    })
    expect(await json(await confirm(expired.id, expiredHash))).toMatchObject({
      status: "confirmed",
    })
    expect(await json(await app.request(`http://pirate.test/reward_campaigns/${campaign.id}`, {
      headers: authHeaders(session.accessToken),
    }, ctx.env))).toMatchObject({ funded_cents: 200000 })
  })

  test("a transfer broadcast before expiry still funds the campaign when confirmation is resumed after expiry", async () => {
    // The money-stranding case. A wallet broadcasts valid USDC, the confirm request is lost, the
    // quote lapses, and the client resumes with the SAME hash on reload. Refusing on wall-clock
    // alone would leave real USDC in the treasury that no campaign can ever claim.
    const ctx = await createRouteTestContext(campaignEnv())
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "reward-funding-late-confirm")
    await addWallet(ctx, session.userId, new Date().toISOString())
    await seedCampaignSong(ctx, session.userId)
    const create = await app.request("http://pirate.test/reward_campaigns", {
      method: "POST",
      headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
      body: JSON.stringify(campaignBody({ idempotency_key: "late-confirm-campaign" })),
    }, ctx.env)
    const campaign = await json(create) as { id: string }
    const quoteResponse = await app.request(`http://pirate.test/reward_campaigns/${campaign.id}/funding_quotes`, {
      method: "POST",
      headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
      body: JSON.stringify({ amount_cents: 100000, idempotency_key: "late-confirm-quote" }),
    }, ctx.env)
    const quote = await json(quoteResponse) as { id: string }

    // The confirm request never reached the server, so the quote is still `quoted` with no hash.
    // Then it lapses.
    const expiresAt = "2020-01-01T00:00:00.000Z"
    await ctx.client.execute({
      sql: "UPDATE reward_campaign_funding_effects SET expires_at = ?2 WHERE reward_campaign_funding_effect_id = ?1",
      args: [quote.id, expiresAt],
    })

    // The chain says the transfer was mined one minute BEFORE the quote expired.
    const minedAt = Math.floor(Date.parse(expiresAt) / 1000) - 60
    setBookingPaymentVerifierForTests(async ({ fundingTxRef, expected }) => ({
      kind: "verified",
      senderAddress: expected.senderAddress,
      txRef: fundingTxRef,
      blockTimestamp: minedAt,
    }))

    const txHash = `0x${"b".repeat(64)}`
    const resumed = await app.request(
      `http://pirate.test/reward_campaigns/${campaign.id}/funding_quotes/${quote.id}/confirm`,
      {
        method: "POST",
        headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
        body: JSON.stringify({ tx_hash: txHash }),
      },
      ctx.env,
    )
    expect(resumed.status).toBe(200)
    expect(await json(resumed)).toMatchObject({ id: quote.id, status: "confirmed", tx_hash: txHash })

    // The money reached the campaign: it is fully funded and live, not stranded.
    const funded = await app.request(`http://pirate.test/reward_campaigns/${campaign.id}`, {
      headers: authHeaders(session.accessToken),
    }, ctx.env)
    expect(await json(funded)).toMatchObject({ status: "active", funded_cents: 100000 })
  })

  test("does not reopen an expired quote from a retired settlement chain", async () => {
    const ctx = await createRouteTestContext(campaignEnv())
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "reward-retired-chain-quote")
    await addWallet(ctx, session.userId, new Date().toISOString())
    await seedCampaignSong(ctx, session.userId)
    const create = await app.request("http://pirate.test/reward_campaigns", {
      method: "POST",
      headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
      body: JSON.stringify(campaignBody({ idempotency_key: "retired-chain-campaign" })),
    }, ctx.env)
    const campaign = await json(create) as { id: string }
    const quoteResponse = await app.request(`http://pirate.test/reward_campaigns/${campaign.id}/funding_quotes`, {
      method: "POST",
      headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
      body: JSON.stringify({ amount_cents: 100000, idempotency_key: "retired-chain-quote" }),
    }, ctx.env)
    const quote = await json(quoteResponse) as { id: string }
    await ctx.client.execute({
      sql: `UPDATE reward_campaign_funding_effects
        SET chain_id = 8453, expires_at = '2020-01-01T00:00:00.000Z'
        WHERE reward_campaign_funding_effect_id = ?1`,
      args: [quote.id],
    })
    let verifierCalled = false
    setBookingPaymentVerifierForTests(async () => {
      verifierCalled = true
      throw new Error("retired quote must not reach receipt verification")
    })
    const response = await app.request(
      `http://pirate.test/reward_campaigns/${campaign.id}/funding_quotes/${quote.id}/confirm`,
      {
        method: "POST",
        headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
        body: JSON.stringify({ tx_hash: `0x${"d".repeat(64)}` }),
      },
      ctx.env,
    )
    expect(response.status).toBe(409)
    expect(verifierCalled).toBe(false)
    const effect = await ctx.client.execute({
      sql: "SELECT status, tx_hash FROM reward_campaign_funding_effects WHERE reward_campaign_funding_effect_id = ?1",
      args: [quote.id],
    })
    expect(effect.rows[0]).toEqual({ status: "quoted", tx_hash: null })
  })

  test("does not confirm a quote after its campaign has ended", async () => {
    const ctx = await createRouteTestContext(campaignEnv())
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "reward-ended-campaign-quote")
    await addWallet(ctx, session.userId, new Date().toISOString())
    await seedCampaignSong(ctx, session.userId)
    const create = await app.request("http://pirate.test/reward_campaigns", {
      method: "POST",
      headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
      body: JSON.stringify(campaignBody({ idempotency_key: "ended-campaign-confirm" })),
    }, ctx.env)
    const campaign = await json(create) as { id: string }
    const quoteResponse = await app.request(`http://pirate.test/reward_campaigns/${campaign.id}/funding_quotes`, {
      method: "POST",
      headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
      body: JSON.stringify({ amount_cents: 100000, idempotency_key: "ended-campaign-quote" }),
    }, ctx.env)
    const quote = await json(quoteResponse) as { id: string }
    await ctx.client.execute({
      sql: "UPDATE reward_campaigns SET status = 'ended' WHERE reward_campaign_id = ?1",
      args: [campaign.id],
    })
    let verifierCalled = false
    setBookingPaymentVerifierForTests(async () => {
      verifierCalled = true
      throw new Error("ended campaign must not reach receipt verification")
    })
    const response = await app.request(
      `http://pirate.test/reward_campaigns/${campaign.id}/funding_quotes/${quote.id}/confirm`,
      {
        method: "POST",
        headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
        body: JSON.stringify({ tx_hash: `0x${"e".repeat(64)}` }),
      },
      ctx.env,
    )
    expect(response.status).toBe(409)
    expect(verifierCalled).toBe(false)
    const state = await ctx.client.execute({
      sql: `SELECT c.status AS campaign_status, f.status AS funding_status, f.tx_hash
        FROM reward_campaigns c
        JOIN reward_campaign_funding_effects f ON f.reward_campaign_id = c.reward_campaign_id
        WHERE f.reward_campaign_funding_effect_id = ?1`,
      args: [quote.id],
    })
    expect(state.rows[0]).toEqual({ campaign_status: "ended", funding_status: "quoted", tx_hash: null })
  })

  test("a narrowly late transfer re-acquires its slot and receives a fresh campaign window", async () => {
    const ctx = await createRouteTestContext(campaignEnv())
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "reward-funding-post-expiry")
    await addWallet(ctx, session.userId, new Date().toISOString())
    await seedCampaignSong(ctx, session.userId)
    const create = await app.request("http://pirate.test/reward_campaigns", {
      method: "POST",
      headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
      body: JSON.stringify(campaignBody({ idempotency_key: "post-expiry-campaign" })),
    }, ctx.env)
    const campaign = await json(create) as { id: string }
    const quoteResponse = await app.request(`http://pirate.test/reward_campaigns/${campaign.id}/funding_quotes`, {
      method: "POST",
      headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
      body: JSON.stringify({ amount_cents: 100000, idempotency_key: "post-expiry-quote" }),
    }, ctx.env)
    const quote = await json(quoteResponse) as { id: string }

    const expiresAt = new Date(Date.now() - 2 * 60 * 1000).toISOString()
    await ctx.client.execute({
      sql: "UPDATE reward_campaign_funding_effects SET expires_at = ?2 WHERE reward_campaign_funding_effect_id = ?1",
      args: [quote.id, expiresAt],
    })

    // The chain says the transfer was mined one minute AFTER the quote expired.
    const minedAt = Math.floor(Date.parse(expiresAt) / 1000) + 60
    setBookingPaymentVerifierForTests(async ({ fundingTxRef, expected }) => ({
      kind: "verified",
      senderAddress: expected.senderAddress,
      txRef: fundingTxRef,
      blockTimestamp: minedAt,
    }))

    const accepted = await app.request(
      `http://pirate.test/reward_campaigns/${campaign.id}/funding_quotes/${quote.id}/confirm`,
      {
        method: "POST",
        headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
        body: JSON.stringify({ tx_hash: `0x${"c".repeat(64)}` }),
      },
      ctx.env,
    )
    expect(accepted.status).toBe(200)
    expect(await json(accepted)).toMatchObject({ status: "confirmed" })

    const funded = await app.request(`http://pirate.test/reward_campaigns/${campaign.id}`, {
      headers: authHeaders(session.accessToken),
    }, ctx.env)
    const fundedBody = await json(funded) as { status: string; funded_cents: number; starts_at: number; ends_at: number }
    expect(fundedBody).toMatchObject({ status: "active", funded_cents: 100000 })
    expect(fundedBody.starts_at).toBeGreaterThan(Math.floor(Date.now() / 1000) - 10)
    const schedule = await ctx.client.execute({
      sql: "SELECT requested_starts_at, requested_ends_at, starts_at, ends_at FROM reward_campaigns WHERE reward_campaign_id = ?1",
      args: [campaign.id],
    })
    expect(schedule.rows[0]?.requested_starts_at).not.toBe(schedule.rows[0]?.starts_at)
    expect(schedule.rows[0]?.requested_ends_at).not.toBe(schedule.rows[0]?.ends_at)
    expect(fundedBody.ends_at - fundedBody.starts_at).toBe(
      Math.floor((Date.parse(String(schedule.rows[0]?.requested_ends_at)) - Date.parse(String(schedule.rows[0]?.requested_starts_at))) / 1000),
    )
  })

  test("handles partial, pending, expired, and rejected campaign funding safely", async () => {
    const ctx = await createRouteTestContext({
      ...campaignEnv(),
    })
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "reward-funding-adversarial")
    await addWallet(ctx, session.userId, new Date().toISOString())
    await seedCampaignSong(ctx, session.userId)
    const create = await app.request("http://pirate.test/reward_campaigns", {
      method: "POST",
      headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
      body: JSON.stringify(campaignBody({ idempotency_key: "funding-adversarial-campaign" })),
    }, ctx.env)
    const campaign = await json(create) as { id: string }
    const quote = async (amountCents: number, key: string) => {
      const response = await app.request(`http://pirate.test/reward_campaigns/${campaign.id}/funding_quotes`, {
        method: "POST",
        headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
        body: JSON.stringify({ amount_cents: amountCents, idempotency_key: key }),
      }, ctx.env)
      expect(response.status).toBe(201)
      return await json(response) as { id: string }
    }
    const confirm = (fundingId: string, hex: string) => app.request(
      `http://pirate.test/reward_campaigns/${campaign.id}/funding_quotes/${fundingId}/confirm`,
      {
        method: "POST",
        headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
        body: JSON.stringify({ tx_hash: `0x${hex.repeat(64)}` }),
      },
      ctx.env,
    )

    const partial = await quote(40000, "partial-funding")
    let verificationCalls = 0
    setBookingPaymentVerifierForTests(async ({ fundingTxRef, expected }) => {
      verificationCalls += 1
      return verificationCalls === 1
        ? { kind: "pending", reason: "receipt_pending" }
        : { kind: "verified", senderAddress: expected.senderAddress, txRef: fundingTxRef }
    })
    expect(await json(await confirm(partial.id, "c"))).toMatchObject({ status: "confirming" })
    expect(await json(await confirm(partial.id, "c"))).toMatchObject({ status: "confirmed" })
    const partiallyFunded = await app.request(`http://pirate.test/reward_campaigns/${campaign.id}`, {
      headers: authHeaders(session.accessToken),
    }, ctx.env)
    expect(await json(partiallyFunded)).toMatchObject({ status: "active", funded_cents: 40000 })

    const expired = await quote(10000, "expired-funding")
    await ctx.client.execute({
      sql: "UPDATE reward_campaign_funding_effects SET expires_at = '2020-01-01T00:00:00.000Z' WHERE reward_campaign_funding_effect_id = ?1",
      args: [expired.id],
    })
    const expiredConfirm = await confirm(expired.id, "d")
    expect(expiredConfirm.status).toBe(200)
    expect(await json(expiredConfirm)).toMatchObject({
      status: "refund_pending",
      failure_reason: "funding_confirmed_after_quote_expiry",
    })
    // A lapsed quote is now verified rather than refused on wall-clock alone: only the chain can
    // say whether the transfer was mined in time. This stub reports no block timestamp, so the
    // transfer cannot be proven timely and is held for an operator refund — fail closed.
    expect(verificationCalls).toBe(3)

    const wrongAmount = await quote(10000, "wrong-amount-custody")
    let custodyVerificationCalls = 0
    setBookingPaymentVerifierForTests(async ({ fundingTxRef, expected }) => {
      custodyVerificationCalls += 1
      return {
        kind: "custody_mismatch",
        reason: "wrong_transfer_amount",
        senderAddress: expected.senderAddress,
        txRef: fundingTxRef,
        observedAmountAtomic: "90000000",
      }
    })
    const wrongAmountResponse = await confirm(wrongAmount.id, "f")
    expect(wrongAmountResponse.status).toBe(200)
    expect(await json(wrongAmountResponse)).toMatchObject({
      status: "refund_pending",
      failure_reason: "wrong_transfer_amount",
    })
    expect(await json(await confirm(wrongAmount.id, "f"))).toMatchObject({ status: "refund_pending" })
    expect(custodyVerificationCalls).toBe(1)
    const custodyEffect = await ctx.client.execute({
      sql: "SELECT status, received_amount_atomic FROM reward_campaign_funding_effects WHERE reward_campaign_funding_effect_id = ?1",
      args: [wrongAmount.id],
    })
    expect(custodyEffect.rows).toEqual([{ status: "refund_pending", received_amount_atomic: "90000000" }])

    const awaitingFinality = await reconcileRewardFundingRefunds({
      env: {
        ...ctx.env,
        REWARDS_CAMPAIGNS_ENABLED: "false",
        REWARDS_PAYOUTS_ENABLED: "false",
        REWARDS_REFUNDS_ENABLED: "true",
      },
      client: ctx.client,
      verify: async () => ({ kind: "pending", reason: "safe_block_pending" }),
    })
    expect(awaitingFinality).toMatchObject({
      scanned: 2,
      enqueued: 0,
      confirmed: 0,
      pending_finality: 2,
      errors: 0,
    })

    let refundSequence = 0
    setRewardFundingRefundCoordinatorForTests({
      settle: async (request) => {
        refundSequence += 1
        expect(request).toMatchObject({
          operatorKind: "rewards",
          effectKind: "reward_funding_refund",
          fundingEffectId: request.idempotencyKey,
        })
        return {
          idempotencyKey: JSON.stringify(["reward_funding_refund", request.idempotencyKey]),
          txHash: `0x${refundSequence.toString(16).padStart(64, "0")}`,
          nonce: refundSequence,
          state: "confirmed",
        }
      },
    })
    const refunded = await reconcileRewardFundingRefunds({
      env: ctx.env,
      client: ctx.client,
      verify: async (expected, txHash) => ({
        kind: "verified",
        senderAddress: expected.senderAddress,
        txRef: txHash,
      }),
    })
    expect(refunded).toMatchObject({ scanned: 2, enqueued: 2, confirmed: 2, errors: 0 })
    const refundEffects = await ctx.client.execute({
      sql: `
        SELECT status, received_amount_atomic, refund_tx_hash, refund_confirmed_at
        FROM reward_campaign_funding_effects
        WHERE reward_campaign_funding_effect_id IN (?1, ?2)
        ORDER BY reward_campaign_funding_effect_id
      `,
      args: [expired.id, wrongAmount.id],
    })
    expect(refundEffects.rows).toHaveLength(2)
    expect(refundEffects.rows.every((row) => row.status === "refunded" && row.refund_tx_hash && row.refund_confirmed_at)).toBe(true)

    for (const [reason, hex] of [["wrong_transfer_recipient", "e"]] as const) {
      const rejected = await quote(10000, `rejected-${reason}`)
      let rejectedVerificationCalls = 0
      setBookingPaymentVerifierForTests(async () => {
        rejectedVerificationCalls += 1
        return { kind: "rejected", reason }
      })
      const rejectedResponse = await confirm(rejected.id, hex)
      expect(rejectedResponse.status).toBe(200)
      expect(await json(rejectedResponse)).toMatchObject({ status: "failed", failure_reason: reason })
      expect(await json(await confirm(rejected.id, hex))).toMatchObject({ status: "failed", failure_reason: reason })
      expect(rejectedVerificationCalls).toBe(1)
    }
    const finalCampaign = await app.request(`http://pirate.test/reward_campaigns/${campaign.id}`, {
      headers: authHeaders(session.accessToken),
    }, ctx.env)
    expect(await json(finalCampaign)).toMatchObject({
      status: "funding_quoted",
      funded_cents: 40000,
      refunded_cents: 0,
    })
    const reconciliation = await ctx.client.execute({
      sql: `
        SELECT stored_funded_cents, computed_funded_cents, counters_match
        FROM reward_campaign_accounting_reconciliation
        WHERE reward_campaign_id = ?1
      `,
      args: [campaign.id],
    })
    expect(reconciliation.rows).toEqual([{
      stored_funded_cents: 40000,
      computed_funded_cents: 40000,
      counters_match: 1,
    }])
  })

  test("allows only one concurrent campaign to consume a funding transaction", async () => {
    const ctx = await createRouteTestContext(campaignEnv())
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "reward-funding-concurrent")
    await addWallet(ctx, session.userId, new Date().toISOString())
    await seedCampaignSong(ctx, session.userId, "pst_reward_concurrent_a")
    await seedCampaignSong(ctx, session.userId, "pst_reward_concurrent_b")

    const createFundableCampaign = async (post: string, suffix: string) => {
      const created = await app.request("http://pirate.test/reward_campaigns", {
        method: "POST",
        headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
        body: JSON.stringify(campaignBody({ post, idempotency_key: `concurrent-campaign-${suffix}` })),
      }, ctx.env)
      expect(created.status).toBe(201)
      const campaign = await json(created) as { id: string }
      const quoted = await app.request(`http://pirate.test/reward_campaigns/${campaign.id}/funding_quotes`, {
        method: "POST",
        headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
        body: JSON.stringify({ amount_cents: 100000, idempotency_key: `concurrent-quote-${suffix}` }),
      }, ctx.env)
      expect(quoted.status).toBe(201)
      return { campaignId: campaign.id, fundingId: (await json(quoted) as { id: string }).id }
    }
    const first = await createFundableCampaign("pst_reward_concurrent_a", "a")
    const second = await createFundableCampaign("pst_reward_concurrent_b", "b")
    let verificationCalls = 0
    setBookingPaymentVerifierForTests(async ({ fundingTxRef, expected }) => {
      verificationCalls += 1
      await Promise.resolve()
      return { kind: "verified", senderAddress: expected.senderAddress, txRef: fundingTxRef }
    })
    const txHash = `0x${"1".repeat(64)}`
    const submit = ({ campaignId, fundingId }: { campaignId: string; fundingId: string }) => app.request(
      `http://pirate.test/reward_campaigns/${campaignId}/funding_quotes/${fundingId}/confirm`,
      {
        method: "POST",
        headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
        body: JSON.stringify({ tx_hash: txHash }),
      },
      ctx.env,
    )
    const responses = await Promise.all([submit(first), submit(second)])
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409])
    expect(verificationCalls).toBe(1)
    const consumed = await ctx.client.execute({
      sql: "SELECT COUNT(*) AS count FROM reward_campaign_funding_effects WHERE chain_id = 84532 AND tx_hash = ?1",
      args: [txHash],
    })
    expect(consumed.rows[0]?.count).toBe(1)
  })

  test("GET /me/rewards returns ledger balance, today earnings, recent events, and nullifier gate state", async () => {
    const ctx = await createRouteTestContext({
      REWARDS_READS_ENABLED: "true",
      REWARDS_CAMPAIGN_CHAIN_ID: "84532",
      PIRATE_REWARDS_SETTLEMENT_CHAIN_ID: "84532",
      PIRATE_REWARDS_SETTLEMENT_BACKEND: "local",
      REWARDS_IDENTITY_PROVIDER: "self",
      REWARDS_MIN_CASHOUT_CENTS: "100",
    })
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "reward-route-user")
    const otherSession = await exchangeJwt(ctx.env, "reward-route-other-user")
    const now = "2026-07-09T12:00:00.000Z"
    const today = todayUtc()

    await createRewardsCommunity(ctx, session.userId, now)

    await ctx.client.execute({
      sql: `
        INSERT INTO reward_user_days (user_id, activity_date, credited_cents, updated_at)
        VALUES (?1, ?2, 30, ?3)
      `,
      args: [session.userId, today, now],
    })
    await ctx.client.execute({
      sql: `
        INSERT INTO reward_events (
          reward_event_id, user_id, community_id, post_id, activity_date,
          reward_kind, amount_cents, source, created_at
        )
        VALUES
          ('rew_route_day', ?1, 'cmt_rewards_route', 'pst_reward_song', ?2, 'study_streak_day', 30, 'song_engagement_reconciler', ?3),
          ('rew_route_milestone', ?1, 'cmt_rewards_route', 'pst_reward_song', ?2, 'study_streak_milestone_7', 50, 'song_engagement_reconciler', ?3),
          ('rew_route_other', ?4, 'cmt_rewards_route', 'pst_reward_song', ?2, 'study_streak_day', 10, 'song_engagement_reconciler', ?3)
      `,
      args: [session.userId, today, now, otherSession.userId],
    })

    const unverified = await app.request(
      "http://pirate.test/me/rewards",
      { headers: authHeaders(session.accessToken) },
      ctx.env,
    )
    expect(unverified.status).toBe(200)
    const unverifiedBody = await json(unverified) as {
      balance_cents: number
      today_earned_cents: number
      recent_events: Array<{ id: string; amount_cents: number; reward_kind: string }>
      cashout: { eligible: boolean; min_cents: number; verification_state: string; verification_provider: string }
    }
    expect(unverifiedBody.balance_cents).toBe(80)
    expect(unverifiedBody.today_earned_cents).toBe(30)
    expect(unverifiedBody.recent_events.map((event) => event.id).sort()).toEqual(["rew_route_day", "rew_route_milestone"])
    expect(unverifiedBody.cashout).toEqual({
      eligible: false,
      min_cents: 100,
      verification_state: "unverified",
      verification_provider: null,
    })

    await addNullifier(ctx, session.userId, now)
    await ctx.client.execute({
      sql: `
        INSERT INTO reward_events (
          reward_event_id, user_id, community_id, post_id, activity_date,
          reward_kind, amount_cents, source, created_at
        )
        VALUES ('rew_route_cashout_ready', ?1, 'cmt_rewards_route', 'pst_reward_song_2', ?2, 'study_streak_day', 20, 'song_engagement_reconciler', ?3)
      `,
      args: [session.userId, today, now],
    })
    await ctx.client.execute({
      sql: `
        INSERT INTO reward_payout_effects (
          reward_payout_effect_id, user_id, amount_cents, recipient_address,
          idempotency_key, status, submitted_at, created_at, updated_at
        )
        VALUES (
          'rpe_route_pending', ?1, 10, '0x1000000000000000000000000000000000000001',
          'reward-cashout:route-pending', 'submitted', ?2, ?2, ?2
        )
      `,
      args: [session.userId, now],
    })

    const verified = await app.request(
      "http://pirate.test/me/rewards",
      { headers: authHeaders(session.accessToken) },
      ctx.env,
    )
    expect(verified.status).toBe(200)
    const verifiedBody = await json(verified) as {
      balance_cents: number
      cashout: { eligible: boolean; min_cents: number; verification_state: string; verification_provider: string }
      latest_in_flight_cashout: { id: string; amount_cents: number; status: string; settlement_stage: string } | null
    }
    expect(verifiedBody.balance_cents).toBe(90)
    expect(verifiedBody.cashout).toEqual({
      eligible: false,
      min_cents: 100,
      verification_state: "verified",
      verification_provider: "self",
    })
    expect(verifiedBody.latest_in_flight_cashout).toMatchObject({
      id: "rpe_route_pending",
      amount_cents: 10,
      status: "submitted",
      settlement_stage: "reserved",
    })

    ctx.env.REWARDS_IDENTITY_PROVIDER = "very"
    const wrongIdentityNamespace = await app.request(
      "http://pirate.test/me/rewards",
      { headers: authHeaders(session.accessToken) },
      ctx.env,
    )
    expect((await json(wrongIdentityNamespace) as { cashout: { verification_state: string } }).cashout.verification_state).toBe("verified")
  })

  test("GET /me/rewards requires authentication", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const response = await app.request("http://pirate.test/me/rewards", {}, ctx.env)
    expect(response.status).toBe(401)
  })

  test("GET /me/rewards advertises cashout eligibility only while payouts are enabled", async () => {
    const ctx = await createRouteTestContext({
      REWARDS_READS_ENABLED: "true",
      REWARDS_PAYOUTS_ENABLED: "true",
      REWARDS_CAMPAIGN_CHAIN_ID: "84532",
      PIRATE_REWARDS_SETTLEMENT_CHAIN_ID: "84532",
      PIRATE_REWARDS_SETTLEMENT_BACKEND: "local",
      REWARDS_IDENTITY_PROVIDER: "self",
      REWARDS_MIN_CASHOUT_CENTS: "100",
    })
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "reward-cashout-capability-user")
    const now = "2026-08-12T12:00:00.000Z"
    await addNullifier(ctx, session.userId, now)
    await addRewardEvent(ctx, session.userId, 100, now)

    const readEligibility = async (): Promise<boolean> => {
      const response = await app.request(
        "http://pirate.test/me/rewards",
        { headers: authHeaders(session.accessToken) },
        ctx.env,
      )
      expect(response.status).toBe(200)
      return (await json(response) as { cashout: { eligible: boolean } }).cashout.eligible
    }

    expect(await readEligibility()).toBe(true)

    ctx.env.REWARDS_PAYOUTS_ENABLED = "false"
    expect(await readEligibility()).toBe(false)

    ctx.env.REWARDS_PAYOUTS_ENABLED = undefined
    expect(await readEligibility()).toBe(false)
  })

  test("selects a nullifier-scoped nationality document through the authenticated rewards route", async () => {
    const ctx = await createRouteTestContext({ REWARDS_IDENTITY_PROVIDER: "self" })
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "reward-binding-route-user")
    const now = "2026-08-01T10:00:00.000Z"
    await addNullifier(ctx, session.userId, now)
    const nullifierId = `idn_rewards_${session.userId}`
    await ctx.client.execute({
      sql: `
        INSERT INTO user_attestations (
          user_attestation_id, user_id, provider, attestation_type, capability_key, status,
          value_json, verified_at, created_at, updated_at, source_identity_nullifier_id
        ) VALUES ('att_reward_binding_route', ?1, 'self', 'nationality', 'nationality',
          'accepted', ?2, ?3, ?3, ?3, ?4)
      `,
      args: [session.userId, JSON.stringify({ nationality: "USA" }), now, nullifierId],
    })

    const before = await app.request("http://pirate.test/me/rewards/identity-binding", {
      headers: authHeaders(session.accessToken),
    }, ctx.env)
    expect(before.status).toBe(200)
    expect(await json(before)).toMatchObject({
      capability: "selection_required",
      selectable_documents: [{ identity_nullifier_id: nullifierId, nationality: "USA" }],
    })

    const selected = await app.request("http://pirate.test/me/rewards/identity-binding", {
      method: "POST",
      headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
      body: JSON.stringify({ identity_nullifier_id: nullifierId }),
    }, ctx.env)
    expect(selected.status).toBe(201)
    const selectedBody = await json(selected) as { active_binding: { id: string; selected_at: number } }
    expect(selectedBody).toMatchObject({
      capability: "selected",
      active_binding: { identity_nullifier_id: nullifierId, nationality: "USA" },
    })

    const retry = await app.request("http://pirate.test/me/rewards/identity-binding", {
      method: "POST",
      headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
      body: JSON.stringify({ identity_nullifier_id: nullifierId }),
    }, ctx.env)
    expect(retry.status).toBe(201)
    expect((await json(retry) as { active_binding: unknown }).active_binding).toEqual(selectedBody.active_binding)
  })

  test("reward reads and payouts fail closed when their independent flags are not true", async () => {
    const ctx = await createRouteTestContext({
      REWARDS_CAMPAIGN_CHAIN_ID: "84532",
      PIRATE_REWARDS_SETTLEMENT_CHAIN_ID: "84532",
      REWARDS_MIN_CASHOUT_CENTS: "100",
    })
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "reward-disabled-user")
    const now = "2026-07-09T12:00:00.000Z"
    let settleCount = 0
    setRewardSettlementCoordinatorForTests({
      settle: async (req) => {
        settleCount += 1
        return { idempotencyKey: JSON.stringify(["reward_payout", req.idempotencyKey]), txHash: "0xrewardtx", nonce: 12, state: "broadcast" }
      },
      confirm: async (req, txHash) => ({ idempotencyKey: JSON.stringify(["reward_payout", req.idempotencyKey]), txHash, nonce: 12, state: "confirmed" }),
      reconcile: async (req) => ({ idempotencyKey: JSON.stringify(["reward_payout", req.idempotencyKey]), txHash: "0xrewardtx", nonce: 12, state: "broadcast" }),
    })

    await addWallet(ctx, session.userId, now)
    await addNullifier(ctx, session.userId, now)
    await addRewardEvent(ctx, session.userId, 150, now)

    const summary = await app.request(
      "http://pirate.test/me/rewards",
      { headers: authHeaders(session.accessToken) },
      ctx.env,
    )
    expect(summary.status).toBe(200)
    expect(await json(summary)).toEqual({
      chain_id: 84532,
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
        min_cents: 100,
        verification_state: "unverified",
        verification_provider: null,
      },
      latest_in_flight_cashout: null,
    })

    const cashout = await app.request(
      "http://pirate.test/me/rewards/cashouts",
      {
        method: "POST",
        headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
        body: JSON.stringify({ amount_cents: 100, idempotency_key: "reward-cashout-disabled" }),
      },
      ctx.env,
    )
    expect(cashout.status).toBe(403)
    expect(settleCount).toBe(0)
  })

  test("accepts ZKPassport and Very cashouts while the legacy environment provider is Self", async () => {
    const ctx = await createRouteTestContext({
      REWARDS_PAYOUTS_ENABLED: "true",
      REWARDS_CAMPAIGN_CHAIN_ID: "84532",
      PIRATE_REWARDS_SETTLEMENT_CHAIN_ID: "84532",
      REWARDS_IDENTITY_PROVIDER: "self",
      REWARDS_MIN_CASHOUT_CENTS: "100",
    })
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "reward-zkpassport-namespace-user")
    const now = "2026-07-09T12:00:00.000Z"
    let settleCount = 0
    setRewardSettlementCoordinatorForTests({
      settle: async (req) => {
        settleCount += 1
        return { idempotencyKey: JSON.stringify(["reward_payout", req.idempotencyKey]), txHash: "0xshouldnotsettle", nonce: 1, state: "broadcast" }
      },
      confirm: async (req, txHash) => ({ idempotencyKey: JSON.stringify(["reward_payout", req.idempotencyKey]), txHash, nonce: 1, state: "confirmed" }),
      reconcile: async (req) => ({ idempotencyKey: JSON.stringify(["reward_payout", req.idempotencyKey]), txHash: "0xshouldnotsettle", nonce: 1, state: "broadcast" }),
    })
    await addWallet(ctx, session.userId, now)
    await addRewardEvent(ctx, session.userId, 150, now)
    await ctx.client.execute({
      sql: `
        INSERT INTO identity_nullifiers (
          identity_nullifier_id, user_id, provider, mechanism, nullifier_hash, status,
          first_seen_at, created_at, updated_at
        ) VALUES (
          'idn_rewards_zkpassport', ?1, 'zkpassport', 'zkpassport-unique-identifier',
          'reward-zkpassport-nullifier', 'active', ?2, ?2, ?2
        )
      `,
      args: [session.userId, now],
    })
    await ctx.client.execute({
      sql: "UPDATE users SET verification_capabilities_json = ?2 WHERE user_id = ?1",
      args: [session.userId, JSON.stringify({
        unique_human: {
          state: "verified",
          provider: "zkpassport",
          proof_type: "unique_human",
          mechanism: "zkpassport-unique-identifier",
          verified_at: Math.floor(Date.parse(now) / 1000),
        },
      })],
    })

    const response = await app.request(
      "http://pirate.test/me/rewards/cashouts",
      {
        method: "POST",
        headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
        body: JSON.stringify({ amount_cents: 100, idempotency_key: "reward-cashout-zkpassport-only" }),
      },
      ctx.env,
    )
    expect(response.status).toBe(202)
    expect(settleCount).toBe(1)

    const verySession = await exchangeJwt(ctx.env, "reward-very-namespace-user")
    await addWallet(ctx, verySession.userId, now, "0x2000000000000000000000000000000000000002")
    await addRewardEvent(ctx, verySession.userId, 150, now)
    await ctx.client.execute({
      sql: `
        INSERT INTO identity_nullifiers (
          identity_nullifier_id, user_id, provider, mechanism, nullifier_hash, status,
          first_seen_at, created_at, updated_at
        ) VALUES (
          'idn_rewards_very', ?1, 'very', 'palm-nullifier',
          'reward-very-nullifier', 'active', ?2, ?2, ?2
        )
      `,
      args: [verySession.userId, now],
    })
    await ctx.client.execute({
      sql: "UPDATE users SET verification_capabilities_json = ?2 WHERE user_id = ?1",
      args: [verySession.userId, JSON.stringify({
        unique_human: {
          state: "verified",
          provider: "very",
          proof_type: "unique_human",
          mechanism: "palm-nullifier",
          verified_at: Math.floor(Date.parse(now) / 1000),
        },
      })],
    })
    const veryResponse = await app.request(
      "http://pirate.test/me/rewards/cashouts",
      {
        method: "POST",
        headers: { ...authHeaders(verySession.accessToken), "content-type": "application/json" },
        body: JSON.stringify({ amount_cents: 100, idempotency_key: "reward-cashout-very" }),
      },
      ctx.env,
    )
    expect(veryResponse.status).toBe(202)
    expect(settleCount).toBe(2)
  })

  test("POST /me/rewards/cashouts gates on nullifier, balance, and idempotently confirms a payout", async () => {
    const ctx = await createRouteTestContext({
      REWARDS_PAYOUTS_ENABLED: "true",
      REWARDS_CAMPAIGN_CHAIN_ID: "84532",
      PIRATE_REWARDS_SETTLEMENT_CHAIN_ID: "84532",
      PIRATE_REWARDS_SETTLEMENT_BACKEND: "local",
      REWARDS_IDENTITY_PROVIDER: "self",
      REWARDS_MIN_CASHOUT_CENTS: "100",
    })
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "reward-cashout-user")
    const now = "2026-07-09T12:00:00.000Z"
    let settleCount = 0
    setRewardSettlementConfirmPollPlanForTests([])
    setRewardSettlementCoordinatorForTests({
      settle: async (req) => {
        settleCount += 1
        return { idempotencyKey: JSON.stringify(["reward_payout", req.idempotencyKey]), txHash: "0xrewardtx", nonce: 12, state: "broadcast" }
      },
      confirm: async (req, txHash) => ({ idempotencyKey: JSON.stringify(["reward_payout", req.idempotencyKey]), txHash, nonce: 12, state: "confirmed" }),
      reconcile: async (req) => ({ idempotencyKey: JSON.stringify(["reward_payout", req.idempotencyKey]), txHash: "0xrewardtx", nonce: 12, state: "broadcast" }),
    })

    await addWallet(ctx, session.userId, now)
    await addRewardEvent(ctx, session.userId, 150, now)

    const unverified = await app.request(
      "http://pirate.test/me/rewards/cashouts",
      {
        method: "POST",
        headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
        body: JSON.stringify({ amount_cents: 100, idempotency_key: "reward-cashout-test-1" }),
      },
      ctx.env,
    )
    expect(unverified.status).toBe(403)
    expect(settleCount).toBe(0)

    await addNullifier(ctx, session.userId, "2025-01-01T12:00:00.000Z")
    const expiredVerification = await app.request(
      "http://pirate.test/me/rewards/cashouts",
      {
        method: "POST",
        headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
        body: JSON.stringify({ amount_cents: 100, idempotency_key: "reward-cashout-expired-human" }),
      },
      ctx.env,
    )
    expect(expiredVerification.status).toBe(403)
    expect(settleCount).toBe(0)

    await addNullifier(ctx, session.userId, now)
    const belowMinimum = await app.request(
      "http://pirate.test/me/rewards/cashouts",
      {
        method: "POST",
        headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
        body: JSON.stringify({ amount_cents: 99, idempotency_key: "reward-cashout-test-below-min" }),
      },
      ctx.env,
    )
    expect(belowMinimum.status).toBe(403)
    expect(settleCount).toBe(0)

    const tooMuch = await app.request(
      "http://pirate.test/me/rewards/cashouts",
      {
        method: "POST",
        headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
        body: JSON.stringify({ amount_cents: 200, idempotency_key: "reward-cashout-test-too-much" }),
      },
      ctx.env,
    )
    expect(tooMuch.status).toBe(403)
    expect(settleCount).toBe(0)

    const response = await app.request(
      "http://pirate.test/me/rewards/cashouts",
      {
        method: "POST",
        headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
        body: JSON.stringify({ amount_cents: 100, idempotency_key: "reward-cashout-test-1" }),
      },
      ctx.env,
    )
    expect(response.status).toBe(202)
    const body = await json(response) as {
      payout: { id: string; amount_cents: number; status: string; settlement_stage: string; settlement_ref: string | null; recipient_address: string }
      balance_cents: number
    }
    expect(body.payout.amount_cents).toBe(100)
    expect((body as typeof body & { chain_id: number }).chain_id).toBe(84532)
    expect((body.payout as typeof body.payout & { chain_id: number }).chain_id).toBe(84532)
    expect(body.payout.status).toBe("confirmed")
    expect(body.payout.settlement_stage).toBe("confirmed")
    expect(body.payout.settlement_ref).toBe("0xrewardtx")
    expect(body.payout.recipient_address).toBe("0x1000000000000000000000000000000000000001")
    expect(body.balance_cents).toBe(50)
    expect(settleCount).toBe(1)

    const statusResponse = await app.request(
      `http://pirate.test/me/rewards/cashouts/${body.payout.id}`,
      { headers: authHeaders(session.accessToken) },
      ctx.env,
    )
    expect(statusResponse.status).toBe(200)
    expect(await json(statusResponse)).toEqual(body)

    await ctx.client.execute({
      sql: "UPDATE wallet_attachments SET wallet_address_display = ?2 WHERE user_id = ?1 AND status = 'active'",
      args: [session.userId, "0x3000000000000000000000000000000000000003"],
    })
    await ctx.client.execute({
      sql: "DELETE FROM identity_nullifiers WHERE user_id = ?1",
      args: [session.userId],
    })

    const replay = await app.request(
      "http://pirate.test/me/rewards/cashouts",
      {
        method: "POST",
        headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
        body: JSON.stringify({ amount_cents: 100, idempotency_key: "reward-cashout-test-1" }),
      },
      ctx.env,
    )
    expect(replay.status).toBe(202)
    expect(settleCount).toBe(1)
    const replayBody = await json(replay) as { balance_cents: number; payout: { recipient_address: string; status: string } }
    expect(replayBody.balance_cents).toBe(50)
    expect(replayBody.payout.status).toBe("confirmed")
    expect(replayBody.payout.recipient_address).toBe("0x1000000000000000000000000000000000000001")

    const otherSession = await exchangeJwt(ctx.env, "reward-cashout-other-user")
    await addWallet(ctx, otherSession.userId, now, "0x2000000000000000000000000000000000000002")
    await addNullifier(ctx, otherSession.userId, now)
    await addRewardEvent(ctx, otherSession.userId, 150, now)
    const sameKeyOtherUser = await app.request(
      "http://pirate.test/me/rewards/cashouts",
      {
        method: "POST",
        headers: { ...authHeaders(otherSession.accessToken), "content-type": "application/json" },
        body: JSON.stringify({ amount_cents: 100, idempotency_key: "reward-cashout-test-1" }),
      },
      ctx.env,
    )
    expect(sameKeyOtherUser.status).toBe(202)
    expect(settleCount).toBe(2)

    const otherUserCannotReadCashout = await app.request(
      `http://pirate.test/me/rewards/cashouts/${body.payout.id}`,
      { headers: authHeaders(otherSession.accessToken) },
      ctx.env,
    )
    expect(otherUserCannotReadCashout.status).toBe(404)
  })

  test("deduplicates different idempotency keys while one cashout is submitted", async () => {
    const ctx = await createRouteTestContext({
      REWARDS_PAYOUTS_ENABLED: "true",
      REWARDS_CAMPAIGN_CHAIN_ID: "84532",
      PIRATE_REWARDS_SETTLEMENT_CHAIN_ID: "84532",
      REWARDS_IDENTITY_PROVIDER: "self",
      REWARDS_MIN_CASHOUT_CENTS: "100",
    })
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "reward-cashout-inflight-user")
    const now = "2026-07-09T12:00:00.000Z"
    let settleCount = 0
    setRewardSettlementConfirmPollPlanForTests([])
    setRewardSettlementCoordinatorForTests({
      settle: async (req) => {
        settleCount += 1
        return { idempotencyKey: JSON.stringify(["reward_payout", req.idempotencyKey]), txHash: "0xinflight", nonce: 14, state: "broadcast" }
      },
      confirm: async (req, txHash) => ({ idempotencyKey: JSON.stringify(["reward_payout", req.idempotencyKey]), txHash, nonce: 14, state: "broadcast" }),
      reconcile: async (req) => ({ idempotencyKey: JSON.stringify(["reward_payout", req.idempotencyKey]), txHash: "0xinflight", nonce: 14, state: "broadcast" }),
    })
    await addWallet(ctx, session.userId, now)
    await addNullifier(ctx, session.userId, now)
    await addRewardEvent(ctx, session.userId, 250, now)

    const postCashout = (amountCents: number, idempotencyKey: string) => app.request(
      "http://pirate.test/me/rewards/cashouts",
      {
        method: "POST",
        headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
        body: JSON.stringify({ amount_cents: amountCents, idempotency_key: idempotencyKey }),
      },
      ctx.env,
    )
    const first = await postCashout(100, "reward-cashout-inflight-tab-a")
    const second = await postCashout(100, "reward-cashout-inflight-tab-b")
    expect(first.status).toBe(202)
    expect(second.status).toBe(202)
    const firstBody = await json(first) as { payout: { id: string; status: string } }
    const secondBody = await json(second) as { payout: { id: string; status: string } }
    expect(firstBody.payout.status).toBe("submitted")
    expect(secondBody.payout.id).toBe(firstBody.payout.id)
    expect(settleCount).toBe(2)

    const differentAmount = await postCashout(110, "reward-cashout-inflight-tab-c")
    expect(differentAmount.status).toBe(409)
    const count = await ctx.client.execute({
      sql: "SELECT COUNT(*) AS count FROM reward_payout_effects WHERE user_id = ?1",
      args: [session.userId],
    })
    expect(count.rows[0]?.count).toBe(1)
    await expect(ctx.client.execute({
      sql: `
        INSERT INTO reward_payout_effects (
          reward_payout_effect_id, user_id, amount_cents, recipient_address,
          idempotency_key, status, submitted_at, created_at, updated_at
        ) VALUES (
          'rpe_route_duplicate_submitted', ?1, 100,
          '0x1000000000000000000000000000000000000001',
          'reward-cashout-raw-duplicate', 'submitted', ?2, ?2, ?2
        )
      `,
      args: [session.userId, now],
    })).rejects.toThrow()
  })

  test("POST /me/rewards/cashouts can attach a verified Privy wallet at claim time", async () => {
    const ctx = await createRouteTestContext({
      REWARDS_PAYOUTS_ENABLED: "true",
      REWARDS_CAMPAIGN_CHAIN_ID: "84532",
      PIRATE_REWARDS_SETTLEMENT_CHAIN_ID: "84532",
      REWARDS_IDENTITY_PROVIDER: "self",
      REWARDS_MIN_CASHOUT_CENTS: "100",
    })
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "reward-cashout-attach-user")
    const now = "2026-07-09T12:00:00.000Z"
    const privySubject = "did:privy:reward-cashout-attach"
    const walletAddress = "0x3000000000000000000000000000000000000003"
    let settleCount = 0
    setRewardSettlementConfirmPollPlanForTests([])
    setRewardSettlementCoordinatorForTests({
      settle: async (req) => {
        settleCount += 1
        return { idempotencyKey: JSON.stringify(["reward_payout", req.idempotencyKey]), txHash: "0xrewardattach", nonce: 14, state: "broadcast" }
      },
      confirm: async (req, txHash) => ({ idempotencyKey: JSON.stringify(["reward_payout", req.idempotencyKey]), txHash, nonce: 14, state: "confirmed" }),
      reconcile: async (req) => ({ idempotencyKey: JSON.stringify(["reward_payout", req.idempotencyKey]), txHash: "0xrewardattach", nonce: 14, state: "broadcast" }),
    })
    setPrivyAccessProofVerifierForTests(async ({ accessToken, walletAddress: selectedWalletAddress }) => {
      expect(accessToken).toBe("privy-reward-attach-token")
      expect(selectedWalletAddress).toBe(walletAddress)
      return {
        provider: "privy",
        providerSubject: privySubject,
        providerUserRef: privySubject,
        walletAddresses: [walletAddress.toLowerCase()],
        selectedWalletAddress: walletAddress.toLowerCase(),
        wallets: [
          {
            chainNamespace: "eip155:1",
            walletAddress,
            walletAddressNormalized: walletAddress.toLowerCase(),
            attachmentKind: "embedded",
          },
        ],
        selectedWallet: {
          chainNamespace: "eip155:1",
          walletAddress,
          walletAddressNormalized: walletAddress.toLowerCase(),
          attachmentKind: "embedded",
        },
      }
    })

    await linkPrivySubject(ctx, session.userId, privySubject, now)
    await addNullifier(ctx, session.userId, now)
    await addRewardEvent(ctx, session.userId, 150, now)

    const response = await app.request(
      "http://pirate.test/me/rewards/cashouts",
      {
        method: "POST",
        headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
        body: JSON.stringify({
          amount_cents: 100,
          idempotency_key: "reward-cashout-attach-wallet",
          wallet_proof: {
            type: "privy_access_token",
            privy_access_token: "privy-reward-attach-token",
            wallet_address: walletAddress,
          },
        }),
      },
      ctx.env,
    )
    expect(response.status).toBe(202)
    const body = await json(response) as {
      payout: { recipient_address: string; status: string; settlement_ref: string | null }
      balance_cents: number
    }
    expect(body.payout).toMatchObject({
      recipient_address: walletAddress,
      status: "confirmed",
      settlement_ref: "0xrewardattach",
    })
    expect(body.balance_cents).toBe(50)
    expect(settleCount).toBe(1)

    const attached = await ctx.client.execute({
      sql: `
        SELECT chain_namespace, wallet_address_display, attachment_kind, is_primary
        FROM wallet_attachments
        WHERE user_id = ?1
      `,
      args: [session.userId],
    })
    expect(attached.rows).toEqual([
      {
        chain_namespace: "eip155:1",
        wallet_address_display: walletAddress,
        attachment_kind: "embedded",
        is_primary: 1,
      },
    ])
  })

  test("POST /me/rewards/cashouts rejects a claim-time wallet proof linked to another account", async () => {
    const ctx = await createRouteTestContext({
      REWARDS_PAYOUTS_ENABLED: "true",
      REWARDS_CAMPAIGN_CHAIN_ID: "84532",
      PIRATE_REWARDS_SETTLEMENT_CHAIN_ID: "84532",
      REWARDS_IDENTITY_PROVIDER: "self",
      REWARDS_MIN_CASHOUT_CENTS: "100",
    })
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "reward-cashout-proof-user")
    const otherSession = await exchangeJwt(ctx.env, "reward-cashout-proof-other")
    const now = "2026-07-09T12:00:00.000Z"
    const privySubject = "did:privy:reward-cashout-other"
    const walletAddress = "0x4000000000000000000000000000000000000004"
    let settleCount = 0
    setRewardSettlementCoordinatorForTests({
      settle: async (req) => {
        settleCount += 1
        return { idempotencyKey: JSON.stringify(["reward_payout", req.idempotencyKey]), txHash: "0xrewardproof", nonce: 15, state: "broadcast" }
      },
      confirm: async (req, txHash) => ({ idempotencyKey: JSON.stringify(["reward_payout", req.idempotencyKey]), txHash, nonce: 15, state: "confirmed" }),
      reconcile: async (req) => ({ idempotencyKey: JSON.stringify(["reward_payout", req.idempotencyKey]), txHash: "0xrewardproof", nonce: 15, state: "broadcast" }),
    })
    setPrivyAccessProofVerifierForTests(async () => ({
      provider: "privy",
      providerSubject: privySubject,
      providerUserRef: privySubject,
      walletAddresses: [walletAddress.toLowerCase()],
      selectedWalletAddress: walletAddress.toLowerCase(),
      wallets: [
        {
          chainNamespace: "eip155:1",
          walletAddress,
          walletAddressNormalized: walletAddress.toLowerCase(),
          attachmentKind: "embedded",
        },
      ],
      selectedWallet: {
        chainNamespace: "eip155:1",
        walletAddress,
        walletAddressNormalized: walletAddress.toLowerCase(),
        attachmentKind: "embedded",
      },
    }))

    await linkPrivySubject(ctx, otherSession.userId, privySubject, now)
    await addNullifier(ctx, session.userId, now)
    await addRewardEvent(ctx, session.userId, 150, now)

    const response = await app.request(
      "http://pirate.test/me/rewards/cashouts",
      {
        method: "POST",
        headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
        body: JSON.stringify({
          amount_cents: 100,
          idempotency_key: "reward-cashout-wrong-wallet-proof",
          wallet_proof: {
            type: "privy_access_token",
            privy_access_token: "privy-reward-other-token",
            wallet_address: walletAddress,
          },
        }),
      },
      ctx.env,
    )
    expect(response.status).toBe(409)
    expect(settleCount).toBe(0)

    const attached = await ctx.client.execute({
      sql: "SELECT COUNT(*) AS count FROM wallet_attachments WHERE user_id = ?1",
      args: [session.userId],
    })
    expect(attached.rows[0]?.count).toBe(0)
  })

  test("submitted reward payouts are reconciled without creating a new payout effect", async () => {
    const ctx = await createRouteTestContext({
      REWARDS_PAYOUTS_ENABLED: "true",
      REWARDS_CAMPAIGN_CHAIN_ID: "84532",
      PIRATE_REWARDS_SETTLEMENT_CHAIN_ID: "84532",
      PIRATE_REWARDS_SETTLEMENT_BACKEND: "local",
      REWARDS_IDENTITY_PROVIDER: "self",
      REWARDS_MIN_CASHOUT_CENTS: "100",
    })
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "reward-payout-reconcile-user")
    const now = "2026-07-09T12:00:00.000Z"
    let settleCount = 0
    let confirmCount = 0
    setRewardSettlementCoordinatorForTests({
      settle: async (req) => {
        settleCount += 1
        return { idempotencyKey: JSON.stringify(["reward_payout", req.idempotencyKey]), txHash: "0xrewardreconcile", nonce: 9, state: "broadcast" }
      },
      confirm: async (req, txHash) => {
        confirmCount += 1
        return { idempotencyKey: JSON.stringify(["reward_payout", req.idempotencyKey]), txHash, nonce: 9, state: "confirmed" }
      },
      reconcile: async (req) => ({ idempotencyKey: JSON.stringify(["reward_payout", req.idempotencyKey]), txHash: "0xrewardreconcile", nonce: 9, state: "broadcast" }),
    })

    await addRewardEvent(ctx, session.userId, 150, now)
    await ctx.client.execute({
      sql: `
        INSERT INTO reward_payout_effects (
          reward_payout_effect_id, user_id, amount_cents, recipient_address,
          idempotency_key, status, submitted_at, created_at, updated_at
        )
        VALUES (
          'rpe_route_reconcile', ?1, 100, '0x1000000000000000000000000000000000000001',
          'reward-cashout-reconcile', 'submitted', ?2, ?2, ?2
        )
      `,
      args: [session.userId, now],
    })

    const summary = await reconcileSubmittedRewardPayouts({
      env: ctx.env,
      client: ctx.client,
      nowUtc: now,
      limit: 10,
      confirmPollMs: [],
    })
    expect(summary).toEqual({
      enabled: true,
      scanned: 1,
      confirmed: 1,
      failed: 0,
      pending: 0,
      errors: 0,
      capacityDeferred: 0,
      capacityObservationStale: false,
      overdueSongs: 0,
    })
    expect(settleCount).toBe(1)
    expect(confirmCount).toBe(1)

    const rows = await ctx.client.execute({
      sql: "SELECT status, settlement_ref FROM reward_payout_effects WHERE idempotency_key = 'reward-cashout-reconcile'",
    })
    expect(rows.rows).toEqual([{ status: "confirmed", settlement_ref: "0xrewardreconcile" }])

    const countRows = await ctx.client.execute({
      sql: "SELECT COUNT(*) AS count FROM reward_payout_effects WHERE user_id = ?1",
      args: [session.userId],
    })
    expect(Number(countRows.rows[0]?.count ?? 0)).toBe(1)
  })

  test("prepared reward payouts respect the durable executor retry schedule", async () => {
    const ctx = await createRouteTestContext({
      REWARDS_PAYOUTS_ENABLED: "true",
      REWARDS_CAMPAIGN_CHAIN_ID: "84532",
      PIRATE_REWARDS_SETTLEMENT_CHAIN_ID: "84532",
      PIRATE_REWARDS_SETTLEMENT_BACKEND: "local",
      REWARDS_IDENTITY_PROVIDER: "self",
      REWARDS_MIN_CASHOUT_CENTS: "100",
    })
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "reward-payout-prepared-backoff-user")
    const now = "2026-07-09T12:00:00.000Z"
    let settleCount = 0
    let reconcileCount = 0
    let confirmCount = 0
    setRewardSettlementCoordinatorForTests({
      settle: async (req) => {
        settleCount += 1
        return {
          idempotencyKey: JSON.stringify(["reward_payout", req.idempotencyKey]),
          txHash: "0xrewardprepared",
          nonce: 9,
          state: "prepared",
        }
      },
      confirm: async (req, txHash) => {
        confirmCount += 1
        return {
          idempotencyKey: JSON.stringify(["reward_payout", req.idempotencyKey]),
          txHash,
          nonce: 9,
          state: "prepared",
        }
      },
      reconcile: async (req) => {
        reconcileCount += 1
        return {
          idempotencyKey: JSON.stringify(["reward_payout", req.idempotencyKey]),
          txHash: "0xrewardprepared",
          nonce: 9,
          state: "prepared",
        }
      },
    })

    await addRewardEvent(ctx, session.userId, 100, now)
    await ctx.client.execute({
      sql: `
        INSERT INTO reward_payout_effects (
          reward_payout_effect_id, user_id, amount_cents, recipient_address,
          idempotency_key, status, settlement_ref, coordinator_state,
          submitted_at, created_at, updated_at
        )
        VALUES (
          'rpe_route_prepared_backoff', ?1, 100,
          '0x1000000000000000000000000000000000000001',
          'reward-cashout-prepared-backoff', 'submitted', '0xrewardprepared',
          'prepared', ?2, ?2, ?2
        )
      `,
      args: [session.userId, now],
    })

    const summary = await reconcileSubmittedRewardPayouts({
      env: ctx.env,
      client: ctx.client,
      nowUtc: now,
      limit: 10,
      confirmPollMs: [],
    })

    expect(summary).toMatchObject({ scanned: 1, pending: 1, errors: 0 })
    expect(settleCount).toBe(1)
    expect(reconcileCount).toBe(0)
    expect(confirmCount).toBe(0)
    const rows = await ctx.client.execute({
      sql: `
        SELECT status, settlement_ref, coordinator_state
        FROM reward_payout_effects
        WHERE reward_payout_effect_id = 'rpe_route_prepared_backoff'
      `,
    })
    expect(rows.rows).toEqual([{
      status: "submitted",
      settlement_ref: "0xrewardprepared",
      coordinator_state: "prepared",
    }])
  })

  test("failed preparation remains submitted while the durable executor owns retry", async () => {
    const ctx = await createRouteTestContext({
      REWARDS_READS_ENABLED: "true",
      REWARDS_PAYOUTS_ENABLED: "true",
      REWARDS_CAMPAIGN_CHAIN_ID: "84532",
      PIRATE_REWARDS_SETTLEMENT_CHAIN_ID: "84532",
      PIRATE_REWARDS_SETTLEMENT_BACKEND: "local",
      REWARDS_IDENTITY_PROVIDER: "self",
      REWARDS_MIN_CASHOUT_CENTS: "100",
    })
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "reward-payout-prep-failure-user")
    const now = "2026-07-09T12:00:00.000Z"
    setRewardSettlementCoordinatorForTests({
      settle: async (req) => ({ idempotencyKey: JSON.stringify(["reward_payout", req.idempotencyKey]), txHash: null, nonce: null, state: "failed_preparation" }),
      confirm: async (req, txHash) => ({ idempotencyKey: JSON.stringify(["reward_payout", req.idempotencyKey]), txHash, nonce: null, state: "failed_preparation" }),
      reconcile: async (req) => ({ idempotencyKey: JSON.stringify(["reward_payout", req.idempotencyKey]), txHash: null, nonce: null, state: "failed_preparation" }),
    })

    await addWallet(ctx, session.userId, now)
    await addNullifier(ctx, session.userId, now)
    await addRewardEvent(ctx, session.userId, 150, now)

    const response = await app.request(
      "http://pirate.test/me/rewards/cashouts",
      {
        method: "POST",
        headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
        body: JSON.stringify({ amount_cents: 100, idempotency_key: "reward-cashout-prep-fails" }),
      },
      ctx.env,
    )
    expect(response.status).toBe(202)
    const first = await json(response) as { balance_cents: number; payout: { status: string } }
    expect(first.payout.status).toBe("submitted")
    expect(first.balance_cents).toBe(50)

    const firstRetry = await reconcileSubmittedRewardPayouts({
      env: ctx.env,
      client: ctx.client,
      nowUtc: now,
      limit: 10,
      confirmPollMs: [],
    })
    expect(firstRetry.pending).toBe(1)
    expect(firstRetry.failed).toBe(0)

    const secondRetry = await reconcileSubmittedRewardPayouts({
      env: ctx.env,
      client: ctx.client,
      nowUtc: now,
      limit: 10,
      confirmPollMs: [],
    })
    expect(secondRetry.pending).toBe(1)
    expect(secondRetry.failed).toBe(0)

    const rows = await ctx.client.execute({
      sql: "SELECT status, failure_reason, attempt_count FROM reward_payout_effects WHERE user_id = ?1 AND idempotency_key = ?2",
      args: [session.userId, "reward-cashout-prep-fails"],
    })
    expect(rows.rows).toEqual([{ status: "submitted", failure_reason: null, attempt_count: 3 }])

    await ctx.client.execute({
      sql: `
        UPDATE reward_payout_effects
        SET attempt_count = 12
        WHERE user_id = ?1 AND idempotency_key = ?2
      `,
      args: [session.userId, "reward-cashout-prep-fails"],
    })
    const cappedRetry = await reconcileSubmittedRewardPayouts({
      env: ctx.env,
      client: ctx.client,
      nowUtc: now,
      limit: 10,
      confirmPollMs: [],
    })
    expect(cappedRetry.scanned).toBe(0)
    expect(cappedRetry.pending).toBe(0)

    const summary = await app.request(
      "http://pirate.test/me/rewards",
      { headers: authHeaders(session.accessToken) },
      ctx.env,
    )
    const summaryBody = await json(summary) as { balance_cents: number }
    expect(summaryBody.balance_cents).toBe(50)
  })
})
