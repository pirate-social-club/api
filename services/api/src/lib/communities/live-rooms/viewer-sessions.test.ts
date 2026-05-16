import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createClient, type Client as LibsqlClient } from "@libsql/client"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { Client } from "../../sql-client"
import {
  deleteLiveRoomViewerSessions,
  pruneStaleLiveRoomViewerSessions,
} from "./viewer-sessions"

let tempDir: string | null = null
let client: LibsqlClient | null = null

function db(): Client {
  if (!client) {
    throw new Error("test db is not initialized")
  }
  return client as unknown as Client
}

async function createSchema(): Promise<void> {
  await db().execute({
    sql: `
      CREATE TABLE live_room_viewer_sessions (
        community_id TEXT NOT NULL,
        live_room_id TEXT NOT NULL,
        viewer_user_id TEXT NOT NULL,
        agora_uid INTEGER NOT NULL CHECK (agora_uid >= 0 AND agora_uid <= 4294967295),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (community_id, live_room_id, viewer_user_id)
      )
    `,
    args: [],
  })
  await db().execute({
    sql: `
      CREATE UNIQUE INDEX idx_live_room_viewer_sessions_uid
        ON live_room_viewer_sessions(community_id, live_room_id, agora_uid)
    `,
    args: [],
  })
}

async function insertSession(input: {
  room: string
  user: string
  uid: number
  updatedAt: string
}): Promise<void> {
  await db().execute({
    sql: `
      INSERT INTO live_room_viewer_sessions (
        community_id, live_room_id, viewer_user_id, agora_uid, created_at, updated_at
      ) VALUES (
        'cmt_test', ?1, ?2, ?3, ?4, ?4
      )
    `,
    args: [input.room, input.user, input.uid, input.updatedAt],
  })
}

async function countSessions(room?: string): Promise<number> {
  const result = await db().execute({
    sql: `
      SELECT COUNT(*) AS count
      FROM live_room_viewer_sessions
      WHERE ?1 IS NULL OR live_room_id = ?1
    `,
    args: [room ?? null],
  })
  return Number(result.rows[0]?.count ?? 0)
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pirate-viewer-sessions-"))
  client = createClient({ url: `file:${join(tempDir, "test.db")}` })
  await createSchema()
})

afterEach(async () => {
  client?.close()
  client = null
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
    tempDir = null
  }
})

describe("live-room viewer sessions", () => {
  test("deletes all viewer sessions for a terminal room", async () => {
    await insertSession({ room: "lr_done", user: "usr_a", uid: 1, updatedAt: "2026-01-01T00:00:00.000Z" })
    await insertSession({ room: "lr_done", user: "usr_b", uid: 2, updatedAt: "2026-01-01T00:01:00.000Z" })
    await insertSession({ room: "lr_other", user: "usr_c", uid: 1, updatedAt: "2026-01-01T00:02:00.000Z" })

    await expect(deleteLiveRoomViewerSessions(db(), {
      communityId: "cmt_test",
      liveRoomId: "lr_done",
    })).resolves.toBe(2)
    await expect(countSessions("lr_done")).resolves.toBe(0)
    await expect(countSessions("lr_other")).resolves.toBe(1)
  })

  test("prunes stale viewer sessions by updated_at with a bounded batch", async () => {
    await insertSession({ room: "lr_old_a", user: "usr_a", uid: 1, updatedAt: "2026-01-01T00:00:00.000Z" })
    await insertSession({ room: "lr_old_b", user: "usr_b", uid: 1, updatedAt: "2026-01-02T00:00:00.000Z" })
    await insertSession({ room: "lr_new", user: "usr_c", uid: 1, updatedAt: "2026-02-01T00:00:00.000Z" })

    await expect(pruneStaleLiveRoomViewerSessions(db(), {
      communityId: "cmt_test",
      olderThanIso: "2026-01-15T00:00:00.000Z",
      limit: 1,
    })).resolves.toBe(1)
    await expect(countSessions()).resolves.toBe(2)

    await expect(pruneStaleLiveRoomViewerSessions(db(), {
      communityId: "cmt_test",
      olderThanIso: "2026-01-15T00:00:00.000Z",
      limit: 100,
    })).resolves.toBe(1)
    await expect(countSessions()).resolves.toBe(1)
    await expect(countSessions("lr_new")).resolves.toBe(1)
  })
})
