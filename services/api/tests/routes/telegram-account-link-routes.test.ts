import { afterEach, describe, expect, test } from "bun:test"
import { app } from "../../src/index"
import { mintPirateAccessToken } from "../../src/lib/auth/pirate-session-token"
import { getSessionRepository } from "../../src/lib/auth/repositories"
import { openCommunityWriteClient } from "../../src/lib/communities/community-read-access"
import { getCommunityRepository } from "../../src/lib/communities/db-community-repository"
import { mergeTelegramAccountIntoCanonical } from "../../src/lib/telegram/account-merge-service"
import { createRouteTestContext, json, resetRuntimeCaches } from "../helpers"
import { exchangeJwt } from "./communities/community-routes-test-helpers"

let cleanup: (() => Promise<void>) | null = null

afterEach(async () => {
  resetRuntimeCaches()
  await cleanup?.()
  cleanup = null
})

function post(url: string, body: unknown, token: string, env: Parameters<typeof app.request>[2]) {
  return app.request(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  }, env)
}

async function createMergeFixture(input: {
  tag: string
  telegramUserId: string
  postIds: string[]
}) {
  const ctx = await createRouteTestContext({
    PIRATE_WEB_PUBLIC_ORIGIN: "https://pirate.test",
  })
  cleanup = ctx.cleanup
  const target = await exchangeJwt(ctx.env, `canonical-${input.tag}`)
  const telegramSession = await getSessionRepository(ctx.env).exchangeIdentity({
    provider: "telegram",
    providerSubject: input.telegramUserId,
    providerUserRef: `telegram_${input.tag}`,
    selectedWalletAddress: null,
    walletAddresses: [],
    selectedWallet: null,
    wallets: [],
  })
  const sourceUserId = telegramSession.user.id.replace(/^usr_/, "")
  const sourceToken = await mintPirateAccessToken({ env: ctx.env, userId: sourceUserId })
  const communityId = `cmt_merge_${input.tag}`
  const now = "2026-08-09T08:00:00.000Z"

  await ctx.client.execute({
    sql: `
      INSERT INTO telegram_accounts (
        telegram_user_id, user_id, username, first_seen_at, last_seen_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?4, ?4)
    `,
    args: [input.telegramUserId, sourceUserId, `telegram_${input.tag}`, now],
  })
  await ctx.client.execute({
    sql: `
      INSERT INTO communities (
        community_id, creator_user_id, display_name, membership_mode, status,
        provisioning_state, transfer_state, created_at, updated_at
      ) VALUES (?1, ?2, ?3, 'open', 'active', 'active', 'none', ?4, ?4)
    `,
    args: [communityId, target.userId, `Merge ${input.tag}`, now],
  })
  await ctx.client.execute({
    sql: `
      INSERT INTO community_database_routing (
        community_id, backend, provisioning_state, shard_worker_id, binding_name,
        region, created_at, updated_at
      ) VALUES (?1, 'd1', 'ready', 'community-d1-shard-staging', ?2, 'wnam', ?3, ?3)
    `,
    args: [communityId, `DB_MERGE_${input.tag.toUpperCase()}`, now],
  })
  await ctx.client.execute({
    sql: `
      INSERT INTO telegram_community_bots (
        telegram_community_bot_id, community_id, encrypted_bot_token, token_last4,
        encryption_key_version, telegram_bot_user_id, bot_username, bot_display_name,
        webhook_id, webhook_secret, webhook_status, status, created_at, updated_at,
        actor_user_id
      ) VALUES (
        ?1, ?2, 'v1:000000000000000000000000:00000000000000000000000000000000:00',
        'oken', 1, ?3, ?4, ?5, ?6, ?7, 'active', 'active', ?8, ?8, ?9
      )
    `,
    args: [
      `tcb_${input.tag}`, communityId, `9${input.telegramUserId}`,
      `Merge${input.tag}Bot`, `Merge ${input.tag} bot`, `tgb_${input.tag}`,
      `secret_${input.tag}`, now, target.userId,
    ],
  })

  const shardHandle = await openCommunityWriteClient(
    ctx.env,
    getCommunityRepository(ctx.env),
    communityId,
  )
  const previousCleanup = cleanup
  cleanup = async () => {
    await shardHandle.close()
    await previousCleanup?.()
  }
  await shardHandle.client.execute({
    sql: `
      INSERT INTO communities (
        community_id, display_name, status, artist_governance_state, membership_mode,
        default_age_gate_policy, allow_anonymous_identity, donation_policy_mode,
        donation_partner_status, governance_mode, created_by_user_id, created_at, updated_at
      ) VALUES (?1, ?2, 'active', 'fan_run', 'open', 'none', 0, 'none',
                'unconfigured', 'centralized', ?3, ?4, ?4)
    `,
    args: [communityId, `Merge ${input.tag}`, target.userId, now],
  })
  for (const postId of input.postIds) {
    await shardHandle.client.execute({
      sql: `
        INSERT INTO posts (
          post_id, community_id, author_user_id, identity_mode, post_type, status,
          song_mode, title, lyrics, source_language, rights_basis, analysis_state,
          content_safety_state, age_gate_policy, created_at, updated_at
        ) VALUES (?1, ?2, ?3, 'public', 'song', 'published', 'original', ?1,
                  'Study lyric', 'en', 'original', 'allow', 'safe', 'none', ?4, ?4)
      `,
      args: [postId, communityId, target.userId, now],
    })
  }

  async function consumeLink(): Promise<{ linkIntentId: string }> {
    const created = await post(
      "http://pirate.test/users/me/telegram-account-link-intents",
      { community_id: communityId },
      sourceToken,
      ctx.env,
    )
    expect(created.status).toBe(201)
    const linkToken = new URL((await json(created) as { link_url: string }).link_url)
      .searchParams.get("token")
    expect(linkToken).toBeTruthy()
    const intent = await ctx.client.execute({
      sql: `SELECT link_intent_id FROM telegram_account_link_intents WHERE token_hash IS NOT NULL AND source_user_id = ?1`,
      args: [sourceUserId],
    })
    const consumed = await post(
      "http://pirate.test/users/me/telegram-account-link-intents/consume",
      { token: linkToken },
      target.accessToken,
      ctx.env,
    )
    expect(consumed.status).toBe(200)
    expect(await json(consumed)).toEqual({ linked: true })
    return { linkIntentId: String(intent.rows[0]?.link_intent_id) }
  }

  return {
    ctx,
    target,
    sourceUserId,
    sourceToken,
    communityId,
    providerSubject: input.telegramUserId,
    telegramUserId: input.telegramUserId,
    shard: shardHandle.client,
    consumeLink,
  }
}

async function insertEngagementDay(input: {
  shard: Awaited<ReturnType<typeof createMergeFixture>>["shard"]
  userId: string
  postId: string
  communityId: string
  date: string
  attempts?: number
  correct?: number
  timezone?: string
}) {
  const timestamp = `${input.date}T12:00:00.000Z`
  await input.shard.execute({
    sql: `
      INSERT INTO song_engagement_days (
        user_id, post_id, community_id, activity_date, study_attempt_count,
        study_correct_count, study_target_count, karaoke_pass_count, qualified,
        created_at, updated_at, activity_timezone
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 10, 0, 1, ?7, ?7, ?8)
    `,
    args: [
      input.userId, input.postId, input.communityId, input.date,
      input.attempts ?? 1, input.correct ?? 1, timestamp, input.timezone ?? "UTC",
    ],
  })
}

async function insertStreak(input: {
  shard: Awaited<ReturnType<typeof createMergeFixture>>["shard"]
  userId: string
  postId: string
  communityId: string
  current: number
  best: number
  lastDate: string
  startDate: string
  total: number
  createdAt: string
  updatedAt: string
  timezone: string
  timezoneUpdatedAt: string
  activeUntilAt: string
}) {
  await input.shard.execute({
    sql: `
      INSERT INTO song_streaks (
        user_id, post_id, community_id, current_streak, best_streak,
        last_qualified_date, streak_started_date, total_qualified_days,
        created_at, updated_at, timezone, timezone_updated_at, active_until_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
    `,
    args: [
      input.userId, input.postId, input.communityId, input.current, input.best,
      input.lastDate, input.startDate, input.total, input.createdAt, input.updatedAt,
      input.timezone, input.timezoneUpdatedAt, input.activeUntilAt,
    ],
  })
}

describe("Telegram account linking", () => {
  test("moves a fresh Telegram-only identity after the web user proves both contexts", async () => {
    const ctx = await createRouteTestContext({
      PIRATE_WEB_PUBLIC_ORIGIN: "https://pirate.test",
    })
    cleanup = ctx.cleanup
    const target = await exchangeJwt(ctx.env, "existing-web-account")
    const telegramSession = await getSessionRepository(ctx.env).exchangeIdentity({
      provider: "telegram",
      providerSubject: "424242",
      providerUserRef: "telegram_student",
      selectedWalletAddress: null,
      walletAddresses: [],
      selectedWallet: null,
      wallets: [],
    })
    const sourceUserId = telegramSession.user.id.replace(/^usr_/, "")
    const sourceToken = await mintPirateAccessToken({ env: ctx.env, userId: sourceUserId })
    const now = new Date().toISOString()

    await ctx.client.execute({
      sql: `
        INSERT INTO telegram_accounts (
          telegram_user_id, user_id, username, first_name, last_name, photo_url,
          first_seen_at, last_seen_at, updated_at
        ) VALUES ('424242', ?1, 'telegram_student', NULL, NULL, NULL, ?2, ?2, ?2)
      `,
      args: [sourceUserId, now],
    })
    await ctx.client.execute({
      sql: `
        INSERT INTO communities (
          community_id, creator_user_id, display_name, membership_mode, status,
          provisioning_state, transfer_state, created_at, updated_at
        ) VALUES (
          'cmt_link_test', ?1, 'Link Test', 'open', 'active',
          'active', 'none', ?2, ?2
        )
      `,
      args: [target.userId, now],
    })
    await ctx.client.execute({
      sql: `
        INSERT INTO telegram_community_bots (
          telegram_community_bot_id, community_id, encrypted_bot_token, token_last4,
          encryption_key_version, telegram_bot_user_id, bot_username, bot_display_name,
          webhook_id, webhook_secret, webhook_status, status, created_at, updated_at,
          revoked_at, rotated_from, actor_user_id
        ) VALUES (
          'tcb_link_test', 'cmt_link_test',
          'v1:000000000000000000000000:00000000000000000000000000000000:00',
          'oken', 1, '987654', 'LinkTestBot', 'Link test bot',
          'tgb_link_test', 'link-test-secret', 'active', 'active', ?1, ?1,
          NULL, NULL, ?2
        )
      `,
      args: [now, target.userId],
    })

    const created = await post(
      "http://pirate.test/users/me/telegram-account-link-intents",
      { community_id: "cmt_link_test" },
      sourceToken,
      ctx.env,
    )
    expect(created.status).toBe(201)
    const createdBody = await json(created) as { link_url: string }
    const linkToken = new URL(createdBody.link_url).searchParams.get("token")
    expect(linkToken).toBeTruthy()

    const consumed = await post(
      "http://pirate.test/users/me/telegram-account-link-intents/consume",
      { token: linkToken },
      target.accessToken,
      ctx.env,
    )
    expect(consumed.status).toBe(200)
    expect(await json(consumed)).toEqual({ linked: true })

    const providerLink = await ctx.client.execute({
      sql: `
        SELECT user_id FROM auth_provider_links
        WHERE provider = 'telegram' AND provider_subject = '424242' AND status = 'active'
      `,
    })
    expect(String(providerLink.rows[0]?.user_id)).toBe(target.userId)
    const account = await ctx.client.execute(
      "SELECT user_id FROM telegram_accounts WHERE telegram_user_id = '424242'",
    )
    expect(String(account.rows[0]?.user_id)).toBe(target.userId)

    const replay = await post(
      "http://pirate.test/users/me/telegram-account-link-intents/consume",
      { token: linkToken },
      target.accessToken,
      ctx.env,
    )
    expect(replay.status).toBe(409)
    const replayBody = await json(replay) as { code: string }
    expect(replayBody.code).toBe("telegram_account_link_expired")
  })

  test("merges allowed Telegram membership activity into the canonical account", async () => {
    const ctx = await createRouteTestContext({
      PIRATE_WEB_PUBLIC_ORIGIN: "https://pirate.test",
    })
    cleanup = ctx.cleanup
    const target = await exchangeJwt(ctx.env, "conflict-web-account")
    const telegramSession = await getSessionRepository(ctx.env).exchangeIdentity({
      provider: "telegram",
      providerSubject: "515151",
      providerUserRef: "established_student",
      selectedWalletAddress: null,
      walletAddresses: [],
      selectedWallet: null,
      wallets: [],
    })
    const sourceUserId = telegramSession.user.id.replace(/^usr_/, "")
    const sourceToken = await mintPirateAccessToken({ env: ctx.env, userId: sourceUserId })
    const now = new Date().toISOString()
    await ctx.client.execute({
      sql: `
        INSERT INTO telegram_accounts (
          telegram_user_id, user_id, first_seen_at, last_seen_at, updated_at
        ) VALUES ('515151', ?1, ?2, ?2, ?2)
      `,
      args: [sourceUserId, now],
    })
    await ctx.client.execute({
      sql: `
        INSERT INTO communities (
          community_id, creator_user_id, display_name, membership_mode, status,
          provisioning_state, transfer_state, created_at, updated_at
        ) VALUES ('cmt_conflict_link', ?1, 'Conflict Link', 'open', 'active',
                  'active', 'none', ?2, ?2)
      `,
      args: [target.userId, now],
    })
    await ctx.client.execute({
      sql: `
        INSERT INTO telegram_community_bots (
          telegram_community_bot_id, community_id, encrypted_bot_token, token_last4,
          encryption_key_version, telegram_bot_user_id, bot_username, bot_display_name,
          webhook_id, webhook_secret, webhook_status, status, created_at, updated_at,
          actor_user_id
        ) VALUES (
          'tcb_conflict_link', 'cmt_conflict_link',
          'v1:000000000000000000000000:00000000000000000000000000000000:00',
          'oken', 1, '987655', 'ConflictBot', 'Conflict bot',
          'tgb_conflict_link', 'conflict-secret', 'active', 'active', ?1, ?1, ?2
        )
      `,
      args: [now, target.userId],
    })
    await ctx.client.execute({
      sql: `
        INSERT INTO community_membership_projections (
          projection_id, community_id, user_id, membership_state,
          role_summary_json, source_updated_at, created_at, updated_at
        ) VALUES (
          'cmp_link_conflict', 'cmt_conflict_link', ?1, 'member',
          '[]', ?2, ?2, ?2
        )
      `,
      args: [sourceUserId, now],
    })
    await ctx.client.execute({
      sql: `
        INSERT INTO wallet_attachments (
          wallet_attachment_id, user_id, chain_namespace,
          wallet_address_normalized, wallet_address_display,
          attachment_kind, is_primary, status, attached_at, created_at, updated_at
        ) VALUES (
          'wal_telegram_source', ?1, 'eip155:1',
          '0x1111111111111111111111111111111111111111',
          '0x1111111111111111111111111111111111111111',
          'external', 0, 'active', ?2, ?2, ?2
        )
      `,
      args: [sourceUserId, now],
    })

    const created = await post(
      "http://pirate.test/users/me/telegram-account-link-intents",
      { community_id: "cmt_conflict_link" },
      sourceToken,
      ctx.env,
    )
    const token = new URL((await json(created) as { link_url: string }).link_url)
      .searchParams.get("token")
    const consumed = await post(
      "http://pirate.test/users/me/telegram-account-link-intents/consume",
      { token },
      target.accessToken,
      ctx.env,
    )
    expect(consumed.status).toBe(200)
    expect(await json(consumed)).toEqual({ linked: true })

    const projection = await ctx.client.execute({
      sql: `
        SELECT user_id, membership_state
        FROM community_membership_projections
        WHERE community_id = 'cmt_conflict_link'
      `,
    })
    expect(projection.rows).toHaveLength(1)
    expect(String(projection.rows[0]?.user_id)).toBe(target.userId)
    expect(String(projection.rows[0]?.membership_state)).toBe("member")

    const alias = await ctx.client.execute({
      sql: `SELECT canonical_user_id FROM user_account_aliases WHERE source_user_id = ?1`,
      args: [sourceUserId],
    })
    expect(String(alias.rows[0]?.canonical_user_id)).toBe(target.userId)

    // Attaching a cashout wallet must not block consolidation and must not
    // silently transfer wallet authority to the canonical account.
    const sourceWallet = await ctx.client.execute({
      sql: `SELECT user_id FROM wallet_attachments WHERE wallet_attachment_id = 'wal_telegram_source'`,
    })
    expect(String(sourceWallet.rows[0]?.user_id)).toBe(sourceUserId)
  })

  test("leaves canonical streak rows byte-identical when the source has no study history", async () => {
    const fixture = await createMergeFixture({
      tag: "no_history",
      telegramUserId: "616161",
      postIds: ["pst_canonical_history"],
    })
    await insertEngagementDay({
      shard: fixture.shard,
      userId: fixture.target.userId,
      postId: "pst_canonical_history",
      communityId: fixture.communityId,
      date: "2026-08-01",
      timezone: "Pacific/Auckland",
    })
    await insertStreak({
      shard: fixture.shard,
      userId: fixture.target.userId,
      postId: "pst_canonical_history",
      communityId: fixture.communityId,
      current: 7,
      best: 9,
      lastDate: "2026-08-01",
      startDate: "2026-07-26",
      total: 12,
      createdAt: "2026-06-01T01:02:03.000Z",
      updatedAt: "2026-08-01T11:12:13.000Z",
      timezone: "Pacific/Auckland",
      timezoneUpdatedAt: "2026-07-01T04:05:06.000Z",
      activeUntilAt: "2026-08-02T12:00:00.000Z",
    })
    const before = await fixture.shard.execute({
      sql: `SELECT * FROM song_streaks WHERE user_id = ?1 AND post_id = 'pst_canonical_history'`,
      args: [fixture.target.userId],
    })

    await fixture.consumeLink()

    const after = await fixture.shard.execute({
      sql: `SELECT * FROM song_streaks WHERE user_id = ?1 AND post_id = 'pst_canonical_history'`,
      args: [fixture.target.userId],
    })
    expect(after.rows).toEqual(before.rows)
    expect(after.rows[0]).toMatchObject({
      timezone: "Pacific/Auckland",
      timezone_updated_at: "2026-07-01T04:05:06.000Z",
      active_until_at: "2026-08-02T12:00:00.000Z",
      created_at: "2026-06-01T01:02:03.000Z",
    })
  })

  test("merges non-reward study state without touching unrelated streaks and replays idempotently", async () => {
    const canonicalOnlyPostId = "pst_canonical_only"
    const sourceOnlyPostId = "pst_source_only"
    const sharedPostId = "pst_shared_history"
    const fixture = await createMergeFixture({
      tag: "study_history",
      telegramUserId: "717171",
      postIds: [canonicalOnlyPostId, sourceOnlyPostId, sharedPostId],
    })
    const canonicalUserId = fixture.target.userId
    const sourceUserId = fixture.sourceUserId
    const old = "2026-07-01T00:00:00.000Z"
    const recent = "2026-07-20T00:00:00.000Z"

    await fixture.shard.execute({
      sql: `
        INSERT INTO community_memberships (
          membership_id, community_id, user_id, status, joined_at, created_at, updated_at
        ) VALUES ('mbr_source_merge', ?1, ?2, 'member', ?3, ?3, ?3)
      `,
      args: [fixture.communityId, sourceUserId, old],
    })
    await fixture.ctx.client.execute({
      sql: `
        INSERT INTO community_membership_projections (
          projection_id, community_id, user_id, membership_state,
          role_summary_json, source_updated_at, created_at, updated_at
        ) VALUES ('cmp_source_merge', ?1, ?2, 'member', '[]', ?3, ?3, ?3)
      `,
      args: [fixture.communityId, sourceUserId, old],
    })
    await fixture.shard.execute({
      sql: `
        INSERT INTO song_study_session (
          id, user_id, post_id, community_id, target_language, status,
          exercise_count, required_correct_count, max_presentations,
          created_at, expires_at, updated_at
        ) VALUES ('sss_source_merge', ?1, ?2, ?3, 'es', 'active', 1, 1, 1, ?4, ?5, ?4)
      `,
      args: [sourceUserId, sharedPostId, fixture.communityId, old, "2026-08-01T00:00:00.000Z"],
    })
    await fixture.shard.execute({
      sql: `
        INSERT INTO song_study_attempt (
          id, user_id, post_id, exercise_id, line_id, exercise_type,
          target_language, study_pack_version, attempt_number, idempotency_key,
          outcome, created_at
        ) VALUES
          ('ssa_canonical_merge', ?1, ?3, 'exercise_merge', 'line_merge',
           'translation_choice', 'es', 1, 1, 'canonical-attempt', 'correct', ?4),
          ('ssa_source_merge', ?2, ?3, 'exercise_merge', 'line_merge',
           'translation_choice', 'es', 1, 1, 'source-attempt', 'incorrect', ?5)
      `,
      args: [canonicalUserId, sourceUserId, sharedPostId, old, recent],
    })
    await fixture.shard.execute({
      sql: `
        INSERT INTO song_study_review_state (
          user_id, post_id, line_id, exercise_type, target_language, state,
          stability, difficulty, due_at, last_reviewed_at, reps, lapses,
          fsrs_params_version, updated_at
        ) VALUES
          (?1, ?3, 'line_merge', 'translation_choice', 'es', 'learning',
           1, 5, ?4, ?4, 1, 0, 1, ?4),
          (?2, ?3, 'line_merge', 'translation_choice', 'es', 'review',
           4, 3, ?5, ?5, 6, 1, 2, ?5)
      `,
      args: [canonicalUserId, sourceUserId, sharedPostId, old, recent],
    })

    await insertEngagementDay({
      shard: fixture.shard,
      userId: canonicalUserId,
      postId: canonicalOnlyPostId,
      communityId: fixture.communityId,
      date: "2026-06-15",
      timezone: "Pacific/Honolulu",
    })
    await insertStreak({
      shard: fixture.shard,
      userId: canonicalUserId,
      postId: canonicalOnlyPostId,
      communityId: fixture.communityId,
      current: 4,
      best: 8,
      lastDate: "2026-06-15",
      startDate: "2026-06-12",
      total: 14,
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-06-15T13:00:00.000Z",
      timezone: "Pacific/Honolulu",
      timezoneUpdatedAt: "2026-05-02T00:00:00.000Z",
      activeUntilAt: "2026-06-17T10:00:00.000Z",
    })
    const canonicalOnlyBefore = await fixture.shard.execute({
      sql: `SELECT * FROM song_streaks WHERE user_id = ?1 AND post_id = ?2`,
      args: [canonicalUserId, canonicalOnlyPostId],
    })

    for (const date of ["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-10"]) {
      await insertEngagementDay({
        shard: fixture.shard,
        userId: canonicalUserId,
        postId: sharedPostId,
        communityId: fixture.communityId,
        date,
        attempts: date === "2026-07-10" ? 2 : 1,
        timezone: "America/New_York",
      })
    }
    for (const date of ["2026-07-10", "2026-07-11"]) {
      await insertEngagementDay({
        shard: fixture.shard,
        userId: sourceUserId,
        postId: sharedPostId,
        communityId: fixture.communityId,
        date,
        attempts: date === "2026-07-10" ? 3 : 1,
        correct: date === "2026-07-10" ? 5 : 1,
        timezone: "Asia/Tbilisi",
      })
    }
    await insertStreak({
      shard: fixture.shard,
      userId: canonicalUserId,
      postId: sharedPostId,
      communityId: fixture.communityId,
      current: 1,
      best: 3,
      lastDate: "2026-07-10",
      startDate: "2026-07-10",
      total: 4,
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-07-10T13:00:00.000Z",
      timezone: "America/New_York",
      timezoneUpdatedAt: "2026-04-02T00:00:00.000Z",
      activeUntilAt: "2026-07-12T04:00:00.000Z",
    })
    await insertStreak({
      shard: fixture.shard,
      userId: sourceUserId,
      postId: sharedPostId,
      communityId: fixture.communityId,
      current: 2,
      best: 2,
      lastDate: "2026-07-11",
      startDate: "2026-07-10",
      total: 2,
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-11T13:00:00.000Z",
      timezone: "Asia/Tbilisi",
      timezoneUpdatedAt: "2026-07-10T00:00:00.000Z",
      activeUntilAt: "2026-07-12T20:00:00.000Z",
    })

    for (const date of ["2026-07-20", "2026-07-22"]) {
      await insertEngagementDay({
        shard: fixture.shard,
        userId: sourceUserId,
        postId: sourceOnlyPostId,
        communityId: fixture.communityId,
        date,
        timezone: "Asia/Tokyo",
      })
    }
    await insertStreak({
      shard: fixture.shard,
      userId: sourceUserId,
      postId: sourceOnlyPostId,
      communityId: fixture.communityId,
      current: 1,
      best: 1,
      lastDate: "2026-07-22",
      startDate: "2026-07-22",
      total: 2,
      createdAt: "2026-07-20T01:00:00.000Z",
      updatedAt: "2026-07-22T01:00:00.000Z",
      timezone: "Asia/Tokyo",
      timezoneUpdatedAt: "2026-07-20T01:00:00.000Z",
      activeUntilAt: "2026-07-23T15:00:00.000Z",
    })

    const { linkIntentId } = await fixture.consumeLink()

    const mergeRow = await fixture.ctx.client.execute({
      sql: `SELECT user_account_merge_id, status FROM user_account_merges WHERE source_user_id = ?1`,
      args: [sourceUserId],
    })
    const mergeId = String(mergeRow.rows[0]?.user_account_merge_id)
    expect(mergeRow.rows[0]?.status).toBe("completed")
    const receipt = await fixture.shard.execute({
      sql: `SELECT COUNT(*) AS count FROM user_account_merge_receipts WHERE user_account_merge_id = ?1`,
      args: [mergeId],
    })
    expect(Number(receipt.rows[0]?.count)).toBe(1)

    const canonicalOnlyAfter = await fixture.shard.execute({
      sql: `SELECT * FROM song_streaks WHERE user_id = ?1 AND post_id = ?2`,
      args: [canonicalUserId, canonicalOnlyPostId],
    })
    expect(canonicalOnlyAfter.rows).toEqual(canonicalOnlyBefore.rows)

    const sharedStreak = await fixture.shard.execute({
      sql: `
        SELECT current_streak, best_streak, last_qualified_date, streak_started_date,
               total_qualified_days, created_at, timezone, timezone_updated_at, active_until_at
        FROM song_streaks WHERE user_id = ?1 AND post_id = ?2
      `,
      args: [canonicalUserId, sharedPostId],
    })
    expect(sharedStreak.rows).toHaveLength(1)
    expect(sharedStreak.rows[0]).toMatchObject({
      current_streak: 2,
      best_streak: 3,
      last_qualified_date: "2026-07-11",
      streak_started_date: "2026-07-10",
      total_qualified_days: 5,
      created_at: "2026-04-01T00:00:00.000Z",
      timezone: "America/New_York",
      timezone_updated_at: "2026-04-02T00:00:00.000Z",
      active_until_at: "2026-07-12T04:00:00.000Z",
    })
    const bestRunStart = "2026-07-01"
    expect(sharedStreak.rows[0]?.streak_started_date).not.toBe(bestRunStart)

    const sharedOverlap = await fixture.shard.execute({
      sql: `
        SELECT activity_date, study_attempt_count, study_correct_count, activity_timezone
        FROM song_engagement_days
        WHERE user_id = ?1 AND post_id = ?2 AND activity_date = '2026-07-10'
      `,
      args: [canonicalUserId, sharedPostId],
    })
    expect(sharedOverlap.rows).toEqual([expect.objectContaining({
      activity_date: "2026-07-10",
      study_attempt_count: 5,
      study_correct_count: 5,
      activity_timezone: "America/New_York",
    })])

    const sourceOnlyStreak = await fixture.shard.execute({
      sql: `
        SELECT user_id, current_streak, best_streak, streak_started_date,
               total_qualified_days, created_at, timezone, timezone_updated_at, active_until_at
        FROM song_streaks WHERE post_id = ?1
      `,
      args: [sourceOnlyPostId],
    })
    expect(sourceOnlyStreak.rows).toEqual([expect.objectContaining({
      user_id: canonicalUserId,
      current_streak: 1,
      best_streak: 1,
      streak_started_date: "2026-07-22",
      total_qualified_days: 2,
      created_at: "2026-07-20T01:00:00.000Z",
      timezone: "Asia/Tokyo",
      timezone_updated_at: "2026-07-20T01:00:00.000Z",
      active_until_at: "2026-07-23T15:00:00.000Z",
    })])

    const membership = await fixture.shard.execute({
      sql: `SELECT user_id, status FROM community_memberships WHERE membership_id = 'mbr_source_merge'`,
    })
    expect(membership.rows[0]).toMatchObject({ user_id: canonicalUserId, status: "member" })
    const projection = await fixture.ctx.client.execute({
      sql: `SELECT user_id, membership_state FROM community_membership_projections WHERE community_id = ?1`,
      args: [fixture.communityId],
    })
    expect(projection.rows).toEqual([expect.objectContaining({
      user_id: canonicalUserId,
      membership_state: "member",
    })])
    const session = await fixture.shard.execute({
      sql: `SELECT user_id, status FROM song_study_session WHERE id = 'sss_source_merge'`,
    })
    expect(session.rows[0]).toMatchObject({ user_id: canonicalUserId, status: "expired" })
    const attempts = await fixture.shard.execute({
      sql: `SELECT id, user_id, attempt_number, idempotency_key FROM song_study_attempt ORDER BY attempt_number`,
    })
    expect(attempts.rows).toEqual([
      expect.objectContaining({ id: "ssa_canonical_merge", user_id: canonicalUserId, attempt_number: 1 }),
      expect.objectContaining({
        id: "ssa_source_merge",
        user_id: canonicalUserId,
        attempt_number: 2,
        idempotency_key: `merge:${mergeId}:ssa_source_merge`,
      }),
    ])
    const review = await fixture.shard.execute({
      sql: `SELECT user_id, state, stability, difficulty, reps, lapses, fsrs_params_version FROM song_study_review_state`,
    })
    expect(review.rows).toEqual([expect.objectContaining({
      user_id: canonicalUserId,
      state: "review",
      stability: 4,
      difficulty: 3,
      reps: 6,
      lapses: 1,
      fsrs_params_version: 2,
    })])

    const alias = await fixture.ctx.client.execute({
      sql: `SELECT canonical_user_id, status FROM user_account_aliases WHERE source_user_id = ?1`,
      args: [sourceUserId],
    })
    expect(alias.rows[0]).toMatchObject({ canonical_user_id: canonicalUserId, status: "active" })
    const telegramAccount = await fixture.ctx.client.execute({
      sql: `SELECT user_id FROM telegram_accounts WHERE telegram_user_id = ?1`,
      args: [fixture.telegramUserId],
    })
    expect(telegramAccount.rows[0]?.user_id).toBe(canonicalUserId)
    const telegramResolution = await getSessionRepository(fixture.ctx.env).exchangeIdentity({
      provider: "telegram",
      providerSubject: fixture.providerSubject,
      providerUserRef: "telegram_study_history",
      selectedWalletAddress: null,
      walletAddresses: [],
      selectedWallet: null,
      wallets: [],
    })
    expect(telegramResolution.user.id.replace(/^usr_/, "")).toBe(canonicalUserId)

    const shardStateBeforeReplay = await fixture.shard.execute({
      sql: `
        SELECT 'engagement' AS kind, user_id, post_id, activity_date AS key, study_attempt_count AS value
        FROM song_engagement_days
        UNION ALL
        SELECT 'streak', user_id, post_id, streak_started_date, current_streak FROM song_streaks
        UNION ALL
        SELECT 'attempt', user_id, post_id, id, attempt_number FROM song_study_attempt
        ORDER BY kind, post_id, key
      `,
    })
    await fixture.ctx.client.execute({
      sql: `UPDATE user_account_merges SET status = 'migrating', completed_at = NULL WHERE user_account_merge_id = ?1`,
      args: [mergeId],
    })
    await mergeTelegramAccountIntoCanonical({
      env: fixture.ctx.env,
      linkIntentId,
      sourceUserId,
      canonicalUserId,
      providerSubject: fixture.providerSubject,
      telegramUserId: fixture.telegramUserId,
    })
    const shardStateAfterReplay = await fixture.shard.execute({
      sql: `
        SELECT 'engagement' AS kind, user_id, post_id, activity_date AS key, study_attempt_count AS value
        FROM song_engagement_days
        UNION ALL
        SELECT 'streak', user_id, post_id, streak_started_date, current_streak FROM song_streaks
        UNION ALL
        SELECT 'attempt', user_id, post_id, id, attempt_number FROM song_study_attempt
        ORDER BY kind, post_id, key
      `,
    })
    expect(shardStateAfterReplay.rows).toEqual(shardStateBeforeReplay.rows)
    const receiptsAfterReplay = await fixture.shard.execute({
      sql: `SELECT COUNT(*) AS count FROM user_account_merge_receipts WHERE user_account_merge_id = ?1`,
      args: [mergeId],
    })
    expect(Number(receiptsAfterReplay.rows[0]?.count)).toBe(1)
  })
})
