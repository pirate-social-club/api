import { badRequestError, notFoundError } from "../errors"
import { nowIso } from "../helpers"
import { publicPostId } from "../public-ids"
import { rowValue } from "../sql-row"

// Operator surface for deliveries whose outcome cannot be known.
//
// Telegram's Bot API has no idempotency key and cannot read back arbitrary
// channel history, so once a send response is lost there is no automatic way to
// learn whether the message landed. The publishing path therefore parks the row
// as 'uncertain' and never retries it. Without this surface those rows are
// invisible: nothing scans the table, so they would sit indefinitely.
//
// Everything here is deliberately narrow. Listing and counting are read-only,
// and the only two writes are explicit operator decisions.

export type UncertainDeliveryFilters = {
  communityId?: string | null
  destinationId?: string | null
  // Age floor, so an operator can ignore rows still young enough that an
  // in-flight attempt might yet resolve itself.
  olderThanMinutes?: number | null
}

export type UncertainDelivery = {
  delivery_id: string
  community_id: string
  destination_id: string
  post_id: string
  attempt_count: number
  // The last attempt, which is the age an operator triages on.
  last_attempt_at: string
  last_error: string | null
  // Present only when a prior attempt got far enough to learn it.
  telegram_message_id: number | null
}

type ControlPlaneLike = {
  execute: (query: { sql: string; args: unknown[] }) => Promise<{ rows: unknown[] }>
}

const MAX_PAGE_SIZE = 100

// telegram_chat_id is deliberately absent: an operator triages by community and
// destination, and the raw channel id is a Telegram identifier this surface has
// no need to expose. destination_id is sufficient to act.
function toUncertainDelivery(row: unknown): UncertainDelivery {
  const messageId = rowValue(row, "telegram_message_id")
  const rawPostId = String(rowValue(row, "post_id") ?? "")
  return {
    delivery_id: String(rowValue(row, "telegram_post_delivery_id") ?? ""),
    community_id: String(rowValue(row, "community_id") ?? ""),
    destination_id: String(rowValue(row, "telegram_channel_destination_id") ?? ""),
    post_id: publicPostId(rawPostId),
    attempt_count: Number(rowValue(row, "attempt_count") ?? 0),
    last_attempt_at: String(rowValue(row, "updated_at") ?? ""),
    last_error: rowValue(row, "last_error") == null ? null : String(rowValue(row, "last_error")),
    telegram_message_id: messageId == null ? null : Number(messageId),
  }
}

// Shared so the list and the count can never disagree about what "stranded"
// means — a count that drifts from its list is worse than no count.
function buildFilterClause(filters: UncertainDeliveryFilters): { sql: string; args: unknown[] } {
  const clauses: string[] = ["status = 'uncertain'"]
  const args: unknown[] = []
  if (filters.communityId) {
    args.push(filters.communityId)
    clauses.push(`community_id = ?${args.length}`)
  }
  if (filters.destinationId) {
    args.push(filters.destinationId)
    clauses.push(`telegram_channel_destination_id = ?${args.length}`)
  }
  if (filters.olderThanMinutes != null) {
    if (!Number.isFinite(filters.olderThanMinutes) || filters.olderThanMinutes < 0) {
      throw badRequestError("older_than_minutes must be a non-negative number")
    }
    const cutoff = new Date(Date.now() - filters.olderThanMinutes * 60_000).toISOString()
    args.push(cutoff)
    clauses.push(`updated_at <= ?${args.length}`)
  }
  return { sql: clauses.join(" AND "), args }
}

export async function listUncertainDeliveries(input: {
  client: ControlPlaneLike
  filters?: UncertainDeliveryFilters
  limit?: number
}): Promise<UncertainDelivery[]> {
  const filters = input.filters ?? {}
  const { sql: where, args } = buildFilterClause(filters)
  const limit = Math.min(Math.max(input.limit ?? 50, 1), MAX_PAGE_SIZE)
  args.push(limit)
  const result = await input.client.execute({
    sql: `
      SELECT telegram_post_delivery_id, community_id, telegram_channel_destination_id,
             post_id, attempt_count, updated_at, last_error, telegram_message_id
      FROM telegram_post_deliveries
      WHERE ${where}
      ORDER BY updated_at ASC
      LIMIT ?${args.length}
    `,
    args,
  })
  return result.rows.map(toUncertainDelivery)
}

export async function countUncertainDeliveries(input: {
  client: ControlPlaneLike
  filters?: UncertainDeliveryFilters
}): Promise<number> {
  const { sql: where, args } = buildFilterClause(input.filters ?? {})
  const result = await input.client.execute({
    sql: `SELECT COUNT(*) AS uncertain_count FROM telegram_post_deliveries WHERE ${where}`,
    args,
  })
  return Number(rowValue(result.rows[0], "uncertain_count") ?? 0)
}

export type ResolutionAction = "marked_delivered" | "retry_authorized"

export type ResolutionOutcome = {
  delivery_id: string
  action: ResolutionAction
  // False when the row was not 'uncertain' — a repeat of an already-applied
  // resolution, which is a success for the caller but must not act twice.
  applied: boolean
  // Only ever true alongside applied, so a duplicate call cannot re-enqueue.
  retry_enqueued: boolean
}

/**
 * Resolve one uncertain delivery.
 *
 * Idempotent by construction: every write is a compare-and-set on
 * `status = 'uncertain'`. A second identical call updates zero rows and reports
 * `applied: false` rather than acting again, so a retried request cannot
 * double-post to Telegram or double-enqueue a job.
 *
 * `marked_delivered` needs evidence, not a guess — either a message id the
 * operator read off the channel, or an explicit confirmation that they looked.
 *
 * `retry_authorized` moves the row back to 'pending', which means "reserved,
 * never sent". That does NOT re-enable automatic retries: nothing scans this
 * table, so the single attempt comes from the job the caller enqueues and
 * nothing else. If that attempt is itself ambiguous it lands back in
 * 'uncertain' and needs a fresh authorization.
 */
export async function resolveUncertainDelivery(input: {
  client: ControlPlaneLike
  deliveryId: string
  action: ResolutionAction
  actorUserId: string
  reason?: string | null
  // marked_delivered evidence.
  telegramMessageId?: number | null
  operatorConfirmed?: boolean
}): Promise<ResolutionOutcome> {
  if (!input.actorUserId.trim()) {
    throw badRequestError("An operator identity is required to resolve a delivery")
  }
  const reason = input.reason?.trim() ? input.reason.trim().slice(0, 500) : null
  const now = nowIso()

  if (input.action === "marked_delivered") {
    const messageId = input.telegramMessageId ?? null
    if (messageId == null && !input.operatorConfirmed) {
      throw badRequestError(
        "marked_delivered requires either telegram_message_id or operator_confirmed",
      )
    }
    const result = await input.client.execute({
      sql: `
        UPDATE telegram_post_deliveries
        SET status = 'delivered',
            telegram_message_id = COALESCE(?2, telegram_message_id),
            delivered_at = COALESCE(delivered_at, ?3),
            last_error = NULL,
            resolution_action = 'marked_delivered',
            resolved_at = ?3,
            resolved_by_user_id = ?4,
            resolution_reason = ?5,
            updated_at = ?3
        WHERE telegram_post_delivery_id = ?1
          AND status = 'uncertain'
        RETURNING telegram_post_delivery_id
      `,
      args: [input.deliveryId, messageId, now, input.actorUserId, reason],
    })
    return {
      delivery_id: input.deliveryId,
      action: "marked_delivered",
      applied: result.rows.length > 0,
      retry_enqueued: false,
    }
  }

  const result = await input.client.execute({
    sql: `
      UPDATE telegram_post_deliveries
      SET status = 'pending',
          last_error = NULL,
          resolution_action = 'retry_authorized',
          resolved_at = ?2,
          resolved_by_user_id = ?3,
          resolution_reason = ?4,
          updated_at = ?2
      WHERE telegram_post_delivery_id = ?1
        AND status = 'uncertain'
      RETURNING community_id, post_id
    `,
    args: [input.deliveryId, now, input.actorUserId, reason],
  })
  return {
    delivery_id: input.deliveryId,
    action: "retry_authorized",
    applied: result.rows.length > 0,
    retry_enqueued: false,
  }
}

/**
 * Undo a retry authorization whose job could not be enqueued.
 *
 * Without this the row sits in 'pending' with nothing scheduled to act on it:
 * no scanner will pick it up, and a repeat request would see the row is no
 * longer 'uncertain' and decline to enqueue. Returning it to 'uncertain' keeps
 * "stranded" and "listed by the ops surface" the same set, so the operator can
 * simply try again.
 *
 * Guarded on the exact state this function created, so it can never clobber a
 * concurrent resolution or a retry that did start.
 */
export async function revertRetryAuthorization(input: {
  client: ControlPlaneLike
  deliveryId: string
  note: string
}): Promise<boolean> {
  const now = nowIso()
  const result = await input.client.execute({
    sql: `
      UPDATE telegram_post_deliveries
      SET status = 'uncertain',
          last_error = ?2,
          resolution_action = NULL,
          resolved_at = NULL,
          resolved_by_user_id = NULL,
          resolution_reason = NULL,
          updated_at = ?3
      WHERE telegram_post_delivery_id = ?1
        AND status = 'pending'
        AND resolution_action = 'retry_authorized'
      RETURNING telegram_post_delivery_id
    `,
    args: [input.deliveryId, input.note.slice(0, 1000), now],
  })
  return result.rows.length > 0
}

// Returned by the retry path so the caller can enqueue exactly one job for the
// row it actually flipped. Kept separate from resolveUncertainDelivery so the
// control-plane write and the community-shard enqueue stay distinguishable.
export async function findDeliverySubject(input: {
  client: ControlPlaneLike
  deliveryId: string
}): Promise<{ communityId: string; postId: string }> {
  const result = await input.client.execute({
    sql: `
      SELECT community_id, post_id
      FROM telegram_post_deliveries
      WHERE telegram_post_delivery_id = ?1
      LIMIT 1
    `,
    args: [input.deliveryId],
  })
  const row = result.rows[0]
  if (!row) {
    throw notFoundError("Telegram delivery not found")
  }
  return {
    communityId: String(rowValue(row, "community_id") ?? ""),
    postId: String(rowValue(row, "post_id") ?? ""),
  }
}
