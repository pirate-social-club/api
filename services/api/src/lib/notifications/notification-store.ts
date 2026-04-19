import type { DbExecutor } from "../db-helpers"
import { executeFirst } from "../db-helpers"
import { makeId } from "../helpers"
import type {
  NotificationEventType,
  NotificationFeedItem,
  NotificationFeedResponse,
  NotificationSummary,
  NotificationTasksResponse,
  UserTask,
  UserTaskStatus,
  UserTaskType,
} from "../../types"

function rowToUserTask(row: Record<string, unknown>): UserTask {
  return {
    task_id: String(row.task_id),
    user_id: String(row.user_id),
    type: String(row.type) as UserTaskType,
    subject_type: String(row.subject_type),
    subject_id: String(row.subject_id),
    status: String(row.status) as UserTaskStatus,
    priority: Number(row.priority ?? 0),
    payload: row.payload_json ? JSON.parse(String(row.payload_json)) : null,
    resolved_at: row.resolved_at ? String(row.resolved_at) : null,
    dismissed_at: row.dismissed_at ? String(row.dismissed_at) : null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  }
}

export async function ensureNotificationTables(executor: DbExecutor): Promise<void> {
  await executor.execute(`
    CREATE TABLE IF NOT EXISTS user_tasks (
      task_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      subject_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      priority INTEGER NOT NULL DEFAULT 0,
      payload_json TEXT,
      resolved_at TEXT,
      dismissed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)

  await executor.execute(`
    CREATE INDEX IF NOT EXISTS idx_user_tasks_user_status
    ON user_tasks (user_id, status, updated_at DESC)
  `)

  await executor.execute(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_user_tasks_user_type_subject
    ON user_tasks (user_id, type, subject_id)
    WHERE status = 'open'
  `)

  await executor.execute(`
    CREATE TABLE IF NOT EXISTS notification_events (
      event_id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      actor_user_id TEXT,
      subject_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      object_type TEXT,
      object_id TEXT,
      payload_json TEXT,
      dedupe_key TEXT,
      created_at TEXT NOT NULL
    )
  `)

  await executor.execute(`
    CREATE INDEX IF NOT EXISTS idx_notification_events_created
    ON notification_events (created_at DESC)
  `)

  await executor.execute(`
    CREATE TABLE IF NOT EXISTS notification_receipts (
      event_id TEXT NOT NULL,
      recipient_user_id TEXT NOT NULL,
      seen_at TEXT,
      read_at TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (event_id, recipient_user_id)
    )
  `)

  await executor.execute(`
    CREATE INDEX IF NOT EXISTS idx_notification_receipts_recipient
    ON notification_receipts (recipient_user_id, read_at, created_at DESC)
  `)
}

export async function upsertUserTask(input: {
  executor: DbExecutor
  userId: string
  type: UserTaskType
  subjectType: string
  subjectId: string
  priority?: number
  payload?: Record<string, unknown> | null
  status?: UserTaskStatus
  createdAt: string
}): Promise<UserTask> {
  const taskId = makeId("tsk")
  const payloadJson = input.payload ? JSON.stringify(input.payload) : null
  const status = input.status ?? "open"
  const priority = input.priority ?? 0

  try {
    await input.executor.execute({
      sql: `
        INSERT INTO user_tasks (task_id, user_id, type, subject_type, subject_id, status, priority, payload_json, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
      `,
      args: [taskId, input.userId, input.type, input.subjectType, input.subjectId, status, priority, payloadJson, input.createdAt],
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes("UNIQUE") || message.includes("unique") || message.includes("duplicate")) {
      const existing = await executeFirst(input.executor, {
        sql: `SELECT * FROM user_tasks WHERE user_id = ?1 AND type = ?2 AND subject_id = ?3 AND status = 'open' LIMIT 1`,
        args: [input.userId, input.type, input.subjectId],
      }) as Record<string, unknown> | null
      if (existing) {
        return rowToUserTask(existing)
      }
    }
    throw error
  }

  return {
    task_id: taskId,
    user_id: input.userId,
    type: input.type,
    subject_type: input.subjectType,
    subject_id: input.subjectId,
    status,
    priority,
    payload: input.payload ?? null,
    resolved_at: null,
    dismissed_at: null,
    created_at: input.createdAt,
    updated_at: input.createdAt,
  }
}

export async function resolveUserTask(input: {
  executor: DbExecutor
  userId: string
  type: UserTaskType
  subjectId: string
  resolvedAt: string
}): Promise<void> {
  await input.executor.execute({
    sql: `
      UPDATE user_tasks
      SET status = 'completed', resolved_at = ?1, updated_at = ?1
      WHERE user_id = ?2 AND type = ?3 AND subject_id = ?4 AND status = 'open'
    `,
    args: [input.resolvedAt, input.userId, input.type, input.subjectId],
  })
}

export async function dismissUserTask(input: {
  executor: DbExecutor
  taskId: string
  userId: string
  dismissedAt: string
}): Promise<UserTask | null> {
  const result = await input.executor.execute({
    sql: `
      UPDATE user_tasks
      SET status = 'dismissed', dismissed_at = ?1, updated_at = ?1
      WHERE task_id = ?2 AND user_id = ?3 AND status = 'open'
    `,
    args: [input.dismissedAt, input.taskId, input.userId],
  })

  if (!result.rowsAffected || result.rowsAffected === 0) {
    return null
  }

  const row = await executeFirst(input.executor, {
    sql: `SELECT * FROM user_tasks WHERE task_id = ?1 AND user_id = ?2`,
    args: [input.taskId, input.userId],
  }) as Record<string, unknown> | null
  return row ? rowToUserTask(row) : null
}

export async function listOpenUserTasks(input: {
  executor: DbExecutor
  userId: string
}): Promise<NotificationTasksResponse> {
  const result = await input.executor.execute({
    sql: `
      SELECT * FROM user_tasks
      WHERE user_id = ?1 AND status = 'open'
      ORDER BY priority DESC, updated_at DESC
    `,
    args: [input.userId],
  })
  return { items: result.rows.map(rowToUserTask) }
}

export async function insertNotificationEvent(input: {
  executor: DbExecutor
  type: NotificationEventType
  actorUserId: string | null
  subjectType: string
  subjectId: string
  objectType?: string | null
  objectId?: string | null
  payload?: Record<string, unknown> | null
  dedupeKey?: string | null
  createdAt: string
}): Promise<string> {
  const eventId = makeId("nev")
  const payloadJson = input.payload ? JSON.stringify(input.payload) : null

  await input.executor.execute({
    sql: `
      INSERT INTO notification_events (event_id, type, actor_user_id, subject_type, subject_id, object_type, object_id, payload_json, dedupe_key, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
    `,
    args: [eventId, input.type, input.actorUserId, input.subjectType, input.subjectId, input.objectType ?? null, input.objectId ?? null, payloadJson, input.dedupeKey ?? null, input.createdAt],
  })

  return eventId
}

export async function insertNotificationReceipt(input: {
  executor: DbExecutor
  eventId: string
  recipientUserId: string
  createdAt: string
}): Promise<void> {
  await input.executor.execute({
    sql: `
      INSERT OR IGNORE INTO notification_receipts (event_id, recipient_user_id, created_at)
      VALUES (?1, ?2, ?3)
    `,
    args: [input.eventId, input.recipientUserId, input.createdAt],
  })
}

export async function getNotificationSummary(input: {
  executor: DbExecutor
  userId: string
}): Promise<NotificationSummary> {
  const taskRow = await executeFirst(input.executor, {
    sql: `SELECT COUNT(*) as cnt FROM user_tasks WHERE user_id = ?1 AND status = 'open'`,
    args: [input.userId],
  }) as Record<string, unknown> | null

  const receiptRow = await executeFirst(input.executor, {
    sql: `SELECT COUNT(*) as cnt FROM notification_receipts WHERE recipient_user_id = ?1 AND read_at IS NULL`,
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
}): Promise<NotificationFeedResponse> {
  const limit = Math.min(100, Math.max(1, input.limit ?? 25))

  let sql: string
  let args: unknown[]

  if (input.cursor) {
    sql = `
      SELECT
        e.event_id, e.type, e.actor_user_id, e.subject_type, e.subject_id,
        e.object_type, e.object_id, e.payload_json as event_payload, e.created_at as event_created_at,
        r.recipient_user_id, r.seen_at, r.read_at, r.created_at as receipt_created_at
      FROM notification_receipts r
      JOIN notification_events e ON e.event_id = r.event_id
      WHERE r.recipient_user_id = ?1 AND e.created_at < ?2
      ORDER BY e.created_at DESC
      LIMIT ?3
    `
    args = [input.userId, input.cursor, limit + 1]
  } else {
    sql = `
      SELECT
        e.event_id, e.type, e.actor_user_id, e.subject_type, e.subject_id,
        e.object_type, e.object_id, e.payload_json as event_payload, e.created_at as event_created_at,
        r.recipient_user_id, r.seen_at, r.read_at, r.created_at as receipt_created_at
      FROM notification_receipts r
      JOIN notification_events e ON e.event_id = r.event_id
      WHERE r.recipient_user_id = ?1
      ORDER BY e.created_at DESC
      LIMIT ?2
    `
    args = [input.userId, limit + 1]
  }

  const result = await input.executor.execute({ sql, args })
  const rows = result.rows

  const hasMore = rows.length > limit
  const items = (hasMore ? rows.slice(0, limit) : rows).map((row) => ({
    event: {
      event_id: String(row.event_id),
      type: String(row.type) as NotificationEventType,
      actor_user_id: row.actor_user_id ? String(row.actor_user_id) : null,
      subject_type: String(row.subject_type),
      subject_id: String(row.subject_id),
      object_type: row.object_type ? String(row.object_type) : null,
      object_id: row.object_id ? String(row.object_id) : null,
      payload: row.event_payload ? JSON.parse(String(row.event_payload)) : null,
      created_at: String(row.event_created_at),
    },
    receipt: {
      event_id: String(row.event_id),
      recipient_user_id: String(row.recipient_user_id),
      seen_at: row.seen_at ? String(row.seen_at) : null,
      read_at: row.read_at ? String(row.read_at) : null,
      created_at: String(row.receipt_created_at),
    },
  } satisfies NotificationFeedItem))

  const nextCursor = hasMore && items.length > 0 ? items[items.length - 1].event.created_at : null

  return { items, next_cursor: nextCursor }
}

export async function markNotificationsRead(input: {
  executor: DbExecutor
  userId: string
  eventIds: string[]
  readAt: string
}): Promise<void> {
  if (input.eventIds.length === 0) return

  const placeholders = input.eventIds.map((_, i) => `?${i + 3}`).join(",")
  await input.executor.execute({
    sql: `
      UPDATE notification_receipts
      SET read_at = ?1, seen_at = COALESCE(seen_at, ?1)
      WHERE recipient_user_id = ?2 AND event_id IN (${placeholders}) AND read_at IS NULL
    `,
    args: [input.readAt, input.userId, ...input.eventIds],
  })
}

export async function markAllNotificationsRead(input: {
  executor: DbExecutor
  userId: string
  readAt: string
}): Promise<void> {
  await input.executor.execute({
    sql: `
      UPDATE notification_receipts
      SET read_at = ?1, seen_at = COALESCE(seen_at, ?1)
      WHERE recipient_user_id = ?2 AND read_at IS NULL
    `,
    args: [input.readAt, input.userId],
  })
}
