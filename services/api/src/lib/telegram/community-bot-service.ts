import type { ActorContext, AdminActorContext } from "../auth-middleware"
import { executeFirst } from "../db-helpers"
import { badRequestError, providerUnavailable } from "../errors"
import { makeId, nowIso } from "../helpers"
import { getControlPlaneClient } from "../runtime-deps"
import { numberOrNull, rowValue, stringOrNull } from "../sql-row"
import { resolveCommunityDbWrapKey, resolveCommunityDbWrapKeyVersion } from "../communities/create/repository"
import type { CommunityReadRepository } from "../communities/db-community-repository"
import type { Env } from "../../env"
import {
  deleteTelegramWebhook,
  getTelegramBotProfile,
  setTelegramWebhook,
  type TelegramBotCredential,
} from "./bot-api"
import {
  decryptTelegramBotToken,
  encryptTelegramBotToken,
  normalizeTelegramBotToken,
} from "./bot-credential-crypto"
import { requireOwnedTelegramCommunity } from "./community-chat-service"

type TelegramCommunityBotStatus = "active" | "revoked" | "invalid"
type TelegramWebhookStatus = "pending" | "active" | "failed" | "disabled"

type TelegramCommunityBotRow = {
  telegram_community_bot_id: string
  community_id: string
  encrypted_bot_token: string
  token_last4: string
  encryption_key_version: number
  telegram_bot_user_id: string
  bot_username: string
  bot_display_name: string
  webhook_id: string
  webhook_secret: string
  webhook_status: TelegramWebhookStatus
  status: TelegramCommunityBotStatus
  created_at: string
  updated_at: string
  revoked_at: string | null
  rotated_from: string | null
  actor_user_id: string
}

export type TelegramCommunityBotResource = {
  id: string
  object: "telegram_community_bot"
  community: string
  status: "missing" | "connected" | "invalid"
  bot_username: string | null
  bot_display_name: string | null
  token_last4: string | null
  webhook_status: TelegramWebhookStatus | null
  connected_at: number | null
}

export type TelegramCommunityBotCredential = TelegramBotCredential & {
  id: string
  communityId: string
  webhookId: string
  webhookSecret: string
}

function randomHex(bytes: number): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes))
  return Array.from(data, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function unixSecondsFromIso(value: string | null): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null
}

function serializeBotRow(row: unknown): TelegramCommunityBotRow | null {
  if (!row || typeof row !== "object") return null
  const status = stringOrNull(rowValue(row, "status"))
  const webhookStatus = stringOrNull(rowValue(row, "webhook_status"))
  if (
    status !== "active" && status !== "revoked" && status !== "invalid"
  ) {
    return null
  }
  if (
    webhookStatus !== "pending"
    && webhookStatus !== "active"
    && webhookStatus !== "failed"
    && webhookStatus !== "disabled"
  ) {
    return null
  }
  return {
    telegram_community_bot_id: String(rowValue(row, "telegram_community_bot_id") || ""),
    community_id: String(rowValue(row, "community_id") || ""),
    encrypted_bot_token: String(rowValue(row, "encrypted_bot_token") || ""),
    token_last4: String(rowValue(row, "token_last4") || ""),
    encryption_key_version: numberOrNull(rowValue(row, "encryption_key_version")) ?? 1,
    telegram_bot_user_id: String(rowValue(row, "telegram_bot_user_id") || ""),
    bot_username: String(rowValue(row, "bot_username") || ""),
    bot_display_name: String(rowValue(row, "bot_display_name") || ""),
    webhook_id: String(rowValue(row, "webhook_id") || ""),
    webhook_secret: String(rowValue(row, "webhook_secret") || ""),
    webhook_status: webhookStatus,
    status,
    created_at: String(rowValue(row, "created_at") || ""),
    updated_at: String(rowValue(row, "updated_at") || ""),
    revoked_at: stringOrNull(rowValue(row, "revoked_at")),
    rotated_from: stringOrNull(rowValue(row, "rotated_from")),
    actor_user_id: String(rowValue(row, "actor_user_id") || ""),
  }
}

function serializeBotResource(row: TelegramCommunityBotRow | null): TelegramCommunityBotResource {
  if (!row) {
    return {
      id: "",
      object: "telegram_community_bot",
      community: "",
      status: "missing",
      bot_username: null,
      bot_display_name: null,
      token_last4: null,
      webhook_status: null,
      connected_at: null,
    }
  }
  return {
    id: row.telegram_community_bot_id,
    object: "telegram_community_bot",
    community: row.community_id,
    status: row.status === "active" ? "connected" : "invalid",
    bot_username: row.bot_username,
    bot_display_name: row.bot_display_name,
    token_last4: row.token_last4,
    webhook_status: row.webhook_status,
    connected_at: unixSecondsFromIso(row.created_at),
  }
}

async function readTelegramCommunityBot(input: {
  env: Env
  botId?: string
  communityId?: string
  webhookId?: string
  status?: TelegramCommunityBotStatus
}): Promise<TelegramCommunityBotRow | null> {
  const client = getControlPlaneClient(input.env)
  const clauses = ["1 = 1"]
  const args: unknown[] = []
  if (input.botId) {
    args.push(input.botId)
    clauses.push(`telegram_community_bot_id = ?${args.length}`)
  }
  if (input.communityId) {
    args.push(input.communityId)
    clauses.push(`community_id = ?${args.length}`)
  }
  if (input.webhookId) {
    args.push(input.webhookId)
    clauses.push(`webhook_id = ?${args.length}`)
  }
  if (input.status) {
    args.push(input.status)
    clauses.push(`status = ?${args.length}`)
  }
  const row = await executeFirst(client, {
    sql: `
      SELECT telegram_community_bot_id, community_id, encrypted_bot_token, token_last4,
             encryption_key_version, telegram_bot_user_id, bot_username, bot_display_name,
             webhook_id, webhook_secret, webhook_status, status, created_at, updated_at,
             revoked_at, rotated_from, actor_user_id
      FROM telegram_community_bots
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at DESC, telegram_community_bot_id DESC
      LIMIT 1
    `,
    args,
  })
  return serializeBotRow(row)
}

function publicApiOrigin(env: Env): string | null {
  const origin = env.PIRATE_API_PUBLIC_ORIGIN?.trim().replace(/\/+$/u, "")
  if (!origin || !origin.startsWith("https://")) return null
  return origin
}

async function registerCommunityBotWebhook(input: {
  env: Env
  bot: TelegramBotCredential
  webhookId: string
  webhookSecret: string
}): Promise<TelegramWebhookStatus> {
  const origin = publicApiOrigin(input.env)
  if (!origin) return "pending"
  try {
    await setTelegramWebhook(input.bot, {
      url: `${origin}/telegram/community-bots/${encodeURIComponent(input.webhookId)}/webhook`,
      secret_token: input.webhookSecret,
      allowed_updates: ["message", "chat_join_request"],
      drop_pending_updates: false,
    })
    return "active"
  } catch (error) {
    console.warn("[telegram-community-bot] webhook registration failed", {
      message: error instanceof Error ? error.message : String(error),
    })
    return "failed"
  }
}

export async function getCommunityTelegramBot(input: {
  env: Env
  communityRepository: Pick<CommunityReadRepository, "getCommunityById">
  communityId: string
  actor: ActorContext | AdminActorContext
}): Promise<TelegramCommunityBotResource> {
  const community = await requireOwnedTelegramCommunity({
    repository: input.communityRepository,
    communityId: input.communityId,
    actor: input.actor,
  })
  const row = await readTelegramCommunityBot({
    env: input.env,
    communityId: community.community_id,
    status: "active",
  })
  const resource = serializeBotResource(row)
  return row ? resource : { ...resource, community: community.community_id }
}

export async function saveCommunityTelegramBot(input: {
  env: Env
  communityRepository: Pick<CommunityReadRepository, "getCommunityById">
  communityId: string
  actor: ActorContext | AdminActorContext
  botToken: unknown
}): Promise<TelegramCommunityBotResource> {
  const community = await requireOwnedTelegramCommunity({
    repository: input.communityRepository,
    communityId: input.communityId,
    actor: input.actor,
  })
  if (typeof input.botToken !== "string") {
    throw badRequestError("Telegram bot token is required")
  }
  const plaintextToken = normalizeTelegramBotToken(input.botToken)
  const profile = await getTelegramBotProfile({ token: plaintextToken })
  if (!profile.is_bot || !profile.username?.trim()) {
    throw badRequestError("Telegram token must belong to a bot with a username")
  }

  const now = nowIso()
  const client = getControlPlaneClient(input.env)
  const wrapKey = resolveCommunityDbWrapKey(input.env)
  const encryptionKeyVersion = resolveCommunityDbWrapKeyVersion(input.env)
  const encryptedToken = encryptTelegramBotToken({ plaintextToken, wrapKey })
  const tokenLast4 = plaintextToken.slice(-4)
  const webhookId = makeId("tgb")
  const webhookSecret = randomHex(24)
  const webhookStatus = await registerCommunityBotWebhook({
    env: input.env,
    bot: {
      token: plaintextToken,
      userId: profile.id,
      username: profile.username,
    },
    webhookId,
    webhookSecret,
  })

  const tx = await client.transaction("write")
  let inserted: TelegramCommunityBotRow | null = null
  try {
    const existing = await readTelegramCommunityBot({
      env: input.env,
      communityId: community.community_id,
      status: "active",
    })
    if (existing) {
      await tx.execute({
        sql: `
          UPDATE telegram_community_bots
          SET status = 'revoked',
              revoked_at = ?2,
              updated_at = ?2
          WHERE telegram_community_bot_id = ?1
        `,
        args: [existing.telegram_community_bot_id, now],
      })
    }
    const botId = makeId("tcb")
    await tx.execute({
      sql: `
        INSERT INTO telegram_community_bots (
          telegram_community_bot_id, community_id, encrypted_bot_token, token_last4,
          encryption_key_version, telegram_bot_user_id, bot_username, bot_display_name,
          webhook_id, webhook_secret, webhook_status, status, created_at, updated_at,
          revoked_at, rotated_from, actor_user_id
        ) VALUES (
          ?1, ?2, ?3, ?4,
          ?5, ?6, ?7, ?8,
          ?9, ?10, ?11, 'active', ?12, ?12,
          NULL, ?13, ?14
        )
      `,
      args: [
        botId,
        community.community_id,
        encryptedToken,
        tokenLast4,
        encryptionKeyVersion,
        String(profile.id),
        profile.username,
        profile.first_name,
        webhookId,
        webhookSecret,
        webhookStatus,
        now,
        existing?.telegram_community_bot_id ?? null,
        input.actor.userId,
      ],
    })
    inserted = {
      telegram_community_bot_id: botId,
      community_id: community.community_id,
      encrypted_bot_token: encryptedToken,
      token_last4: tokenLast4,
      encryption_key_version: encryptionKeyVersion,
      telegram_bot_user_id: String(profile.id),
      bot_username: profile.username,
      bot_display_name: profile.first_name,
      webhook_id: webhookId,
      webhook_secret: webhookSecret,
      webhook_status: webhookStatus,
      status: "active",
      created_at: now,
      updated_at: now,
      revoked_at: null,
      rotated_from: existing?.telegram_community_bot_id ?? null,
      actor_user_id: input.actor.userId,
    }
    await tx.commit()
  } catch (error) {
    await tx.rollback().catch(() => undefined)
    throw error
  } finally {
    tx.close()
  }
  return serializeBotResource(inserted)
}

export async function revokeCommunityTelegramBot(input: {
  env: Env
  communityRepository: Pick<CommunityReadRepository, "getCommunityById">
  communityId: string
  actor: ActorContext | AdminActorContext
}): Promise<TelegramCommunityBotResource> {
  const community = await requireOwnedTelegramCommunity({
    repository: input.communityRepository,
    communityId: input.communityId,
    actor: input.actor,
  })
  const existing = await readTelegramCommunityBot({
    env: input.env,
    communityId: community.community_id,
    status: "active",
  })
  if (existing) {
    try {
      await deleteTelegramWebhook({
        token: decryptTelegramBotToken({
          encryptedToken: existing.encrypted_bot_token,
          encryptionKeyVersion: existing.encryption_key_version,
          wrapKey: resolveCommunityDbWrapKey(input.env),
        }),
        userId: existing.telegram_bot_user_id,
        username: existing.bot_username,
      }, { drop_pending_updates: false })
    } catch (error) {
      console.warn("[telegram-community-bot] deleteWebhook failed during revoke", {
        community: community.community_id,
        bot: existing.telegram_community_bot_id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  const now = nowIso()
  await getControlPlaneClient(input.env).execute({
    sql: `
      UPDATE telegram_community_bots
      SET status = 'revoked',
          revoked_at = ?2,
          updated_at = ?2
      WHERE community_id = ?1
        AND status = 'active'
    `,
    args: [community.community_id, now],
  })
  return {
    id: "",
    object: "telegram_community_bot",
    community: community.community_id,
    status: "missing",
    bot_username: null,
    bot_display_name: null,
    token_last4: null,
    webhook_status: null,
    connected_at: null,
  }
}

export async function decryptActiveCommunityTelegramBot(input: {
  env: Env
  communityId: string
}): Promise<TelegramCommunityBotCredential> {
  const credential = await decryptActiveCommunityTelegramBotOrNull(input)
  if (!credential) {
    throw providerUnavailable("Telegram bot token is required before connecting Telegram")
  }
  return credential
}

export async function getActiveCommunityTelegramBotUsername(input: {
  env: Env
  communityId: string
}): Promise<string | null> {
  const row = await readTelegramCommunityBot({
    env: input.env,
    communityId: input.communityId,
    status: "active",
  })
  return row?.bot_username ?? null
}

export async function decryptActiveCommunityTelegramBotOrNull(input: {
  env: Env
  communityId: string
}): Promise<TelegramCommunityBotCredential | null> {
  const row = await readTelegramCommunityBot({
    env: input.env,
    communityId: input.communityId,
    status: "active",
  })
  if (!row) {
    return null
  }
  return {
    id: row.telegram_community_bot_id,
    communityId: row.community_id,
    token: decryptTelegramBotToken({
      encryptedToken: row.encrypted_bot_token,
      encryptionKeyVersion: row.encryption_key_version,
      wrapKey: resolveCommunityDbWrapKey(input.env),
    }),
    userId: row.telegram_bot_user_id,
    username: row.bot_username,
    webhookId: row.webhook_id,
    webhookSecret: row.webhook_secret,
  }
}

export async function decryptCommunityTelegramBotById(input: {
  env: Env
  botId: string
}): Promise<TelegramCommunityBotCredential | null> {
  const row = await readTelegramCommunityBot({
    env: input.env,
    botId: input.botId,
    status: "active",
  })
  if (!row) return null
  return {
    id: row.telegram_community_bot_id,
    communityId: row.community_id,
    token: decryptTelegramBotToken({
      encryptedToken: row.encrypted_bot_token,
      encryptionKeyVersion: row.encryption_key_version,
      wrapKey: resolveCommunityDbWrapKey(input.env),
    }),
    userId: row.telegram_bot_user_id,
    username: row.bot_username,
    webhookId: row.webhook_id,
    webhookSecret: row.webhook_secret,
  }
}

export async function decryptCommunityTelegramBotByWebhookId(input: {
  env: Env
  webhookId: string
}): Promise<TelegramCommunityBotCredential | null> {
  const row = await readTelegramCommunityBot({
    env: input.env,
    webhookId: input.webhookId,
    status: "active",
  })
  if (!row) return null
  return {
    id: row.telegram_community_bot_id,
    communityId: row.community_id,
    token: decryptTelegramBotToken({
      encryptedToken: row.encrypted_bot_token,
      encryptionKeyVersion: row.encryption_key_version,
      wrapKey: resolveCommunityDbWrapKey(input.env),
    }),
    userId: row.telegram_bot_user_id,
    username: row.bot_username,
    webhookId: row.webhook_id,
    webhookSecret: row.webhook_secret,
  }
}
