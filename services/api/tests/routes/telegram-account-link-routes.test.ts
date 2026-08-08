import { afterEach, describe, expect, test } from "bun:test"
import { app } from "../../src/index"
import { mintPirateAccessToken } from "../../src/lib/auth/pirate-session-token"
import { getSessionRepository } from "../../src/lib/auth/repositories"
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
  })
})
