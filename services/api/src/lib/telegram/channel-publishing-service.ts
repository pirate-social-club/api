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

type ControlPlaneLike = {
  execute: (query: { sql: string; args: unknown[] }) => Promise<{ rows: unknown[] }>
}

// Injected rather than imported at the call sites so the delivery ordering can
// be tested without module mocking — `bun test` runs this package in a single
// process, so a mock.module here would leak into every other suite.
export type TelegramPublishDeps = {
  controlPlane: ControlPlaneLike
  loadBot: typeof decryptActiveCommunityTelegramBotOrNull
  telegram: {
    sendMessage: typeof sendTelegramMessage
    sendPhoto: typeof sendTelegramPhoto
    sendVideo: typeof sendTelegramVideo
    editCaption: typeof editTelegramMessageCaption
    editText: typeof editTelegramMessageText
  }
}

export function defaultTelegramPublishDeps(env: Env): TelegramPublishDeps {
  return {
    controlPlane: getControlPlaneClient(env),
    loadBot: decryptActiveCommunityTelegramBotOrNull,
    telegram: {
      sendMessage: sendTelegramMessage,
      sendPhoto: sendTelegramPhoto,
      sendVideo: sendTelegramVideo,
      editCaption: editTelegramMessageCaption,
      editText: editTelegramMessageText,
    },
  }
}

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
  status: string
  attemptCount: number
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
  media_refs?: Array<MediaRef>
}

// Mirrors the descriptors written by post-create-asset-preparation. There is no
// `preview_storage_ref` on a real media ref — previews live on `preview_video` /
// `preview_audio`, and the still frame on `poster_ref`.
type MediaRef = {
  storage_ref?: string | null
  mime_type?: string | null
  size_bytes?: number | null
  poster_ref?: string | null
  poster_mime_type?: string | null
  poster_size_bytes?: number | null
  preview_video?: MediaPreviewRef | null
  preview_audio?: MediaPreviewRef | null
}

type MediaPreviewRef = {
  storage_ref?: string | null
  mime_type?: string | null
  size_bytes?: number | null
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
  const attemptCount = rowValue(row, "attempt_count")
  return {
    id: String(rowValue(row, "telegram_post_delivery_id") ?? ""),
    messageId: messageId == null ? null : Number(messageId),
    contentHash: String(rowValue(row, "content_hash") ?? ""),
    status: String(rowValue(row, "status") ?? "pending"),
    attemptCount: attemptCount == null ? 0 : Number(attemptCount),
  }
}

// A row left `pending` with attempts recorded and no message id means an
// earlier attempt reached the Telegram send without recording its outcome. The
// Bot API offers neither an idempotency key nor a read-back, so retrying is a
// coin flip that previously duplicated the channel post once per attempt (up to
// COMMUNITY_JOB_MAX_ATTEMPTS). Fail closed and leave it for operator review.
function isUnconfirmedSend(delivery: Delivery | null): boolean {
  return Boolean(
    delivery
    && delivery.status === "pending"
    && delivery.attemptCount > 0
    && delivery.messageId == null,
  )
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

// Telegram fetches by-URL uploads itself and rejects anything past these
// ceilings, so an oversized asset must be filtered here rather than burning
// retries on a send that can never succeed.
export const TELEGRAM_URL_PHOTO_MAX_BYTES = 5 * 1024 * 1024
export const TELEGRAM_URL_VIDEO_MAX_BYTES = 20 * 1024 * 1024

export type TelegramPublicationMedia = { kind: "photo" | "video"; url: string }

function httpsRef(value: unknown): string | null {
  const trimmed = typeof value === "string" ? value.trim() : ""
  return trimmed && /^https:\/\//u.test(trimmed) ? trimmed : null
}

function mediaCandidate(
  ref: string | null | undefined,
  mimeType: string | null | undefined,
  sizeBytes: number | null | undefined,
): (TelegramPublicationMedia & { sizeBytes: number | null }) | null {
  const url = httpsRef(ref)
  if (!url) return null
  const mime = mimeType?.toLowerCase() ?? ""
  const kind = mime.startsWith("video/") ? "video" : mime.startsWith("image/") ? "photo" : null
  if (!kind) return null
  const size = typeof sizeBytes === "number" && Number.isFinite(sizeBytes) ? sizeBytes : null
  // An unknown size still gets attempted: we cannot rule it out, and a reject
  // lands on the failure path rather than silently dropping the media.
  const limit = kind === "photo" ? TELEGRAM_URL_PHOTO_MAX_BYTES : TELEGRAM_URL_VIDEO_MAX_BYTES
  if (size !== null && size > limit) return null
  return { kind, url, sizeBytes: size }
}

export function telegramPublicationMedia(post: ProjectedPost): TelegramPublicationMedia | null {
  const media = post.media_refs?.[0]
  if (!media) return null

  // Locked posts must never hand the full asset to a public channel: only the
  // preview clip or the poster still. A locked post with neither degrades to
  // the text + link rendering, which is the correct paywall behaviour.
  // preview_audio has no photo/video send path, so locked audio falls through
  // to the poster (cover art) and then to text.
  const candidates = post.access_mode === "locked"
    ? [
        mediaCandidate(media.preview_video?.storage_ref, media.preview_video?.mime_type ?? "video/mp4", media.preview_video?.size_bytes),
        mediaCandidate(media.poster_ref, media.poster_mime_type ?? "image/jpeg", media.poster_size_bytes),
      ]
    : [
        mediaCandidate(media.storage_ref, media.mime_type, media.size_bytes),
        // Oversized video still gets a visual: the poster is well under the
        // photo ceiling and beats posting a bare link.
        mediaCandidate(media.poster_ref, media.poster_mime_type ?? "image/jpeg", media.poster_size_bytes),
      ]

  const chosen = candidates.find((candidate) => candidate !== null)
  return chosen ? { kind: chosen.kind, url: chosen.url } : null
}

function openMarkup(url: string) {
  return {
    inline_keyboard: [[{
      text: "Open in Pirate",
      web_app: { url },
    }]],
  }
}

async function findDestination(client: ControlPlaneLike, communityId: string): Promise<ChannelDestination | null> {
  const result = await client.execute({
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

async function findDelivery(client: ControlPlaneLike, destinationId: string, postId: string): Promise<Delivery | null> {
  const result = await client.execute({
    sql: `
      SELECT telegram_post_delivery_id, telegram_message_id, content_hash, status, attempt_count
      FROM telegram_post_deliveries
      WHERE telegram_channel_destination_id = ?1
        AND post_id = ?2
      LIMIT 1
    `,
    args: [destinationId, postId],
  })
  return existingDelivery(result.rows[0])
}

// Claims the delivery slot BEFORE anything is handed to Telegram. If this write
// fails nothing is sent, so a send can never outlive the record of it. The
// message id and delivered_at are deliberately left untouched so an edit of an
// already-delivered post keeps its identity.
async function reserveDelivery(input: {
  destination: ChannelDestination
  deliveryId: string
  communityId: string
  postId: string
  projectionUpdatedAt: string
  contentHash: string
  client: ControlPlaneLike
}): Promise<void> {
  const now = nowIso()
  await input.client.execute({
    sql: `
      INSERT INTO telegram_post_deliveries (
        telegram_post_delivery_id, telegram_channel_destination_id, community_id, post_id,
        telegram_chat_id, telegram_message_id, projection_updated_at, content_hash, status,
        attempt_count, last_error, delivered_at, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7, 'pending', 1, NULL, NULL, ?8, ?8)
      ON CONFLICT (telegram_channel_destination_id, post_id) DO UPDATE SET
        projection_updated_at = excluded.projection_updated_at,
        content_hash = excluded.content_hash,
        status = 'pending',
        attempt_count = telegram_post_deliveries.attempt_count + 1,
        last_error = NULL,
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
      now,
    ],
  })
}

async function markDeliverySucceeded(input: {
  client: ControlPlaneLike
  deliveryId: string
  messageId: number
}): Promise<void> {
  const now = nowIso()
  await input.client.execute({
    sql: `
      UPDATE telegram_post_deliveries
      SET status = 'delivered',
          telegram_message_id = ?2,
          last_error = NULL,
          delivered_at = ?3,
          updated_at = ?3
      WHERE telegram_post_delivery_id = ?1
    `,
    args: [input.deliveryId, input.messageId, now],
  })
}

// The reservation already counted this attempt, so this must not increment
// again — doing so would burn the job's retry budget at twice the real rate.
async function markDeliveryFailure(input: {
  client: ControlPlaneLike
  deliveryId: string
  error: unknown
}): Promise<void> {
  const now = nowIso()
  await input.client.execute({
    sql: `
      UPDATE telegram_post_deliveries
      SET status = 'failed',
          last_error = ?2,
          updated_at = ?3
      WHERE telegram_post_delivery_id = ?1
    `,
    args: [input.deliveryId, errorMessage(input.error), now],
  })
}

// Leaves the row `pending` on purpose: that is what keeps isUnconfirmedSend
// true on every later pass, so no retry can duplicate the channel post.
async function markDeliveryUnconfirmed(input: {
  client: ControlPlaneLike
  deliveryId: string
}): Promise<void> {
  const now = nowIso()
  await input.client.execute({
    sql: `
      UPDATE telegram_post_deliveries
      SET last_error = ?2,
          updated_at = ?3
      WHERE telegram_post_delivery_id = ?1
    `,
    args: [
      input.deliveryId,
      "A previous attempt sent to Telegram without recording the outcome. Skipped to avoid duplicating the channel post; needs operator review.",
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
}, deps: TelegramPublishDeps = defaultTelegramPublishDeps(input.env)): Promise<string | null> {
  const client = deps.controlPlane
  const post = parsePost(input.projection)
  if (!eligibleTelegramPost(input.projection, post)) return null
  const destination = await findDestination(client, input.projection.community_id)
  if (!destination) return null
  const bot = await deps.loadBot({
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
  const existing = await findDelivery(client, destination.id, input.projection.source_post_id)
  if (existing?.messageId && existing.contentHash === contentHash) return existing.id
  const deliveryId = existing?.id ?? makeId("tpd")

  if (isUnconfirmedSend(existing)) {
    await markDeliveryUnconfirmed({ client, deliveryId })
    return null
  }

  // Reserve first. A failure here throws before any Telegram call, which is the
  // whole point: no send without a durable record of it.
  await reserveDelivery({
    destination,
    deliveryId,
    communityId: input.projection.community_id,
    postId: input.projection.source_post_id,
    projectionUpdatedAt: input.projection.updated_at,
    contentHash,
    client,
  })

  // Distinguishes "never reached Telegram" (safe to retry) from "Telegram
  // accepted it but we failed to record that" (must never retry).
  let sent = false
  try {
    let messageId = existing?.messageId ?? null
    if (messageId) {
      if (media) {
        await deps.telegram.editCaption(bot, {
          chat_id: destination.chatId,
          message_id: messageId,
          caption: renderTelegramPostCaption(post),
          reply_markup: openMarkup(url),
        })
      } else {
        await deps.telegram.editText(bot, {
          chat_id: destination.chatId,
          message_id: messageId,
          text: renderTelegramPostText(post),
          reply_markup: openMarkup(url),
        })
      }
    } else if (media?.kind === "video") {
      messageId = (await deps.telegram.sendVideo(bot, {
        chat_id: destination.chatId,
        video: media.url,
        caption: renderTelegramPostCaption(post),
        reply_markup: openMarkup(url),
      })).message_id
    } else if (media?.kind === "photo") {
      messageId = (await deps.telegram.sendPhoto(bot, {
        chat_id: destination.chatId,
        photo: media.url,
        caption: renderTelegramPostCaption(post),
        reply_markup: openMarkup(url),
      })).message_id
    } else {
      messageId = (await deps.telegram.sendMessage(bot, {
        chat_id: destination.chatId,
        text: renderTelegramPostText(post),
        reply_markup: openMarkup(url),
      })).message_id
    }

    sent = true
    await markDeliverySucceeded({ client, deliveryId, messageId })
    return deliveryId
  } catch (error) {
    if (sent) {
      // Telegram already has the message; only the confirmation write failed.
      // Leaving the row `pending` with no message id is what makes every later
      // pass take the isUnconfirmedSend branch instead of sending again.
      await markDeliveryUnconfirmed({ client, deliveryId }).catch(() => undefined)
    } else {
      await markDeliveryFailure({ client, deliveryId, error }).catch(() => undefined)
    }
    throw error
  }
}
