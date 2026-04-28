import { executeFirst, type DbExecutor } from "../db-helpers"
import { getProfileRow } from "../auth/auth-db-user-queries"

export async function hasNotificationEventDedupeKey(executor: DbExecutor, dedupeKey: string): Promise<boolean> {
  const row = await executeFirst(executor, {
    sql: `
      SELECT event_id
      FROM notification_events
      WHERE dedupe_key = ?1
      LIMIT 1
    `,
    args: [dedupeKey],
  }) as Record<string, unknown> | null
  return Boolean(row)
}

export async function buildActorIdentityPayload(executor: DbExecutor, userId: string): Promise<Record<string, unknown>> {
  const profile = await getProfileRow(executor, userId).catch(() => null)
  return {
    actor_display_name: profile?.display_name?.trim() || null,
    actor_avatar_url: profile?.avatar_ref?.trim() || null,
  }
}
