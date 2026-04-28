import { executeFirst, type DbExecutor } from "../db-helpers"
import { makeId } from "../helpers"
import type { NotificationEventType } from "../../types"

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
  if (input.dedupeKey?.trim()) {
    const existing = await executeFirst(input.executor, {
      sql: `
        SELECT event_id
        FROM notification_events
        WHERE dedupe_key = ?1
        LIMIT 1
      `,
      args: [input.dedupeKey],
    }) as Record<string, unknown> | null
    if (existing?.event_id) {
      return String(existing.event_id)
    }
  }

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
