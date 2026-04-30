import type { DbExecutor } from "../db-helpers"
import { executeFirst } from "../db-helpers"
import type {
  NotificationEventType,
  NotificationFeedItem,
  NotificationFeedResponse,
  NotificationSummary,
} from "../../types"
import { nullableUnixSeconds, unixSeconds } from "../../serializers/time"

export async function getNotificationSummary(input: {
  executor: DbExecutor
  userId: string
}): Promise<NotificationSummary> {
  const taskRow = await executeFirst(input.executor, {
    sql: `SELECT COUNT(*) as cnt FROM user_tasks WHERE user_id = ?1 AND status = 'open'`,
    args: [input.userId],
  }) as Record<string, unknown> | null

  const receiptRow = await executeFirst(input.executor, {
    sql: `
      SELECT COUNT(*) as cnt
      FROM notification_receipts r
      JOIN notification_events e ON e.event_id = r.event_id
      WHERE r.recipient_user_id = ?1 AND r.read_at IS NULL AND e.type <> 'xmtp_message'
    `,
    args: [input.userId],
  }) as Record<string, unknown> | null

  const openTaskCount = Number(taskRow?.cnt ?? 0)
  const unreadActivityCount = Number(receiptRow?.cnt ?? 0)

  return {
    open_task_count: openTaskCount,
    unread_activity_count: unreadActivityCount,
    has_unread: openTaskCount > 0 || unreadActivityCount > 0,
  }
}

export async function listNotificationFeed(input: {
  executor: DbExecutor
  userId: string
  cursor?: string | null
  limit?: number
  type?: NotificationEventType
}): Promise<NotificationFeedResponse> {
  const limit = Math.min(100, Math.max(1, input.limit ?? 25))

  let sql: string
  let args: unknown[]
  if (input.cursor) {
    const typeFilter = input.type ? " AND e.type = ?3" : ""
    sql = `
      SELECT
        e.event_id, e.type, e.actor_user_id, e.subject_type, e.subject_id,
        e.object_type, e.object_id, e.payload_json as event_payload, e.created_at as event_created_at,
        r.recipient_user_id, r.seen_at, r.read_at, r.created_at as receipt_created_at
      FROM notification_receipts r
      JOIN notification_events e ON e.event_id = r.event_id
      WHERE r.recipient_user_id = ?1 AND e.created_at < ?2${typeFilter}
      ORDER BY e.created_at DESC
      LIMIT ?${input.type ? 4 : 3}
    `
    args = input.type
      ? [input.userId, input.cursor, input.type, limit + 1]
      : [input.userId, input.cursor, limit + 1]
  } else {
    const typeFilter = input.type ? " AND e.type = ?2" : ""
    sql = `
      SELECT
        e.event_id, e.type, e.actor_user_id, e.subject_type, e.subject_id,
        e.object_type, e.object_id, e.payload_json as event_payload, e.created_at as event_created_at,
        r.recipient_user_id, r.seen_at, r.read_at, r.created_at as receipt_created_at
      FROM notification_receipts r
      JOIN notification_events e ON e.event_id = r.event_id
      WHERE r.recipient_user_id = ?1${typeFilter}
      ORDER BY e.created_at DESC
      LIMIT ?${input.type ? 3 : 2}
    `
    args = input.type
      ? [input.userId, input.type, limit + 1]
      : [input.userId, limit + 1]
  }

  const result = await input.executor.execute({ sql, args })
  const rows = result.rows

  const hasMore = rows.length > limit
  const items = (hasMore ? rows.slice(0, limit) : rows).map((row) => ({
    event: {
      id: `ne_${String(row.event_id)}`,
      object: "notification_event",
      type: String(row.type) as NotificationEventType,
      actor_user: row.actor_user_id ? `usr_${String(row.actor_user_id)}` : null,
      subject_type: String(row.subject_type),
      subject: String(row.subject_id),
      object_type: row.object_type ? String(row.object_type) : null,
      payload: row.event_payload ? JSON.parse(String(row.event_payload)) : null,
      created: unixSeconds(String(row.event_created_at)),
    },
    receipt: {
      id: `nr_${String(row.event_id)}`,
      object: "notification_receipt",
      recipient_user: `usr_${String(row.recipient_user_id)}`,
      seen_at: nullableUnixSeconds(row.seen_at ? String(row.seen_at) : null),
      read_at: nullableUnixSeconds(row.read_at ? String(row.read_at) : null),
      created: unixSeconds(String(row.receipt_created_at)),
    },
  } satisfies NotificationFeedItem))

  const nextCursor = hasMore && rows.length > 0 ? String(rows[Math.min(limit, rows.length) - 1].event_created_at) : null

  return { items, next_cursor: nextCursor }
}

export async function markNotificationsRead(input: {
  executor: DbExecutor
  userId: string
  eventIds: string[]
  readAt: string
}): Promise<Record<string, number>> {
  const countsByType: Record<string, number> = {}
  if (input.eventIds.length === 0) return countsByType

  const selectPlaceholders = input.eventIds.map((_, i) => `?${i + 2}`).join(",")
  const rows = await input.executor.execute({
    sql: `
      SELECT e.type AS notification_type, COUNT(*) AS cnt
      FROM notification_receipts r
      JOIN notification_events e ON e.event_id = r.event_id
      WHERE r.recipient_user_id = ?1
        AND r.event_id IN (${selectPlaceholders})
        AND r.read_at IS NULL
      GROUP BY e.type
    `,
    args: [input.userId, ...input.eventIds],
  })
  for (const row of rows.rows) {
    countsByType[String(row.notification_type)] = Number(row.cnt ?? 0)
  }
  if (Object.keys(countsByType).length === 0) {
    return countsByType
  }

  const updatePlaceholders = input.eventIds.map((_, i) => `?${i + 3}`).join(",")
  await input.executor.execute({
    sql: `
      UPDATE notification_receipts
      SET read_at = ?1, seen_at = COALESCE(seen_at, ?1)
      WHERE recipient_user_id = ?2 AND event_id IN (${updatePlaceholders}) AND read_at IS NULL
    `,
    args: [input.readAt, input.userId, ...input.eventIds],
  })
  return countsByType
}

export async function markAllNotificationsRead(input: {
  executor: DbExecutor
  userId: string
  readAt: string
}): Promise<Record<string, number>> {
  const countsByType: Record<string, number> = {}
  const rows = await input.executor.execute({
    sql: `
      SELECT e.type AS notification_type, COUNT(*) AS cnt
      FROM notification_receipts r
      JOIN notification_events e ON e.event_id = r.event_id
      WHERE r.recipient_user_id = ?1 AND r.read_at IS NULL
      GROUP BY e.type
    `,
    args: [input.userId],
  })
  for (const row of rows.rows) {
    countsByType[String(row.notification_type)] = Number(row.cnt ?? 0)
  }
  if (Object.keys(countsByType).length === 0) {
    return countsByType
  }

  await input.executor.execute({
    sql: `
      UPDATE notification_receipts
      SET read_at = ?1, seen_at = COALESCE(seen_at, ?1)
      WHERE recipient_user_id = ?2 AND read_at IS NULL
    `,
    args: [input.readAt, input.userId],
  })
  return countsByType
}
