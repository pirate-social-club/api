import { describe, expect, test } from "bun:test"
import type { CommunityMembershipProjectionRow, CommunityRow } from "../auth/auth-db-rows"
import { filterCommunitiesWithPosts, resolveHomeFeedCommunityIds, sortCommunitySummaries } from "./home-feed-service"
import type { CommunityAggregate } from "./home-feed-service"
import type { HomeFeedCommunitySummary } from "../../types"

function createCommunityRow(input: {
  communityId: string
  creatorUserId: string
}): CommunityRow {
  return {
    community_id: input.communityId,
    creator_user_id: input.creatorUserId,
    display_name: input.communityId,
    status: "active",
    provisioning_state: "active",
    transfer_state: "none",
    route_slug: input.communityId,
    namespace_verification_id: null,
    pending_namespace_verification_session_id: null,
    primary_database_binding_id: null,
    created_at: "2026-04-18T00:00:00.000Z",
    updated_at: "2026-04-18T00:00:00.000Z",
  }
}

function createMembershipRow(input: {
  communityId: string
  userId: string
  membershipState: CommunityMembershipProjectionRow["membership_state"]
}): CommunityMembershipProjectionRow {
  return {
    projection_id: `cmp_${input.communityId}_${input.userId}`,
    community_id: input.communityId,
    user_id: input.userId,
    membership_state: input.membershipState,
    role_summary_json: null,
    source_updated_at: "2026-04-18T00:00:00.000Z",
    created_at: "2026-04-18T00:00:00.000Z",
    updated_at: "2026-04-18T00:00:00.000Z",
  }
}

describe("resolveHomeFeedCommunityIds", () => {
  test("returns member communities for an established signed-in user", () => {
    const communityIds = resolveHomeFeedCommunityIds({
      activeCommunities: [
        createCommunityRow({ communityId: "cmt_alpha", creatorUserId: "usr_owner" }),
        createCommunityRow({ communityId: "cmt_beta", creatorUserId: "usr_owner" }),
      ],
      membershipRows: [
        createMembershipRow({
          communityId: "cmt_beta",
          userId: "usr_viewer",
          membershipState: "member",
        }),
      ],
      userId: "usr_viewer",
    })

    expect(communityIds).toEqual(["cmt_beta"])
  })

  test("falls back to active communities for a fresh signed-in user", () => {
    const communityIds = resolveHomeFeedCommunityIds({
      activeCommunities: [
        createCommunityRow({ communityId: "cmt_alpha", creatorUserId: "usr_owner" }),
        createCommunityRow({ communityId: "cmt_beta", creatorUserId: "usr_owner" }),
      ],
      membershipRows: [],
      userId: "usr_fresh",
    })

    expect(communityIds).toEqual(["cmt_alpha", "cmt_beta"])
  })

  test("returns all active communities for an anonymous viewer", () => {
    const communityIds = resolveHomeFeedCommunityIds({
      activeCommunities: [
        createCommunityRow({ communityId: "cmt_alpha", creatorUserId: "usr_owner" }),
        createCommunityRow({ communityId: "cmt_beta", creatorUserId: "usr_owner" }),
      ],
      membershipRows: [],
      userId: null,
    })

    expect(communityIds).toEqual(["cmt_alpha", "cmt_beta"])
  })
})

function createCommunitySummary(input: {
  communityId: string
  displayName?: string
  updatedAt?: string
}): HomeFeedCommunitySummary {
  return {
    community_id: input.communityId,
    display_name: input.displayName ?? input.communityId,
    route_slug: input.communityId,
    avatar_ref: null,
    member_count: null,
    updated_at: input.updatedAt ?? "2026-04-18T00:00:00.000Z",
  }
}

describe("filterCommunitiesWithPosts", () => {
  test("excludes communities with no eligible posts when a time range is active", () => {
    const alpha = createCommunitySummary({ communityId: "cmt_alpha" })
    const beta = createCommunitySummary({ communityId: "cmt_beta" })
    const gamma = createCommunitySummary({ communityId: "cmt_gamma" })
    const aggregates = new Map<string, CommunityAggregate>([
      ["cmt_alpha", { totalScore: 5, bestRank: 2, latestPostMs: 1000 }],
      ["cmt_gamma", { totalScore: 3, bestRank: 1, latestPostMs: 500 }],
    ])

    const result = filterCommunitiesWithPosts([alpha, beta, gamma], aggregates, true)

    expect(result.map((summary) => summary.community_id)).toEqual(["cmt_alpha", "cmt_gamma"])
  })

  test("keeps communities without projection rows when no time range is active", () => {
    const alpha = createCommunitySummary({ communityId: "cmt_alpha" })
    const beta = createCommunitySummary({ communityId: "cmt_beta" })
    const aggregates = new Map<string, CommunityAggregate>([
      ["cmt_alpha", { totalScore: 5, bestRank: 2, latestPostMs: 1000 }],
    ])

    const result = filterCommunitiesWithPosts([alpha, beta], aggregates, false)

    expect(result.map((summary) => summary.community_id)).toEqual(["cmt_alpha", "cmt_beta"])
  })
})

describe("sortCommunitySummaries", () => {
  const alpha = createCommunitySummary({ communityId: "cmt_alpha" })
  const beta = createCommunitySummary({ communityId: "cmt_beta" })
  const gamma = createCommunitySummary({ communityId: "cmt_gamma" })

  test("sorts by total score descending for top sort", () => {
    const aggregates = new Map<string, CommunityAggregate>([
      ["cmt_alpha", { totalScore: 50, bestRank: 1, latestPostMs: 1000 }],
      ["cmt_beta", { totalScore: 200, bestRank: 1, latestPostMs: 1000 }],
      ["cmt_gamma", { totalScore: 100, bestRank: 1, latestPostMs: 1000 }],
    ])

    const result = sortCommunitySummaries([alpha, beta, gamma], aggregates, "top")

    expect(result.map((s) => s.community_id)).toEqual(["cmt_beta", "cmt_gamma", "cmt_alpha"])
  })

  test("sorts by best rank descending for best sort", () => {
    const aggregates = new Map<string, CommunityAggregate>([
      ["cmt_alpha", { totalScore: 50, bestRank: 3, latestPostMs: 1000 }],
      ["cmt_beta", { totalScore: 200, bestRank: 10, latestPostMs: 1000 }],
      ["cmt_gamma", { totalScore: 100, bestRank: 7, latestPostMs: 1000 }],
    ])

    const result = sortCommunitySummaries([alpha, beta, gamma], aggregates, "best")

    expect(result.map((s) => s.community_id)).toEqual(["cmt_beta", "cmt_gamma", "cmt_alpha"])
  })

  test("sorts by latest post time descending for new sort", () => {
    const aggregates = new Map<string, CommunityAggregate>([
      ["cmt_alpha", { totalScore: 0, bestRank: 0, latestPostMs: 3000 }],
      ["cmt_beta", { totalScore: 0, bestRank: 0, latestPostMs: 1000 }],
      ["cmt_gamma", { totalScore: 0, bestRank: 0, latestPostMs: 2000 }],
    ])

    const result = sortCommunitySummaries([alpha, beta, gamma], aggregates, "new")

    expect(result.map((s) => s.community_id)).toEqual(["cmt_alpha", "cmt_gamma", "cmt_beta"])
  })

  test("falls back to updated_at when community has no projection data", () => {
    const aggregates = new Map<string, CommunityAggregate>()
    const recentAlpha = createCommunitySummary({ communityId: "cmt_alpha", updatedAt: "2026-04-20T00:00:00.000Z" })
    const olderBeta = createCommunitySummary({ communityId: "cmt_beta", updatedAt: "2026-04-18T00:00:00.000Z" })

    const result = sortCommunitySummaries([olderBeta, recentAlpha], aggregates, "new")

    expect(result.map((s) => s.community_id)).toEqual(["cmt_alpha", "cmt_beta"])
  })

  test("limits to 6 communities in caller", () => {
    const summaries = Array.from({ length: 10 }, (_, i) =>
      createCommunitySummary({ communityId: `cmt_${i}` })
    )
    const aggregates = new Map<string, CommunityAggregate>(
      summaries.map((s, i) => [s.community_id, { totalScore: i, bestRank: i, latestPostMs: i }])
    )

    const sorted = sortCommunitySummaries(summaries, aggregates, "top")

    expect(sorted.length).toBe(10)
    expect(sorted.slice(0, 6).length).toBe(6)
    expect(sorted[0].community_id).toBe("cmt_9")
  })
})
