import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import type { Env } from "../../src/env"
import apiHandler, { reconcileScheduledRewardCampaigns } from "../../src/index"
import { getCommunityRepository } from "../../src/lib/communities/db-community-repository"
import { openCommunityWriteClient } from "../../src/lib/communities/community-read-access"
import { reconcileRewardCampaigns } from "../../src/lib/rewards/reward-campaign-reconciler"
import type { RewardQualificationWakeup } from "../../src/lib/rewards/reward-qualification-wakeup"
import type { ScheduledCronLockDO } from "../../src/lib/scheduled-cron-lock"
import { createRouteTestContext, resetRuntimeCaches } from "../helpers"
import { exchangeJwt } from "./communities/community-routes-test-helpers"

type RouteContext = Awaited<ReturnType<typeof createRouteTestContext>>

setDefaultTimeout(15_000)

const DAY_MS = 86_400_000

function recentCampaignWindow(): { campaignEndsAt: string; qualifiedAt: string } {
  const qualifiedAtMs = Date.now() - DAY_MS
  return {
    campaignEndsAt: new Date(qualifiedAtMs + (2 * DAY_MS)).toISOString(),
    qualifiedAt: new Date(qualifiedAtMs).toISOString(),
  }
}

let cleanup: (() => Promise<void>) | null = null

afterEach(async () => {
  if (cleanup) await cleanup()
  cleanup = null
  resetRuntimeCaches()
})

function rewardEnv(overrides: Partial<Env> = {}): Partial<Env> {
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
    REWARD_QUALIFICATION_WAKEUP_ENQUEUE_ENABLED: "true",
    REWARD_QUALIFICATION_WAKEUP_CONSUMER_ENABLED: "true",
    ...overrides,
  }
}

function permissiveLockNamespace(calls: string[] = []) {
  const stub = {
    tryAcquire: (_ttlMs: number, owner: string) => {
      calls.push(`acquire:${owner}`)
      return true
    },
    release: (owner: string) => {
      calls.push(`release:${owner}`)
    },
  }
  return {
    getByName: () => stub,
  } as unknown as DurableObjectNamespace<ScheduledCronLockDO>
}

function wakeupMessage(value: RewardQualificationWakeup, attempts = 1) {
  let action: "ack" | "retry" | null = null
  const message: Message<RewardQualificationWakeup> = {
    id: `msg_${value.event_id}_${attempts}`,
    timestamp: new Date(value.enqueued_at),
    body: value,
    attempts,
    ack: () => { action ??= "ack" },
    retry: () => { action ??= "retry" },
  }
  const batch: MessageBatch<RewardQualificationWakeup> = {
    queue: "reward-wakeups-test",
    messages: [message],
    metadata: { metrics: { backlogCount: 1, backlogBytes: 256 } },
    ackAll: () => { action ??= "ack" },
    retryAll: () => { action ??= "retry" },
  }
  return { action: () => action, batch }
}

async function runQueueEntrypoint(
  batch: MessageBatch<RewardQualificationWakeup>,
  env: Env,
): Promise<void> {
  if (!apiHandler.queue) throw new Error("Queue handler is unavailable")
  await apiHandler.queue(batch, env, {} as ExecutionContext)
}

async function verifyUser(ctx: RouteContext, userId: string, key: string, now: string): Promise<void> {
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
  const attestationId = `att_${key}_unique_human`
  await ctx.client.execute({
    sql: `
      INSERT INTO user_attestations (
        user_attestation_id, user_id, source_verification_session_id, provider, attestation_type,
        capability_key, status, value_json, verified_at, expires_at, revoked_at, created_at, updated_at
      ) VALUES (?1, ?2, NULL, 'self', 'unique_human', 'unique_human', 'accepted', ?3, ?4, NULL, NULL, ?4, ?4)
    `,
    args: [attestationId, userId, JSON.stringify({ state: "verified" }), now],
  })
  await ctx.client.execute({
    sql: `
      INSERT INTO identity_nullifiers (
        identity_nullifier_id, user_id, provider, mechanism, nullifier_hash,
        status, source_user_attestation_id, first_seen_at, created_at, updated_at
      ) VALUES (?1, ?2, 'self', 'zk-nullifier', ?3, 'active', ?4, ?5, ?5, ?5)
    `,
    args: [`idn_${key}`, userId, `nullifier_${key}`, attestationId, now],
  })
}

type OutboxFixture = {
  activity: "study" | "karaoke"
  eventId: string
  evidence?: Record<string, unknown>
  periodKey: string
  qualifiedAt: string
}

async function seedCampaignCommunity(input: {
  campaignEndsAt: string
  campaignStartsAt: string
  communityId: string
  ctx: RouteContext
  events: OutboxFixture[]
  key: string
  postId: string
  userId: string
}): Promise<void> {
  const bundleId = `sab_${input.key}`
  const campaignId = `rcp_${input.key}`
  const now = input.campaignStartsAt
  await input.ctx.client.execute({
    sql: `
      INSERT INTO communities (
        community_id, creator_user_id, display_name, membership_mode,
        status, provisioning_state, transfer_state, created_at, updated_at
      ) VALUES (?1, ?2, ?3, 'open', 'active', 'active', 'none', ?4, ?4)
    `,
    args: [input.communityId, input.userId, `Campaign ${input.key}`, now],
  })
  await input.ctx.client.execute({
    sql: `
      INSERT INTO community_database_routing (
        community_id, backend, provisioning_state, shard_worker_id,
        binding_name, region, migrated_at, created_at, updated_at
      ) VALUES (?1, 'd1', 'ready', 'community-d1-shard-test', ?2, 'eeur', ?3, ?3, ?3)
    `,
    args: [input.communityId, `DB_${input.key.toUpperCase()}`, now],
  })
  await input.ctx.client.execute({
    sql: `
      INSERT INTO reward_campaigns (
        reward_campaign_id, rewarder_user_id, creation_idempotency_key,
        community_id, post_id, song_artifact_bundle_id, song_owner_user_id,
        status, eligible_activity, min_score_bps, daily_reward_cents,
        milestone_7_cents, milestone_30_cents, reward_period_cap_cents,
        budget_cents, funded_cents, terms_hash, starts_at, ends_at,
        activated_at, created_at, updated_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6, ?2, 'active', 'either', 8500, 40,
        0, 0, 400, 1000, 1000, ?3, ?7, ?8, ?7, ?7, ?7
      )
    `,
    args: [
      campaignId,
      input.userId,
      `create_${input.key}`,
      input.communityId,
      input.postId,
      bundleId,
      input.campaignStartsAt,
      input.campaignEndsAt,
    ],
  })
  await input.ctx.client.execute({
    sql: `
      INSERT INTO reward_campaign_funding_effects (
        reward_campaign_funding_effect_id, reward_campaign_id, funder_user_id,
        idempotency_key, chain_id, token_address, expected_amount_cents,
        expected_amount_atomic, received_amount_atomic, sender_address,
        treasury_address, tx_hash, status, expires_at, confirmed_at, created_at, updated_at
      ) VALUES (
        ?1, ?2, ?3, ?4, 84532,
        '0x1000000000000000000000000000000000000001', 1000, '10000000', '10000000',
        '0x3000000000000000000000000000000000000003',
        '0x2000000000000000000000000000000000000002',
        ?5, 'confirmed', ?6, ?7, ?7, ?7
      )
    `,
    args: [
      `rcf_${input.key}`,
      campaignId,
      input.userId,
      `fund_${input.key}`,
      `0x${input.key.padEnd(64, "a").slice(0, 64)}`,
      input.campaignEndsAt,
      now,
    ],
  })

  const repository = getCommunityRepository(input.ctx.env)
  const db = await openCommunityWriteClient(input.ctx.env, repository, input.communityId)
  try {
    await db.client.execute({
      sql: `
        INSERT INTO communities (
          community_id, display_name, status, artist_governance_state,
          membership_mode, default_age_gate_policy, donation_policy_mode,
          donation_partner_status, governance_mode, created_by_user_id,
          created_at, updated_at
        ) VALUES (?1, ?2, 'active', 'fan_run', 'open', 'none', 'none',
          'unconfigured', 'centralized', ?3, ?4, ?4)
      `,
      args: [input.communityId, `Campaign ${input.key}`, input.userId, now],
    })
    await db.client.execute({
      sql: `
        INSERT INTO posts (
          post_id, community_id, author_user_id, identity_mode, post_type,
          status, song_mode, title, lyrics, source_language, rights_basis,
          analysis_state, content_safety_state, age_gate_policy, created_at,
          updated_at, access_mode, visibility, song_title, song_cover_art_ref,
          song_artifact_bundle_id
        ) VALUES (?1, ?2, ?3, 'public', 'song', 'published', 'original',
          'Song', 'Lyrics', 'en', 'original', 'allow', 'safe', 'none', ?4, ?4,
          'public', 'public', 'Song', 'ipfs://cover', ?5)
      `,
      args: [input.postId, input.communityId, input.userId, now, bundleId],
    })
    for (const event of input.events) {
      await db.client.execute({
        sql: `
          INSERT INTO reward_qualification_outbox (
            event_id, user_id, community_id, post_id, song_artifact_bundle_id,
            activity, qualified_at, reward_period_key,
            qualification_policy_version, evidence_summary_json, created_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'policy-v1', ?9, ?7)
        `,
        args: [
          event.eventId,
          input.userId,
          input.communityId,
          input.postId,
          bundleId,
          event.activity,
          event.qualifiedAt,
          event.periodKey,
          JSON.stringify(event.evidence ?? {}),
        ],
      })
    }
  } finally {
    await db.close()
    await repository.close?.()
  }
}

function wakeup(input: {
  communityId: string
  eventId: string
  qualifiedAt: string
}): RewardQualificationWakeup {
  return {
    schema_version: 1,
    community_id: input.communityId,
    event_id: input.eventId,
    activity: "study",
    qualified_at: input.qualifiedAt,
    enqueued_at: new Date(Date.parse(input.qualifiedAt) + 100).toISOString(),
  }
}

describe("reward qualification wake-up integration", () => {
  test("Queue and cron entrypoints racing still create one reward", async () => {
    const lockCalls: string[] = []
    const namespace = permissiveLockNamespace(lockCalls)
    const communityId = "cmt_wakeup_race"
    const { campaignEndsAt, qualifiedAt } = recentCampaignWindow()
    const ctx = await createRouteTestContext(rewardEnv({
      REWARD_QUALIFICATION_WAKEUP_COMMUNITY_IDS: communityId,
      SCHEDULED_CRON_LOCK: namespace,
    }))
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "reward-wakeup-race-user")
    await verifyUser(ctx, session.userId, "wakeup_race", qualifiedAt)
    await seedCampaignCommunity({
      campaignEndsAt,
      campaignStartsAt: qualifiedAt,
      communityId,
      ctx,
      events: [{
        activity: "study",
        eventId: "rqo_wakeup_race",
        periodKey: qualifiedAt.slice(0, 10),
        qualifiedAt,
      }],
      key: "wakeup_race",
      postId: "pst_wakeup_race",
      userId: session.userId,
    })

    const firstDelivery = wakeupMessage(wakeup({
      communityId,
      eventId: "rqo_wakeup_race",
      qualifiedAt,
    }))
    await Promise.all([
      runQueueEntrypoint(firstDelivery.batch, ctx.env),
      reconcileScheduledRewardCampaigns(ctx.env),
    ])
    const racedAction = firstDelivery.action()
    expect(racedAction === "ack" || racedAction === "retry").toBe(true)

    const replay = wakeupMessage(wakeup({
      communityId,
      eventId: "rqo_wakeup_race",
      qualifiedAt,
    }), 2)
    await runQueueEntrypoint(replay.batch, ctx.env)
    expect(replay.action()).toBe("ack")
    expect(lockCalls.filter((call) => call.startsWith("acquire:"))).toHaveLength(3)

    const effects = await ctx.client.execute(`
      SELECT
        (SELECT count(*) FROM reward_events WHERE reward_kind = 'campaign_practice_day') AS events,
        (SELECT count(*) FROM reward_campaign_reservations) AS reservations,
        (SELECT count(*) FROM reward_song_period_claims) AS claims,
        (SELECT count(*) FROM reward_pending_qualifications
          WHERE status IN ('pending_verification', 'reconciling')) AS live_pending,
        (SELECT status FROM reward_pending_qualifications
          WHERE reward_qualification_event_id = 'rqo_wakeup_race') AS projection_status,
        (SELECT credited_cents FROM reward_campaigns
          WHERE reward_campaign_id = 'rcp_wakeup_race') AS credited_cents
    `)
    expect(effects.rows).toEqual([{
      events: 1,
      reservations: 1,
      claims: 1,
      live_pending: 0,
      projection_status: "credited",
      credited_cents: 40,
    }])
  })

  test("a target deeper than one 100-row ingestion page retries then drains", async () => {
    const communityId = "cmt_wakeup_backlog"
    const { campaignEndsAt, qualifiedAt } = recentCampaignWindow()
    const targetAt = Date.parse(qualifiedAt)
    const events: OutboxFixture[] = Array.from({ length: 101 }, (_, index) => {
      const qualifiedAt = new Date(targetAt - ((100 - index) * 86_400_000)).toISOString()
      return {
        activity: "study",
        eventId: `rqo_backlog_${String(index + 1).padStart(3, "0")}`,
        periodKey: qualifiedAt.slice(0, 10),
        qualifiedAt,
      }
    })
    const target = events[100] as OutboxFixture
    const ctx = await createRouteTestContext(rewardEnv({
      REWARD_QUALIFICATION_WAKEUP_COMMUNITY_IDS: communityId,
      SCHEDULED_CRON_LOCK: permissiveLockNamespace(),
    }))
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "reward-wakeup-backlog-user")
    await verifyUser(ctx, session.userId, "wakeup_backlog", target.qualifiedAt)
    await seedCampaignCommunity({
      campaignEndsAt,
      campaignStartsAt: target.qualifiedAt,
      communityId,
      ctx,
      events,
      key: "wakeup_backlog",
      postId: "pst_wakeup_backlog",
      userId: session.userId,
    })

    const first = wakeupMessage(wakeup({
      communityId,
      eventId: target.eventId,
      qualifiedAt: target.qualifiedAt,
    }))
    await runQueueEntrypoint(first.batch, ctx.env)
    expect(first.action()).toBe("retry")
    expect((await ctx.client.execute(`
      SELECT last_shard_sequence FROM reward_qualification_checkpoints
      WHERE community_id = 'cmt_wakeup_backlog'
    `)).rows).toEqual([{ last_shard_sequence: 100 }])

    const second = wakeupMessage(wakeup({
      communityId,
      eventId: target.eventId,
      qualifiedAt: target.qualifiedAt,
    }), 2)
    await runQueueEntrypoint(second.batch, ctx.env)
    expect(second.action()).toBe("ack")
    const drained = await ctx.client.execute(`
      SELECT
        (SELECT last_shard_sequence FROM reward_qualification_checkpoints
          WHERE community_id = 'cmt_wakeup_backlog') AS checkpoint,
        (SELECT count(*) FROM reward_qualification_events
          WHERE community_id = 'cmt_wakeup_backlog') AS events,
        (SELECT count(*) FROM reward_events WHERE reward_kind = 'campaign_practice_day') AS credits
    `)
    expect(drained.rows).toEqual([{ checkpoint: 101, events: 101, credits: 1 }])
  })

  test("multi-community event filters keep cursor placeholders and checkpoints isolated", async () => {
    const qualifiedAt = "2026-08-10T12:00:00.000Z"
    const ctx = await createRouteTestContext(rewardEnv())
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "reward-wakeup-cursor-user")
    await verifyUser(ctx, session.userId, "wakeup_cursor", qualifiedAt)
    await seedCampaignCommunity({
      campaignEndsAt: "2026-08-12T12:00:00.000Z",
      campaignStartsAt: qualifiedAt,
      communityId: "cmt_cursor_a",
      ctx,
      events: [
        {
          activity: "karaoke",
          eventId: "rqo_cursor_a_score",
          evidence: { final_score_bps: 100 },
          periodKey: "2026-08-10",
          qualifiedAt,
        },
        {
          activity: "study",
          eventId: "rqo_cursor_a_credit",
          periodKey: "2026-08-10",
          qualifiedAt,
        },
      ],
      key: "cursor_a",
      postId: "pst_cursor_a",
      userId: session.userId,
    })
    await seedCampaignCommunity({
      campaignEndsAt: "2026-08-12T12:00:00.000Z",
      campaignStartsAt: qualifiedAt,
      communityId: "cmt_cursor_b",
      ctx,
      events: [{
        activity: "study",
        eventId: "rqo_cursor_b_credit",
        periodKey: "2026-08-10",
        qualifiedAt,
      }],
      key: "cursor_b",
      postId: "pst_cursor_b",
      userId: session.userId,
    })

    const repository = getCommunityRepository(ctx.env)
    try {
      const summary = await reconcileRewardCampaigns({
        env: ctx.env,
        communityRepository: repository,
        controlPlaneClient: ctx.client,
        communityIds: ["cmt_cursor_a", "cmt_cursor_b"],
        eventIds: ["rqo_cursor_a_score", "rqo_cursor_a_credit", "rqo_cursor_b_credit"],
        mode: "hint",
        maxCommunities: 2,
        maxCredits: 2,
        maxScannedQualifications: 3,
        outboxBatchSize: 10,
        now: "2026-08-10T12:00:01.000Z",
      })
      expect(summary).toMatchObject({
        scanned_communities: 2,
        ingested_qualifications: 3,
        scanned_qualifications: 3,
        credited_events: 2,
        credited_cents: 80,
        skipped_score: 1,
        failed_communities: 0,
        errors: 0,
      })
    } finally {
      await repository.close?.()
    }
    const checkpoints = await ctx.client.execute(`
      SELECT community_id, last_shard_sequence
      FROM reward_qualification_checkpoints
      WHERE community_id IN ('cmt_cursor_a', 'cmt_cursor_b')
      ORDER BY community_id
    `)
    expect(checkpoints.rows).toEqual([
      { community_id: "cmt_cursor_a", last_shard_sequence: 2 },
      { community_id: "cmt_cursor_b", last_shard_sequence: 1 },
    ])
  })
})
