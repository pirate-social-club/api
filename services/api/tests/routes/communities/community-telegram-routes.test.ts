import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createClient, type Client } from "@libsql/client"
import { createHmac } from "node:crypto"
import { app } from "../../../src/index"
import { buildLocalCommunityDbUrl } from "../../../src/lib/communities/community-local-db"
import { resolveTelegramAccount } from "../../../src/lib/telegram/join-request-service"
import { approvePendingTelegramJoinGrantsForUser } from "../../../src/lib/telegram/onboarding-service"
import { buildDefaultVerificationCapabilities } from "../../../src/lib/verification/verification-capabilities"
import { createRouteTestContext, json, resetRuntimeCaches } from "../../helpers"
import {
  exchangeJwt,
  requestJson,
} from "./community-routes-test-helpers"
import type { Env } from "../../../src/env"

const VALID_WRAP_KEY = "0".repeat(64)
const ELEVENLABS_COMMUNITY_API_KEY = "elevenlabs-community-telegram-key-1234"

let cleanup: (() => Promise<void>) | null = null
const originalFetch = globalThis.fetch

beforeEach(() => {
  resetRuntimeCaches()
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  if (cleanup) {
    await cleanup()
    cleanup = null
  }
})

async function createCommunity(input: {
  env: Env
  accessToken: string
  displayName: string
}): Promise<string> {
  const response = await requestJson("http://pirate.test/communities", {
    display_name: input.displayName,
    membership_mode: "request",
    handle_policy: { policy_template: "standard" },
  }, input.env, input.accessToken)
  expect(response.status).toBe(202)
  const body = await json(response) as { community: { id: string } }
  return body.community.id.replace(/^com_/, "")
}

function completeSetupIntent(input: {
  body: Record<string, unknown>
  env: Env
  secret?: string
}): Promise<Response> {
  return Promise.resolve(app.request(
    "http://pirate.test/telegram/setup-intents/complete",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(input.secret ? { "x-telegram-bot-secret": input.secret } : {}),
      },
      body: JSON.stringify(input.body),
    },
    input.env,
  ))
}

function telegramWebhook(input: {
  body: Record<string, unknown>
  env: Env
  secret?: string
}): Promise<Response> {
  return Promise.resolve(app.request(
    "http://pirate.test/telegram/webhook",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(input.secret ? { "x-telegram-bot-api-secret-token": input.secret } : {}),
      },
      body: JSON.stringify(input.body),
    },
    input.env,
  ))
}

function telegramCommunityBotWebhook(input: {
  body: Record<string, unknown>
  env: Env
  secret?: string
  webhookId: string
}): Promise<Response> {
  return Promise.resolve(app.request(
    `http://pirate.test/telegram/community-bots/${encodeURIComponent(input.webhookId)}/webhook`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(input.secret ? { "x-telegram-bot-api-secret-token": input.secret } : {}),
      },
      body: JSON.stringify(input.body),
    },
    input.env,
  ))
}

function installTelegramApiMock(handler: (request: Request) => unknown | Promise<unknown>): Request[] {
  const requests: Request[] = []
  ;(globalThis as { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> }).fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init)
    requests.push(request)
    const payload = await handler(request)
    return Response.json(payload)
  }
  return requests
}

type TelegramAndOpenRouterMock = {
  openRouterCalls: Array<{
    authorization: string | null
    body: {
      model?: string
      messages?: Array<{ role?: string; content?: string }>
    }
  }>
  telegramRequests: Request[]
}

function installTelegramAndOpenRouterMock(responseContent: string): TelegramAndOpenRouterMock {
  const openRouterCalls: TelegramAndOpenRouterMock["openRouterCalls"] = []
  const telegramRequests: Request[] = []
  ;(globalThis as { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> }).fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init)
    if (request.url === "https://openrouter.test/api/v1/chat/completions") {
      openRouterCalls.push({
        authorization: request.headers.get("authorization"),
        body: await request.json() as TelegramAndOpenRouterMock["openRouterCalls"][number]["body"],
      })
      return Response.json({
        id: `chatcmpl_telegram_${openRouterCalls.length}`,
        choices: [{ message: { content: responseContent } }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        },
      })
    }
    telegramRequests.push(request)
    const method = request.url.split("/").at(-1)
    if (method === "getMe") {
      return Response.json({
        ok: true,
        result: {
          id: 987654,
          is_bot: true,
          first_name: "Pirate Test Bot",
          username: "PirateTestBot",
        },
      })
    }
    if (method === "setWebhook" || method === "deleteWebhook") {
      return Response.json({ ok: true, result: true })
    }
    return Response.json({
      ok: true,
      result: { message_id: 600 + telegramRequests.length },
    })
  }
  return { openRouterCalls, telegramRequests }
}

function completionBody(input: {
  setupToken: string
  telegramChatId: string
  title?: string
  username?: string
  telegramUserId?: string
}): Record<string, unknown> {
  return {
    setup_token: input.setupToken,
    telegram_user: { id: input.telegramUserId ?? "123456" },
    telegram_chat: {
      id: input.telegramChatId,
      title: input.title ?? "Telegram Owner Club",
      username: input.username ?? "telegramownerclub",
      type: "supergroup",
    },
    bot_admin_status: "ready",
  }
}

function signedTelegramInitData(input: {
  botToken: string
  user: Record<string, unknown>
  authDate?: number
}): string {
  const params = new URLSearchParams()
  params.set("auth_date", String(input.authDate ?? Math.floor(Date.now() / 1000)))
  params.set("query_id", "telegram-onboarding-test")
  params.set("user", JSON.stringify(input.user))
  const dataCheckString = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")
  const secretKey = createHmac("sha256", "WebAppData").update(input.botToken).digest()
  const hash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex")
  params.set("hash", hash)
  return params.toString()
}

function telegramWebAppUrlFromReplyMarkup(replyMarkup: unknown): string {
  const markup = replyMarkup as {
    inline_keyboard?: Array<Array<{ web_app?: { url?: string } }>>
  }
  const url = markup.inline_keyboard?.[0]?.[0]?.web_app?.url
  expect(typeof url).toBe("string")
  return url!
}

function onboardingTokenFromWebAppUrl(url: string): string {
  return new URL(url).searchParams.get("token") ?? ""
}

function telegramSessionAutoExchange(input: {
  body: Record<string, unknown>
  env: Env
}): Promise<Response> {
  return Promise.resolve(app.request(
    "http://pirate.test/telegram/session/auto-exchange",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input.body),
    },
    input.env,
  ))
}

async function createSetupIntent(input: {
  env: Env
  communityId: string
  accessToken: string
}): Promise<{
  id: string
  community: string
  status: string
  bot_start_parameter: string
  bot_deep_link: string | null
}> {
  await ensureTelegramBotForCommunity({
    env: input.env,
    communityId: input.communityId,
  })
  const response = await requestJson(
    `http://pirate.test/communities/${input.communityId}/telegram-chat/setup-intents`,
    {},
    input.env,
    input.accessToken,
  )
  expect(response.status).toBe(200)
  return await json(response) as {
    id: string
    community: string
    status: string
    bot_start_parameter: string
    bot_deep_link: string | null
  }
}

async function ensureTelegramBotForCommunity(input: {
  env: Env
  communityId: string
}): Promise<void> {
  const url = input.env.CONTROL_PLANE_DATABASE_URL
  if (!url) {
    throw new Error("CONTROL_PLANE_DATABASE_URL is required")
  }
  const client = createClient({ url })
  const now = new Date().toISOString()
  try {
    const community = await client.execute({
      sql: "SELECT creator_user_id FROM communities WHERE community_id = ?1 LIMIT 1",
      args: [input.communityId],
    })
    const actorUserId = String(community.rows[0]?.creator_user_id ?? "")
    if (!actorUserId) {
      throw new Error(`missing test community ${input.communityId}`)
    }
    await client.execute({
      sql: `
        INSERT INTO telegram_community_bots (
          telegram_community_bot_id, community_id, encrypted_bot_token, token_last4,
          encryption_key_version, telegram_bot_user_id, bot_username, bot_display_name,
          webhook_id, webhook_secret, webhook_status, status, created_at, updated_at,
          revoked_at, rotated_from, actor_user_id
        ) VALUES (
          ?1, ?2, 'v1:000000000000000000000000:00000000000000000000000000000000:00', 'oken',
          1, '987654', 'PirateTestBot', 'Pirate test bot',
          ?3, 'test-community-webhook-secret', 'active', 'active', ?4, ?4,
          NULL, NULL, ?5
        )
        ON CONFLICT DO NOTHING
      `,
      args: [
        `tcb_${input.communityId}`,
        input.communityId,
        `tgb_${input.communityId}`,
        now,
        actorUserId,
      ],
    })
  } finally {
    client.close()
  }
}

async function saveCommunityBotForWebhook(input: {
  env: Env
  communityId: string
  accessToken: string
  token?: string
}): Promise<{ webhookId: string; webhookSecret: string; token: string }> {
  const token = input.token ?? "987654:communitydirectbottoken1234567890"
  const response = await requestJson(
    `http://pirate.test/communities/${input.communityId}/telegram-bot`,
    { bot_token: token },
    input.env,
    input.accessToken,
  )
  expect(response.status).toBe(200)
  const client = createClient({ url: input.env.CONTROL_PLANE_DATABASE_URL! })
  try {
    const stored = await client.execute({
      sql: `
        SELECT webhook_id, webhook_secret
        FROM telegram_community_bots
        WHERE community_id = ?1
          AND status = 'active'
        LIMIT 1
      `,
      args: [input.communityId],
    })
    const row = stored.rows[0]
    return {
      webhookId: String(row?.webhook_id ?? ""),
      webhookSecret: String(row?.webhook_secret ?? ""),
      token,
    }
  } finally {
    client.close()
  }
}

async function saveOpenRouterKey(input: {
  env: Env
  communityId: string
  accessToken: string
}): Promise<Response> {
  return requestJson(
    `http://pirate.test/communities/${input.communityId}/assistant-credential`,
    { api_key: "sk-or-telegram-assistant-key-1234" },
    input.env,
    input.accessToken,
  )
}

async function saveElevenLabsKey(input: {
  env: Env
  communityId: string
  accessToken: string
}): Promise<Response> {
  return requestJson(
    `http://pirate.test/communities/${input.communityId}/assistant-credential`,
    {
      provider: "elevenlabs",
      api_key: ELEVENLABS_COMMUNITY_API_KEY,
    },
    input.env,
    input.accessToken,
  )
}

async function updateAssistantPolicy(input: {
  env: Env
  communityId: string
  accessToken: string
  body: Record<string, unknown>
}): Promise<Response> {
  return requestJson(
    `http://pirate.test/communities/${input.communityId}/assistant-policy`,
    input.body,
    input.env,
    input.accessToken,
  )
}

async function setupEnabledAssistant(input: {
  env: Env
  communityId: string
  ownerToken: string
  policy?: Record<string, unknown>
}): Promise<void> {
  const credential = await saveOpenRouterKey({
    env: input.env,
    communityId: input.communityId,
    accessToken: input.ownerToken,
  })
  expect(credential.status).toBe(200)
  if (input.policy?.voiceMode && input.policy.voiceMode !== "off") {
    const elevenLabsCredential = await saveElevenLabsKey({
      env: input.env,
      communityId: input.communityId,
      accessToken: input.ownerToken,
    })
    expect(elevenLabsCredential.status).toBe(200)
  }
  const policy = await updateAssistantPolicy({
    env: input.env,
    communityId: input.communityId,
    accessToken: input.ownerToken,
    body: {
      enabled: true,
      selectedModelId: "test/telegram-assistant-model",
      systemPrompt: "You are the Telegram community assistant.",
      maxContextThreads: 5,
      maxLookbackDays: 365,
      perUserDailyMessageCap: null,
      telegramPrivateAssistantEnabled: true,
      ...input.policy,
    },
  })
  expect(policy.status).toBe(200)
}

async function seedAssistantContextRows(input: {
  communityDbRoot: string
  communityId: string
  userId: string
}): Promise<void> {
  const client = createClient({
    url: buildLocalCommunityDbUrl(input.communityDbRoot, input.communityId),
  })
  const now = new Date().toISOString()
  try {
    await client.batch([
      {
        sql: `
          INSERT INTO community_rules (
            rule_id, community_id, title, body, position, status, created_at, updated_at, report_reason
          ) VALUES (
            ?1, ?2, 'Telegram rule', 'Use /ask for assistant questions.', 0, 'active', ?3, ?3, 'Telegram rule'
          )
        `,
        args: [`rule_${input.communityId}_telegram`, input.communityId, now],
      },
      {
        sql: `
          INSERT INTO posts (
            post_id, community_id, author_user_id, identity_mode, post_type, status,
            title, body, analysis_state, content_safety_state, age_gate_policy, created_at, updated_at
          ) VALUES (
            ?1, ?2, ?3, 'public', 'text', 'published',
            'Telegram assistant context', 'This board answers assistant questions from Telegram.',
            'allow', 'safe', 'none', ?4, ?4
          )
        `,
        args: [`pst_${input.communityId}_telegram`, input.communityId, input.userId, now],
      },
    ], "write")
  } finally {
    client.close()
  }
}

async function setCommunityGatePolicy(input: {
  communityDbRoot: string
  communityId: string
  expression: Record<string, unknown>
}): Promise<void> {
  const client = createClient({
    url: buildLocalCommunityDbUrl(input.communityDbRoot, input.communityId),
  })
  const now = new Date().toISOString()
  try {
    await client.batch([
      {
        sql: `
          UPDATE communities
          SET membership_mode = 'gated',
              updated_at = ?2
          WHERE community_id = ?1
        `,
        args: [input.communityId, now],
      },
      {
        sql: `
          INSERT INTO community_gate_policies (
            community_id, scope, version, expression_json, created_at, updated_at
          ) VALUES (
            ?1, 'membership', 1, ?2, ?3, ?3
          )
          ON CONFLICT(community_id, scope) DO UPDATE SET
            expression_json = excluded.expression_json,
            updated_at = excluded.updated_at
        `,
        args: [
          input.communityId,
          JSON.stringify({ version: 1, expression: input.expression }),
          now,
        ],
      },
    ], "write")
  } finally {
    client.close()
  }
}

async function setUserNationality(input: {
  client: Client
  userId: string
  countryCode: string
}): Promise<void> {
  const capabilities = buildDefaultVerificationCapabilities()
  capabilities.nationality = {
    ...capabilities.nationality,
    state: "verified",
    provider: "self",
    value: input.countryCode,
    verified_at: Math.floor(Date.now() / 1000),
  }
  await input.client.execute({
    sql: `
      UPDATE users
      SET verification_capabilities_json = ?2,
          updated_at = ?3
      WHERE user_id = ?1
    `,
    args: [input.userId, JSON.stringify(capabilities), new Date().toISOString()],
  })
}

async function getTelegramAssistantEvent(input: {
  client: Client
  telegramChatId: string
  telegramMessageId: number
}): Promise<{ status: string; trigger_type: string; prompt: string } | null> {
  const result = await input.client.execute({
    sql: `
      SELECT status, trigger_type, prompt
      FROM telegram_assistant_events
      WHERE telegram_chat_id = ?1
        AND telegram_message_id = ?2
      LIMIT 1
    `,
    args: [input.telegramChatId, input.telegramMessageId],
  })
  const row = result.rows[0]
  return row
    ? {
        status: String(row.status ?? ""),
        trigger_type: String(row.trigger_type ?? ""),
        prompt: String(row.prompt ?? ""),
      }
    : null
}

async function getTelegramAssistantEventChannel(input: {
  client: Client
  telegramChatId: string
  telegramMessageId: number
}): Promise<string | null> {
  const result = await input.client.execute({
    sql: `
      SELECT channel
      FROM telegram_assistant_events
      WHERE telegram_chat_id = ?1
        AND telegram_message_id = ?2
      LIMIT 1
    `,
    args: [input.telegramChatId, input.telegramMessageId],
  })
  const channel = result.rows[0]?.channel
  return typeof channel === "string" ? channel : null
}

async function getTelegramJoinGrant(input: {
  client: Client
  telegramChatId: string
  telegramUserId: string
}): Promise<{
  status: string
  user_id: string | null
  missing_capabilities_json: string | null
  prompted_at: string | null
  approved_at: string | null
  expires_at: string | null
  error_message: string | null
} | null> {
  const result = await input.client.execute({
    sql: `
      SELECT status, user_id, missing_capabilities_json, prompted_at, approved_at, expires_at, error_message
      FROM telegram_join_grants
      WHERE telegram_chat_id = ?1
        AND telegram_user_id = ?2
      ORDER BY created_at DESC, grant_id DESC
      LIMIT 1
    `,
    args: [input.telegramChatId, input.telegramUserId],
  })
  const row = result.rows[0]
  return row
    ? {
        status: String(row.status ?? ""),
        user_id: typeof row.user_id === "string" ? row.user_id : null,
        missing_capabilities_json: typeof row.missing_capabilities_json === "string" ? row.missing_capabilities_json : null,
        prompted_at: typeof row.prompted_at === "string" ? row.prompted_at : null,
        approved_at: typeof row.approved_at === "string" ? row.approved_at : null,
        expires_at: typeof row.expires_at === "string" ? row.expires_at : null,
        error_message: typeof row.error_message === "string" ? row.error_message : null,
      }
    : null
}

async function countTelegramJoinGrants(input: {
  client: Client
  telegramChatId: string
  telegramUserId: string
}): Promise<number> {
  const result = await input.client.execute({
    sql: `
      SELECT COUNT(*) AS count
      FROM telegram_join_grants
      WHERE telegram_chat_id = ?1
        AND telegram_user_id = ?2
    `,
    args: [input.telegramChatId, input.telegramUserId],
  })
  return Number(result.rows[0]?.count ?? 0)
}

async function linkTelegramAccount(input: {
  client: Client
  telegramUserId: string
  userId: string
}): Promise<void> {
  const now = new Date().toISOString()
  await input.client.execute({
    sql: `
      INSERT INTO telegram_accounts (
        telegram_user_id, user_id, username, first_name, last_name, photo_url,
        first_seen_at, last_seen_at, updated_at
      ) VALUES (
        ?1, ?2, NULL, NULL, NULL, NULL,
        ?3, ?3, ?3
      )
    `,
    args: [input.telegramUserId, input.userId, now],
  })
}

async function getTelegramAccount(input: {
  client: Client
  telegramUserId: string
}): Promise<{ telegram_user_id: string; user_id: string } | null> {
  const result = await input.client.execute({
    sql: `
      SELECT telegram_user_id, user_id
      FROM telegram_accounts
      WHERE telegram_user_id = ?1
      LIMIT 1
    `,
    args: [input.telegramUserId],
  })
  const row = result.rows[0]
  return row
    ? {
        telegram_user_id: String(row.telegram_user_id ?? ""),
        user_id: String(row.user_id ?? ""),
      }
    : null
}

async function markCommunityMember(input: {
  communityDbRoot: string
  communityId: string
  userId: string
}): Promise<void> {
  const client = createClient({
    url: buildLocalCommunityDbUrl(input.communityDbRoot, input.communityId),
  })
  const now = new Date().toISOString()
  try {
    await client.execute({
      sql: `
        INSERT INTO community_memberships (
          membership_id, community_id, user_id, status, joined_at, left_at, banned_at, created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, 'member', ?4, NULL, NULL, ?4, ?4
        )
      `,
      args: [`mbr_${input.communityId}_${input.userId}`, input.communityId, input.userId, now],
    })
  } finally {
    client.close()
  }
}

async function getCommunityMembershipStatus(input: {
  communityDbRoot: string
  communityId: string
  userId: string
}): Promise<string | null> {
  const client = createClient({
    url: buildLocalCommunityDbUrl(input.communityDbRoot, input.communityId),
  })
  try {
    const result = await client.execute({
      sql: `
        SELECT status
        FROM community_memberships
        WHERE community_id = ?1
          AND user_id = ?2
        LIMIT 1
      `,
      args: [input.communityId, input.userId],
    })
    const status = result.rows[0]?.status
    return typeof status === "string" ? status : null
  } finally {
    client.close()
  }
}

async function getAssistantUserMessageMetadata(input: {
  communityDbRoot: string
  communityId: string
  content: string
  userId: string
}): Promise<Record<string, unknown> | null> {
  const client = createClient({
    url: buildLocalCommunityDbUrl(input.communityDbRoot, input.communityId),
  })
  try {
    const result = await client.execute({
      sql: `
        SELECT metadata_json
        FROM community_assistant_messages
        WHERE community_id = ?1
          AND user_id = ?2
          AND role = 'user'
          AND content = ?3
        ORDER BY created_at DESC
        LIMIT 1
      `,
      args: [input.communityId, input.userId, input.content],
    })
    const metadataJson = result.rows[0]?.metadata_json
    return typeof metadataJson === "string" && metadataJson
      ? JSON.parse(metadataJson) as Record<string, unknown>
      : null
  } finally {
    client.close()
  }
}

async function linkTelegramChatForCommunity(input: {
  env: Env
  communityId: string
  accessToken: string
  telegramChatId: string
  title?: string
}): Promise<void> {
  const setupIntent = await createSetupIntent({
    env: input.env,
    communityId: input.communityId,
    accessToken: input.accessToken,
  })
  const response = await completeSetupIntent({
    env: input.env,
    secret: "test-telegram-secret",
    body: completionBody({
      setupToken: setupIntent.bot_start_parameter,
      telegramChatId: input.telegramChatId,
      title: input.title ?? "Telegram Assistant Club",
      username: "telegramassistantclub",
    }),
  })
  expect(response.status).toBe(200)
}

async function getSetupIntentStatus(input: {
  client: Client
  setupIntentId: string
}): Promise<string | null> {
  const result = await input.client.execute({
    sql: `
      SELECT status
      FROM telegram_setup_intents
      WHERE telegram_setup_intent_id = ?1
    `,
    args: [input.setupIntentId],
  })
  const status = result.rows[0]?.status
  return typeof status === "string" ? status : null
}

async function getSetupIntentRequest(input: {
  client: Client
  setupIntentId: string
}): Promise<{
  request_id: number | null
  request_owner_telegram_user_id: string | null
  request_private_chat_id: string | null
  request_message_id: number | null
}> {
  const result = await input.client.execute({
    sql: `
      SELECT request_id, request_owner_telegram_user_id, request_private_chat_id, request_message_id
      FROM telegram_setup_intents
      WHERE telegram_setup_intent_id = ?1
    `,
    args: [input.setupIntentId],
  })
  const row = result.rows[0]
  return {
    request_id: row?.request_id == null ? null : Number(row.request_id),
    request_owner_telegram_user_id: typeof row?.request_owner_telegram_user_id === "string" ? row.request_owner_telegram_user_id : null,
    request_private_chat_id: typeof row?.request_private_chat_id === "string" ? row.request_private_chat_id : null,
    request_message_id: row?.request_message_id == null ? null : Number(row.request_message_id),
  }
}

describe("community Telegram routes", () => {
  test("owner can save a community-owned bot token without exposing plaintext", async () => {
    const token = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXsecretLAST4"
    const telegramRequests = installTelegramApiMock(async (request) => {
      const method = request.url.split("/").at(-1)
      const body = await request.json().catch(() => ({})) as Record<string, unknown>
      if (method === "getMe") {
        return {
          ok: true,
          result: {
            id: 123456789,
            is_bot: true,
            first_name: "Community Test Bot",
            username: "CommunityOwnedBot",
          },
        }
      }
      if (method === "setWebhook") {
        expect(body.url).toContain("/telegram/community-bots/")
        expect(typeof body.secret_token).toBe("string")
        expect(body.allowed_updates).toEqual(["message", "chat_join_request"])
        return { ok: true, result: true }
      }
      if (method === "deleteWebhook") {
        expect(body.drop_pending_updates).toBe(false)
        return { ok: true, result: true }
      }
      return { ok: true, result: { message_id: 700 } }
    })
    const ctx = await createRouteTestContext({
      PIRATE_API_PUBLIC_ORIGIN: "https://api.pirate.test",
      TURSO_COMMUNITY_DB_WRAP_KEY: VALID_WRAP_KEY,
      TURSO_COMMUNITY_DB_WRAP_KEY_VERSION: "2",
    })
    cleanup = ctx.cleanup
    const owner = await exchangeJwt(ctx.env, "telegram-bot-owner")
    const communityId = await createCommunity({
      env: ctx.env,
      accessToken: owner.accessToken,
      displayName: "Community Bot Club",
    })

    const saveResponse = await requestJson(
      `http://pirate.test/communities/${communityId}/telegram-bot`,
      { bot_token: token },
      ctx.env,
      owner.accessToken,
    )
    expect(saveResponse.status).toBe(200)
    const saved = await json(saveResponse) as {
      status: string
      bot_username: string | null
      token_last4: string | null
      webhook_status: string | null
      bot_token?: string
      encrypted_bot_token?: string
    }
    expect(saved.status).toBe("connected")
    expect(saved.bot_username).toBe("CommunityOwnedBot")
    expect(saved.token_last4).toBe("AST4")
    expect(saved.webhook_status).toBe("active")
    expect(saved.bot_token).toBeUndefined()
    expect(saved.encrypted_bot_token).toBeUndefined()

    const stored = await ctx.client.execute({
      sql: `
        SELECT encrypted_bot_token, token_last4, webhook_id, webhook_secret, webhook_status, status
        FROM telegram_community_bots
        WHERE bot_username = ?1
        LIMIT 1
      `,
      args: ["CommunityOwnedBot"],
    })
    expect(stored.rows.length).toBe(1)
    const row = stored.rows[0]
    expect(String(row?.encrypted_bot_token).startsWith("v1:")).toBe(true)
    expect(String(row?.encrypted_bot_token)).not.toContain(token)
    expect(row?.token_last4).toBe("AST4")
    expect(row?.webhook_status).toBe("active")
    expect(row?.status).toBe("active")
    expect(String(row?.webhook_id).startsWith("tgb_")).toBe(true)
    expect(String(row?.webhook_secret).length).toBeGreaterThan(20)
    expect(telegramRequests.map((request) => request.url)).toEqual([
      `https://api.telegram.org/bot${token}/getMe`,
      `https://api.telegram.org/bot${token}/setWebhook`,
    ])

    const revokeResponse = await requestJson(
      `http://pirate.test/communities/${communityId}/telegram-bot/revoke`,
      {},
      ctx.env,
      owner.accessToken,
    )
    expect(revokeResponse.status).toBe(200)
    const revoked = await json(revokeResponse) as { status: string; token_last4: string | null }
    expect(revoked.status).toBe("missing")
    expect(revoked.token_last4).toBeNull()
    expect(telegramRequests.map((request) => request.url)).toEqual([
      `https://api.telegram.org/bot${token}/getMe`,
      `https://api.telegram.org/bot${token}/setWebhook`,
      `https://api.telegram.org/bot${token}/deleteWebhook`,
    ])
  })

  test("community bot webhook decrypts and uses that community bot token", async () => {
    const token = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXsecretLAST4"
    const telegramRequests = installTelegramApiMock(async (request) => {
      const method = request.url.split("/").at(-1)
      if (method === "getMe") {
        return {
          ok: true,
          result: {
            id: 123456789,
            is_bot: true,
            first_name: "Community Test Bot",
            username: "CommunityOwnedBot",
          },
        }
      }
      if (method === "setWebhook") {
        return { ok: true, result: true }
      }
      return { ok: true, result: { message_id: 701 } }
    })
    const ctx = await createRouteTestContext({
      PIRATE_API_PUBLIC_ORIGIN: "https://api.pirate.test",
      TURSO_COMMUNITY_DB_WRAP_KEY: VALID_WRAP_KEY,
      TURSO_COMMUNITY_DB_WRAP_KEY_VERSION: "2",
      TELEGRAM_BOT_TOKEN: "999999999:PLATFORMTOKENSHOULDNOTBEUSED",
      TELEGRAM_BOT_USERNAME: "PlatformBot",
    })
    cleanup = ctx.cleanup
    const owner = await exchangeJwt(ctx.env, "telegram-community-webhook-owner")
    const communityId = await createCommunity({
      env: ctx.env,
      accessToken: owner.accessToken,
      displayName: "Community Webhook Club",
    })
    const saveResponse = await requestJson(
      `http://pirate.test/communities/${communityId}/telegram-bot`,
      { bot_token: token },
      ctx.env,
      owner.accessToken,
    )
    expect(saveResponse.status).toBe(200)
    const stored = await ctx.client.execute({
      sql: `
        SELECT webhook_id, webhook_secret
        FROM telegram_community_bots
        WHERE bot_username = ?1
        LIMIT 1
      `,
      args: ["CommunityOwnedBot"],
    })
    expect(stored.rows.length).toBe(1)
    const webhookId = String(stored.rows[0]?.webhook_id)
    const webhookSecret = String(stored.rows[0]?.webhook_secret)

    const rejected = await telegramCommunityBotWebhook({
      env: ctx.env,
      webhookId,
      secret: "wrong-secret",
      body: { update_id: 1, message: { message_id: 1, chat: { id: 9001, type: "private" }, from: { id: 5001 }, text: "/start" } },
    })
    expect(rejected.status).toBe(401)

    const accepted = await telegramCommunityBotWebhook({
      env: ctx.env,
      webhookId,
      secret: webhookSecret,
      body: { update_id: 2, message: { message_id: 2, chat: { id: 9001, type: "private" }, from: { id: 5001 }, text: "/start" } },
    })
    expect(accepted.status).toBe(200)
    const sendMessageRequests = telegramRequests.filter((request) => request.url.endsWith("/sendMessage"))
    expect(sendMessageRequests).toHaveLength(1)
    expect(sendMessageRequests[0]?.url).toBe(`https://api.telegram.org/bot${token}/sendMessage`)
  })

  test("public bot username endpoint exposes only the active bot username", async () => {
    const token = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXsecretLAST4"
    installTelegramApiMock(async (request) => {
      const method = request.url.split("/").at(-1)
      if (method === "getMe") {
        return {
          ok: true,
          result: {
            id: 123456789,
            is_bot: true,
            first_name: "Community Test Bot",
            username: "CommunityOwnedBot",
          },
        }
      }
      if (method === "setWebhook") {
        return { ok: true, result: true }
      }
      return { ok: true, result: true }
    })
    const ctx = await createRouteTestContext({
      PIRATE_API_PUBLIC_ORIGIN: "https://api.pirate.test",
      TURSO_COMMUNITY_DB_WRAP_KEY: VALID_WRAP_KEY,
      TURSO_COMMUNITY_DB_WRAP_KEY_VERSION: "2",
    })
    cleanup = ctx.cleanup
    const owner = await exchangeJwt(ctx.env, "telegram-bot-username-owner")
    const communityId = await createCommunity({
      env: ctx.env,
      accessToken: owner.accessToken,
      displayName: "Community Bot Username Club",
    })

    const missingResponse = await app.request(
      `http://pirate.test/communities/com_${communityId}/telegram-bot-username`,
      {},
      ctx.env,
    )
    expect(missingResponse.status).toBe(200)
    const missingBody = await json(missingResponse) as { active_telegram_bot_username?: string | null }
    expect(missingBody.active_telegram_bot_username).toBeNull()

    await saveCommunityBotForWebhook({
      accessToken: owner.accessToken,
      communityId,
      env: ctx.env,
      token,
    })

    const activeResponse = await app.request(
      `http://pirate.test/communities/com_${communityId}/telegram-bot-username`,
      {},
      ctx.env,
    )
    expect(activeResponse.status).toBe(200)
    const activeBody = await json(activeResponse) as {
      active_telegram_bot_username?: string | null
      encrypted_bot_token?: string
      webhook_id?: string
    }
    expect(activeBody).toEqual({ active_telegram_bot_username: "CommunityOwnedBot" })
    expect(activeBody.encrypted_bot_token).toBeUndefined()
    expect(activeBody.webhook_id).toBeUndefined()
  })

  test("community bot start with matching join payload resolves from bot identity", async () => {
    const token = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXsecretLAST4"
    const telegramRequests = installTelegramApiMock(async (request) => {
      const method = request.url.split("/").at(-1)
      if (method === "getMe") {
        return {
          ok: true,
          result: {
            id: 123456789,
            is_bot: true,
            first_name: "Community Test Bot",
            username: "CommunityOwnedBot",
          },
        }
      }
      if (method === "setWebhook" || method === "setChatMenuButton") {
        return { ok: true, result: true }
      }
      return { ok: true, result: { message_id: 702 } }
    })
    const ctx = await createRouteTestContext({
      PIRATE_API_PUBLIC_ORIGIN: "https://api.pirate.test",
      PIRATE_WEB_PUBLIC_ORIGIN: "https://staging.pirate.test",
      TURSO_COMMUNITY_DB_WRAP_KEY: VALID_WRAP_KEY,
      TURSO_COMMUNITY_DB_WRAP_KEY_VERSION: "2",
    })
    cleanup = ctx.cleanup
    const owner = await exchangeJwt(ctx.env, "telegram-bot-join-owner")
    const communityId = await createCommunity({
      env: ctx.env,
      accessToken: owner.accessToken,
      displayName: "Community Join Payload Club",
    })
    const { webhookId, webhookSecret } = await saveCommunityBotForWebhook({
      accessToken: owner.accessToken,
      communityId,
      env: ctx.env,
      token,
    })

    const accepted = await telegramCommunityBotWebhook({
      env: ctx.env,
      webhookId,
      secret: webhookSecret,
      body: {
        update_id: 3,
        message: {
          message_id: 3,
          chat: { id: 9001, type: "private" },
          from: { id: 5001, language_code: "ar" },
          text: `/start join_com_${communityId}`,
        },
      },
    })
    expect(accepted.status).toBe(200)
    const sendMessageRequests = telegramRequests.filter((request) => request.url.endsWith("/sendMessage"))
    expect(sendMessageRequests).toHaveLength(1)
    const sendBody = await sendMessageRequests[0]!.json() as {
      text?: string
      reply_markup?: { inline_keyboard?: Array<Array<{ text?: string; web_app?: { url?: string } }>> }
    }
    expect(sendBody.text).toBe("مرحباً بك في Community Join Payload Club. اربط حسابك في Pirate للتحقق والانضمام.")
    expect(sendBody.reply_markup?.inline_keyboard?.[0]?.[0]?.text).toBe("تحقق للانضمام")
    expect(sendBody.reply_markup?.inline_keyboard?.[0]?.[0]?.web_app?.url).toBe(`https://staging.pirate.test/tg/verify/com_${communityId}`)
  })

  test("community bot start joins linked users who are eligible", async () => {
    const token = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXsecretLAST4"
    const telegramRequests = installTelegramApiMock(async (request) => {
      const method = request.url.split("/").at(-1)
      if (method === "getMe") {
        return {
          ok: true,
          result: {
            id: 123456789,
            is_bot: true,
            first_name: "Community Test Bot",
            username: "CommunityOwnedBot",
          },
        }
      }
      if (method === "setWebhook" || method === "setChatMenuButton") {
        return { ok: true, result: true }
      }
      return { ok: true, result: { message_id: 704 } }
    })
    const ctx = await createRouteTestContext({
      PIRATE_API_PUBLIC_ORIGIN: "https://api.pirate.test",
      PIRATE_WEB_PUBLIC_ORIGIN: "https://staging.pirate.test",
      TURSO_COMMUNITY_DB_WRAP_KEY: VALID_WRAP_KEY,
      TURSO_COMMUNITY_DB_WRAP_KEY_VERSION: "2",
    })
    cleanup = ctx.cleanup
    const owner = await exchangeJwt(ctx.env, "telegram-bot-auto-join-owner")
    const member = await exchangeJwt(ctx.env, "telegram-bot-auto-join-member")
    const communityId = await createCommunity({
      env: ctx.env,
      accessToken: owner.accessToken,
      displayName: "Community Auto Join Club",
    })
    await setCommunityGatePolicy({
      communityDbRoot: ctx.communityDbRoot,
      communityId,
      expression: {
        op: "gate",
        gate: {
          type: "nationality",
          provider: "self",
          allowed: ["US"],
        },
      },
    })
    await setUserNationality({
      client: ctx.client,
      userId: member.userId,
      countryCode: "US",
    })
    await ctx.client.execute({
      sql: `UPDATE profiles SET preferred_locale = 'zh' WHERE user_id = ?1`,
      args: [member.userId],
    })
    await linkTelegramAccount({
      client: ctx.client,
      telegramUserId: "5002",
      userId: member.userId,
    })
    const { webhookId, webhookSecret } = await saveCommunityBotForWebhook({
      accessToken: owner.accessToken,
      communityId,
      env: ctx.env,
      token,
    })

    const accepted = await telegramCommunityBotWebhook({
      env: ctx.env,
      webhookId,
      secret: webhookSecret,
      body: {
        update_id: 5,
        message: {
          message_id: 5,
          chat: { id: 9002, type: "private" },
          from: { id: 5002, language_code: "ka" },
          text: `/start join_com_${communityId}`,
        },
      },
    })

    expect(accepted.status).toBe(200)
    expect(await getCommunityMembershipStatus({
      communityDbRoot: ctx.communityDbRoot,
      communityId,
      userId: member.userId,
    })).toBe("member")
    const sendMessageRequests = telegramRequests.filter((request) => request.url.endsWith("/sendMessage"))
    expect(sendMessageRequests).toHaveLength(1)
    const sendBody = await sendMessageRequests[0]!.json() as {
      reply_markup?: { inline_keyboard?: Array<Array<{ text?: string; web_app?: { url?: string } }>> }
      text?: string
    }
    expect(sendBody.text).toBe("თქვენ ახლა ხართ Community Auto Join Club-ში.")
    expect(sendBody.reply_markup?.inline_keyboard?.[0]?.[0]?.text).toBe("საზოგადოების გახსნა")
    expect(sendBody.reply_markup?.inline_keyboard?.[0]?.[0]?.web_app?.url).toBe(`https://staging.pirate.test/tg/c/com_${communityId}`)
  })

  test("community bot start rejects a join payload for another community", async () => {
    const token = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXsecretLAST4"
    const telegramRequests = installTelegramApiMock(async (request) => {
      const method = request.url.split("/").at(-1)
      if (method === "getMe") {
        return {
          ok: true,
          result: {
            id: 123456789,
            is_bot: true,
            first_name: "Community Test Bot",
            username: "CommunityOwnedBot",
          },
        }
      }
      if (method === "setWebhook") {
        return { ok: true, result: true }
      }
      return { ok: true, result: { message_id: 703 } }
    })
    const ctx = await createRouteTestContext({
      PIRATE_API_PUBLIC_ORIGIN: "https://api.pirate.test",
      PIRATE_WEB_PUBLIC_ORIGIN: "https://staging.pirate.test",
      TURSO_COMMUNITY_DB_WRAP_KEY: VALID_WRAP_KEY,
      TURSO_COMMUNITY_DB_WRAP_KEY_VERSION: "2",
    })
    cleanup = ctx.cleanup
    const owner = await exchangeJwt(ctx.env, "telegram-bot-join-mismatch-owner")
    const communityId = await createCommunity({
      env: ctx.env,
      accessToken: owner.accessToken,
      displayName: "Community Join Mismatch Club",
    })
    const otherCommunityId = await createCommunity({
      env: ctx.env,
      accessToken: owner.accessToken,
      displayName: "Other Community Join Club",
    })
    const { webhookId, webhookSecret } = await saveCommunityBotForWebhook({
      accessToken: owner.accessToken,
      communityId,
      env: ctx.env,
      token,
    })

    const accepted = await telegramCommunityBotWebhook({
      env: ctx.env,
      webhookId,
      secret: webhookSecret,
      body: {
        update_id: 4,
        message: {
          message_id: 4,
          chat: { id: 9001, type: "private" },
          from: { id: 5001 },
          text: `/start join_com_${otherCommunityId}`,
        },
      },
    })
    expect(accepted.status).toBe(200)
    const sendMessageRequests = telegramRequests.filter((request) => request.url.endsWith("/sendMessage"))
    expect(sendMessageRequests).toHaveLength(1)
    const sendBody = await sendMessageRequests[0]!.json() as { text?: string }
    expect(sendBody.text).toBe("This link is for a different community.")
  })

  test("owner can create setup intent, complete linked chat, update settings, and unlink", async () => {
    const ctx = await createRouteTestContext({
      TELEGRAM_BOT_USERNAME: "PirateTestBot",
      TELEGRAM_BOT_INTEGRATION_SECRET: "test-telegram-secret",
    })
    cleanup = ctx.cleanup
    const owner = await exchangeJwt(ctx.env, "telegram-owner")
    const communityId = await createCommunity({
      env: ctx.env,
      accessToken: owner.accessToken,
      displayName: "Telegram Owner Club",
    })

    const setupIntent = await createSetupIntent({
      env: ctx.env,
      communityId,
      accessToken: owner.accessToken,
    })
    expect(setupIntent.id.startsWith("tsi_")).toBe(true)
    expect(setupIntent.community).toBe(`com_${communityId}`)
    expect(setupIntent.status).toBe("pending")
    expect(setupIntent.bot_start_parameter.startsWith("tgsetup_")).toBe(true)
    expect(setupIntent.bot_deep_link).toContain("https://t.me/PirateTestBot?start=tgsetup_")

    const completeResponse = await completeSetupIntent({
      env: ctx.env,
      secret: "test-telegram-secret",
      body: completionBody({
        setupToken: setupIntent.bot_start_parameter,
        telegramChatId: "-1001234567890",
      }),
    })
    expect(completeResponse.status).toBe(200)
    const completeBody = await json(completeResponse) as {
      linked_chat: {
        id: string
        object: string
        community: string
        title: string
        username: string | null
        link_mode: string
        bot_admin_status: string
        directory_visible: boolean
        telegram_chat_id?: string
      }
    }
    expect(completeBody.linked_chat.id.startsWith("tlc_")).toBe(true)
    expect(completeBody.linked_chat.object).toBe("telegram_linked_chat")
    expect(completeBody.linked_chat.community).toBe(`com_${communityId}`)
    expect(completeBody.linked_chat.title).toBe("Telegram Owner Club")
    expect(completeBody.linked_chat.username).toBe("telegramownerclub")
    expect(completeBody.linked_chat.link_mode).toBe("join_request")
    expect(completeBody.linked_chat.bot_admin_status).toBe("ready")
    expect(completeBody.linked_chat.directory_visible).toBe(true)
    expect(completeBody.linked_chat.telegram_chat_id).toBeUndefined()

    const getResponse = await app.request(
      `http://pirate.test/communities/${communityId}/telegram-chat`,
      { headers: { authorization: `Bearer ${owner.accessToken}` } },
      ctx.env,
    )
    expect(getResponse.status).toBe(200)
    const getBody = await json(getResponse) as {
      linked_chat: { title: string; link_mode: string; directory_visible: boolean }
    }
    expect(getBody.linked_chat.title).toBe("Telegram Owner Club")
    expect(getBody.linked_chat.link_mode).toBe("join_request")
    expect(getBody.linked_chat.directory_visible).toBe(true)

    const updateResponse = await requestJson(
      `http://pirate.test/communities/${communityId}/telegram-chat`,
      {
        link_mode: "invite_link",
        directory_visible: false,
      },
      ctx.env,
      owner.accessToken,
    )
    expect(updateResponse.status).toBe(200)
    const updateBody = await json(updateResponse) as {
      linked_chat: { link_mode: string; directory_visible: boolean }
    }
    expect(updateBody.linked_chat.link_mode).toBe("invite_link")
    expect(updateBody.linked_chat.directory_visible).toBe(false)

    const unlinkResponse = await requestJson(
      `http://pirate.test/communities/${communityId}/telegram-chat/unlink`,
      {},
      ctx.env,
      owner.accessToken,
    )
    expect(unlinkResponse.status).toBe(200)
    const unlinkBody = await json(unlinkResponse) as { linked_chat: unknown }
    expect(unlinkBody.linked_chat).toBeNull()
  })

  test("non-owners cannot create setup intents", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup
    const owner = await exchangeJwt(ctx.env, "telegram-owner-only-owner")
    const stranger = await exchangeJwt(ctx.env, "telegram-owner-only-stranger")
    const communityId = await createCommunity({
      env: ctx.env,
      accessToken: owner.accessToken,
      displayName: "Telegram Owner Only Club",
    })

    const response = await requestJson(
      `http://pirate.test/communities/${communityId}/telegram-chat/setup-intents`,
      {},
      ctx.env,
      stranger.accessToken,
    )
    expect(response.status).toBe(404)
  })

  test("setup completion rejects Telegram channels", async () => {
    const ctx = await createRouteTestContext({
      TELEGRAM_BOT_INTEGRATION_SECRET: "test-telegram-secret",
    })
    cleanup = ctx.cleanup
    const owner = await exchangeJwt(ctx.env, "telegram-channel-owner")
    const communityId = await createCommunity({
      env: ctx.env,
      accessToken: owner.accessToken,
      displayName: "Telegram Channel Reject Club",
    })
    const setupIntent = await createSetupIntent({
      env: ctx.env,
      communityId,
      accessToken: owner.accessToken,
    })

    const response = await completeSetupIntent({
      env: ctx.env,
      secret: "test-telegram-secret",
      body: {
        setup_token: setupIntent.bot_start_parameter,
        telegram_user: { id: "123456" },
        telegram_chat: {
          id: "-100555",
          title: "Announcements Channel",
          username: "announcements",
          type: "channel",
        },
      },
    })
    expect(response.status).toBe(400)

    const getResponse = await app.request(
      `http://pirate.test/communities/${communityId}/telegram-chat`,
      { headers: { authorization: `Bearer ${owner.accessToken}` } },
      ctx.env,
    )
    const body = await json(getResponse) as { linked_chat: unknown }
    expect(body.linked_chat).toBeNull()
  })

  test("setup completion requires the bot integration secret", async () => {
    const ctx = await createRouteTestContext({
      TELEGRAM_BOT_INTEGRATION_SECRET: "test-telegram-secret",
    })
    cleanup = ctx.cleanup
    const owner = await exchangeJwt(ctx.env, "telegram-secret-owner")
    const communityId = await createCommunity({
      env: ctx.env,
      accessToken: owner.accessToken,
      displayName: "Telegram Secret Club",
    })
    const setupIntent = await createSetupIntent({
      env: ctx.env,
      communityId,
      accessToken: owner.accessToken,
    })

    const response = await completeSetupIntent({
      env: ctx.env,
      body: {
        setup_token: setupIntent.bot_start_parameter,
        telegram_chat: {
          id: "-100777",
          title: "Telegram Secret Club",
          type: "supergroup",
        },
      },
    })
    expect(response.status).toBe(401)
  })

  test("setup completion expires stale pending intents", async () => {
    const ctx = await createRouteTestContext({
      TELEGRAM_BOT_INTEGRATION_SECRET: "test-telegram-secret",
    })
    cleanup = ctx.cleanup
    const owner = await exchangeJwt(ctx.env, "telegram-expired-owner")
    const communityId = await createCommunity({
      env: ctx.env,
      accessToken: owner.accessToken,
      displayName: "Telegram Expired Club",
    })
    const setupIntent = await createSetupIntent({
      env: ctx.env,
      communityId,
      accessToken: owner.accessToken,
    })
    await ctx.client.execute({
      sql: `
        UPDATE telegram_setup_intents
        SET expires_at = ?2
        WHERE telegram_setup_intent_id = ?1
      `,
      args: [setupIntent.id, new Date(Date.now() - 60_000).toISOString()],
    })

    const response = await completeSetupIntent({
      env: ctx.env,
      secret: "test-telegram-secret",
      body: completionBody({
        setupToken: setupIntent.bot_start_parameter,
        telegramChatId: "-100888",
      }),
    })

    expect(response.status).toBe(409)
    expect(await getSetupIntentStatus({ client: ctx.client, setupIntentId: setupIntent.id })).toBe("expired")
    const getResponse = await app.request(
      `http://pirate.test/communities/${communityId}/telegram-chat`,
      { headers: { authorization: `Bearer ${owner.accessToken}` } },
      ctx.env,
    )
    const body = await json(getResponse) as { linked_chat: unknown }
    expect(body.linked_chat).toBeNull()
  })

  test("setup completion rejects token replay after first completion", async () => {
    const ctx = await createRouteTestContext({
      TELEGRAM_BOT_INTEGRATION_SECRET: "test-telegram-secret",
    })
    cleanup = ctx.cleanup
    const owner = await exchangeJwt(ctx.env, "telegram-replay-owner")
    const communityId = await createCommunity({
      env: ctx.env,
      accessToken: owner.accessToken,
      displayName: "Telegram Replay Club",
    })
    const setupIntent = await createSetupIntent({
      env: ctx.env,
      communityId,
      accessToken: owner.accessToken,
    })
    const body = completionBody({
      setupToken: setupIntent.bot_start_parameter,
      telegramChatId: "-100999",
      title: "Telegram Replay Club",
      username: "telegramreplayclub",
    })

    const firstResponse = await completeSetupIntent({
      env: ctx.env,
      secret: "test-telegram-secret",
      body,
    })
    expect(firstResponse.status).toBe(200)

    const replayResponse = await completeSetupIntent({
      env: ctx.env,
      secret: "test-telegram-secret",
      body,
    })
    expect(replayResponse.status).toBe(409)
    expect(await getSetupIntentStatus({ client: ctx.client, setupIntentId: setupIntent.id })).toBe("completed")
  })

  test("setup completion rejects chats already linked to another community", async () => {
    const ctx = await createRouteTestContext({
      TELEGRAM_BOT_INTEGRATION_SECRET: "test-telegram-secret",
    })
    cleanup = ctx.cleanup
    const firstOwner = await exchangeJwt(ctx.env, "telegram-cross-first-owner")
    const secondOwner = await exchangeJwt(ctx.env, "telegram-cross-second-owner")
    const firstCommunityId = await createCommunity({
      env: ctx.env,
      accessToken: firstOwner.accessToken,
      displayName: "Telegram First Club",
    })
    const secondCommunityId = await createCommunity({
      env: ctx.env,
      accessToken: secondOwner.accessToken,
      displayName: "Telegram Second Club",
    })
    const firstSetupIntent = await createSetupIntent({
      env: ctx.env,
      communityId: firstCommunityId,
      accessToken: firstOwner.accessToken,
    })
    const secondSetupIntent = await createSetupIntent({
      env: ctx.env,
      communityId: secondCommunityId,
      accessToken: secondOwner.accessToken,
    })

    const firstResponse = await completeSetupIntent({
      env: ctx.env,
      secret: "test-telegram-secret",
      body: completionBody({
        setupToken: firstSetupIntent.bot_start_parameter,
        telegramChatId: "-1004242",
        title: "Shared Telegram Club",
        username: "sharedtelegramclub",
      }),
    })
    expect(firstResponse.status).toBe(200)

    const secondResponse = await completeSetupIntent({
      env: ctx.env,
      secret: "test-telegram-secret",
      body: completionBody({
        setupToken: secondSetupIntent.bot_start_parameter,
        telegramChatId: "-1004242",
        title: "Shared Telegram Club",
        username: "sharedtelegramclub",
      }),
    })
    expect(secondResponse.status).toBe(409)

    const getSecondResponse = await app.request(
      `http://pirate.test/communities/${secondCommunityId}/telegram-chat`,
      { headers: { authorization: `Bearer ${secondOwner.accessToken}` } },
      ctx.env,
    )
    const getSecondBody = await json(getSecondResponse) as { linked_chat: unknown }
    expect(getSecondBody.linked_chat).toBeNull()
  })

  test("webhook start arms setup intent and sends request_chat keyboard in private chat", async () => {
    const ctx = await createRouteTestContext({
      TELEGRAM_BOT_USERNAME: "PirateTestBot",
      TELEGRAM_BOT_TOKEN: "987654:bot-token",
      TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
    })
    cleanup = ctx.cleanup
    const owner = await exchangeJwt(ctx.env, "telegram-webhook-start-owner")
    const communityId = await createCommunity({
      env: ctx.env,
      accessToken: owner.accessToken,
      displayName: "Telegram Webhook Start Club",
    })
    const setupIntent = await createSetupIntent({
      env: ctx.env,
      communityId,
      accessToken: owner.accessToken,
    })
    const requests = installTelegramApiMock(() => ({
      ok: true,
      result: { message_id: 55 },
    }))

    const response = await telegramWebhook({
      env: ctx.env,
      secret: "webhook-secret",
      body: {
        update_id: 1,
        message: {
          message_id: 41,
          text: `/start ${setupIntent.bot_start_parameter}`,
          from: { id: 777000 },
          chat: { id: 777000, type: "private" },
        },
      },
    })

    expect(response.status).toBe(200)
    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toBe("https://api.telegram.org/bot987654:bot-token/sendMessage")
    const sendBody = await requests[0]!.json() as {
      chat_id: string
      text: string
      reply_markup: {
        keyboard: Array<Array<{
          request_chat: {
            request_id: number
            chat_is_channel: boolean
            bot_is_member: boolean
            user_administrator_rights: { can_invite_users: boolean }
            bot_administrator_rights: { can_invite_users: boolean }
          }
        }>>
      }
    }
    expect(sendBody.chat_id).toBe("777000")
    expect(sendBody.text).toContain("Add @PirateTestBot")
    const requestChat = sendBody.reply_markup.keyboard[0]![0]!.request_chat
    expect(requestChat.chat_is_channel).toBe(false)
    expect(requestChat.bot_is_member).toBe(true)
    expect(requestChat.user_administrator_rights.can_invite_users).toBe(true)
    expect(requestChat.bot_administrator_rights.can_invite_users).toBe(true)

    const storedRequest = await getSetupIntentRequest({
      client: ctx.client,
      setupIntentId: setupIntent.id,
    })
    expect(storedRequest.request_id).toBe(requestChat.request_id)
    expect(storedRequest.request_owner_telegram_user_id).toBe("777000")
    expect(storedRequest.request_private_chat_id).toBe("777000")
    expect(storedRequest.request_message_id).toBe(41)
    expect(await getTelegramAccount({
      client: ctx.client,
      telegramUserId: "777000",
    })).toEqual({
      telegram_user_id: "777000",
      user_id: owner.userId,
    })
  })

  test("webhook start in a group does not arm setup intent", async () => {
    const ctx = await createRouteTestContext({
      TELEGRAM_BOT_USERNAME: "PirateTestBot",
      TELEGRAM_BOT_TOKEN: "987654:bot-token",
      TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
    })
    cleanup = ctx.cleanup
    const owner = await exchangeJwt(ctx.env, "telegram-webhook-group-owner")
    const communityId = await createCommunity({
      env: ctx.env,
      accessToken: owner.accessToken,
      displayName: "Telegram Webhook Group Club",
    })
    const setupIntent = await createSetupIntent({
      env: ctx.env,
      communityId,
      accessToken: owner.accessToken,
    })
    const requests = installTelegramApiMock(() => ({
      ok: true,
      result: { message_id: 56 },
    }))

    const response = await telegramWebhook({
      env: ctx.env,
      secret: "webhook-secret",
      body: {
        update_id: 2,
        message: {
          message_id: 42,
          text: `/start ${setupIntent.bot_start_parameter}`,
          from: { id: 777001 },
          chat: { id: -1007001, type: "supergroup" },
        },
      },
    })

    expect(response.status).toBe(200)
    expect(requests).toHaveLength(1)
    const sendBody = await requests[0]!.json() as { chat_id: string; text: string; reply_markup?: unknown }
    expect(sendBody.chat_id).toBe("-1007001")
    expect(sendBody.text).toContain("private chat")
    expect(sendBody.reply_markup).toBeUndefined()
    const storedRequest = await getSetupIntentRequest({
      client: ctx.client,
      setupIntentId: setupIntent.id,
    })
    expect(storedRequest.request_id).toBeNull()
  })

  test("webhook chat_shared completes an armed setup intent", async () => {
    const ctx = await createRouteTestContext({
      TELEGRAM_BOT_USERNAME: "PirateTestBot",
      TELEGRAM_BOT_TOKEN: "987654:bot-token",
      TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
    })
    cleanup = ctx.cleanup
    const owner = await exchangeJwt(ctx.env, "telegram-webhook-shared-owner")
    const communityId = await createCommunity({
      env: ctx.env,
      accessToken: owner.accessToken,
      displayName: "Telegram Webhook Shared Club",
    })
    const setupIntent = await createSetupIntent({
      env: ctx.env,
      communityId,
      accessToken: owner.accessToken,
    })
    const requests = installTelegramApiMock((request) => {
      if (request.url.endsWith("/getChat")) {
        return {
          ok: true,
          result: {
            id: -1008080,
            type: "supergroup",
            title: "Telegram Webhook Shared Club",
            username: "telegramwebhookshared",
          },
        }
      }
      if (request.url.endsWith("/getChatMember")) {
        return {
          ok: true,
          result: {
            status: "administrator",
            can_invite_users: true,
          },
        }
      }
      return {
        ok: true,
        result: { message_id: 57 },
      }
    })

    const startResponse = await telegramWebhook({
      env: ctx.env,
      secret: "webhook-secret",
      body: {
        update_id: 3,
        message: {
          message_id: 43,
          text: `/start ${setupIntent.bot_start_parameter}`,
          from: { id: 777002 },
          chat: { id: 777002, type: "private" },
        },
      },
    })
    expect(startResponse.status).toBe(200)
    const storedRequest = await getSetupIntentRequest({
      client: ctx.client,
      setupIntentId: setupIntent.id,
    })
    expect(typeof storedRequest.request_id).toBe("number")

    const sharedResponse = await telegramWebhook({
      env: ctx.env,
      secret: "webhook-secret",
      body: {
        update_id: 4,
        message: {
          message_id: 44,
          from: { id: 777002 },
          chat: { id: 777002, type: "private" },
          chat_shared: {
            request_id: storedRequest.request_id,
            chat_id: -1008080,
            title: "Fallback Title",
            username: "fallbackusername",
          },
        },
      },
    })

    expect(sharedResponse.status).toBe(200)
    expect(requests.map((request) => request.url.split("/").pop())).toEqual([
      "sendMessage",
      "getChat",
      "getChatMember",
      "sendMessage",
    ])
    const getMemberBody = await requests[2]!.json() as { chat_id: string; user_id: number }
    expect(getMemberBody.chat_id).toBe("-1008080")
    expect(getMemberBody.user_id).toBe(987654)
    const successBody = await requests[3]!.json() as { text: string }
    expect(successBody.text).toContain("connected")
    expect(await getTelegramAccount({
      client: ctx.client,
      telegramUserId: "777002",
    })).toEqual({
      telegram_user_id: "777002",
      user_id: owner.userId,
    })

    const getResponse = await app.request(
      `http://pirate.test/communities/${communityId}/telegram-chat`,
      { headers: { authorization: `Bearer ${owner.accessToken}` } },
      ctx.env,
    )
    const body = await json(getResponse) as {
      linked_chat: {
        title: string
        username: string | null
        bot_admin_status: string
      } | null
    }
    expect(body.linked_chat?.title).toBe("Telegram Webhook Shared Club")
    expect(body.linked_chat?.username).toBe("telegramwebhookshared")
    expect(body.linked_chat?.bot_admin_status).toBe("ready")

    await ctx.client.execute({
      sql: "DELETE FROM telegram_accounts WHERE telegram_user_id = ?1",
      args: ["777002"],
    })
    expect(await resolveTelegramAccount({
      env: ctx.env,
      telegramUserId: "777002",
    })).toEqual({ userId: owner.userId })
    expect(await getTelegramAccount({
      client: ctx.client,
      telegramUserId: "777002",
    })).toEqual({
      telegram_user_id: "777002",
      user_id: owner.userId,
    })
  })

  test("webhook chat_shared with the wrong request id is acknowledged without linking", async () => {
    const ctx = await createRouteTestContext({
      TELEGRAM_BOT_USERNAME: "PirateTestBot",
      TELEGRAM_BOT_TOKEN: "987654:bot-token",
      TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
    })
    cleanup = ctx.cleanup
    const owner = await exchangeJwt(ctx.env, "telegram-webhook-wrong-request-owner")
    const communityId = await createCommunity({
      env: ctx.env,
      accessToken: owner.accessToken,
      displayName: "Telegram Webhook Wrong Request Club",
    })
    const setupIntent = await createSetupIntent({
      env: ctx.env,
      communityId,
      accessToken: owner.accessToken,
    })
    const requests = installTelegramApiMock((request) => {
      if (request.url.endsWith("/getChat")) {
        return {
          ok: true,
          result: {
            id: -1008181,
            type: "supergroup",
            title: "Telegram Webhook Wrong Request Club",
            username: "telegramwrongrequest",
          },
        }
      }
      if (request.url.endsWith("/getChatMember")) {
        return {
          ok: true,
          result: {
            status: "administrator",
            can_invite_users: true,
          },
        }
      }
      return {
        ok: true,
        result: { message_id: 58 },
      }
    })

    const startResponse = await telegramWebhook({
      env: ctx.env,
      secret: "webhook-secret",
      body: {
        update_id: 6,
        message: {
          message_id: 45,
          text: `/start ${setupIntent.bot_start_parameter}`,
          from: { id: 777003 },
          chat: { id: 777003, type: "private" },
        },
      },
    })
    expect(startResponse.status).toBe(200)
    const storedRequest = await getSetupIntentRequest({
      client: ctx.client,
      setupIntentId: setupIntent.id,
    })
    expect(typeof storedRequest.request_id).toBe("number")
    const wrongRequestId = storedRequest.request_id === 1 ? 2 : 1

    const sharedResponse = await telegramWebhook({
      env: ctx.env,
      secret: "webhook-secret",
      body: {
        update_id: 7,
        message: {
          message_id: 46,
          from: { id: 777003 },
          chat: { id: 777003, type: "private" },
          chat_shared: {
            request_id: wrongRequestId,
            chat_id: -1008181,
            title: "Wrong Request Fallback",
          },
        },
      },
    })

    expect(sharedResponse.status).toBe(200)
    expect(requests.map((request) => request.url.split("/").pop())).toEqual([
      "sendMessage",
      "getChat",
      "getChatMember",
      "sendMessage",
    ])
    const errorBody = await requests[3]!.json() as { text: string }
    expect(errorBody.text).toContain("not found")

    const getResponse = await app.request(
      `http://pirate.test/communities/${communityId}/telegram-chat`,
      { headers: { authorization: `Bearer ${owner.accessToken}` } },
      ctx.env,
    )
    const body = await json(getResponse) as { linked_chat: unknown }
    expect(body.linked_chat).toBeNull()
  })

  test("webhook chat_shared expires an armed setup intent that aged out", async () => {
    const ctx = await createRouteTestContext({
      TELEGRAM_BOT_USERNAME: "PirateTestBot",
      TELEGRAM_BOT_TOKEN: "987654:bot-token",
      TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
    })
    cleanup = ctx.cleanup
    const owner = await exchangeJwt(ctx.env, "telegram-webhook-expired-request-owner")
    const communityId = await createCommunity({
      env: ctx.env,
      accessToken: owner.accessToken,
      displayName: "Telegram Webhook Expired Request Club",
    })
    const setupIntent = await createSetupIntent({
      env: ctx.env,
      communityId,
      accessToken: owner.accessToken,
    })
    const requests = installTelegramApiMock((request) => {
      if (request.url.endsWith("/getChat")) {
        return {
          ok: true,
          result: {
            id: -1008282,
            type: "supergroup",
            title: "Telegram Webhook Expired Request Club",
            username: "telegramexpiredrequest",
          },
        }
      }
      if (request.url.endsWith("/getChatMember")) {
        return {
          ok: true,
          result: {
            status: "administrator",
            can_invite_users: true,
          },
        }
      }
      return {
        ok: true,
        result: { message_id: 59 },
      }
    })

    const startResponse = await telegramWebhook({
      env: ctx.env,
      secret: "webhook-secret",
      body: {
        update_id: 8,
        message: {
          message_id: 47,
          text: `/start ${setupIntent.bot_start_parameter}`,
          from: { id: 777004 },
          chat: { id: 777004, type: "private" },
        },
      },
    })
    expect(startResponse.status).toBe(200)
    const storedRequest = await getSetupIntentRequest({
      client: ctx.client,
      setupIntentId: setupIntent.id,
    })
    expect(typeof storedRequest.request_id).toBe("number")
    await ctx.client.execute({
      sql: `
        UPDATE telegram_setup_intents
        SET expires_at = ?2
        WHERE telegram_setup_intent_id = ?1
      `,
      args: [setupIntent.id, new Date(Date.now() - 60_000).toISOString()],
    })

    const sharedResponse = await telegramWebhook({
      env: ctx.env,
      secret: "webhook-secret",
      body: {
        update_id: 9,
        message: {
          message_id: 48,
          from: { id: 777004 },
          chat: { id: 777004, type: "private" },
          chat_shared: {
            request_id: storedRequest.request_id,
            chat_id: -1008282,
            title: "Expired Request Fallback",
          },
        },
      },
    })

    expect(sharedResponse.status).toBe(200)
    expect(await getSetupIntentStatus({ client: ctx.client, setupIntentId: setupIntent.id })).toBe("expired")
    const errorBody = await requests[3]!.json() as { text: string }
    expect(errorBody.text).toContain("expired")

    const getResponse = await app.request(
      `http://pirate.test/communities/${communityId}/telegram-chat`,
      { headers: { authorization: `Bearer ${owner.accessToken}` } },
      ctx.env,
    )
    const body = await json(getResponse) as { linked_chat: unknown }
    expect(body.linked_chat).toBeNull()
  })

  test("webhook acknowledges setup errors even when the error reply fails", async () => {
    const ctx = await createRouteTestContext({
      TELEGRAM_BOT_TOKEN: "987654:bot-token",
      TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
    })
    cleanup = ctx.cleanup
    const requests = installTelegramApiMock(() => ({
      ok: false,
      description: "Too Many Requests",
    }))

    const response = await telegramWebhook({
      env: ctx.env,
      secret: "webhook-secret",
      body: {
        update_id: 10,
        message: {
          message_id: 49,
          text: "/start tgsetup_missing",
          from: { id: 777005 },
          chat: { id: 777005, type: "private" },
        },
      },
    })

    expect(response.status).toBe(200)
    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toBe("https://api.telegram.org/bot987654:bot-token/sendMessage")
  })

  test("webhook group ask routes to assistant with group-safe context and threaded reply", async () => {
    const ctx = await createRouteTestContext({
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      OPENROUTER_TIMEOUT_MS: "1000",
      TELEGRAM_BOT_USERNAME: "PirateTestBot",
      TELEGRAM_BOT_TOKEN: "987654:bot-token",
      TELEGRAM_BOT_INTEGRATION_SECRET: "test-telegram-secret",
      TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
      TURSO_COMMUNITY_DB_WRAP_KEY: VALID_WRAP_KEY,
      TURSO_COMMUNITY_DB_WRAP_KEY_VERSION: "1",
    })
    cleanup = ctx.cleanup
    const owner = await exchangeJwt(ctx.env, "telegram-group-assistant-owner")
    const communityId = await createCommunity({
      env: ctx.env,
      accessToken: owner.accessToken,
      displayName: "Telegram Group Assistant Club",
    })
    await seedAssistantContextRows({
      communityDbRoot: ctx.communityDbRoot,
      communityId,
      userId: owner.userId,
    })
    await setupEnabledAssistant({
      env: ctx.env,
      communityId,
      ownerToken: owner.accessToken,
      policy: { actionMode: "draft_only" },
    })
    await linkTelegramChatForCommunity({
      env: ctx.env,
      communityId,
      accessToken: owner.accessToken,
      telegramChatId: "-1009001",
      title: "Telegram Group Assistant Club",
    })
    const mock = installTelegramAndOpenRouterMock("Use /ask for assistant questions.")

    const response = await telegramWebhook({
      env: ctx.env,
      secret: "webhook-secret",
      body: {
        update_id: 11,
        message: {
          message_id: 101,
          message_thread_id: 77,
          text: "/ask what are the rules?",
          from: { id: 777006 },
          chat: { id: -1009001, type: "supergroup" },
        },
      },
    })

    expect(response.status).toBe(200)
    expect(mock.openRouterCalls).toHaveLength(1)
    expect(mock.openRouterCalls[0]?.authorization).toBe("Bearer sk-or-telegram-assistant-key-1234")
    expect(mock.openRouterCalls[0]?.body.model).toBe("test/telegram-assistant-model")
    const systemContent = mock.openRouterCalls[0]?.body.messages?.[0]?.content ?? ""
    expect(systemContent).toContain("Assistant audience: public_group")
    expect(systemContent).toContain("Telegram rule")
    expect(systemContent).not.toContain("Viewer membership")
    expect(systemContent).not.toContain("draft_only")
    expect(systemContent).toContain("Telegram group response rules")

    expect(mock.telegramRequests).toHaveLength(1)
    const sendBody = await mock.telegramRequests[0]!.json() as {
      chat_id: string
      message_thread_id?: number
      text: string
      reply_parameters?: { message_id: number }
    }
    expect(sendBody.chat_id).toBe("-1009001")
    expect(sendBody.message_thread_id).toBe(77)
    expect(sendBody.reply_parameters?.message_id).toBe(101)
    expect(sendBody.text).toContain("Use /ask")
    expect(await getTelegramAssistantEvent({
      client: ctx.client,
      telegramChatId: "-1009001",
      telegramMessageId: 101,
    })).toEqual({
      status: "answered",
      trigger_type: "ask_command",
      prompt: "what are the rules?",
    })
    expect(await getTelegramAssistantEventChannel({
      client: ctx.client,
      telegramChatId: "-1009001",
      telegramMessageId: 101,
    })).toBe("group")
  })

  test("webhook group assistant supports bot-qualified ask and reply-to-bot triggers", async () => {
    const ctx = await createRouteTestContext({
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      OPENROUTER_TIMEOUT_MS: "1000",
      TELEGRAM_BOT_USERNAME: "PirateTestBot",
      TELEGRAM_BOT_TOKEN: "987654:bot-token",
      TELEGRAM_BOT_INTEGRATION_SECRET: "test-telegram-secret",
      TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
      TURSO_COMMUNITY_DB_WRAP_KEY: VALID_WRAP_KEY,
      TURSO_COMMUNITY_DB_WRAP_KEY_VERSION: "1",
    })
    cleanup = ctx.cleanup
    const owner = await exchangeJwt(ctx.env, "telegram-group-assistant-trigger-owner")
    const communityId = await createCommunity({
      env: ctx.env,
      accessToken: owner.accessToken,
      displayName: "Telegram Group Trigger Club",
    })
    await setupEnabledAssistant({
      env: ctx.env,
      communityId,
      ownerToken: owner.accessToken,
    })
    await linkTelegramChatForCommunity({
      env: ctx.env,
      communityId,
      accessToken: owner.accessToken,
      telegramChatId: "-1009002",
      title: "Telegram Group Trigger Club",
    })
    const mock = installTelegramAndOpenRouterMock("Triggered answer.")

    const mentioned = await telegramWebhook({
      env: ctx.env,
      secret: "webhook-secret",
      body: {
        update_id: 12,
        message: {
          message_id: 102,
          text: "/ask@PirateTestBot explain this group",
          from: { id: 777007 },
          chat: { id: -1009002, type: "supergroup" },
        },
      },
    })
    expect(mentioned.status).toBe(200)

    const reply = await telegramWebhook({
      env: ctx.env,
      secret: "webhook-secret",
      body: {
        update_id: 13,
        message: {
          message_id: 103,
          text: "follow up from a reply",
          from: { id: 777007 },
          chat: { id: -1009002, type: "supergroup" },
          reply_to_message: {
            message_id: 600,
            from: { id: 987654, is_bot: true, username: "PirateTestBot" },
          },
        },
      },
    })
    expect(reply.status).toBe(200)

    const spacedMention = await telegramWebhook({
      env: ctx.env,
      secret: "webhook-secret",
      body: {
        update_id: 14,
        message: {
          message_id: 104,
          text: "/ask @PirateTestBot what changed?",
          from: { id: 777007 },
          chat: { id: -1009002, type: "supergroup" },
        },
      },
    })
    expect(spacedMention.status).toBe(200)

    expect(mock.openRouterCalls).toHaveLength(3)
    expect(mock.telegramRequests).toHaveLength(3)
    expect(await getTelegramAssistantEvent({
      client: ctx.client,
      telegramChatId: "-1009002",
      telegramMessageId: 102,
    })).toEqual({
      status: "answered",
      trigger_type: "ask_command_mention",
      prompt: "explain this group",
    })
    expect(await getTelegramAssistantEvent({
      client: ctx.client,
      telegramChatId: "-1009002",
      telegramMessageId: 103,
    })).toEqual({
      status: "answered",
      trigger_type: "reply_to_bot",
      prompt: "follow up from a reply",
    })
    expect(await getTelegramAssistantEvent({
      client: ctx.client,
      telegramChatId: "-1009002",
      telegramMessageId: 104,
    })).toEqual({
      status: "answered",
      trigger_type: "ask_command_mention",
      prompt: "what changed?",
    })
  })

  test("webhook group assistant reports model provider failures clearly", async () => {
    const ctx = await createRouteTestContext({
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      OPENROUTER_TIMEOUT_MS: "1000",
      TELEGRAM_BOT_USERNAME: "PirateTestBot",
      TELEGRAM_BOT_TOKEN: "987654:bot-token",
      TELEGRAM_BOT_INTEGRATION_SECRET: "test-telegram-secret",
      TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
      TURSO_COMMUNITY_DB_WRAP_KEY: VALID_WRAP_KEY,
      TURSO_COMMUNITY_DB_WRAP_KEY_VERSION: "1",
    })
    cleanup = ctx.cleanup
    const owner = await exchangeJwt(ctx.env, "telegram-group-assistant-provider-owner")
    const communityId = await createCommunity({
      env: ctx.env,
      accessToken: owner.accessToken,
      displayName: "Telegram Group Provider Club",
    })
    await setupEnabledAssistant({
      env: ctx.env,
      communityId,
      ownerToken: owner.accessToken,
    })
    await linkTelegramChatForCommunity({
      env: ctx.env,
      communityId,
      accessToken: owner.accessToken,
      telegramChatId: "-1009005",
      title: "Telegram Group Provider Club",
    })

    const telegramRequests: Request[] = []
    ;(globalThis as { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> }).fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request ? input : new Request(input, init)
      if (request.url === "https://openrouter.test/api/v1/chat/completions") {
        return new Response("<html>timeout</html>", {
          headers: { "content-type": "text/html" },
          status: 200,
        })
      }
      telegramRequests.push(request)
      return Response.json({ ok: true, result: { message_id: 700 } })
    }

    const response = await telegramWebhook({
      env: ctx.env,
      secret: "webhook-secret",
      body: {
        update_id: 15,
        message: {
          message_id: 105,
          text: "/ask what is new?",
          from: { id: 777010 },
          chat: { id: -1009005, type: "supergroup" },
        },
      },
    })

    expect(response.status).toBe(200)
    expect(telegramRequests).toHaveLength(1)
    const sendBody = await telegramRequests[0]!.json() as { text: string }
    expect(sendBody.text).toContain("assistant model provider failed to respond")
    expect(await getTelegramAssistantEvent({
      client: ctx.client,
      telegramChatId: "-1009005",
      telegramMessageId: 105,
    })).toEqual({
      status: "failed",
      trigger_type: "ask_command",
      prompt: "what is new?",
    })
  })

  test("webhook ignores non-trigger group messages without persistence or provider calls", async () => {
    const ctx = await createRouteTestContext({
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      TELEGRAM_BOT_USERNAME: "PirateTestBot",
      TELEGRAM_BOT_TOKEN: "987654:bot-token",
      TELEGRAM_BOT_INTEGRATION_SECRET: "test-telegram-secret",
      TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
      TURSO_COMMUNITY_DB_WRAP_KEY: VALID_WRAP_KEY,
      TURSO_COMMUNITY_DB_WRAP_KEY_VERSION: "1",
    })
    cleanup = ctx.cleanup
    const owner = await exchangeJwt(ctx.env, "telegram-group-assistant-ignore-owner")
    const communityId = await createCommunity({
      env: ctx.env,
      accessToken: owner.accessToken,
      displayName: "Telegram Group Ignore Club",
    })
    await setupEnabledAssistant({
      env: ctx.env,
      communityId,
      ownerToken: owner.accessToken,
    })
    await linkTelegramChatForCommunity({
      env: ctx.env,
      communityId,
      accessToken: owner.accessToken,
      telegramChatId: "-1009003",
      title: "Telegram Group Ignore Club",
    })
    const mock = installTelegramAndOpenRouterMock("Should not be used.")

    const response = await telegramWebhook({
      env: ctx.env,
      secret: "webhook-secret",
      body: {
        update_id: 14,
        message: {
          message_id: 104,
          text: "hello @PirateTestBot",
          from: { id: 777008 },
          chat: { id: -1009003, type: "supergroup" },
        },
      },
    })

    expect(response.status).toBe(200)
    expect(mock.openRouterCalls).toHaveLength(0)
    expect(mock.telegramRequests).toHaveLength(0)
    expect(await getTelegramAssistantEvent({
      client: ctx.client,
      telegramChatId: "-1009003",
      telegramMessageId: 104,
    })).toBeNull()
  })

  test("webhook group ask reports disabled assistant without provider calls", async () => {
    const ctx = await createRouteTestContext({
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      TELEGRAM_BOT_USERNAME: "PirateTestBot",
      TELEGRAM_BOT_TOKEN: "987654:bot-token",
      TELEGRAM_BOT_INTEGRATION_SECRET: "test-telegram-secret",
      TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
      TURSO_COMMUNITY_DB_WRAP_KEY: VALID_WRAP_KEY,
      TURSO_COMMUNITY_DB_WRAP_KEY_VERSION: "1",
    })
    cleanup = ctx.cleanup
    const owner = await exchangeJwt(ctx.env, "telegram-group-assistant-disabled-owner")
    const communityId = await createCommunity({
      env: ctx.env,
      accessToken: owner.accessToken,
      displayName: "Telegram Group Disabled Club",
    })
    await linkTelegramChatForCommunity({
      env: ctx.env,
      communityId,
      accessToken: owner.accessToken,
      telegramChatId: "-1009004",
      title: "Telegram Group Disabled Club",
    })
    const mock = installTelegramAndOpenRouterMock("Should not be used.")

    const response = await telegramWebhook({
      env: ctx.env,
      secret: "webhook-secret",
      body: {
        update_id: 15,
        message: {
          message_id: 105,
          text: "/ask are you enabled?",
          from: { id: 777009 },
          chat: { id: -1009004, type: "supergroup" },
        },
      },
    })

    expect(response.status).toBe(200)
    expect(mock.openRouterCalls).toHaveLength(0)
    expect(mock.telegramRequests).toHaveLength(1)
    const sendBody = await mock.telegramRequests[0]!.json() as { text: string }
    expect(sendBody.text).toContain("not enabled")
    expect(await getTelegramAssistantEvent({
      client: ctx.client,
      telegramChatId: "-1009004",
      telegramMessageId: 105,
    })).toEqual({
      status: "failed",
      trigger_type: "ask_command",
      prompt: "are you enabled?",
    })
  })

  test("community bot private DM routes linked members to assistant with private context and history", async () => {
    const ctx = await createRouteTestContext({
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      OPENROUTER_TIMEOUT_MS: "1000",
      PIRATE_API_PUBLIC_ORIGIN: "https://api.pirate.test",
      TURSO_COMMUNITY_DB_WRAP_KEY: VALID_WRAP_KEY,
      TURSO_COMMUNITY_DB_WRAP_KEY_VERSION: "1",
    })
    cleanup = ctx.cleanup
    const mock = installTelegramAndOpenRouterMock("Direct answer.")
    const owner = await exchangeJwt(ctx.env, "telegram-direct-assistant-owner")
    const member = await exchangeJwt(ctx.env, "telegram-direct-assistant-member")
    const communityId = await createCommunity({
      env: ctx.env,
      accessToken: owner.accessToken,
      displayName: "Telegram Direct Assistant Club",
    })
    await setupEnabledAssistant({
      env: ctx.env,
      communityId,
      ownerToken: owner.accessToken,
    })
    await seedAssistantContextRows({
      communityDbRoot: ctx.communityDbRoot,
      communityId,
      userId: owner.userId,
    })
    await markCommunityMember({
      communityDbRoot: ctx.communityDbRoot,
      communityId,
      userId: member.userId,
    })
    await linkTelegramAccount({
      client: ctx.client,
      telegramUserId: "777201",
      userId: member.userId,
    })
    const bot = await saveCommunityBotForWebhook({
      env: ctx.env,
      communityId,
      accessToken: owner.accessToken,
    })

    const first = await telegramCommunityBotWebhook({
      env: ctx.env,
      webhookId: bot.webhookId,
      secret: bot.webhookSecret,
      body: {
        update_id: 50,
        message: {
          message_id: 201,
          text: "what are the rules?",
          from: { id: 777201 },
          chat: { id: 887201, type: "private" },
        },
      },
    })
    expect(first.status).toBe(200)

    const second = await telegramCommunityBotWebhook({
      env: ctx.env,
      webhookId: bot.webhookId,
      secret: bot.webhookSecret,
      body: {
        update_id: 51,
        message: {
          message_id: 202,
          text: "/ask @PirateTestBot what did I ask?",
          from: { id: 777201 },
          chat: { id: 887201, type: "private" },
        },
      },
    })
    expect(second.status).toBe(200)

    expect(mock.openRouterCalls).toHaveLength(2)
    expect(mock.openRouterCalls[0]?.authorization).toBe("Bearer sk-or-telegram-assistant-key-1234")
    const firstSystem = mock.openRouterCalls[0]?.body.messages?.[0]?.content ?? ""
    expect(firstSystem).toContain("Assistant audience: private_user")
    expect(firstSystem).toContain("Viewer membership:")
    expect(firstSystem).toContain("Telegram private chat response rules")
    expect(firstSystem).not.toContain("Telegram group response rules")
    expect(mock.openRouterCalls[0]?.body.messages?.at(-1)?.content).toBe("what are the rules?")

    const secondMessages = mock.openRouterCalls[1]?.body.messages ?? []
    expect(secondMessages.some((message) => message.role === "user" && message.content === "what are the rules?")).toBe(true)
    expect(secondMessages.some((message) => message.role === "assistant" && message.content === "Direct answer.")).toBe(true)
    expect(secondMessages.at(-1)?.content).toBe("what did I ask?")

    const sendMessageRequests = mock.telegramRequests.filter((request) => request.url.endsWith("/sendMessage"))
    expect(sendMessageRequests).toHaveLength(2)
    expect(sendMessageRequests[0]?.url).toBe(`https://api.telegram.org/bot${bot.token}/sendMessage`)
    const firstSendBody = await sendMessageRequests[0]!.json() as { chat_id: string; text: string }
    expect(firstSendBody.chat_id).toBe("887201")
    expect(firstSendBody.text).toBe("Direct answer.")
    expect(await getAssistantUserMessageMetadata({
      communityDbRoot: ctx.communityDbRoot,
      communityId,
      content: "what are the rules?",
      userId: member.userId,
    })).toMatchObject({
      source: "telegram_dm",
      telegram_chat_id: "887201",
      telegram_community_bot_id: expect.any(String),
      telegram_message_id: 201,
      telegram_user_id: "777201",
    })
  })

  test("community bot private DM sends text before voice when text and voice replies are enabled", async () => {
    const ctx = await createRouteTestContext({
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      OPENROUTER_TIMEOUT_MS: "1000",
      PIRATE_API_PUBLIC_ORIGIN: "https://api.pirate.test",
      TURSO_COMMUNITY_DB_WRAP_KEY: VALID_WRAP_KEY,
      TURSO_COMMUNITY_DB_WRAP_KEY_VERSION: "1",
    })
    cleanup = ctx.cleanup
    const openRouterCalls: Request[] = []
    const elevenLabsTtsCalls: Request[] = []
    const telegramRequests: Request[] = []
    ;(globalThis as { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> }).fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request ? input : new Request(input, init)
      if (request.url === "https://openrouter.test/api/v1/chat/completions") {
        openRouterCalls.push(request)
        return Response.json({
          id: "chatcmpl_telegram_direct_text_and_voice",
          choices: [{ message: { content: "Text and voice answer." } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        })
      }
      if (request.url.startsWith("https://api.elevenlabs.io/v1/text-to-speech/voice_text_and_voice")) {
        elevenLabsTtsCalls.push(request)
        expect(request.headers.get("xi-api-key")).toBe(ELEVENLABS_COMMUNITY_API_KEY)
        expect(new URL(request.url).searchParams.get("output_format")).toBe("opus_48000_32")
        const body = await request.json() as { text?: string; model_id?: string }
        expect(body.text).toBe("Text and voice answer.")
        expect(body.model_id).toBe("eleven_flash_v2_5")
        return new Response(new Uint8Array([1, 2, 3, 4]), {
          headers: {
            "content-type": "audio/ogg",
            "request-id": "elevenlabs_text_and_voice_request",
          },
        })
      }
      telegramRequests.push(request)
      const method = request.url.split("/").at(-1)
      if (method === "getMe") {
        return Response.json({
          ok: true,
          result: {
            id: 987654,
            is_bot: true,
            first_name: "Pirate Test Bot",
            username: "PirateTestBot",
          },
        })
      }
      if (method === "setWebhook" || method === "deleteWebhook") {
        return Response.json({ ok: true, result: true })
      }
      return Response.json({
        ok: true,
        result: { message_id: 701 + telegramRequests.length },
      })
    }

    const owner = await exchangeJwt(ctx.env, "telegram-direct-text-voice-owner")
    const member = await exchangeJwt(ctx.env, "telegram-direct-text-voice-member")
    const communityId = await createCommunity({
      env: ctx.env,
      accessToken: owner.accessToken,
      displayName: "Telegram Direct Text Voice Club",
    })
    await setupEnabledAssistant({
      env: ctx.env,
      communityId,
      ownerToken: owner.accessToken,
      policy: {
        voiceMode: "text_and_voice_replies",
        sttProvider: "elevenlabs",
        sttModel: "scribe_v2",
        ttsProvider: "elevenlabs",
        ttsVoice: "voice_text_and_voice",
      },
    })
    await markCommunityMember({
      communityDbRoot: ctx.communityDbRoot,
      communityId,
      userId: member.userId,
    })
    await linkTelegramAccount({
      client: ctx.client,
      telegramUserId: "777212",
      userId: member.userId,
    })
    const bot = await saveCommunityBotForWebhook({
      env: ctx.env,
      communityId,
      accessToken: owner.accessToken,
    })

    const response = await telegramCommunityBotWebhook({
      env: ctx.env,
      webhookId: bot.webhookId,
      secret: bot.webhookSecret,
      body: {
        update_id: 53,
        message: {
          message_id: 212,
          text: "send both please",
          from: { id: 777212 },
          chat: { id: 887212, type: "private" },
        },
      },
    })

    expect(response.status).toBe(200)
    expect(openRouterCalls).toHaveLength(1)
    expect(elevenLabsTtsCalls).toHaveLength(1)
    const sendRequests = telegramRequests
      .filter((request) => request.url.endsWith("/sendMessage") || request.url.endsWith("/sendVoice"))
    expect(sendRequests.map((request) => request.url.split("/").at(-1))).toEqual(["sendMessage", "sendVoice"])
    const textBody = await sendRequests[0]!.json() as { chat_id: string; text: string }
    expect(textBody.chat_id).toBe("887212")
    expect(textBody.text).toBe("Text and voice answer.")
    const form = await sendRequests[1]!.formData()
    expect(form.get("chat_id")).toBe("887212")
    expect(form.get("reply_parameters")).toBe(JSON.stringify({ message_id: 212 }))
    expect(form.get("voice")).toBeInstanceOf(File)
  })

  test("community bot private DM transcribes voice and sends voice replies when enabled", async () => {
    const ctx = await createRouteTestContext({
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      OPENROUTER_TIMEOUT_MS: "1000",
      PIRATE_API_PUBLIC_ORIGIN: "https://api.pirate.test",
      TURSO_COMMUNITY_DB_WRAP_KEY: VALID_WRAP_KEY,
      TURSO_COMMUNITY_DB_WRAP_KEY_VERSION: "1",
    })
    cleanup = ctx.cleanup
    const openRouterCalls: Array<{ authorization: string | null; body: { messages?: Array<{ role?: string; content?: string }> } }> = []
    const elevenLabsSttCalls: Request[] = []
    const elevenLabsTtsCalls: Request[] = []
    const telegramRequests: Request[] = []
    ;(globalThis as { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> }).fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request ? input : new Request(input, init)
      if (request.url === "https://openrouter.test/api/v1/chat/completions") {
        openRouterCalls.push({
          authorization: request.headers.get("authorization"),
          body: await request.json() as { messages?: Array<{ role?: string; content?: string }> },
        })
        return Response.json({
          id: "chatcmpl_telegram_direct_voice",
          choices: [{ message: { content: "Voice DM answer." } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        })
      }
      if (request.url === "https://api.elevenlabs.io/v1/speech-to-text") {
        elevenLabsSttCalls.push(request)
        expect(request.headers.get("xi-api-key")).toBe(ELEVENLABS_COMMUNITY_API_KEY)
        const form = await request.formData()
        expect(form.get("model_id")).toBe("scribe_v2")
        expect(form.get("file")).toBeInstanceOf(File)
        return Response.json({
          text: "voice direct question",
          confidence: 0.97,
          language_code: "en",
        })
      }
      if (request.url.startsWith("https://api.elevenlabs.io/v1/text-to-speech/voice_direct_dm")) {
        elevenLabsTtsCalls.push(request)
        expect(request.headers.get("xi-api-key")).toBe(ELEVENLABS_COMMUNITY_API_KEY)
        expect(new URL(request.url).searchParams.get("output_format")).toBe("opus_48000_32")
        const body = await request.json() as { text?: string; model_id?: string }
        expect(body.text).toBe("Voice DM answer.")
        expect(body.model_id).toBe("eleven_flash_v2_5")
        return new Response(new Uint8Array([1, 2, 3, 4]), {
          headers: {
            "content-type": "audio/ogg",
            "request-id": "elevenlabs_direct_voice_request",
          },
        })
      }
      if (request.url.includes("/getFile")) {
        telegramRequests.push(request)
        return Response.json({
          ok: true,
          result: {
            file_id: "voice_file_123",
            file_unique_id: "voice_unique_123",
            file_size: 128,
            file_path: "voice/file_123.oga",
          },
        })
      }
      if (request.url.includes("/file/bot") && request.url.endsWith("/voice/file_123.oga")) {
        return new Response(new Uint8Array([9, 8, 7, 6]), {
          headers: { "content-type": "audio/ogg" },
        })
      }
      telegramRequests.push(request)
      const method = request.url.split("/").at(-1)
      if (method === "getMe") {
        return Response.json({
          ok: true,
          result: {
            id: 987654,
            is_bot: true,
            first_name: "Pirate Test Bot",
            username: "PirateTestBot",
          },
        })
      }
      if (method === "setWebhook" || method === "deleteWebhook") {
        return Response.json({ ok: true, result: true })
      }
      return Response.json({
        ok: true,
        result: { message_id: 701 + telegramRequests.length },
      })
    }

    const owner = await exchangeJwt(ctx.env, "telegram-direct-voice-owner")
    const member = await exchangeJwt(ctx.env, "telegram-direct-voice-member")
    const communityId = await createCommunity({
      env: ctx.env,
      accessToken: owner.accessToken,
      displayName: "Telegram Direct Voice Club",
    })
    await setupEnabledAssistant({
      env: ctx.env,
      communityId,
      ownerToken: owner.accessToken,
      policy: {
        voiceMode: "voice_replies",
        sttProvider: "elevenlabs",
        sttModel: "scribe_v2",
        ttsProvider: "elevenlabs",
        ttsVoice: "voice_direct_dm",
      },
    })
    await markCommunityMember({
      communityDbRoot: ctx.communityDbRoot,
      communityId,
      userId: member.userId,
    })
    await linkTelegramAccount({
      client: ctx.client,
      telegramUserId: "777211",
      userId: member.userId,
    })
    const bot = await saveCommunityBotForWebhook({
      env: ctx.env,
      communityId,
      accessToken: owner.accessToken,
    })

    const response = await telegramCommunityBotWebhook({
      env: ctx.env,
      webhookId: bot.webhookId,
      secret: bot.webhookSecret,
      body: {
        update_id: 52,
        message: {
          message_id: 211,
          from: { id: 777211 },
          chat: { id: 887211, type: "private" },
          voice: {
            file_id: "voice_file_123",
            file_unique_id: "voice_unique_123",
            duration: 2,
            mime_type: "audio/ogg",
            file_size: 128,
          },
        },
      },
    })

    expect(response.status).toBe(200)
    expect(elevenLabsSttCalls).toHaveLength(1)
    expect(openRouterCalls).toHaveLength(1)
    expect(openRouterCalls[0]?.authorization).toBe("Bearer sk-or-telegram-assistant-key-1234")
    expect(openRouterCalls[0]?.body.messages?.at(-1)?.content).toBe("voice direct question")
    expect(elevenLabsTtsCalls).toHaveLength(1)
    const sendVoiceRequests = telegramRequests.filter((request) => request.url.endsWith("/sendVoice"))
    const sendMessageRequests = telegramRequests.filter((request) => request.url.endsWith("/sendMessage"))
    expect(sendVoiceRequests).toHaveLength(1)
    expect(sendMessageRequests).toHaveLength(0)
    const form = await sendVoiceRequests[0]!.formData()
    expect(form.get("chat_id")).toBe("887211")
    expect(form.get("reply_parameters")).toBe(JSON.stringify({ message_id: 211 }))
    const voice = form.get("voice")
    expect(voice).toBeInstanceOf(File)
    expect((voice as File).name).toBe("assistant-reply.ogg")
  })

  test("community bot private DM answers unlinked Telegram users with preview and verify button", async () => {
    const ctx = await createRouteTestContext({
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      PIRATE_API_PUBLIC_ORIGIN: "https://api.pirate.test",
      PIRATE_WEB_PUBLIC_ORIGIN: "https://staging.pirate.test",
      TURSO_COMMUNITY_DB_WRAP_KEY: VALID_WRAP_KEY,
      TURSO_COMMUNITY_DB_WRAP_KEY_VERSION: "1",
    })
    cleanup = ctx.cleanup
    const mock = installTelegramAndOpenRouterMock("Preview answer.")
    const owner = await exchangeJwt(ctx.env, "telegram-direct-unlinked-owner")
    const communityId = await createCommunity({
      env: ctx.env,
      accessToken: owner.accessToken,
      displayName: "Telegram Direct Unlinked Club",
    })
    await setupEnabledAssistant({
      env: ctx.env,
      communityId,
      ownerToken: owner.accessToken,
    })
    const bot = await saveCommunityBotForWebhook({
      env: ctx.env,
      communityId,
      accessToken: owner.accessToken,
    })

    const response = await telegramCommunityBotWebhook({
      env: ctx.env,
      webhookId: bot.webhookId,
      secret: bot.webhookSecret,
      body: {
        update_id: 52,
        message: {
          message_id: 203,
          text: "hello",
          from: { id: 777202 },
          chat: { id: 887202, type: "private" },
        },
      },
    })

    expect(response.status).toBe(200)
    expect(mock.openRouterCalls).toHaveLength(1)
    const systemContent = mock.openRouterCalls[0]?.body.messages?.find((item) => item.role === "system")?.content ?? ""
    expect(systemContent).toContain("Assistant audience: public_group")
    expect(systemContent).not.toContain("Viewer membership")
    const sendMessageRequests = mock.telegramRequests.filter((request) => request.url.endsWith("/sendMessage"))
    expect(sendMessageRequests).toHaveLength(1)
    const sendBody = await sendMessageRequests[0]!.json() as {
      text: string
      reply_markup?: { inline_keyboard?: Array<Array<{ text?: string; web_app?: { url?: string } }>> }
    }
    expect(sendBody.text).toBe("Preview answer.\n\nVerify to unlock the full assistant.")
    expect(sendBody.reply_markup?.inline_keyboard?.[0]?.[0]).toEqual({
      text: "Verify to join",
      web_app: { url: `https://staging.pirate.test/tg/verify/com_${communityId}` },
    })
    expect(await getTelegramAccount({
      client: ctx.client,
      telegramUserId: "777202",
    })).toBeNull()
    expect(await getTelegramAssistantEvent({
      client: ctx.client,
      telegramChatId: "887202",
      telegramMessageId: 203,
    })).toEqual({
      status: "answered",
      trigger_type: "reply_to_bot",
      prompt: "hello",
    })
    expect(await getTelegramAssistantEventChannel({
      client: ctx.client,
      telegramChatId: "887202",
      telegramMessageId: 203,
    })).toBe("private_preview")
  })

  test("community bot private DM preview limit encourages verification", async () => {
    const ctx = await createRouteTestContext({
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      PIRATE_API_PUBLIC_ORIGIN: "https://api.pirate.test",
      PIRATE_WEB_PUBLIC_ORIGIN: "https://staging.pirate.test",
      TURSO_COMMUNITY_DB_WRAP_KEY: VALID_WRAP_KEY,
      TURSO_COMMUNITY_DB_WRAP_KEY_VERSION: "1",
    })
    cleanup = ctx.cleanup
    const mock = installTelegramAndOpenRouterMock("Should not be used.")
    const owner = await exchangeJwt(ctx.env, "telegram-direct-preview-limit-owner")
    const communityId = await createCommunity({
      env: ctx.env,
      accessToken: owner.accessToken,
      displayName: "Telegram Direct Preview Limit Club",
    })
    await setupEnabledAssistant({
      env: ctx.env,
      communityId,
      ownerToken: owner.accessToken,
    })
    const bot = await saveCommunityBotForWebhook({
      env: ctx.env,
      communityId,
      accessToken: owner.accessToken,
    })
    const now = new Date().toISOString()
    for (let index = 0; index < 10; index += 1) {
      await ctx.client.execute({
        sql: `
          INSERT INTO telegram_assistant_events (
            event_id, community_id, telegram_chat_id, telegram_message_id, telegram_user_id,
            user_id, channel, trigger_type, prompt, assistant_message_ref, status, error_message,
            created_at, completed_at
          ) VALUES (
            ?1, ?2, ?3, ?4, ?5,
            NULL, 'private_preview', 'reply_to_bot', 'previous preview', NULL, 'answered', NULL,
            ?6, ?6
          )
        `,
        args: [
          `tae_preview_limit_${index}`,
          communityId,
          "887203",
          9000 + index,
          "777203",
          now,
        ],
      })
    }

    const response = await telegramCommunityBotWebhook({
      env: ctx.env,
      webhookId: bot.webhookId,
      secret: bot.webhookSecret,
      body: {
        update_id: 53,
        message: {
          message_id: 204,
          text: "hello over limit",
          from: { id: 777203, language_code: "ka" },
          chat: { id: 887203, type: "private" },
        },
      },
    })

    expect(response.status).toBe(200)
    expect(mock.openRouterCalls).toHaveLength(0)
    const sendMessageRequests = mock.telegramRequests.filter((request) => request.url.endsWith("/sendMessage"))
    expect(sendMessageRequests).toHaveLength(1)
    const sendBody = await sendMessageRequests[0]!.json() as {
      text: string
      reply_markup?: { inline_keyboard?: Array<Array<{ text?: string; web_app?: { url?: string } }>> }
    }
    expect(sendBody.text).toContain("დღევანდელი საცდელი შეტყობინებები ამოიწურა")
    expect(sendBody.text).not.toContain("/start")
    expect(sendBody.reply_markup?.inline_keyboard?.[0]?.[0]).toEqual({
      text: "გაიარეთ ვერიფიკაცია",
      web_app: { url: `https://staging.pirate.test/tg/verify/com_${communityId}` },
    })
    expect(await getTelegramAssistantEvent({
      client: ctx.client,
      telegramChatId: "887203",
      telegramMessageId: 204,
    })).toEqual({
      status: "rate_limited",
      trigger_type: "reply_to_bot",
      prompt: "hello over limit",
    })
    expect(await getTelegramAssistantEventChannel({
      client: ctx.client,
      telegramChatId: "887203",
      telegramMessageId: 204,
    })).toBe("private_preview")
  })

  test("community bot private DM preview aggregate cap encourages verification", async () => {
    const ctx = await createRouteTestContext({
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      PIRATE_API_PUBLIC_ORIGIN: "https://api.pirate.test",
      PIRATE_WEB_PUBLIC_ORIGIN: "https://staging.pirate.test",
      TURSO_COMMUNITY_DB_WRAP_KEY: VALID_WRAP_KEY,
      TURSO_COMMUNITY_DB_WRAP_KEY_VERSION: "1",
    })
    cleanup = ctx.cleanup
    const mock = installTelegramAndOpenRouterMock("Should not be used.")
    const owner = await exchangeJwt(ctx.env, "telegram-direct-preview-aggregate-limit-owner")
    const communityId = await createCommunity({
      env: ctx.env,
      accessToken: owner.accessToken,
      displayName: "Telegram Direct Preview Aggregate Limit Club",
    })
    await setupEnabledAssistant({
      env: ctx.env,
      communityId,
      ownerToken: owner.accessToken,
    })
    const bot = await saveCommunityBotForWebhook({
      env: ctx.env,
      communityId,
      accessToken: owner.accessToken,
    })
    const now = new Date().toISOString()
    await ctx.client.execute({
      sql: `
        WITH RECURSIVE preview_rows(row_index) AS (
          SELECT 0
          UNION ALL
          SELECT row_index + 1 FROM preview_rows WHERE row_index < 999
        )
        INSERT INTO telegram_assistant_events (
          event_id, community_id, telegram_chat_id, telegram_message_id, telegram_user_id,
          user_id, channel, trigger_type, prompt, assistant_message_ref, status, error_message,
          created_at, completed_at
        )
        SELECT
          'tae_preview_aggregate_limit_' || row_index, ?1, CAST(888000 + row_index AS TEXT), 10000 + row_index,
          'preview_aggregate_user_' || row_index,
          NULL, 'private_preview', 'reply_to_bot', 'previous preview', NULL, 'answered', NULL,
          ?2, ?2
        FROM preview_rows
      `,
      args: [communityId, now],
    })

    const response = await telegramCommunityBotWebhook({
      env: ctx.env,
      webhookId: bot.webhookId,
      secret: bot.webhookSecret,
      body: {
        update_id: 54,
        message: {
          message_id: 205,
          text: "hello over aggregate limit",
          from: { id: 777205 },
          chat: { id: 887205, type: "private" },
        },
      },
    })

    expect(response.status).toBe(200)
    expect(mock.openRouterCalls).toHaveLength(0)
    const sendMessageRequests = mock.telegramRequests.filter((request) => request.url.endsWith("/sendMessage"))
    expect(sendMessageRequests).toHaveLength(1)
    const sendBody = await sendMessageRequests[0]!.json() as {
      text: string
      reply_markup?: { inline_keyboard?: Array<Array<{ text?: string; web_app?: { url?: string } }>> }
    }
    expect(sendBody.text).toContain("You have used today's preview messages.")
    expect(sendBody.reply_markup?.inline_keyboard?.[0]?.[0]).toEqual({
      text: "Verify to join",
      web_app: { url: `https://staging.pirate.test/tg/verify/com_${communityId}` },
    })
    expect(await getTelegramAssistantEvent({
      client: ctx.client,
      telegramChatId: "887205",
      telegramMessageId: 205,
    })).toEqual({
      status: "rate_limited",
      trigger_type: "reply_to_bot",
      prompt: "hello over aggregate limit",
    })
    expect(await getTelegramAssistantEventChannel({
      client: ctx.client,
      telegramChatId: "887205",
      telegramMessageId: 205,
    })).toBe("private_preview")
  })

  test("telegram auto-exchange accepts active community bot init data and rejects platform init data", async () => {
    const communityBotToken = "123456789:ACTIVE_COMMUNITY_BOT_TOKEN_LAST4"
    installTelegramApiMock(async (request) => {
      const method = request.url.split("/").at(-1)
      if (method === "getMe") {
        return {
          ok: true,
          result: {
            id: 123456789,
            is_bot: true,
            first_name: "Community Auto Exchange Bot",
            username: "CommunityAutoExchangeBot",
          },
        }
      }
      if (method === "setWebhook") {
        return { ok: true, result: true }
      }
      return { ok: true, result: true }
    })
    const ctx = await createRouteTestContext({
      TELEGRAM_BOT_USERNAME: "PirateTestBot",
      TELEGRAM_BOT_TOKEN: "987654:platform-token",
      PIRATE_WEB_PUBLIC_ORIGIN: "https://staging.pirate.test",
      PIRATE_API_PUBLIC_ORIGIN: "https://api.pirate.test",
      TURSO_COMMUNITY_DB_WRAP_KEY: VALID_WRAP_KEY,
      TURSO_COMMUNITY_DB_WRAP_KEY_VERSION: "2",
    })
    cleanup = ctx.cleanup
    const owner = await exchangeJwt(ctx.env, "telegram-auto-exchange-active-bot-owner")
    const communityId = await createCommunity({
      env: ctx.env,
      accessToken: owner.accessToken,
      displayName: "Telegram Auto Exchange Active Bot Club",
    })
    await saveCommunityBotForWebhook({
      accessToken: owner.accessToken,
      communityId,
      env: ctx.env,
      token: communityBotToken,
    })

    const accepted = await telegramSessionAutoExchange({
      env: ctx.env,
      body: {
        community_id: `com_${communityId}`,
        init_data: signedTelegramInitData({
          botToken: communityBotToken,
          user: {
            id: 779121,
            username: "communityaccepted",
          },
        }),
      },
    })
    expect(accepted.status).toBe(200)

    const rejected = await telegramSessionAutoExchange({
      env: ctx.env,
      body: {
        community_id: `com_${communityId}`,
        init_data: signedTelegramInitData({
          botToken: "987654:platform-token",
          user: {
            id: 779122,
            username: "platformrejected",
          },
        }),
      },
    })
    expect(rejected.status).toBe(401)
    const account = await ctx.client.execute({
      sql: "SELECT user_id FROM telegram_accounts WHERE telegram_user_id = ?1 LIMIT 1",
      args: ["779122"],
    })
    expect(account.rows).toHaveLength(0)
  })

  test("telegram auto-exchange falls back to platform init data when no community bot exists", async () => {
    const ctx = await createRouteTestContext({
      TELEGRAM_BOT_USERNAME: "PirateTestBot",
      TELEGRAM_BOT_TOKEN: "987654:platform-token",
      PIRATE_WEB_PUBLIC_ORIGIN: "https://staging.pirate.test",
      PIRATE_API_PUBLIC_ORIGIN: "https://api.pirate.test",
    })
    cleanup = ctx.cleanup
    const owner = await exchangeJwt(ctx.env, "telegram-auto-exchange-platform-fallback-owner")
    const communityId = await createCommunity({
      env: ctx.env,
      accessToken: owner.accessToken,
      displayName: "Telegram Auto Exchange Platform Fallback Club",
    })

    const exchangeResponse = await telegramSessionAutoExchange({
      env: ctx.env,
      body: {
        community_id: `com_${communityId}`,
        init_data: signedTelegramInitData({
          botToken: "987654:platform-token",
          user: {
            id: 779123,
            username: "platformfallback",
          },
        }),
      },
    })
    expect(exchangeResponse.status).toBe(200)
  })

  test("community bot private DM prompts non-members to verify when preview is unavailable", async () => {
    const ctx = await createRouteTestContext({
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      PIRATE_API_PUBLIC_ORIGIN: "https://api.pirate.test",
      PIRATE_WEB_PUBLIC_ORIGIN: "https://staging.pirate.test",
      TURSO_COMMUNITY_DB_WRAP_KEY: VALID_WRAP_KEY,
      TURSO_COMMUNITY_DB_WRAP_KEY_VERSION: "1",
    })
    cleanup = ctx.cleanup
    const mock = installTelegramAndOpenRouterMock("Should not be used.")
    const owner = await exchangeJwt(ctx.env, "telegram-direct-nonmember-owner")
    const stranger = await exchangeJwt(ctx.env, "telegram-direct-nonmember-user")
    const communityId = await createCommunity({
      env: ctx.env,
      accessToken: owner.accessToken,
      displayName: "Telegram Direct Nonmember Club",
    })
    await linkTelegramAccount({
      client: ctx.client,
      telegramUserId: "777203",
      userId: stranger.userId,
    })
    const bot = await saveCommunityBotForWebhook({
      env: ctx.env,
      communityId,
      accessToken: owner.accessToken,
    })

    const response = await telegramCommunityBotWebhook({
      env: ctx.env,
      webhookId: bot.webhookId,
      secret: bot.webhookSecret,
      body: {
        update_id: 53,
        message: {
          message_id: 204,
          text: "hello",
          from: { id: 777203 },
          chat: { id: 887203, type: "private" },
        },
      },
    })

    expect(response.status).toBe(200)
    expect(mock.openRouterCalls).toHaveLength(0)
    const sendMessageRequests = mock.telegramRequests.filter((request) => request.url.endsWith("/sendMessage"))
    expect(sendMessageRequests).toHaveLength(1)
    const sendBody = await sendMessageRequests[0]!.json() as {
      text: string
      reply_markup?: { inline_keyboard?: Array<Array<{ text?: string; web_app?: { url?: string } }>> }
    }
    expect(sendBody.text).toBe("Verify and join this community to use the full assistant.")
    expect(sendBody.reply_markup?.inline_keyboard?.[0]?.[0]?.text).toBe("Open Pirate")
    const webAppUrl = telegramWebAppUrlFromReplyMarkup(sendBody.reply_markup)
    expect(webAppUrl).toContain(`https://staging.pirate.test/tg/exchange?community=com_${communityId}`)
    expect(onboardingTokenFromWebAppUrl(webAppUrl)).toMatch(/^tgonboard_/u)
  })

  test("community bot private DM reports disabled assistant without provider calls", async () => {
    const ctx = await createRouteTestContext({
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      PIRATE_API_PUBLIC_ORIGIN: "https://api.pirate.test",
      TURSO_COMMUNITY_DB_WRAP_KEY: VALID_WRAP_KEY,
      TURSO_COMMUNITY_DB_WRAP_KEY_VERSION: "1",
    })
    cleanup = ctx.cleanup
    const mock = installTelegramAndOpenRouterMock("Should not be used.")
    const owner = await exchangeJwt(ctx.env, "telegram-direct-disabled-owner")
    const member = await exchangeJwt(ctx.env, "telegram-direct-disabled-member")
    const communityId = await createCommunity({
      env: ctx.env,
      accessToken: owner.accessToken,
      displayName: "Telegram Direct Disabled Club",
    })
    await markCommunityMember({
      communityDbRoot: ctx.communityDbRoot,
      communityId,
      userId: member.userId,
    })
    await linkTelegramAccount({
      client: ctx.client,
      telegramUserId: "777204",
      userId: member.userId,
    })
    const bot = await saveCommunityBotForWebhook({
      env: ctx.env,
      communityId,
      accessToken: owner.accessToken,
    })

    const response = await telegramCommunityBotWebhook({
      env: ctx.env,
      webhookId: bot.webhookId,
      secret: bot.webhookSecret,
      body: {
        update_id: 54,
        message: {
          message_id: 205,
          text: "hello",
          from: { id: 777204 },
          chat: { id: 887204, type: "private" },
        },
      },
    })

    expect(response.status).toBe(200)
    expect(mock.openRouterCalls).toHaveLength(0)
    const sendMessageRequests = mock.telegramRequests.filter((request) => request.url.endsWith("/sendMessage"))
    expect(sendMessageRequests).toHaveLength(1)
    const sendBody = await sendMessageRequests[0]!.json() as { text: string }
    expect(sendBody.text).toContain("not enabled")
  })

  test("webhook group ask rate limits repeated prompts from the same Telegram user", async () => {
    const ctx = await createRouteTestContext({
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      OPENROUTER_TIMEOUT_MS: "1000",
      TELEGRAM_BOT_USERNAME: "PirateTestBot",
      TELEGRAM_BOT_TOKEN: "987654:bot-token",
      TELEGRAM_BOT_INTEGRATION_SECRET: "test-telegram-secret",
      TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
      TURSO_COMMUNITY_DB_WRAP_KEY: VALID_WRAP_KEY,
      TURSO_COMMUNITY_DB_WRAP_KEY_VERSION: "1",
    })
    cleanup = ctx.cleanup
    const owner = await exchangeJwt(ctx.env, "telegram-group-assistant-rate-limit-owner")
    const communityId = await createCommunity({
      env: ctx.env,
      accessToken: owner.accessToken,
      displayName: "Telegram Group Rate Limit Club",
    })
    await setupEnabledAssistant({
      env: ctx.env,
      communityId,
      ownerToken: owner.accessToken,
    })
    await linkTelegramChatForCommunity({
      env: ctx.env,
      communityId,
      accessToken: owner.accessToken,
      telegramChatId: "-1009005",
      title: "Telegram Group Rate Limit Club",
    })
    const mock = installTelegramAndOpenRouterMock("Allowed answer.")

    for (let index = 0; index < 6; index += 1) {
      const response = await telegramWebhook({
        env: ctx.env,
        secret: "webhook-secret",
        body: {
          update_id: 16 + index,
          message: {
            message_id: 106 + index,
            text: `/ask question ${index}`,
            from: { id: 777010 },
            chat: { id: -1009005, type: "supergroup" },
          },
        },
      })
      expect(response.status).toBe(200)
    }

    expect(mock.openRouterCalls).toHaveLength(5)
    expect(mock.telegramRequests).toHaveLength(6)
    const blockedSendBody = await mock.telegramRequests[5]!.json() as { text: string }
    expect(blockedSendBody.text).toContain("rate limited")
    expect(await getTelegramAssistantEvent({
      client: ctx.client,
      telegramChatId: "-1009005",
      telegramMessageId: 111,
    })).toEqual({
      status: "rate_limited",
      trigger_type: "ask_command",
      prompt: "question 5",
    })
  })

  test("webhook chat_join_request from an unknown Telegram chat is acknowledged without action", async () => {
    const ctx = await createRouteTestContext({
      TELEGRAM_BOT_USERNAME: "PirateTestBot",
      TELEGRAM_BOT_TOKEN: "987654:bot-token",
      TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
    })
    cleanup = ctx.cleanup
    const requests = installTelegramApiMock(() => ({
      ok: true,
      result: { message_id: 800 },
    }))

    const response = await telegramWebhook({
      env: ctx.env,
      secret: "webhook-secret",
      body: {
        update_id: 30,
        chat_join_request: {
          chat: { id: -1009100, type: "supergroup", title: "Unknown Group" },
          from: { id: 779100, username: "joiner" },
          user_chat_id: 889100,
          date: 1_779_000_000,
        },
      },
    })

    expect(response.status).toBe(200)
    expect(requests).toHaveLength(0)
    expect(await getTelegramJoinGrant({
      client: ctx.client,
      telegramChatId: "-1009100",
      telegramUserId: "779100",
    })).toBeNull()
  })

  test("webhook chat_join_request prompts unmapped Telegram users with a Mini App join link", async () => {
    const ctx = await createRouteTestContext({
      TELEGRAM_BOT_USERNAME: "PirateTestBot",
      TELEGRAM_BOT_TOKEN: "987654:bot-token",
      TELEGRAM_BOT_INTEGRATION_SECRET: "test-telegram-secret",
      TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
      PIRATE_WEB_PUBLIC_ORIGIN: "https://staging.pirate.test",
    })
    cleanup = ctx.cleanup
    const owner = await exchangeJwt(ctx.env, "telegram-join-unmapped-owner")
    const communityId = await createCommunity({
      env: ctx.env,
      accessToken: owner.accessToken,
      displayName: "Telegram Join Unmapped Club",
    })
    await linkTelegramChatForCommunity({
      env: ctx.env,
      communityId,
      accessToken: owner.accessToken,
      telegramChatId: "-1009101",
      title: "Telegram Join Unmapped Club",
    })
    const requests = installTelegramApiMock(() => ({
      ok: true,
      result: { message_id: 801 },
    }))

    const response = await telegramWebhook({
      env: ctx.env,
      secret: "webhook-secret",
      body: {
        update_id: 31,
        chat_join_request: {
          chat: { id: -1009101, type: "supergroup", title: "Telegram Join Unmapped Club" },
          from: { id: 779101, username: "joiner" },
          user_chat_id: 889101,
          date: 1_779_000_001,
        },
      },
    })

    expect(response.status).toBe(200)
    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toBe("https://api.telegram.org/bot987654:bot-token/sendMessage")
    const sendBody = await requests[0]!.json() as { chat_id: string; text: string; reply_markup?: unknown }
    expect(sendBody.chat_id).toBe("889101")
    expect(sendBody.text).toContain(`https://staging.pirate.test/tg/c/com_${communityId}`)
    expect(sendBody.text).toContain("verify and join")
    expect(sendBody.reply_markup).toBeUndefined()
    const grant = await getTelegramJoinGrant({
      client: ctx.client,
      telegramChatId: "-1009101",
      telegramUserId: "779101",
    })
    expect(grant?.status).toBe("pending")
    expect(grant?.user_id).toBeNull()
    expect(grant?.prompted_at).toBeTruthy()
    expect(grant?.approved_at).toBeNull()
    expect(grant?.expires_at).toBeTruthy()
    expect(JSON.parse(grant?.missing_capabilities_json ?? "[]")).toContain("telegram_account")
  })

  test("community bot chat_join_request prompts unmapped Telegram users with a Mini App button", async () => {
    const ctx = await createRouteTestContext({
      TELEGRAM_BOT_INTEGRATION_SECRET: "test-telegram-secret",
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      PIRATE_API_PUBLIC_ORIGIN: "https://api.pirate.test",
      PIRATE_WEB_PUBLIC_ORIGIN: "https://staging.pirate.test",
      TURSO_COMMUNITY_DB_WRAP_KEY: VALID_WRAP_KEY,
      TURSO_COMMUNITY_DB_WRAP_KEY_VERSION: "1",
    })
    cleanup = ctx.cleanup
    const mock = installTelegramAndOpenRouterMock("Should not be used.")
    const owner = await exchangeJwt(ctx.env, "telegram-community-bot-join-unmapped-owner")
    const communityId = await createCommunity({
      env: ctx.env,
      accessToken: owner.accessToken,
      displayName: "Telegram Community Bot Join Club",
    })
    const bot = await saveCommunityBotForWebhook({
      env: ctx.env,
      communityId,
      accessToken: owner.accessToken,
    })
    await linkTelegramChatForCommunity({
      env: ctx.env,
      communityId,
      accessToken: owner.accessToken,
      telegramChatId: "-1009121",
      title: "Telegram Community Bot Join Club",
    })

    const response = await telegramCommunityBotWebhook({
      env: ctx.env,
      webhookId: bot.webhookId,
      secret: bot.webhookSecret,
      body: {
        update_id: 37,
        chat_join_request: {
          chat: { id: -1009121, type: "supergroup", title: "Telegram Community Bot Join Club" },
          from: { id: 779121, username: "joiner" },
          user_chat_id: 889121,
          date: 1_779_000_121,
        },
      },
    })

    expect(response.status).toBe(200)
    const sendMessageRequests = mock.telegramRequests.filter((request) => request.url.endsWith("/sendMessage"))
    expect(sendMessageRequests).toHaveLength(1)
    const sendBody = await sendMessageRequests[0]!.json() as { chat_id: string; text: string; reply_markup: unknown }
    expect(sendBody.chat_id).toBe("889121")
    expect(sendBody.text).toContain("verify and join")
    const webAppUrl = telegramWebAppUrlFromReplyMarkup(sendBody.reply_markup)
    expect(webAppUrl).toContain(`https://staging.pirate.test/tg/exchange?community=com_${communityId}`)
    expect(onboardingTokenFromWebAppUrl(webAppUrl)).toMatch(/^tgonboard_/u)
    const grant = await getTelegramJoinGrant({
      client: ctx.client,
      telegramChatId: "-1009121",
      telegramUserId: "779121",
    })
    expect(grant?.status).toBe("pending")
    expect(JSON.parse(grant?.missing_capabilities_json ?? "[]")).toContain("telegram_account")
  })

  test("webhook chat_join_request reuses an existing pending grant for duplicate join requests", async () => {
    const ctx = await createRouteTestContext({
      TELEGRAM_BOT_USERNAME: "PirateTestBot",
      TELEGRAM_BOT_TOKEN: "987654:bot-token",
      TELEGRAM_BOT_INTEGRATION_SECRET: "test-telegram-secret",
      TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
      PIRATE_WEB_PUBLIC_ORIGIN: "https://staging.pirate.test",
    })
    cleanup = ctx.cleanup
    const owner = await exchangeJwt(ctx.env, "telegram-join-dedupe-owner")
    const communityId = await createCommunity({
      env: ctx.env,
      accessToken: owner.accessToken,
      displayName: "Telegram Join Dedupe Club",
    })
    await linkTelegramChatForCommunity({
      env: ctx.env,
      communityId,
      accessToken: owner.accessToken,
      telegramChatId: "-1009106",
      title: "Telegram Join Dedupe Club",
    })
    const requests = installTelegramApiMock(() => ({
      ok: true,
      result: { message_id: 806 },
    }))

    for (let index = 0; index < 2; index += 1) {
      const response = await telegramWebhook({
        env: ctx.env,
        secret: "webhook-secret",
        body: {
          update_id: 36 + index,
          chat_join_request: {
            chat: { id: -1009106, type: "supergroup", title: "Telegram Join Dedupe Club" },
            from: { id: 779106, username: "joiner" },
            user_chat_id: 889106,
            date: 1_779_000_006 + index,
          },
        },
      })
      expect(response.status).toBe(200)
    }

    expect(requests).toHaveLength(2)
    expect(await countTelegramJoinGrants({
      client: ctx.client,
      telegramChatId: "-1009106",
      telegramUserId: "779106",
    })).toBe(1)
    const grant = await getTelegramJoinGrant({
      client: ctx.client,
      telegramChatId: "-1009106",
      telegramUserId: "779106",
    })
    expect(grant?.status).toBe("pending")
    expect(grant?.prompted_at).toBeTruthy()
  })

  test("webhook chat_join_request approves linked Telegram users who are already community members", async () => {
    const ctx = await createRouteTestContext({
      TELEGRAM_BOT_USERNAME: "PirateTestBot",
      TELEGRAM_BOT_TOKEN: "987654:bot-token",
      TELEGRAM_BOT_INTEGRATION_SECRET: "test-telegram-secret",
      TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
      PIRATE_WEB_PUBLIC_ORIGIN: "https://staging.pirate.test",
    })
    cleanup = ctx.cleanup
    const owner = await exchangeJwt(ctx.env, "telegram-join-approve-owner")
    const member = await exchangeJwt(ctx.env, "telegram-join-approve-member")
    const communityId = await createCommunity({
      env: ctx.env,
      accessToken: owner.accessToken,
      displayName: "Telegram Join Approve Club",
    })
    await markCommunityMember({
      communityDbRoot: ctx.communityDbRoot,
      communityId,
      userId: member.userId,
    })
    await linkTelegramAccount({
      client: ctx.client,
      telegramUserId: "779102",
      userId: member.userId,
    })
    await linkTelegramChatForCommunity({
      env: ctx.env,
      communityId,
      accessToken: owner.accessToken,
      telegramChatId: "-1009102",
      title: "Telegram Join Approve Club",
    })
    const requests = installTelegramApiMock(() => ({
      ok: true,
      result: true,
    }))

    const response = await telegramWebhook({
      env: ctx.env,
      secret: "webhook-secret",
      body: {
        update_id: 32,
        chat_join_request: {
          chat: { id: -1009102, type: "supergroup", title: "Telegram Join Approve Club" },
          from: { id: 779102, username: "member" },
          user_chat_id: 889102,
          date: 1_779_000_002,
        },
      },
    })

    expect(response.status).toBe(200)
    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toBe("https://api.telegram.org/bot987654:bot-token/approveChatJoinRequest")
    const approveBody = await requests[0]!.json() as { chat_id: string; user_id: string }
    expect(approveBody.chat_id).toBe("-1009102")
    expect(approveBody.user_id).toBe("779102")
    const grant = await getTelegramJoinGrant({
      client: ctx.client,
      telegramChatId: "-1009102",
      telegramUserId: "779102",
    })
    expect(grant?.status).toBe("approved")
    expect(grant?.user_id).toBe(member.userId)
    expect(grant?.approved_at).toBeTruthy()
  })

  test("webhook chat_join_request prompts linked users who are not yet joinable", async () => {
    const ctx = await createRouteTestContext({
      TELEGRAM_BOT_USERNAME: "PirateTestBot",
      TELEGRAM_BOT_TOKEN: "987654:bot-token",
      TELEGRAM_BOT_INTEGRATION_SECRET: "test-telegram-secret",
      TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
      PIRATE_WEB_PUBLIC_ORIGIN: "https://staging.pirate.test",
    })
    cleanup = ctx.cleanup
    const owner = await exchangeJwt(ctx.env, "telegram-join-ineligible-owner")
    const joiner = await exchangeJwt(ctx.env, "telegram-join-ineligible-user")
    const communityId = await createCommunity({
      env: ctx.env,
      accessToken: owner.accessToken,
      displayName: "Telegram Join Ineligible Club",
    })
    await linkTelegramAccount({
      client: ctx.client,
      telegramUserId: "779103",
      userId: joiner.userId,
    })
    await linkTelegramChatForCommunity({
      env: ctx.env,
      communityId,
      accessToken: owner.accessToken,
      telegramChatId: "-1009103",
      title: "Telegram Join Ineligible Club",
    })
    const requests = installTelegramApiMock(() => ({
      ok: true,
      result: { message_id: 803 },
    }))

    const response = await telegramWebhook({
      env: ctx.env,
      secret: "webhook-secret",
      body: {
        update_id: 33,
        chat_join_request: {
          chat: { id: -1009103, type: "supergroup", title: "Telegram Join Ineligible Club" },
          from: { id: 779103, username: "joiner" },
          user_chat_id: 889103,
          date: 1_779_000_003,
        },
      },
    })

    expect(response.status).toBe(200)
    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toBe("https://api.telegram.org/bot987654:bot-token/sendMessage")
    const sendBody = await requests[0]!.json() as { chat_id: string; text: string }
    expect(sendBody.chat_id).toBe("889103")
    expect(sendBody.text).toContain("cannot approve")
    const grant = await getTelegramJoinGrant({
      client: ctx.client,
      telegramChatId: "-1009103",
      telegramUserId: "779103",
    })
    expect(grant?.status).toBe("pending")
    expect(grant?.user_id).toBe(joiner.userId)
    expect(grant?.prompted_at).toBeTruthy()
    expect(grant?.approved_at).toBeNull()
  })

  test("webhook chat_join_request names missing nationality gates", async () => {
    const ctx = await createRouteTestContext({
      TELEGRAM_BOT_USERNAME: "PirateTestBot",
      TELEGRAM_BOT_TOKEN: "987654:bot-token",
      TELEGRAM_BOT_INTEGRATION_SECRET: "test-telegram-secret",
      TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
      PIRATE_WEB_PUBLIC_ORIGIN: "https://staging.pirate.test",
    })
    cleanup = ctx.cleanup
    const owner = await exchangeJwt(ctx.env, "telegram-join-nationality-owner")
    const joiner = await exchangeJwt(ctx.env, "telegram-join-nationality-user")
    const communityId = await createCommunity({
      env: ctx.env,
      accessToken: owner.accessToken,
      displayName: "Telegram Join Nationality Club",
    })
    await setCommunityGatePolicy({
      communityDbRoot: ctx.communityDbRoot,
      communityId,
      expression: {
        op: "gate",
        gate: {
          type: "nationality",
          provider: "self",
          allowed: ["PS"],
        },
      },
    })
    await setUserNationality({
      client: ctx.client,
      userId: joiner.userId,
      countryCode: "US",
    })
    await linkTelegramAccount({
      client: ctx.client,
      telegramUserId: "779108",
      userId: joiner.userId,
    })
    await linkTelegramChatForCommunity({
      env: ctx.env,
      communityId,
      accessToken: owner.accessToken,
      telegramChatId: "-1009108",
      title: "Telegram Join Nationality Club",
    })
    const requests = installTelegramApiMock(() => ({
      ok: true,
      result: { message_id: 808 },
    }))

    const response = await telegramWebhook({
      env: ctx.env,
      secret: "webhook-secret",
      body: {
        update_id: 39,
        chat_join_request: {
          chat: { id: -1009108, type: "supergroup", title: "Telegram Join Nationality Club" },
          from: { id: 779108, username: "joiner" },
          user_chat_id: 889108,
          date: 1_779_000_008,
        },
      },
    })

    expect(response.status).toBe(200)
    expect(requests).toHaveLength(1)
    const sendBody = await requests[0]!.json() as { chat_id: string; text: string }
    expect(sendBody.chat_id).toBe("889108")
    expect(sendBody.text).toContain("verified nationality")
    expect(sendBody.text).toContain(`https://staging.pirate.test/tg/c/com_${communityId}`)
    const grant = await getTelegramJoinGrant({
      client: ctx.client,
      telegramChatId: "-1009108",
      telegramUserId: "779108",
    })
    expect(grant?.status).toBe("pending")
    expect(grant?.user_id).toBe(joiner.userId)
    expect(JSON.parse(grant?.missing_capabilities_json ?? "[]")).toContain("nationality")
  })

  test("post-verification approval approves pending nationality-gated Telegram join requests", async () => {
    const ctx = await createRouteTestContext({
      TELEGRAM_BOT_USERNAME: "PirateTestBot",
      TELEGRAM_BOT_TOKEN: "987654:bot-token",
      TELEGRAM_BOT_INTEGRATION_SECRET: "test-telegram-secret",
      TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
      PIRATE_WEB_PUBLIC_ORIGIN: "https://staging.pirate.test",
    })
    cleanup = ctx.cleanup
    const owner = await exchangeJwt(ctx.env, "telegram-join-verified-owner")
    const joiner = await exchangeJwt(ctx.env, "telegram-join-verified-user")
    const communityId = await createCommunity({
      env: ctx.env,
      accessToken: owner.accessToken,
      displayName: "Telegram Join Verified Club",
    })
    await setCommunityGatePolicy({
      communityDbRoot: ctx.communityDbRoot,
      communityId,
      expression: {
        op: "gate",
        gate: {
          type: "nationality",
          provider: "self",
          allowed: ["PS"],
        },
      },
    })
    await linkTelegramAccount({
      client: ctx.client,
      telegramUserId: "779111",
      userId: joiner.userId,
    })
    await linkTelegramChatForCommunity({
      env: ctx.env,
      communityId,
      accessToken: owner.accessToken,
      telegramChatId: "-1009111",
      title: "Telegram Join Verified Club",
    })
    await ctx.client.execute({
      sql: `
        UPDATE telegram_linked_chats
        SET telegram_community_bot_id = NULL
        WHERE community_id = ?1
          AND telegram_chat_id = ?2
      `,
      args: [communityId, "-1009111"],
    })
    const requests = installTelegramApiMock((request) => request.url.endsWith("/approveChatJoinRequest")
      ? { ok: true, result: true }
      : { ok: true, result: { message_id: 811 } })

    const response = await telegramWebhook({
      env: ctx.env,
      secret: "webhook-secret",
      body: {
        update_id: 41,
        chat_join_request: {
          chat: { id: -1009111, type: "supergroup", title: "Telegram Join Verified Club" },
          from: { id: 779111, username: "joiner" },
          user_chat_id: 889111,
          date: Math.floor(Date.now() / 1000),
        },
      },
    })

    expect(response.status).toBe(200)
    expect(requests).toHaveLength(1)
    await setUserNationality({
      client: ctx.client,
      userId: joiner.userId,
      countryCode: "PS",
    })

    const approvalResults = await approvePendingTelegramJoinGrantsForUser({
      env: ctx.env,
      userId: joiner.userId,
    })

    expect(approvalResults).toEqual([{ grantId: expect.any(String), status: "approved" }])
    expect(requests).toHaveLength(2)
    expect(requests[1]!.url).toBe("https://api.telegram.org/bot987654:bot-token/approveChatJoinRequest")
    const approveBody = await requests[1]!.json() as { chat_id: string; user_id: string }
    expect(approveBody.chat_id).toBe("-1009111")
    expect(approveBody.user_id).toBe("779111")
    const grant = await getTelegramJoinGrant({
      client: ctx.client,
      telegramChatId: "-1009111",
      telegramUserId: "779111",
    })
    expect(grant?.status).toBe("approved")
    expect(grant?.approved_at).toBeTruthy()
  })

  test("webhook chat_join_request marks prompt failures without retrying the webhook", async () => {
    const ctx = await createRouteTestContext({
      TELEGRAM_BOT_USERNAME: "PirateTestBot",
      TELEGRAM_BOT_TOKEN: "987654:bot-token",
      TELEGRAM_BOT_INTEGRATION_SECRET: "test-telegram-secret",
      TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
      PIRATE_WEB_PUBLIC_ORIGIN: "https://staging.pirate.test",
    })
    cleanup = ctx.cleanup
    const owner = await exchangeJwt(ctx.env, "telegram-join-prompt-fail-owner")
    const communityId = await createCommunity({
      env: ctx.env,
      accessToken: owner.accessToken,
      displayName: "Telegram Join Prompt Failure Club",
    })
    await linkTelegramChatForCommunity({
      env: ctx.env,
      communityId,
      accessToken: owner.accessToken,
      telegramChatId: "-1009104",
      title: "Telegram Join Prompt Failure Club",
    })
    installTelegramApiMock(() => ({
      ok: false,
      description: "Forbidden: bot can't initiate conversation",
    }))

    const response = await telegramWebhook({
      env: ctx.env,
      secret: "webhook-secret",
      body: {
        update_id: 34,
        chat_join_request: {
          chat: { id: -1009104, type: "supergroup", title: "Telegram Join Prompt Failure Club" },
          from: { id: 779104, username: "joiner" },
          user_chat_id: 889104,
          date: 1_779_000_004,
        },
      },
    })

    expect(response.status).toBe(200)
    const grant = await getTelegramJoinGrant({
      client: ctx.client,
      telegramChatId: "-1009104",
      telegramUserId: "779104",
    })
    expect(grant?.status).toBe("failed")
    expect(grant?.error_message).toContain("prompt failed")
  })

  test("webhook chat_join_request fails pending grant when web origin is missing", async () => {
    const ctx = await createRouteTestContext({
      TELEGRAM_BOT_USERNAME: "PirateTestBot",
      TELEGRAM_BOT_TOKEN: "987654:bot-token",
      TELEGRAM_BOT_INTEGRATION_SECRET: "test-telegram-secret",
      TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
      PIRATE_WEB_PUBLIC_ORIGIN: "",
    })
    cleanup = ctx.cleanup
    const owner = await exchangeJwt(ctx.env, "telegram-join-missing-origin-owner")
    const communityId = await createCommunity({
      env: ctx.env,
      accessToken: owner.accessToken,
      displayName: "Telegram Join Missing Origin Club",
    })
    await linkTelegramChatForCommunity({
      env: ctx.env,
      communityId,
      accessToken: owner.accessToken,
      telegramChatId: "-1009107",
      title: "Telegram Join Missing Origin Club",
    })
    const requests = installTelegramApiMock(() => ({
      ok: true,
      result: { message_id: 807 },
    }))

    const response = await telegramWebhook({
      env: ctx.env,
      secret: "webhook-secret",
      body: {
        update_id: 38,
        chat_join_request: {
          chat: { id: -1009107, type: "supergroup", title: "Telegram Join Missing Origin Club" },
          from: { id: 779107, username: "joiner" },
          user_chat_id: 889107,
          date: 1_779_000_007,
        },
      },
    })

    expect(response.status).toBe(200)
    expect(requests).toHaveLength(0)
    const grant = await getTelegramJoinGrant({
      client: ctx.client,
      telegramChatId: "-1009107",
      telegramUserId: "779107",
    })
    expect(grant?.status).toBe("failed")
    expect(grant?.error_message).toContain("PIRATE_WEB_PUBLIC_ORIGIN")
  })

  test("webhook chat_join_request marks approve failures without retrying the webhook", async () => {
    const ctx = await createRouteTestContext({
      TELEGRAM_BOT_USERNAME: "PirateTestBot",
      TELEGRAM_BOT_TOKEN: "987654:bot-token",
      TELEGRAM_BOT_INTEGRATION_SECRET: "test-telegram-secret",
      TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
    })
    cleanup = ctx.cleanup
    const owner = await exchangeJwt(ctx.env, "telegram-join-approve-fail-owner")
    const member = await exchangeJwt(ctx.env, "telegram-join-approve-fail-member")
    const communityId = await createCommunity({
      env: ctx.env,
      accessToken: owner.accessToken,
      displayName: "Telegram Join Approve Failure Club",
    })
    await markCommunityMember({
      communityDbRoot: ctx.communityDbRoot,
      communityId,
      userId: member.userId,
    })
    await linkTelegramAccount({
      client: ctx.client,
      telegramUserId: "779105",
      userId: member.userId,
    })
    await linkTelegramChatForCommunity({
      env: ctx.env,
      communityId,
      accessToken: owner.accessToken,
      telegramChatId: "-1009105",
      title: "Telegram Join Approve Failure Club",
    })
    installTelegramApiMock(() => ({
      ok: false,
      description: "Bad Request: user not found",
    }))

    const response = await telegramWebhook({
      env: ctx.env,
      secret: "webhook-secret",
      body: {
        update_id: 35,
        chat_join_request: {
          chat: { id: -1009105, type: "supergroup", title: "Telegram Join Approve Failure Club" },
          from: { id: 779105, username: "member" },
          user_chat_id: 889105,
          date: 1_779_000_005,
        },
      },
    })

    expect(response.status).toBe(200)
    const grant = await getTelegramJoinGrant({
      client: ctx.client,
      telegramChatId: "-1009105",
      telegramUserId: "779105",
    })
    expect(grant?.status).toBe("failed")
    expect(grant?.error_message).toContain("approveChatJoinRequest failed")
  })

  test("webhook requires the Telegram webhook secret", async () => {
    const ctx = await createRouteTestContext({
      TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
    })
    cleanup = ctx.cleanup

    const response = await telegramWebhook({
      env: ctx.env,
      body: { update_id: 5 },
    })

    expect(response.status).toBe(401)
  })
})
