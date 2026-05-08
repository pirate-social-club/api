import { executeFirst, type DbExecutor } from "../db-helpers"
import { getGlobalHandleRow, getLinkedHandleRow, getProfileRow } from "../auth/auth-db-user-queries"

export type NotificationActorIdentity = {
  actorAvatarUrl?: string | null
  actorDisplayName?: string | null
  exposeActorUser?: boolean
}

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
  const primaryLinkedHandle = profile?.primary_linked_handle_id
    ? await getLinkedHandleRow(executor, userId, profile.primary_linked_handle_id).catch(() => null)
    : null
  const globalHandle = profile?.global_handle_id
    ? await getGlobalHandleRow(executor, profile.global_handle_id).catch(() => null)
    : null

  return {
    actor_display_name: primaryLinkedHandle?.label_display?.trim()
      || globalHandle?.label_display?.trim()
      || profile?.display_name?.trim()
      || null,
    actor_avatar_url: profile?.avatar_ref?.trim() || null,
  }
}

export function buildActorIdentityPayloadFromSnapshot(
  identity: NotificationActorIdentity,
): Record<string, unknown> {
  return {
    actor_display_name: identity.actorDisplayName?.trim() || null,
    actor_avatar_url: identity.actorAvatarUrl?.trim() || null,
  }
}
