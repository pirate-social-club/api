import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { app } from "../../src/index"
import { getCommunityRepository } from "../../src/lib/communities/db-community-repository"
import { openCommunityWriteClient } from "../../src/lib/communities/community-read-access"
import { createRouteTestContext, json, resetRuntimeCaches } from "../helpers"
import { exchangeJwt } from "./communities/community-routes-test-helpers"

let cleanup: (() => Promise<void>) | null = null

beforeEach(() => {
  resetRuntimeCaches()
})

afterEach(async () => {
  if (cleanup) {
    await cleanup()
    cleanup = null
  }
})

function authHeaders(accessToken: string): { authorization: string } {
  return { authorization: `Bearer ${accessToken}` }
}

const CAMPAIGN_TOKEN_ADDRESS = "0x1000000000000000000000000000000000000001"

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
    REWARDS_CAMPAIGN_USDC_TOKEN_ADDRESS: CAMPAIGN_TOKEN_ADDRESS,
    REWARDS_CAMPAIGN_TREASURY_ADDRESS: "0xCb23683A41ec98F506B67D89dEAF0Bb52ACC97A6",
    REWARDS_CAMPAIGN_RPC_URL: "https://base-sepolia.example.test",
    PIRATE_REWARDS_SETTLEMENT_OPERATOR_ADDRESS: "0xCb23683A41ec98F506B67D89dEAF0Bb52ACC97A6",
    PIRATE_REWARDS_SETTLEMENT_OPERATOR_PRIVATE_KEY: "0x7000000000000000000000000000000000000000000000000000000000000007",
    PIRATE_REWARDS_SETTLEMENT_USDC_TOKEN_ADDRESS: CAMPAIGN_TOKEN_ADDRESS,
    PIRATE_REWARDS_SETTLEMENT_RPC_URL: "https://base-sepolia.example.test",
    PIRATE_REWARDS_SETTLEMENT_ALLOW_TOKEN_OVERRIDE: "true",
    REWARDS_CAMPAIGN_QUOTE_TTL_SECONDS: "900",
    REWARDS_CAMPAIGN_MIN_BUDGET_CENTS: "1000",
    REWARDS_CAMPAIGN_MAX_BUDGET_CENTS: "1000000",
    REWARDS_CAMPAIGN_MAX_REWARD_CENTS: "1000",
    REWARDS_CAMPAIGN_MIN_DURATION_SECONDS: "3600",
    REWARDS_CAMPAIGN_MAX_DURATION_SECONDS: "7776000",
  }
}

async function seedCampaignSong(
  ctx: Awaited<ReturnType<typeof createRouteTestContext>>,
  ownerUserId: string,
  postId = "pst_reward_campaign_song",
): Promise<void> {
  const now = new Date().toISOString()
  await ctx.client.execute({
    sql: `
      INSERT INTO communities (
        community_id, creator_user_id, display_name, description, membership_mode,
        status, provisioning_state, transfer_state, created_at, updated_at
      )
      VALUES ('cmt_rewards_route', ?1, 'Rewards Test', NULL, 'open', 'active', 'active', 'none', ?2, ?2)
      ON CONFLICT (community_id) DO NOTHING
    `,
    args: [ownerUserId, now],
  })
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
  const timedLyrics = Array.from({ length: 5 }, (_, index) => ({
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
    community: "com_cmt_rewards_route",
    post: "post_pst_reward_campaign_song",
    reward_identity_provider: "very",
    eligible_activity: "study",
    min_score_bps: 7000,
    daily_reward_cents: 40,
    milestone_7_cents: 0,
    milestone_30_cents: 0,
    reward_period_cap_cents: 40,
    budget_cents: 100000,
    starts_at: now - 60,
    ends_at: now + 86400,
    idempotency_key: "asset-descriptor-create-1",
    ...overrides,
  }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

// Mirrors the pre-v5 terms preimage so the test can rewrite a created campaign
// into a faithful legacy (terms_version 4) row.
function legacyTermsPayload(body: Record<string, unknown>, songOwnerUserId: string): string {
  return JSON.stringify({
    community: "cmt_rewards_route",
    post: "pst_reward_campaign_song",
    song_artifact_bundle: "sab_pst_reward_campaign_song",
    song_owner: songOwnerUserId,
    reward_identity_provider: body.reward_identity_provider,
    eligible_activity: body.eligible_activity,
    min_score_bps: body.min_score_bps,
    daily_reward_cents: body.daily_reward_cents,
    milestone_7_cents: body.milestone_7_cents,
    milestone_30_cents: body.milestone_30_cents,
    reward_period_cap_cents: body.reward_period_cap_cents,
    budget_cents: body.budget_cents,
    starts_at: body.starts_at,
    ends_at: body.ends_at,
  })
}

describe("reward campaign asset descriptor", () => {
  test("creation snapshots the settlement asset into immutable terms (v5)", async () => {
    const ctx = await createRouteTestContext(campaignEnv())
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "reward-asset-descriptor-owner")
    await seedCampaignSong(ctx, session.userId)
    const body = campaignBody()

    const created = await app.request("http://pirate.test/reward_campaigns", {
      method: "POST",
      headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
      body: JSON.stringify(body),
    }, ctx.env)
    expect(created.status).toBe(201)
    const campaign = await json(created) as { id: string }

    const row = (await ctx.client.execute({
      sql: `
        SELECT terms_version, asset_chain_id, asset_token_address,
               asset_token_decimals, asset_token_symbol
        FROM reward_campaigns WHERE reward_campaign_id = ?1
      `,
      args: [campaign.id],
    })).rows[0] as Record<string, unknown>
    expect(Number(row.terms_version)).toBe(5)
    expect(Number(row.asset_chain_id)).toBe(84532)
    expect(row.asset_token_address).toBe(CAMPAIGN_TOKEN_ADDRESS.toLowerCase())
    expect(Number(row.asset_token_decimals)).toBe(6)
    expect(row.asset_token_symbol).toBe("USDC")

    // An identical replay verifies against the v5 hash and returns the row.
    const replay = await app.request("http://pirate.test/reward_campaigns", {
      method: "POST",
      headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
      body: JSON.stringify(body),
    }, ctx.env)
    expect(replay.ok).toBe(true)
    const replayed = await json(replay) as { id: string }
    expect(replayed.id).toBe(campaign.id)
  }, 30_000)

  test("replays of pre-descriptor campaigns still verify against the legacy hash", async () => {
    const ctx = await createRouteTestContext(campaignEnv())
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "reward-asset-descriptor-legacy")
    await seedCampaignSong(ctx, session.userId)

    const body = campaignBody({ idempotency_key: "asset-descriptor-legacy-1" })
    const created = await app.request("http://pirate.test/reward_campaigns", {
      method: "POST",
      headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
      body: JSON.stringify(body),
    }, ctx.env)
    expect(created.status).toBe(201)
    const campaign = await json(created) as { id: string }

    // Rewrite the row into a faithful pre-migration campaign: terms_version 4,
    // asset-less hash, NULL descriptor (possible here because the SQLite test
    // mirror does not run the Postgres immutability trigger).
    const legacyHash = await sha256Hex(legacyTermsPayload(body, session.userId))
    await ctx.client.execute({
      sql: `
        UPDATE reward_campaigns
        SET terms_version = 4, terms_hash = ?2, asset_chain_id = NULL,
            asset_token_address = NULL, asset_token_decimals = NULL,
            asset_token_symbol = NULL
        WHERE reward_campaign_id = ?1
      `,
      args: [campaign.id, legacyHash],
    })

    const replay = await app.request("http://pirate.test/reward_campaigns", {
      method: "POST",
      headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
      body: JSON.stringify(body),
    }, ctx.env)
    expect(replay.ok).toBe(true)
    const replayed = await json(replay) as { id: string }
    expect(replayed.id).toBe(campaign.id)

    // A legacy replay with different terms still conflicts.
    const conflicting = await app.request("http://pirate.test/reward_campaigns", {
      method: "POST",
      headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
      body: JSON.stringify({ ...body, daily_reward_cents: 50, reward_period_cap_cents: 50 }),
    }, ctx.env)
    expect(conflicting.status).toBe(409)
  }, 30_000)

  test("funding quotes reject a campaign whose snapshotted asset no longer matches config", async () => {
    const ctx = await createRouteTestContext(campaignEnv())
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "reward-asset-descriptor-retired")
    await seedCampaignSong(ctx, session.userId)

    const created = await app.request("http://pirate.test/reward_campaigns", {
      method: "POST",
      headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
      body: JSON.stringify(campaignBody({ idempotency_key: "asset-descriptor-retired-1" })),
    }, ctx.env)
    expect(created.status).toBe(201)
    const campaign = await json(created) as { id: string }

    await ctx.client.execute({
      sql: "UPDATE reward_campaigns SET asset_token_address = ?2 WHERE reward_campaign_id = ?1",
      args: [campaign.id, "0x2000000000000000000000000000000000000002"],
    })

    const quoted = await app.request(`http://pirate.test/reward_campaigns/${campaign.id}/funding_quotes`, {
      method: "POST",
      headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
      body: JSON.stringify({ amount_cents: 100000, idempotency_key: "asset-descriptor-retired-quote" }),
    }, ctx.env)
    expect(quoted.status).toBe(409)
    const failure = await json(quoted) as { error?: { message?: string } }
    expect(JSON.stringify(failure)).toContain("retired asset")
  }, 30_000)
})
