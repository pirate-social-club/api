import type { Client, QueryResultRow } from "../../sql-client"
import { executeFirst } from "../../db-helpers"
import { badRequestError, notFoundError } from "../../errors"
import { nowIso } from "../../helpers"
import { numberOrNull, rowValue } from "../../sql-row"
import { isLiveRoomViewerUidCollision } from "./viewer-session-constraints"

type LiveRoomViewerSessionExecutor = Pick<Client, "execute">

export function normalizeLiveRoomViewerUid(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw badRequestError("uid must be a 32-bit unsigned integer")
  }
  return value
}

export async function recordLiveRoomViewerSession(client: LiveRoomViewerSessionExecutor, input: {
  communityId: string
  liveRoomId: string
  userId: string
  uid: number
}): Promise<boolean> {
  const now = nowIso()
  try {
    await client.execute({
      sql: `
        INSERT INTO live_room_viewer_sessions (
          community_id, live_room_id, viewer_user_id, agora_uid, created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?5
        )
        ON CONFLICT(community_id, live_room_id, viewer_user_id) DO UPDATE SET
          agora_uid = excluded.agora_uid,
          updated_at = excluded.updated_at
      `,
      args: [input.communityId, input.liveRoomId, input.userId, input.uid, now],
    })
    return true
  } catch (error) {
    if (isLiveRoomViewerUidCollision(error)) {
      return false
    }
    throw error
  }
}

export async function assertLiveRoomViewerSessionUid(client: LiveRoomViewerSessionExecutor, input: {
  communityId: string
  liveRoomId: string
  userId: string
  uid: number
}): Promise<void> {
  const row = await executeFirst(client, {
    sql: `
      SELECT agora_uid
      FROM live_room_viewer_sessions
      WHERE community_id = ?1
        AND live_room_id = ?2
        AND viewer_user_id = ?3
      LIMIT 1
    `,
    args: [input.communityId, input.liveRoomId, input.userId],
  }) as QueryResultRow | null
  if (numberOrNull(rowValue(row, "agora_uid")) !== input.uid) {
    throw notFoundError("Live room viewer session not found")
  }
  await client.execute({
    sql: `
      UPDATE live_room_viewer_sessions
      SET updated_at = ?4
      WHERE community_id = ?1
        AND live_room_id = ?2
        AND viewer_user_id = ?3
    `,
    args: [input.communityId, input.liveRoomId, input.userId, nowIso()],
  })
}

export async function assertPublicLiveRoomViewerSessionUid(client: LiveRoomViewerSessionExecutor, input: {
  communityId: string
  liveRoomId: string
  uid: number
}): Promise<void> {
  const row = await executeFirst(client, {
    sql: `
      SELECT viewer_user_id
      FROM live_room_viewer_sessions
      WHERE community_id = ?1
        AND live_room_id = ?2
        AND agora_uid = ?3
      LIMIT 1
    `,
    args: [input.communityId, input.liveRoomId, input.uid],
  }) as QueryResultRow | null
  const viewerUserId = rowValue(row, "viewer_user_id")
  if (typeof viewerUserId !== "string" || !viewerUserId) {
    throw notFoundError("Live room viewer session not found")
  }
  await client.execute({
    sql: `
      UPDATE live_room_viewer_sessions
      SET updated_at = ?4
      WHERE community_id = ?1
        AND live_room_id = ?2
        AND agora_uid = ?3
    `,
    args: [input.communityId, input.liveRoomId, input.uid, nowIso()],
  })
}

export async function deleteLiveRoomViewerSessions(client: LiveRoomViewerSessionExecutor, input: {
  communityId: string
  liveRoomId: string
}): Promise<number> {
  const result = await client.execute({
    sql: `
      DELETE FROM live_room_viewer_sessions
      WHERE community_id = ?1
        AND live_room_id = ?2
    `,
    args: [input.communityId, input.liveRoomId],
  })
  return Number(result.rowsAffected ?? 0)
}

export async function pruneStaleLiveRoomViewerSessions(client: LiveRoomViewerSessionExecutor, input: {
  communityId: string
  olderThanIso: string
  limit?: number | null
}): Promise<number> {
  const requestedLimit = Number(input.limit ?? 1000)
  const limit = Number.isInteger(requestedLimit)
    ? Math.max(1, Math.min(requestedLimit, 10_000))
    : 1000
  const result = await client.execute({
    sql: `
      DELETE FROM live_room_viewer_sessions
      WHERE rowid IN (
        SELECT rowid
        FROM live_room_viewer_sessions
        WHERE community_id = ?1
          AND updated_at < ?2
        ORDER BY updated_at ASC, live_room_id ASC, viewer_user_id ASC
        LIMIT ?3
      )
    `,
    args: [input.communityId, input.olderThanIso, limit],
  })
  return Number(result.rowsAffected ?? 0)
}
