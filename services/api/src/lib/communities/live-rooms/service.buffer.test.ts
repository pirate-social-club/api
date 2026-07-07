import { describe, expect, test } from "bun:test"
import { createLiveRoomInTransaction } from "./service"
import type { PreparedLiveRoomCreate } from "./create-input"
import type { DbExecutor } from "../../db-helpers"

/**
 * Buffer-safety regression for the live-room create path. createLiveRoomInTransaction
 * used to hydrate the room (getHydratedLiveRoom → SELECTs) inside the write tx, which
 * breaks under the D1 buffering tx (the read sees nothing until commit). It must now
 * issue ONLY writes and return a deterministic descriptor; callers hydrate AFTER
 * commit. This test fails if any read leaks back into the tx executor.
 */
function recordingExecutor() {
  const sqls: string[] = []
  const executor: DbExecutor = {
    execute: async (statement: Parameters<DbExecutor["execute"]>[0]) => {
      sqls.push(typeof statement === "string" ? statement : statement.sql)
      return { rows: [] }
    },
  }
  return { executor, sqls }
}

const PREPARED: PreparedLiveRoomCreate = {
  title: "Live",
  description: null,
  storeUrl: null,
  storeLabel: null,
  roomKind: "solo",
  accessMode: "free",
  visibility: "public",
  audienceGate: null,
  guestUserId: null,
  eventStartAt: null,
  coverRef: null,
  recordingEnabled: false,
  allocations: [{ userId: "usr_host", role: "host", shareBps: 10_000 }],
  setlist: { status: "draft", items: [] },
}

describe("createLiveRoomInTransaction (buffer-safe)", () => {
  test("issues only writes; returns descriptor with no in-tx room hydration", async () => {
    const { executor, sqls } = recordingExecutor()
    const result = await createLiveRoomInTransaction({
      tx: executor,
      userId: "usr_host",
      communityId: "cmt_lr",
      prepared: PREPARED,
    })

    // Deterministic descriptor (no DB-hydrated room).
    expect(result.liveRoomId).toMatch(/^lr_/)
    expect("room" in result).toBe(false)
    expect(result.anchorPost.post_type).toBe("video")

    // No read of any kind ran against the (buffered) tx executor.
    expect(sqls.some((s) => /^\s*select\b/i.test(s) || /pragma/i.test(s))).toBe(false)
    // The core writes happened.
    expect(sqls.some((s) => /insert\s+into\s+posts/i.test(s))).toBe(true)
    expect(sqls.some((s) => /insert\s+into\s+live_rooms/i.test(s) && /store_url/i.test(s) && /store_label/i.test(s) && /audience_gate_json/i.test(s))).toBe(true)
  })
})
