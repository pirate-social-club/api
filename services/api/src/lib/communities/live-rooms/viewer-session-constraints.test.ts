import { describe, expect, test } from "bun:test"
import { isLiveRoomViewerUidCollision } from "./viewer-session-constraints"

function errorWithFields(message: string, fields: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), fields)
}

describe("isLiveRoomViewerUidCollision", () => {
  test("matches SQLite unique constraint failures for the viewer UID index columns", () => {
    const error = errorWithFields(
      "UNIQUE constraint failed: live_room_viewer_sessions.community_id, live_room_viewer_sessions.live_room_id, live_room_viewer_sessions.agora_uid",
      { code: "SQLITE_CONSTRAINT_UNIQUE" },
    )

    expect(isLiveRoomViewerUidCollision(error)).toBe(true)
  })

  test("matches drivers that expose the viewer UID index name", () => {
    const error = errorWithFields("duplicate key value violates unique constraint", {
      code: "23505",
      constraint: "idx_live_room_viewer_sessions_uid",
    })

    expect(isLiveRoomViewerUidCollision(error)).toBe(true)
  })

  test("rejects check constraint failures that mention the same table and UID column", () => {
    const error = errorWithFields(
      "CHECK constraint failed: live_room_viewer_sessions.agora_uid",
      { code: "SQLITE_CONSTRAINT_CHECK" },
    )

    expect(isLiveRoomViewerUidCollision(error)).toBe(false)
  })

  test("rejects unique failures for a different live-room viewer session constraint", () => {
    const error = errorWithFields(
      "UNIQUE constraint failed: live_room_viewer_sessions.community_id, live_room_viewer_sessions.live_room_id, live_room_viewer_sessions.viewer_user_id",
      { code: "SQLITE_CONSTRAINT_UNIQUE" },
    )

    expect(isLiveRoomViewerUidCollision(error)).toBe(false)
  })
})
