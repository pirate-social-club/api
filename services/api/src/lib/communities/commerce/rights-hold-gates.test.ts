import { describe, expect, test } from "bun:test"
import type { InStatement, QueryResult } from "../../sql-client"
import { HttpError } from "../../errors"
import {
  assertAssetNotBlockedByRightsHold,
  assertAssetNotRightsHeld,
  assertListingNotRightsHeld,
} from "./rights-hold-gates"

function holdRow(overrides: Record<string, unknown> = {}) {
  return {
    rights_hold_id: "rhold_1",
    subject_type: "asset",
    subject_id: "asset_1",
    community_id: "cmt_1",
    hold_type: "reference_required",
    source_case_id: "rrc_1",
    analysis_result_ref: "mar_1",
    status: "active",
    reason_code: "undeclared_catalog_match",
    reason: "Reference required",
    created_at: "2026-07-09T00:00:00.000Z",
    updated_at: "2026-07-09T00:00:00.000Z",
    released_at: null,
    ...overrides,
  }
}

function executorWithHolds(holds: Array<Record<string, unknown>>) {
  return {
    async execute(statement: InStatement | string): Promise<QueryResult> {
      if (typeof statement === "string") return { rows: [] }
      const [, subjectType, subjectId] = statement.args ?? []
      return {
        rows: holds.filter((hold) => (
          hold.subject_type === subjectType
          && hold.subject_id === subjectId
          && hold.status === "active"
        )),
      }
    },
  }
}

describe("rights hold commerce gates", () => {
  test("blocks assets held directly", async () => {
    await expect(assertAssetNotRightsHeld({
      client: executorWithHolds([holdRow({ subject_type: "asset", subject_id: "asset_1" })]),
      communityId: "cmt_1",
      asset: { asset_id: "asset_1", source_post_id: "post_1" },
    })).rejects.toMatchObject({
      status: 403,
      code: "eligibility_failed",
    })
  })

  test("blocks assets whose source post is held", async () => {
    await expect(assertAssetNotRightsHeld({
      client: executorWithHolds([holdRow({ subject_type: "post", subject_id: "post_1" })]),
      communityId: "cmt_1",
      asset: { asset_id: "asset_1", source_post_id: "post_1" },
    })).rejects.toBeInstanceOf(HttpError)
  })

  test("uses not-found behavior for public listing checks", async () => {
    await expect(assertListingNotRightsHeld({
      client: executorWithHolds([holdRow({ subject_type: "asset", subject_id: "asset_1" })]),
      communityId: "cmt_1",
      listing: { asset_id: "asset_1", replay_asset_id: null, live_room_id: null },
      mode: "public",
    })).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    })
  })

  test("allows unheld listings", async () => {
    await expect(assertListingNotRightsHeld({
      client: executorWithHolds([]),
      communityId: "cmt_1",
      listing: { asset_id: "asset_1", replay_asset_id: null, live_room_id: null },
    })).resolves.toBeUndefined()
  })

  test("blocks Story delivery only for terminal blocked holds", async () => {
    await expect(assertAssetNotBlockedByRightsHold({
      client: executorWithHolds([holdRow({ subject_type: "asset", subject_id: "asset_1", hold_type: "reference_required" })]),
      communityId: "cmt_1",
      asset: { asset_id: "asset_1", source_post_id: "post_1" },
    })).resolves.toBeUndefined()

    await expect(assertAssetNotBlockedByRightsHold({
      client: executorWithHolds([holdRow({ subject_type: "asset", subject_id: "asset_1", hold_type: "blocked" })]),
      communityId: "cmt_1",
      asset: { asset_id: "asset_1", source_post_id: "post_1" },
    })).rejects.toMatchObject({
      status: 403,
      code: "eligibility_failed",
    })
  })

  test("released holds do not block resumption", async () => {
    await expect(assertListingNotRightsHeld({
      client: executorWithHolds([
        holdRow({ subject_type: "asset", subject_id: "asset_1", status: "released", released_at: "2026-07-09T00:01:00.000Z" }),
      ]),
      communityId: "cmt_1",
      listing: { asset_id: "asset_1", replay_asset_id: null, live_room_id: null },
    })).resolves.toBeUndefined()
  })
})
