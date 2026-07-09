import { afterEach, describe, expect, test } from "bun:test"
import { createClient } from "@libsql/client"
import {
  getActiveRightsHoldForSubject,
  releaseActiveRightsHoldsForSubject,
  upsertActiveRightsHold,
} from "./rights-hold-store"

const clients: Array<ReturnType<typeof createClient>> = []

async function createTestClient() {
  const client = createClient({ url: ":memory:" })
  clients.push(client)
  await client.execute(`
    CREATE TABLE rights_holds (
      rights_hold_id TEXT PRIMARY KEY,
      subject_type TEXT NOT NULL CHECK (
        subject_type IN ('asset', 'post', 'live_room', 'replay_asset')
      ),
      subject_id TEXT NOT NULL,
      community_id TEXT NOT NULL,
      hold_type TEXT NOT NULL CHECK (
        hold_type IN ('reference_required', 'review_hold', 'blocked')
      ),
      source_case_id TEXT,
      analysis_result_ref TEXT,
      status TEXT NOT NULL CHECK (status IN ('active', 'released')),
      reason_code TEXT,
      reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      released_at TEXT
    )
  `)
  await client.execute(`
    CREATE UNIQUE INDEX idx_rights_holds_active_subject
      ON rights_holds(subject_type, subject_id)
      WHERE status = 'active'
  `)
  return client
}

afterEach(() => {
  for (const client of clients.splice(0)) {
    client.close()
  }
})

describe("rights hold store", () => {
  test("does not downgrade an active blocked hold", async () => {
    const client = await createTestClient()
    await upsertActiveRightsHold({
      executor: client,
      communityId: "cmt_1",
      subjectType: "asset",
      subjectId: "ast_1",
      holdType: "blocked",
      now: "2026-07-09T00:00:00.000Z",
    })
    await upsertActiveRightsHold({
      executor: client,
      communityId: "cmt_1",
      subjectType: "asset",
      subjectId: "ast_1",
      holdType: "reference_required",
      now: "2026-07-09T00:01:00.000Z",
    })

    const hold = await getActiveRightsHoldForSubject({
      executor: client,
      communityId: "cmt_1",
      subjectType: "asset",
      subjectId: "ast_1",
    })
    expect(hold?.hold_type).toBe("blocked")
  })

  test("clear release skips blocked holds", async () => {
    const client = await createTestClient()
    await upsertActiveRightsHold({
      executor: client,
      communityId: "cmt_1",
      subjectType: "asset",
      subjectId: "ast_1",
      holdType: "blocked",
      now: "2026-07-09T00:00:00.000Z",
    })
    await releaseActiveRightsHoldsForSubject({
      executor: client,
      communityId: "cmt_1",
      subjectType: "asset",
      subjectId: "ast_1",
      now: "2026-07-09T00:02:00.000Z",
    })

    const hold = await getActiveRightsHoldForSubject({
      executor: client,
      communityId: "cmt_1",
      subjectType: "asset",
      subjectId: "ast_1",
    })
    expect(hold?.hold_type).toBe("blocked")
    expect(hold?.status).toBe("active")
  })
})
