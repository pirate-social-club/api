import { sha256Hex } from "../crypto"
import { internalError, providerUnavailable } from "../errors"
import { makeId, nowIso } from "../helpers"
import { publicPostId } from "../public-ids"
import { getControlPlaneClient } from "../runtime-deps"
import { rowValue } from "../sql-row"
import type { Env } from "../../env"
import type { CommunityPostProjectionRow } from "../auth/auth-db-community-rows"
import {
  editTelegramMessageCaption,
  editTelegramMessageText,
  sendTelegramMessage,
  sendTelegramPhoto,
  sendTelegramVideo,
} from "./bot-api"
import { decryptActiveCommunityTelegramBotOrNull } from "./community-bot-service"

type ChannelDestination = {
  id: string
  botId: string
  chatId: string
  publicationMode: "off" | "from_now" | "recent_backfill"
}

type Delivery = {
  id: string
  messageId: number | null
  contentHash: string
}

type ProjectedPost = {
  post_id?: string
  post_type?: string
  status?: string
  visibility?: string
  title?: string | null
  body?: string | null
  caption?: string | null
  link_url?: string | null
  content_safety_state?: string
  age_gate_policy?: string
  access_mode?: string | null
  media_refs?: Array<{
    storage_ref?: string
    mime_type?: string
    preview_storage_ref?: string | null
  }>
}

function activeDestination(row: unknown): ChannelDestination | null {
  if (!row) return null
  return {
    id: String(rowValue(row, "telegram_channel_destination_id") ?? ""),
    botId: String(rowValue(row, "telegram_community_bot_id") ?? ""),
    chatId: String(rowValue(row, "telegram_chat_id") ?? ""),
    publicationMode: String(rowValue(row, "publication_mode") ?? "off") as ChannelDestination["publicationMode"],
  }
}

function existingDelivery(row: unknown): Delivery | null {
  if (!row) return null
  const messageId = rowValue(row, "telegram_message_id")
  return {
    id: String(rowValue(row, "telegram_post_delivery_id") ?? ""),
    messageId: messageId == null ? null : Number(messageId),
    contentHash: String(rowValue(row, "content_hash") ?? ""),
  }
}

function parsePost(projection: CommunityPostProjectionRow): ProjectedPost {
  try {
    return JSON.parse(projection.projected_payload_json) as ProjectedPost
  } catch {
    throw internalError("Telegram publication projection is invalid")
  }
}

export function eligibleTelegramPost(projection: CommunityPostProjectionRow, post: ProjectedPost): boolean {
  return projection.status === "published"
    && projection.visibility === "public"
    && post.status === "published"
    && post.visibility === "public"
    && post.age_gate_policy !== "18_plus"
    && post.content_safety_state !== "adult"
}

function postUrl(env: Env, postId: string): string {
  const origin = env.PIRATE_WEB_PUBLIC_ORIGIN?.trim().replace(/\/+$/u, "")
  if (!origin) {
    throw providerUnavailable("PIRATE_WEB_PUBLIC_ORIGIN is required for Telegram publication")
  }
  return `${origin}/tg/p/${encodeURIComponent(publicPostId(postId))}`
}

export function renderTelegramPostCaption(post: ProjectedPost): string {
  const parts = [post.title, post.caption, post.body]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value))
  return (parts.join("\n\n") || "New on Pirate").slice(0, 1024)
}

export function renderTelegramPostText(post: ProjectedPost): string {
  const text = renderTelegramPostCaption(post)
  return post.link_url?.trim() ? `${text}\n\n${post.link_url.trim()}`.slice(0, 4096) : text
}

export function telegramPublicationMedia(post: ProjectedPost): { kind: "photo" | "video"; url: string } | null {
  const media = post.media_refs?.[0]
  const source = post.access_mode === "locked"
    ? media?.preview_storage_ref?.trim()
    : media?.storage_ref?.trim()
  if (!source || !/^https:\/\//u.test(source)) return null
  const mime = media?.mime_type?.toLowerCase() ?? ""
  if (mime.startsWith("video/")) return { kind: "video", url: source }
  if (mime.startsWith("image/")) return { kind: "photo", url: source }
  return null
}

function openMarkup(url: string) {
  return {
    inline_keyboard: [[{
      text: "Open in Pirate",
      web_app: { url },
    }]],
  }
}

async function findDestination(env: Env, communityId: string): Promise<ChannelDestination | null> {
  const result = await getControlPlaneClient(env).execute({
    sql: `
      SELECT telegram_channel_destination_id, telegram_community_bot_id, telegram_chat_id, publication_mode
      FROM telegram_channel_destinations
      WHERE community_id = ?1
        AND status = 'active'
        AND publication_mode != 'off'
      LIMIT 1
    `,
    args: [communityId],
  })
  return activeDestination(result.rows[0])
}

async function findDelivery(env: Env, destinationId: string, postId: string): Promise<Delivery | null> {
  const result = await getControlPlaneClient(env).execute({
    sql: `
      SELECT telegram_post_delivery_id, telegram_message_id, content_hash
      FROM telegram_post_deliveries
      WHERE telegram_channel_destination_id = ?1
        AND post_id = ?2
      LIMIT 1
    `,
    args: [destinationId, postId],
  })
  return existingDelivery(result.rows[0])
}

async function markDeliveryFailure(input: {
  destination: ChannelDestination
  deliveryId: string
  communityId: string
  postId: string
  projectionUpdatedAt: string
  contentHash: string
  error: unknown
  env: Env
}): Promise<void> {
  const now = nowIso()
  await getControlPlaneClient(input.env).execute({
    sql: `
      INSERT INTO telegram_post_deliveries (
        telegram_post_delivery_id, telegram_channel_destination_id, community_id, post_id,
        telegram_chat_id, telegram_message_id, projection_updated_at, content_hash, status,
        attempt_count, last_error, delivered_at, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7, 'failed', 1, ?8, NULL, ?9, ?9)
      ON CONFLICT (telegram_channel_destination_id, post_id) DO UPDATE SET
        projection_updated_at = excluded.projection_updated_at,
        content_hash = excluded.content_hash,
        status = 'failed',
        attempt_count = telegram_post_deliveries.attempt_count + 1,
        last_error = excluded.last_error,
        updated_at = excluded.updated_at
    `,
    args: [
      input.deliveryId,
      input.destination.id,
      input.communityId,
      input.postId,
      input.destination.chatId,
      input.projectionUpdatedAt,
      input.contentHash,
      errorMessage(input.error),
      now,
    ],
  })
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1000)
}

export async function publishPostProjectionToTelegram(input: {
  env: Env
  projection: CommunityPostProjectionRow
}): Promise<string | null> {
  const post = parsePost(input.projection)
  if (!eligibleTelegramPost(input.projection, post)) return null
  const destination = await findDestination(input.env, input.projection.community_id)
  if (!destination) return null
  const bot = await decryptActiveCommunityTelegramBotOrNull({
    env: input.env,
    communityId: input.projection.community_id,
  })
  if (!bot || bot.id !== destination.botId) {
    throw providerUnavailable("Telegram channel bot is unavailable")
  }

  const url = postUrl(input.env, input.projection.source_post_id)
  const media = telegramPublicationMedia(post)
  const contentHash = await sha256Hex(JSON.stringify({
    caption: renderTelegramPostCaption(post),
    media,
    text: renderTelegramPostText(post),
    url,
  }))
  const existing = await findDelivery(input.env, destination.id, input.projection.source_post_id)
  if (existing?.messageId && existing.contentHash === contentHash) return existing.id
  const deliveryId = existing?.id ?? makeId("tpd")

  try {
    let messageId = existing?.messageId ?? null
    if (messageId) {
      if (media) {
        await editTelegramMessageCaption(bot, {
          chat_id: destination.chatId,
          message_id: messageId,
          caption: renderTelegramPostCaption(post),
          reply_markup: openMarkup(url),
        })
      } else {
        await editTelegramMessageText(bot, {
          chat_id: destination.chatId,
          message_id: messageId,
          text: renderTelegramPostText(post),
          reply_markup: openMarkup(url),
        })
      }
    } else if (media?.kind === "video") {
      messageId = (await sendTelegramVideo(bot, {
        chat_id: destination.chatId,
        video: media.url,
        caption: renderTelegramPostCaption(post),
        reply_markup: openMarkup(url),
      })).message_id
    } else if (media?.kind === "photo") {
      messageId = (await sendTelegramPhoto(bot, {
        chat_id: destination.chatId,
        photo: media.url,
        caption: renderTelegramPostCaption(post),
        reply_markup: openMarkup(url),
      })).message_id
    } else {
      messageId = (await sendTelegramMessage(bot, {
        chat_id: destination.chatId,
        text: renderTelegramPostText(post),
        reply_markup: openMarkup(url),
      })).message_id
    }

    const now = nowIso()
    await getControlPlaneClient(input.env).execute({
      sql: `
        INSERT INTO telegram_post_deliveries (
          telegram_post_delivery_id, telegram_channel_destination_id, community_id, post_id,
          telegram_chat_id, telegram_message_id, projection_updated_at, content_hash, status,
          attempt_count, last_error, delivered_at, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'delivered', 1, NULL, ?9, ?9, ?9)
        ON CONFLICT (telegram_channel_destination_id, post_id) DO UPDATE SET
          telegram_message_id = excluded.telegram_message_id,
          projection_updated_at = excluded.projection_updated_at,
          content_hash = excluded.content_hash,
          status = 'delivered',
          attempt_count = telegram_post_deliveries.attempt_count + 1,
          last_error = NULL,
          delivered_at = excluded.delivered_at,
          updated_at = excluded.updated_at
      `,
      args: [
        deliveryId,
        destination.id,
        input.projection.community_id,
        input.projection.source_post_id,
        destination.chatId,
        messageId,
        input.projection.updated_at,
        contentHash,
        now,
      ],
    })
    return deliveryId
  } catch (error) {
    await markDeliveryFailure({
      destination,
      deliveryId,
      communityId: input.projection.community_id,
      postId: input.projection.source_post_id,
      projectionUpdatedAt: input.projection.updated_at,
      contentHash,
      error,
      env: input.env,
    })
    throw error
  }
}
