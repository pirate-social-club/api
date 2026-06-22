import { describe, expect, test } from "bun:test"
import { isCommunityLive, requireLiveCommunity } from "./community-status"
import type { CommunityRow } from "../auth/auth-db-rows"

function makeCommunity(overrides: Partial<CommunityRow> = {}): CommunityRow {
  return {
    community_id: "cmt_x",
    creator_user_id: "usr_owner",
    display_name: "X",
    description: null,
    avatar_ref: null,
    banner_ref: null,
    status: "active",
    provisioning_state: "active",
    transfer_state: "none",
    route_slug: null,
    namespace_verification_id: null,
    pending_namespace_verification_session_id: null,
    primary_database_binding_id: null,
    follower_count: 0,
    created_at: "2026-06-22T00:00:00.000Z",
    updated_at: "2026-06-22T00:00:00.000Z",
    ...overrides,
  }
}

function repoReturning(community: CommunityRow | null) {
  return { getCommunityById: async () => community }
}

describe("requireLiveCommunity", () => {
  test("returns the row for a live community", async () => {
    const community = makeCommunity()
    const result = await requireLiveCommunity(repoReturning(community), "cmt_x")
    expect(result).toBe(community)
  })

  test("throws for an archived community", async () => {
    await expect(
      requireLiveCommunity(repoReturning(makeCommunity({ status: "archived" })), "cmt_x"),
    ).rejects.toThrow()
  })

  test("throws for a community that is provisioning but not active", async () => {
    await expect(
      requireLiveCommunity(repoReturning(makeCommunity({ provisioning_state: "provisioning" })), "cmt_x"),
    ).rejects.toThrow()
  })

  test("throws when the community is missing", async () => {
    await expect(requireLiveCommunity(repoReturning(null), "cmt_x")).rejects.toThrow()
  })

  test("isCommunityLive is false for archived", () => {
    expect(isCommunityLive(makeCommunity({ status: "archived" }))).toBe(false)
    expect(isCommunityLive(makeCommunity())).toBe(true)
  })
})
