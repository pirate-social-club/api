import type { ActorContext, AdminActorContext } from "../auth-middleware"
import type {
  CommunityDatabaseBindingRepository,
  CommunityReadRepository,
} from "../communities/db-community-repository"
import { openCommunityWriteClient } from "../communities/community-read-access"
import { enqueueCommunityJob } from "../communities/jobs/store"
import { badRequestError, conflictError } from "../errors"
import { makeId, nowIso } from "../helpers"
import { publicCommunityId } from "../public-ids"
import { getControlPlaneClient } from "../runtime-deps"
import { rowValue, stringOrNull } from "../sql-row"
import type { Env } from "../../env"
import { getTelegramChat, getTelegramChatMember } from "./bot-api"
import { decryptActiveCommunityTelegramBotOrNull } from "./community-bot-service"
import { requireOwnedTelegramCommunity } from "./community-chat-service"

export type TelegramChannelPublicationMode = "off" | "from_now" | "recent_backfill"

export type TelegramChannelDestinationResource = {
  id: string
  object: "telegram_channel_destination"
  community: string
  title: string
  username: string | null
  bot_admin_status: "ready"
  publication_mode: TelegramChannelPublicationMode
  linked_at: number
}

type DestinationRow = {
  id: string
  communityId: string
  title: string
  username: string | null
  publicationMode: TelegramChannelPublicationMode
  linkedAt: string
}

function toDestination(row: unknown): DestinationRow | null {
  if (!row) return null
  return {
    id: String(rowValue(row, "telegram_channel_destination_id") ?? ""),
    communityId: String(rowValue(row, "community_id") ?? ""),
    title: String(rowValue(row, "channel_title") ?? ""),
    username: stringOrNull(rowValue(row, "channel_username")),
    publicationMode: String(rowValue(row, "publication_mode") ?? "from_now") as TelegramChannelPublicationMode,
    linkedAt: String(rowValue(row, "linked_at") ?? ""),
  }
}

function serialize(row: DestinationRow): TelegramChannelDestinationResource {
  return {
    id: row.id,
    object: "telegram_channel_destination",
    community: publicCommunityId(row.communityId),
    title: row.title,
    username: row.username,
    bot_admin_status: "ready",
    publication_mode: row.publicationMode,
    linked_at: Math.floor(Date.parse(row.linkedAt) / 1000),
  }
}

async function activeDestination(env: Env, communityId: string): Promise<DestinationRow | null> {
  const result = await getControlPlaneClient(env).execute({
    sql: `
      SELECT telegram_channel_destination_id, community_id, channel_title, channel_username,
             publication_mode, linked_at
      FROM telegram_channel_destinations
      WHERE community_id = ?1 AND status = 'active'
      LIMIT 1
    `,
    args: [communityId],
  })
  return toDestination(result.rows[0])
}

export async function listActiveTelegramChannelCommunityIds(input: {
  client: {
    execute: (query: {
      sql: string
      args: unknown[]
    }) => Promise<{ rows: unknown[] }>
  }
  limit?: number
}): Promise<string[]> {
  const limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? 25)))
  const result = await input.client.execute({
    sql: `
      SELECT community_id
      FROM telegram_channel_destinations
      WHERE status = 'active'
        AND publication_mode != 'off'
      ORDER BY linked_at DESC
      LIMIT ?1
    `,
    args: [limit],
  })
  return result.rows
    .map((row) => String(rowValue(row, "community_id") ?? ""))
    .filter(Boolean)
}

function normalizeChatId(value: unknown): string {
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value)
  if (typeof value === "string" && value.trim()) return value.trim()
  throw badRequestError("telegram_chat is required")
}

function normalizeMode(value: unknown): TelegramChannelPublicationMode {
  if (value === undefined || value === null) return "from_now"
  if (value === "off" || value === "from_now" || value === "recent_backfill") return value
  throw badRequestError("publication_mode is invalid")
}

export async function getTelegramChannelDestination(input: {
  env: Env
  communityRepository: Pick<CommunityReadRepository, "getCommunityById">
  communityId: string
  actor: ActorContext | AdminActorContext
}): Promise<TelegramChannelDestinationResource | null> {
  const community = await requireOwnedTelegramCommunity({
    repository: input.communityRepository,
    communityId: input.communityId,
    actor: input.actor,
  })
  const destination = await activeDestination(input.env, community.community_id)
  return destination ? serialize(destination) : null
}

export async function connectTelegramChannelDestination(input: {
  env: Env
  communityRepository: Pick<CommunityReadRepository, "getCommunityById">
  communityId: string
  actor: ActorContext | AdminActorContext
  body: { telegram_chat?: unknown; publication_mode?: unknown } | null
}): Promise<TelegramChannelDestinationResource> {
  const community = await requireOwnedTelegramCommunity({
    repository: input.communityRepository,
    communityId: input.communityId,
    actor: input.actor,
  })
  const chatId = normalizeChatId(input.body?.telegram_chat)
  const publicationMode = normalizeMode(input.body?.publication_mode)
  const bot = await decryptActiveCommunityTelegramBotOrNull({
    env: input.env,
    communityId: community.community_id,
  })
  if (!bot) throw badRequestError("Save a community Telegram bot token before connecting a channel")
  const chat = await getTelegramChat(bot, chatId)
  if (chat.type !== "channel") throw badRequestError("telegram_chat must be a channel")
  const member = await getTelegramChatMember(bot, chatId, bot.userId ?? "")
  if (
    member.status !== "administrator"
    && member.status !== "creator"
    || member.can_post_messages === false
  ) {
    throw badRequestError("The community bot must be a channel administrator with permission to post messages")
  }

  const client = getControlPlaneClient(input.env)
  const now = nowIso()
  const id = makeId("tcd")
  const tx = await client.transaction("write")
  try {
    const collision = await tx.execute({
      sql: `
        SELECT community_id
        FROM telegram_channel_destinations
        WHERE telegram_chat_id = ?1 AND status = 'active'
        LIMIT 1
      `,
      args: [chatId],
    })
    const collisionCommunity = stringOrNull(rowValue(collision.rows[0], "community_id"))
    if (collisionCommunity && collisionCommunity !== community.community_id) {
      throw conflictError("Telegram channel is already connected to another community")
    }
    await tx.execute({
      sql: `
        UPDATE telegram_channel_destinations
        SET status = 'unlinked', unlinked_at = ?2, updated_at = ?2
        WHERE community_id = ?1 AND status = 'active'
      `,
      args: [community.community_id, now],
    })
    await tx.execute({
      sql: `
        INSERT INTO telegram_channel_destinations (
          telegram_channel_destination_id, telegram_community_bot_id, community_id, telegram_chat_id,
          channel_title, channel_username, bot_admin_status, publication_mode, status,
          linked_by_user_id, setup_intent_id, linked_at, unlinked_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'ready', ?7, 'active', ?8, NULL, ?9, NULL, ?9)
      `,
      args: [
        id,
        bot.id,
        community.community_id,
        chatId,
        chat.title?.trim() || "Telegram channel",
        chat.username?.trim() || null,
        publicationMode,
        community.creator_user_id,
        now,
      ],
    })
    await tx.commit()
  } catch (error) {
    await tx.rollback().catch(() => undefined)
    throw error
  } finally {
    tx.close()
  }
  const destination = await activeDestination(input.env, community.community_id)
  if (!destination) throw conflictError("Telegram channel was not connected")
  return serialize(destination)
}

export async function completeTelegramChannelSetupByRequest(input: {
  env: Env
  telegramCommunityBotId: string
  requestId: number
  telegramUserId: string
  privateChatId: string
  telegramChatId: string
  channelTitle: string
  channelUsername: string | null
}): Promise<TelegramChannelDestinationResource> {
  const client = getControlPlaneClient(input.env)
  const intentResult = await client.execute({
    sql: `
      SELECT telegram_setup_intent_id, telegram_community_bot_id, community_id, owner_user_id, expires_at
      FROM telegram_setup_intents
      WHERE request_id = ?1
        AND request_owner_telegram_user_id = ?2
        AND request_private_chat_id = ?3
        AND setup_kind = 'channel'
        AND status = 'pending'
      LIMIT 1
    `,
    args: [input.requestId, input.telegramUserId, input.privateChatId],
  })
  const intent = intentResult.rows[0]
  if (!intent) throw conflictError("Telegram channel setup request was not found")
  const botId = String(rowValue(intent, "telegram_community_bot_id") ?? "")
  if (botId !== input.telegramCommunityBotId) {
    throw conflictError("Telegram channel setup request was not found")
  }
  const expiresAt = String(rowValue(intent, "expires_at") ?? "")
  if (Date.parse(expiresAt) <= Date.now()) throw conflictError("Telegram channel setup intent expired")
  const communityId = String(rowValue(intent, "community_id") ?? "")
  const ownerUserId = String(rowValue(intent, "owner_user_id") ?? "")
  const setupIntentId = String(rowValue(intent, "telegram_setup_intent_id") ?? "")
  const now = nowIso()
  const id = makeId("tcd")
  const tx = await client.transaction("write")
  try {
    const collision = await tx.execute({
      sql: `
        SELECT community_id
        FROM telegram_channel_destinations
        WHERE telegram_chat_id = ?1 AND status = 'active'
        LIMIT 1
      `,
      args: [input.telegramChatId],
    })
    const collisionCommunity = stringOrNull(rowValue(collision.rows[0], "community_id"))
    if (collisionCommunity && collisionCommunity !== communityId) {
      throw conflictError("Telegram channel is already connected to another community")
    }
    await tx.execute({
      sql: `
        UPDATE telegram_channel_destinations
        SET status = 'unlinked', unlinked_at = ?2, updated_at = ?2
        WHERE community_id = ?1 AND status = 'active'
      `,
      args: [communityId, now],
    })
    await tx.execute({
      sql: `
        INSERT INTO telegram_channel_destinations (
          telegram_channel_destination_id, telegram_community_bot_id, community_id, telegram_chat_id,
          channel_title, channel_username, bot_admin_status, publication_mode, status,
          linked_by_user_id, setup_intent_id, linked_at, unlinked_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'ready', 'from_now', 'active', ?7, ?8, ?9, NULL, ?9)
      `,
      args: [
        id,
        botId,
        communityId,
        input.telegramChatId,
        input.channelTitle,
        input.channelUsername,
        ownerUserId,
        setupIntentId,
        now,
      ],
    })
    await tx.execute({
      sql: `
        UPDATE telegram_setup_intents
        SET status = 'completed', completed_at = ?2, telegram_user_id = ?3,
            telegram_chat_id = ?4, updated_at = ?2
        WHERE telegram_setup_intent_id = ?1 AND status = 'pending'
      `,
      args: [setupIntentId, now, input.telegramUserId, input.telegramChatId],
    })
    await tx.commit()
  } catch (error) {
    await tx.rollback().catch(() => undefined)
    throw error
  } finally {
    tx.close()
  }
  const destination = await activeDestination(input.env, communityId)
  if (!destination) throw conflictError("Telegram channel was not connected")
  return serialize(destination)
}

export async function unlinkTelegramChannelDestination(input: {
  env: Env
  communityRepository: Pick<CommunityReadRepository, "getCommunityById">
  communityId: string
  actor: ActorContext | AdminActorContext
}): Promise<{ id: string; object: "telegram_channel_destination"; unlinked: true }> {
  const community = await requireOwnedTelegramCommunity({
    repository: input.communityRepository,
    communityId: input.communityId,
    actor: input.actor,
  })
  const destination = await activeDestination(input.env, community.community_id)
  if (!destination) throw conflictError("Telegram channel is not connected")
  const now = nowIso()
  await getControlPlaneClient(input.env).execute({
    sql: `
      UPDATE telegram_channel_destinations
      SET status = 'unlinked', unlinked_at = ?2, updated_at = ?2
      WHERE telegram_channel_destination_id = ?1 AND status = 'active'
    `,
    args: [destination.id, now],
  })
  return { id: destination.id, object: "telegram_channel_destination", unlinked: true }
}

export async function enqueueTelegramChannelBackfill(input: {
  env: Env
  communityRepository: CommunityReadRepository & CommunityDatabaseBindingRepository
  communityId: string
  actor: ActorContext | AdminActorContext
  limit: unknown
}): Promise<{ enqueued: number }> {
  const community = await requireOwnedTelegramCommunity({
    repository: input.communityRepository,
    communityId: input.communityId,
    actor: input.actor,
  })
  const destination = await activeDestination(input.env, community.community_id)
  if (!destination) throw conflictError("Telegram channel is not connected")
  const parsedLimit = Number(input.limit ?? 20)
  if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 50) {
    throw badRequestError("limit must be an integer from 1 to 50")
  }
  const projections = await getControlPlaneClient(input.env).execute({
    sql: `
      SELECT source_post_id
      FROM community_post_projections
      WHERE community_id = ?1
        AND status = 'published'
        AND visibility = 'public'
        AND source_post_id NOT IN (
          SELECT post_id
          FROM telegram_post_deliveries
          WHERE telegram_channel_destination_id = ?2
            AND status IN ('pending', 'delivered')
        )
      ORDER BY source_created_at DESC
      LIMIT ?3
    `,
    args: [community.community_id, destination.id, parsedLimit],
  })
  const postIds = projections.rows
    .map((row) => String(rowValue(row, "source_post_id") ?? ""))
    .filter(Boolean)
    .reverse()
  const db = await openCommunityWriteClient(input.env, input.communityRepository, community.community_id)
  try {
    for (const postId of postIds) {
      await enqueueCommunityJob({
        client: db.client,
        communityId: community.community_id,
        jobType: "telegram_post_publish",
        subjectType: "post",
        subjectId: postId,
        availableAt: new Date(Date.now() + postIds.indexOf(postId) * 2_000).toISOString(),
        createdAt: nowIso(),
      })
    }
  } finally {
    db.close()
  }
  return { enqueued: postIds.length }
}
