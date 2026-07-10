import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { app } from "../../src/index"
import {
  reconcileSubmittedRewardPayouts,
  setRewardSettlementConfirmPollPlanForTests,
  setRewardSettlementCoordinatorForTests,
} from "../../src/lib/rewards/reward-cashout-service"
import { setPrivyAccessProofVerifierForTests } from "../../src/lib/auth/privy-auth"
import { setBookingPaymentVerifierForTests } from "../../src/lib/communities/commerce/funding-proof-service"
import { getCommunityRepository } from "../../src/lib/communities/db-community-repository"
import { openCommunityWriteClient } from "../../src/lib/communities/community-read-access"
import { createRouteTestContext, json, resetRuntimeCaches } from "../helpers"
import { exchangeJwt } from "./communities/community-routes-test-helpers"

let cleanup: (() => Promise<void>) | null = null

beforeEach(() => {
  resetRuntimeCaches()
  setRewardSettlementCoordinatorForTests(null)
  setRewardSettlementConfirmPollPlanForTests(null)
  setPrivyAccessProofVerifierForTests(null)
  setBookingPaymentVerifierForTests(null)
})

afterEach(async () => {
  setRewardSettlementCoordinatorForTests(null)
  setRewardSettlementConfirmPollPlanForTests(null)
  setPrivyAccessProofVerifierForTests(null)
  setBookingPaymentVerifierForTests(null)
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
      REWARDS_CAMPAIGN_CHAIN_ID: "84532",
      REWARDS_CAMPAIGN_USDC_TOKEN_ADDRESS: "0x1000000000000000000000000000000000000001",
      REWARDS_CAMPAIGN_TREASURY_ADDRESS: "0x2000000000000000000000000000000000000002",
      REWARDS_CAMPAIGN_RPC_URL: "https://base-sepolia.example.test",
      REWARDS_CAMPAIGN_QUOTE_TTL_SECONDS: "900",
      REWARDS_CAMPAIGN_MIN_BUDGET_CENTS: "1000",
      REWARDS_CAMPAIGN_MAX_BUDGET_CENTS: "1000000",
      REWARDS_CAMPAIGN_MAX_REWARD_CENTS: "1000",
      REWARDS_CAMPAIGN_MIN_DURATION_SECONDS: "3600",
      REWARDS_CAMPAIGN_MAX_DURATION_SECONDS: "7776000",
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
            governance_mode, created_by_user_id, created_at, updated_at
          ) VALUES (
            'cmt_rewards_route', 'Rewards Test', 'active', 'fan_run', 'open',
            'none', 'none', 'unconfigured', 'centralized', ?1, ?2, ?2
          )
        `,
        args: [ownerUserId, now],
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
  }

  function campaignBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const now = Math.floor(Date.now() / 1000)
    return {
      community: "cmt_rewards_route",
      post: "pst_reward_campaign_song",
      eligible_activity: "either",
      daily_reward_cents: 40,
      milestone_7_cents: 100,
      milestone_30_cents: 300,
      reward_period_cap_cents: 340,
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

  test("creates, quotes, uniquely verifies, and activates a fully funded campaign", async () => {
    const ctx = await createRouteTestContext(campaignEnv())
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "reward-campaign-owner")
    await addWallet(ctx, session.userId, new Date().toISOString())
    await seedCampaignSong(ctx, session.userId)

    const underCapped = await app.request("http://pirate.test/reward_campaigns", {
      method: "POST",
      headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
      body: JSON.stringify(campaignBody({ reward_period_cap_cents: 339 })),
    }, ctx.env)
    expect(underCapped.status).toBe(400)

    const create = await app.request("http://pirate.test/reward_campaigns", {
      method: "POST",
      headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
      body: JSON.stringify(campaignBody()),
    }, ctx.env)
    expect(create.status).toBe(201)
    const campaign = await json(create) as { id: string; status: string; song_owner: string; eligible_activity: string }
    expect(campaign).toMatchObject({ status: "draft", song_owner: session.userId, eligible_activity: "either" })

    const replay = await app.request("http://pirate.test/reward_campaigns", {
      method: "POST",
      headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
      body: JSON.stringify(campaignBody()),
    }, ctx.env)
    expect((await json(replay) as { id: string }).id).toBe(campaign.id)

    const changedReplay = await app.request("http://pirate.test/reward_campaigns", {
      method: "POST",
      headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
      body: JSON.stringify(campaignBody({ daily_reward_cents: 41, reward_period_cap_cents: 341 })),
    }, ctx.env)
    expect(changedReplay.status).toBe(409)

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
      treasury_address: "0x2000000000000000000000000000000000000002",
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
    expect(await json(read)).toMatchObject({
      id: campaign.id,
      status: "active",
      budget_cents: 100000,
      funded_cents: 100000,
      remaining_cents: 100000,
    })
    const publicOffer = await app.request(`http://pirate.test/public/reward_campaigns/${campaign.id}`, {}, ctx.env)
    expect(publicOffer.status).toBe(200)
    expect(await json(publicOffer)).toMatchObject({ id: campaign.id, status: "active" })
    const songOffer = await app.request(
      "http://pirate.test/public/reward_campaigns?community_id=cmt_rewards_route&post_id=pst_reward_campaign_song",
      {},
      ctx.env,
    )
    expect(songOffer.status).toBe(200)
    expect(await json(songOffer)).toMatchObject({ id: campaign.id, status: "active" })
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
    const policyUrl = "http://pirate.test/reward_song_policies/cmt_rewards_route/pst_reward_campaign_song"

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

  test("handles partial, pending, expired, and rejected campaign funding safely", async () => {
    const ctx = await createRouteTestContext(campaignEnv())
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
    expect(await json(partiallyFunded)).toMatchObject({ status: "funding_quoted", funded_cents: 40000 })

    const expired = await quote(10000, "expired-funding")
    await ctx.client.execute({
      sql: "UPDATE reward_campaign_funding_effects SET expires_at = '2020-01-01T00:00:00.000Z' WHERE reward_campaign_funding_effect_id = ?1",
      args: [expired.id],
    })
    const expiredConfirm = await confirm(expired.id, "d")
    expect(expiredConfirm.status).toBe(409)
    expect(verificationCalls).toBe(2)

    for (const [reason, hex] of [["wrong_transfer_recipient", "e"], ["wrong_transfer_amount", "f"]] as const) {
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
    expect(await json(finalCampaign)).toMatchObject({ status: "funding_quoted", funded_cents: 40000 })
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
      cashout: { eligible: boolean; min_cents: number; verification_state: string }
    }
    expect(unverifiedBody.balance_cents).toBe(80)
    expect(unverifiedBody.today_earned_cents).toBe(30)
    expect(unverifiedBody.recent_events.map((event) => event.id).sort()).toEqual(["rew_route_day", "rew_route_milestone"])
    expect(unverifiedBody.cashout).toEqual({
      eligible: false,
      min_cents: 100,
      verification_state: "unverified",
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
      cashout: { eligible: boolean; min_cents: number; verification_state: string }
      latest_in_flight_cashout: { id: string; amount_cents: number; status: string } | null
    }
    expect(verifiedBody.balance_cents).toBe(90)
    expect(verifiedBody.cashout).toEqual({
      eligible: false,
      min_cents: 100,
      verification_state: "verified",
    })
    expect(verifiedBody.latest_in_flight_cashout).toMatchObject({
      id: "rpe_route_pending",
      amount_cents: 10,
      status: "submitted",
    })

    ctx.env.REWARDS_IDENTITY_PROVIDER = "very"
    const wrongIdentityNamespace = await app.request(
      "http://pirate.test/me/rewards",
      { headers: authHeaders(session.accessToken) },
      ctx.env,
    )
    expect((await json(wrongIdentityNamespace) as { cashout: { verification_state: string } }).cashout.verification_state).toBe("unverified")
  })

  test("GET /me/rewards requires authentication", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const response = await app.request("http://pirate.test/me/rewards", {}, ctx.env)
    expect(response.status).toBe(401)
  })

  test("reward reads and payouts fail closed when their independent flags are not true", async () => {
    const ctx = await createRouteTestContext({
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
      balance_cents: 0,
      today_earned_cents: 0,
      recent_events: [],
      cashout: {
        eligible: false,
        min_cents: 100,
        verification_state: "unverified",
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

  test("does not accept ZKPassport as the configured reward identity namespace", async () => {
    const ctx = await createRouteTestContext({
      REWARDS_PAYOUTS_ENABLED: "true",
      REWARDS_IDENTITY_PROVIDER: "zkpassport",
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
    expect(response.status).toBe(403)
    expect(settleCount).toBe(0)
  })

  test("POST /me/rewards/cashouts gates on nullifier, balance, and idempotently confirms a payout", async () => {
    const ctx = await createRouteTestContext({
      REWARDS_PAYOUTS_ENABLED: "true",
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
      payout: { id: string; amount_cents: number; status: string; settlement_ref: string | null; recipient_address: string }
      balance_cents: number
    }
    expect(body.payout.amount_cents).toBe(100)
    expect(body.payout.status).toBe("confirmed")
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

  test("failed preparation payouts eventually fail and release reserved balance", async () => {
    const ctx = await createRouteTestContext({
      REWARDS_READS_ENABLED: "true",
      REWARDS_PAYOUTS_ENABLED: "true",
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
    expect(secondRetry.pending).toBe(0)
    expect(secondRetry.failed).toBe(1)

    const rows = await ctx.client.execute({
      sql: "SELECT status, failure_reason, attempt_count FROM reward_payout_effects WHERE user_id = ?1 AND idempotency_key = ?2",
      args: [session.userId, "reward-cashout-prep-fails"],
    })
    expect(rows.rows).toEqual([{ status: "failed", failure_reason: "failed_preparation", attempt_count: 3 }])

    const summary = await app.request(
      "http://pirate.test/me/rewards",
      { headers: authHeaders(session.accessToken) },
      ctx.env,
    )
    const summaryBody = await json(summary) as { balance_cents: number }
    expect(summaryBody.balance_cents).toBe(150)
  })
})
