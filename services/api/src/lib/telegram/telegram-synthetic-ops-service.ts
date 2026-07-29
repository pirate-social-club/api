import { badRequestError, conflictError, notFoundError, providerUnavailable } from "../errors"
import { nowIso } from "../helpers"
import {
  decodePublicCommunityId,
  decodePublicPostId,
  publicCommunityId,
  publicPostId,
} from "../public-ids"
import { rowValue } from "../sql-row"
import type { Env } from "../../env"
import { deleteTelegramMessages } from "./bot-api"
import { decryptCommunityTelegramBotById } from "./community-bot-service"

type ControlPlaneLike = {
  execute: (query: { sql: string; args: unknown[] }) => Promise<{ rows: unknown[] }>
}

export type TelegramSyntheticFixture = {
  community_id: string
  owner_user_id: string
  channel_title: string
}

export type TelegramSyntheticDelivery = {
  delivery_id: string
  community_id: string
  post_id: string
  status: string
  attempt_count: number
  telegram_message_id: number | null
  last_error: string | null
  updated_at: string
}

function fixtureFromRow(row: unknown): TelegramSyntheticFixture {
  return {
    community_id: publicCommunityId(String(rowValue(row, "community_id") ?? "")),
    owner_user_id: String(rowValue(row, "created_by_user_id") ?? ""),
    channel_title: String(rowValue(row, "channel_title") ?? ""),
  }
}

/**
 * Resolve the staging channel used by the synthetic.
 *
 * With no configured community this deliberately succeeds only when staging
 * has exactly one active destination. Once more channels exist, the scheduled
 * workflow must pin its fixture explicitly instead of ever choosing a user's
 * channel by accident.
 */
export async function findTelegramSyntheticFixture(input: {
  client: ControlPlaneLike
  communityId?: string | null
}): Promise<TelegramSyntheticFixture> {
  const communityId = input.communityId?.trim()
    ? decodePublicCommunityId(input.communityId)
    : null
  const result = await input.client.execute({
    sql: `
      SELECT d.community_id, d.channel_title, c.created_by_user_id
      FROM telegram_channel_destinations d
      JOIN communities c ON c.community_id = d.community_id
      WHERE d.status = 'active'
        AND d.publication_mode != 'off'
        ${communityId ? "AND d.community_id = ?1" : ""}
      ORDER BY d.linked_at ASC
      LIMIT 2
    `,
    args: communityId ? [communityId] : [],
  })
  if (result.rows.length === 0) {
    throw notFoundError("No active Telegram synthetic fixture was found")
  }
  if (!communityId && result.rows.length !== 1) {
    throw conflictError("Multiple Telegram channels are active; configure the synthetic community explicitly")
  }
  const fixture = fixtureFromRow(result.rows[0])
  if (!fixture.owner_user_id) {
    throw conflictError("Telegram synthetic fixture has no community owner")
  }
  return fixture
}

function deliveryFromRow(row: unknown): TelegramSyntheticDelivery {
  const messageId = rowValue(row, "telegram_message_id")
  return {
    delivery_id: String(rowValue(row, "telegram_post_delivery_id") ?? ""),
    community_id: publicCommunityId(String(rowValue(row, "community_id") ?? "")),
    post_id: publicPostId(String(rowValue(row, "post_id") ?? "")),
    status: String(rowValue(row, "status") ?? ""),
    attempt_count: Number(rowValue(row, "attempt_count") ?? 0),
    telegram_message_id: messageId == null ? null : Number(messageId),
    last_error: rowValue(row, "last_error") == null ? null : String(rowValue(row, "last_error")),
    updated_at: String(rowValue(row, "updated_at") ?? ""),
  }
}

async function findSyntheticDeliveryRow(input: {
  client: ControlPlaneLike
  postId: string
  communityId?: string | null
}): Promise<unknown | null> {
  const postId = decodePublicPostId(input.postId)
  if (!postId) throw badRequestError("postId is required")
  const communityId = input.communityId?.trim()
    ? decodePublicCommunityId(input.communityId)
    : null
  const result = await input.client.execute({
    sql: `
      SELECT d.telegram_post_delivery_id, d.telegram_channel_destination_id,
             d.community_id, d.post_id, d.telegram_chat_id,
             d.telegram_message_id, d.status, d.attempt_count, d.last_error,
             d.updated_at, dst.telegram_community_bot_id
      FROM telegram_post_deliveries d
      JOIN telegram_channel_destinations dst
        ON dst.telegram_channel_destination_id = d.telegram_channel_destination_id
      WHERE d.post_id = ?1
        ${communityId ? "AND d.community_id = ?2" : ""}
      LIMIT 1
    `,
    args: communityId ? [postId, communityId] : [postId],
  })
  return result.rows[0] ?? null
}

export async function getTelegramSyntheticDelivery(input: {
  client: ControlPlaneLike
  postId: string
  communityId?: string | null
}): Promise<TelegramSyntheticDelivery | null> {
  const row = await findSyntheticDeliveryRow(input)
  return row ? deliveryFromRow(row) : null
}

/**
 * Remove a synthetic's Telegram message and retire its delivery row.
 *
 * Telegram's batch delete skips already-missing ids, so this operation is
 * idempotent across a lost response. It only accepts a recorded message id:
 * an uncertain send with no id remains visible for operator review instead of
 * claiming cleanup that cannot be proven.
 */
export async function cleanupTelegramSyntheticDelivery(input: {
  env: Env
  client: ControlPlaneLike
  postId: string
  communityId?: string | null
  deleteMessages?: typeof deleteTelegramMessages
  loadBot?: typeof decryptCommunityTelegramBotById
}): Promise<{ delivery: TelegramSyntheticDelivery; applied: boolean }> {
  const row = await findSyntheticDeliveryRow(input)
  if (!row) throw notFoundError("Telegram synthetic delivery not found")
  const delivery = deliveryFromRow(row)
  if (delivery.status === "deleted") {
    return { delivery, applied: false }
  }
  if (delivery.status !== "delivered" || delivery.telegram_message_id == null) {
    throw conflictError("Telegram synthetic delivery has no confirmed message to delete")
  }
  const botId = String(rowValue(row, "telegram_community_bot_id") ?? "")
  const bot = await (input.loadBot ?? decryptCommunityTelegramBotById)({
    env: input.env,
    botId,
  })
  if (!bot) throw providerUnavailable("Telegram synthetic fixture bot is unavailable")

  await (input.deleteMessages ?? deleteTelegramMessages)(bot, {
    chat_id: String(rowValue(row, "telegram_chat_id") ?? ""),
    message_ids: [delivery.telegram_message_id],
  })

  const updatedAt = nowIso()
  const result = await input.client.execute({
    sql: `
      UPDATE telegram_post_deliveries
      SET status = 'deleted',
          last_error = NULL,
          updated_at = ?2
      WHERE telegram_post_delivery_id = ?1
        AND status = 'delivered'
      RETURNING telegram_post_delivery_id
    `,
    args: [delivery.delivery_id, updatedAt],
  })
  return {
    delivery: { ...delivery, status: "deleted", last_error: null, updated_at: updatedAt },
    applied: result.rows.length > 0,
  }
}
