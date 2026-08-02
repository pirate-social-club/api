import { describe, expect, test } from "bun:test"
import { toCommunityRow } from "./auth-db-community-rows"

function communityRow(createdAt: unknown, updatedAt: unknown): Record<string, unknown> {
  return {
    community_id: "cmt_timestamp",
    creator_user_id: "usr_owner",
    display_name: "Timestamp",
    description: null,
    avatar_ref: null,
    banner_ref: null,
    status: "active",
    provisioning_state: "provisioning",
    transfer_state: "none",
    route_slug: "timestamp",
    namespace_verification_id: "nsv_timestamp",
    pending_namespace_verification_session_id: null,
    follower_count: 0,
    created_at: createdAt,
    updated_at: updatedAt,
  }
}

describe("toCommunityRow timestamps", () => {
  test("canonicalizes pg TIMESTAMPTZ Date values without JSON quote corruption", () => {
    const iso = "2026-08-02T12:00:00.000Z"
    const row = toCommunityRow(communityRow(new Date(iso), new Date(iso)))

    expect(row.created_at).toBe(iso)
    expect(row.updated_at).toBe(iso)
  })

  test("canonicalizes offset-bearing strings and rejects timezone-less values", () => {
    const row = toCommunityRow(communityRow(
      "2026-08-02 16:00:00+04",
      "2026-08-02T16:00:01+04:00",
    ))
    expect(row.created_at).toBe("2026-08-02T12:00:00.000Z")
    expect(row.updated_at).toBe("2026-08-02T12:00:01.000Z")

    expect(() => toCommunityRow(communityRow(
      "2026-08-02 12:00:00",
      "2026-08-02T12:00:00.000Z",
    ))).toThrow(/timezone-less timestamp/)
  })
})
