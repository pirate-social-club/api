import { afterEach, describe, expect, test } from "bun:test"
import type { CommunityFollowProjectionRow, CommunityMembershipProjectionRow, CommunityRow } from "../auth/auth-db-rows"
import {
  filterCommunitiesWithPosts,
  filterVisibleHomeFeedProjections,
  listHomeFeedCommunityViewCounts,
  resolveHomeFeedCommunityIds,
  resolveJoinedHomeFeedCommunityIds,
  sortCommunitySummaries,
  withHomeFeedCommunityIdentity,
} from "./home-feed-service"
import type { CommunityAggregate, InternalHomeFeedCommunitySummary } from "./home-feed-service"
import { buildTestEnv, createControlPlaneTestClient } from "../../../tests/helpers"

let cleanup: (() => Promise<void>) | null = null

afterEach(async () => {
  if (cleanup) {
    await cleanup()
    cleanup = null
  }
})

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
    follower_count: 0,
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

function createFollowRow(input: {
  communityId: string
  userId: string
  followState: CommunityFollowProjectionRow["follow_state"]
}): CommunityFollowProjectionRow {
  return {
    projection_id: `cfp_${input.communityId}_${input.userId}`,
    community_id: input.communityId,
    user_id: input.userId,
    follow_state: input.followState,
    source_updated_at: "2026-04-18T00:00:00.000Z",
    unfollowed_at: input.followState === "inactive" ? "2026-04-19T00:00:00.000Z" : null,
    created_at: "2026-04-18T00:00:00.000Z",
    updated_at: "2026-04-18T00:00:00.000Z",
  }
}

describe("resolveHomeFeedCommunityIds", () => {
  test("returns all active communities for a signed-in user", () => {
    const communityIds = resolveHomeFeedCommunityIds({
      activeCommunities: [
        createCommunityRow({ communityId: "cmt_alpha", creatorUserId: "usr_owner" }),
        createCommunityRow({ communityId: "cmt_beta", creatorUserId: "usr_owner" }),
      ],
      followRows: [
        createFollowRow({
          communityId: "cmt_beta",
          userId: "usr_viewer",
          followState: "active",
        }),
      ],
      membershipRows: [],
      userId: "usr_viewer",
    })

    expect(communityIds).toEqual(["cmt_alpha", "cmt_beta"])
  })

  test("does not remove discovery communities after the viewer unfollows them", () => {
    const communityIds = resolveHomeFeedCommunityIds({
      activeCommunities: [
        createCommunityRow({ communityId: "cmt_alpha", creatorUserId: "usr_owner" }),
        createCommunityRow({ communityId: "cmt_beta", creatorUserId: "usr_owner" }),
      ],
      followRows: [
        createFollowRow({
          communityId: "cmt_beta",
          userId: "usr_viewer",
          followState: "inactive",
        }),
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

    expect(communityIds).toEqual(["cmt_alpha", "cmt_beta"])
  })

  test("returns all active communities for a signed-in user without active follows", () => {
    const communityIds = resolveHomeFeedCommunityIds({
      activeCommunities: [
        createCommunityRow({ communityId: "cmt_alpha", creatorUserId: "usr_owner" }),
        createCommunityRow({ communityId: "cmt_beta", creatorUserId: "usr_owner" }),
      ],
      followRows: [],
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
      followRows: [],
      membershipRows: [],
      userId: null,
    })

    expect(communityIds).toEqual(["cmt_alpha", "cmt_beta"])
  })
})

describe("resolveJoinedHomeFeedCommunityIds", () => {
  test("returns only explicit member and owner communities", () => {
    const communityIds = resolveJoinedHomeFeedCommunityIds({
      activeCommunities: [
        createCommunityRow({ communityId: "cmt_alpha", creatorUserId: "usr_viewer" }),
        createCommunityRow({ communityId: "cmt_beta", creatorUserId: "usr_owner" }),
        createCommunityRow({ communityId: "cmt_gamma", creatorUserId: "usr_owner" }),
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

    expect(communityIds).toEqual(["cmt_beta", "cmt_alpha"])
  })
})

describe("filterVisibleHomeFeedProjections", () => {
  test("keeps members-only posts out of anonymous and fallback feeds", () => {
    const result = filterVisibleHomeFeedProjections([
      {
        community_id: "cmt_alpha",
        source_post_id: "pst_public",
        source_created_at: "2026-04-18T00:00:00.000Z",
        visibility: "public",
        upvote_count: 1,
        downvote_count: 0,
        comment_count: 0,
        like_count: 0,
      },
      {
        community_id: "cmt_beta",
        source_post_id: "pst_private",
        source_created_at: "2026-04-18T00:00:00.000Z",
        visibility: "members_only",
        upvote_count: 1,
        downvote_count: 0,
        comment_count: 0,
        like_count: 0,
      },
    ], new Set<string>())

    expect(result.map((row) => row.source_post_id)).toEqual(["pst_public"])
  })

  test("keeps members-only posts for joined communities", () => {
    const result = filterVisibleHomeFeedProjections([
      {
        community_id: "cmt_alpha",
        source_post_id: "pst_public",
        source_created_at: "2026-04-18T00:00:00.000Z",
        visibility: "public",
        upvote_count: 1,
        downvote_count: 0,
        comment_count: 0,
        like_count: 0,
      },
      {
        community_id: "cmt_beta",
        source_post_id: "pst_private",
        source_created_at: "2026-04-18T00:00:00.000Z",
        visibility: "members_only",
        upvote_count: 1,
        downvote_count: 0,
        comment_count: 0,
        like_count: 0,
      },
    ], new Set<string>(["cmt_beta"]))

    expect(result.map((row) => row.source_post_id)).toEqual(["pst_public", "pst_private"])
  })
})

function createCommunitySummary(input: {
  communityId: string
  displayName?: string
  updatedAt?: string
}): InternalHomeFeedCommunitySummary {
  return {
    id: `com_${input.communityId}`,
    object: "home_feed_community_summary",
    community_id: input.communityId,
    display_name: input.displayName ?? input.communityId,
    route_slug: input.communityId,
    avatar_ref: null,
    member_count: null,
    follower_count: null,
    view_count: null,
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

describe("withHomeFeedCommunityIdentity", () => {
  test("uses the local community avatar in home feed summaries", () => {
    const summary = createCommunitySummary({
      communityId: "cmt_palestine",
      displayName: "Palestine",
    })

    const result = withHomeFeedCommunityIdentity(summary, {
      avatarRef: "https://media.pirate.test/palestine.png",
      displayName: "@🇵🇸",
    })

    expect(result.display_name).toBe("@🇵🇸")
    expect(result.avatar_ref).toBe("https://media.pirate.test/palestine.png")
  })

  test("builds a unicode-safe default avatar when no local avatar exists", () => {
    const summary = createCommunitySummary({
      communityId: "cmt_palestine",
      displayName: "🇵🇸",
    })

    const result = withHomeFeedCommunityIdentity(summary, null)

    expect(result.avatar_ref?.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true)
    expect(decodeURIComponent(result.avatar_ref ?? "")).toContain("🇵")
    expect(decodeURIComponent(result.avatar_ref ?? "").includes("\uFFFD")).toBe(false)
  })
})

describe("listHomeFeedCommunityViewCounts", () => {
  test("reads synced community view counts from the control-plane table", async () => {
    const setup = await createControlPlaneTestClient({ includeAllMigrations: true })
    cleanup = setup.cleanup
    await setup.client.execute({
      sql: `
        INSERT INTO community_health_counts (community_id, total_views, updated_at)
        VALUES (?1, ?2, ?3), (?4, ?5, ?6)
      `,
      args: [
        "cmt_alpha",
        12,
        "2026-05-04T00:00:00.000Z",
        "cmt_beta",
        0,
        "2026-05-04T00:00:00.000Z",
      ],
    })

    const counts = await listHomeFeedCommunityViewCounts({
      env: buildTestEnv({
        CONTROL_PLANE_DATABASE_URL: `file:${setup.databasePath}`,
        DEV_MEMORY_STORE_ENABLED: "false",
      }),
      communityIds: ["cmt_alpha", "cmt_gamma"],
    })

    expect(counts.get("cmt_alpha")).toBe(12)
    expect(counts.has("cmt_gamma")).toBe(false)
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
