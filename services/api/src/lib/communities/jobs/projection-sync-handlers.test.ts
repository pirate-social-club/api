import { describe, expect, test } from "bun:test"

import { shouldProjectPostForAnchorRoomRow } from "./projection-sync-handlers"

describe("shouldProjectPostForAnchorRoomRow", () => {
  test("allows regular and public-live posts but rejects unlisted live anchors", () => {
    expect(shouldProjectPostForAnchorRoomRow(null)).toBe(true)
    expect(shouldProjectPostForAnchorRoomRow({ visibility: "public" })).toBe(true)
    expect(shouldProjectPostForAnchorRoomRow({ visibility: "unlisted" })).toBe(false)
    expect(shouldProjectPostForAnchorRoomRow({ visibility: null })).toBe(false)
  })
})
