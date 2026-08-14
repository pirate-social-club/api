import { afterEach, describe, expect, test } from "bun:test"
import type { CommunityFollowProjectionRow, CommunityMembershipProjectionRow, CommunityRow } from "../auth/auth-db-rows"
import {
  filterVisibleHomeFeedProjections,
  homeFeedCorpusMemberCommunityIds,
  listHomeFeedCommunityViewCounts,
  homeFeedBestRankSql,
  listHomeFeedProjectionPage,
  listVideoHomeFeedProjectionRows,
  mergeVideoFeedCandidateRows,
  nextVideoFeedBackfillBatchSize,
  resolveHomeFeedCandidateCommunityIds,
  resolveHomeFeedCommunityIds,
  resolveJoinedHomeFeedCommunityIds,
  refreshMaterializedHomeFeedBookings,
  selectBestVideoFeedProjectionPage,
  sortCommunitySummariesByViews,
  parseVideoFeedCursor,
  videoFeedOrderSql,
  withHomeFeedCommunityIdentity,
} from "./home-feed-service"
import type { Env, HomeFeedItem } from "../../types"
import { SINGLE_COMMUNITY_VIDEO_FEED_SELECTION_POLICY } from "./video-feed-selection"

describe("refreshMaterializedHomeFeedBookings", () => {
  test("replaces cached booking decoration and clears hosts no longer discoverable", async () => {
    const cachedBooking = {
      host_user_id: "usr_host",
      base_price_cents: 3500,
      has_available_slot: true,
      starting_price_cents: 3500,
      currency: "USDC" as const,
    }
    const freshBooking = {
      ...cachedBooking,
      base_price_cents: 5000,
      starting_price_cents: 5000,
    }
    const item = {
      community: {
        id: "com_test",
        object: "home_feed_community_summary",
        display_name: "Test",
      },
      post: {
        post: {
          id: "post_test",
          author_user: "usr_host",
          authorship_mode: "human_direct",
          identity_mode: "public",
        },
      },
      booking: cachedBooking,
    } as HomeFeedItem

    const refreshed = await refreshMaterializedHomeFeedBookings({
      env: {} as Env,
      result: { items: [item], next_cursor: null, top_communities: [] },
      lookup: async () => new Map([["usr_host", freshBooking]]),
    })
    expect(refreshed.items[0]?.booking).toEqual(freshBooking)

    const removed = await refreshMaterializedHomeFeedBookings({
      env: {} as Env,
      result: { items: [item], next_cursor: null, top_communities: [] },
      lookup: async () => new Map(),
    })
    expect(removed.items[0]?.booking).toBeUndefined()
  })
})

describe("nextVideoFeedBackfillBatchSize", () => {
  test("requests only enough candidates to fill the remaining response slots", () => {
    expect(nextVideoFeedBackfillBatchSize({ candidatesScanned: 25, returnedItems: 20 })).toBe(5)
  })

  test("stops at the bounded candidate scan budget", () => {
    expect(nextVideoFeedBackfillBatchSize({ candidatesScanned: 248, returnedItems: 20 })).toBe(2)
    expect(nextVideoFeedBackfillBatchSize({ candidatesScanned: 250, returnedItems: 20 })).toBe(0)
  })
})

describe("parseVideoFeedCursor", () => {
  test("keeps one ranking timestamp across candidate pages", () => {
    expect(parseVideoFeedCursor("v1:1753182000000:25", 1753182999999)).toEqual({
      offset: 25,
      rankedAt: 1753182000000,
    })
  })

  test("starts a fresh snapshot for invalid cursors", () => {
    expect(parseVideoFeedCursor("o:25", 1753182999999)).toEqual({
      offset: 0,
      rankedAt: 1753182999999,
    })
  })

  test("accepts the scorer-backed v2 cursor", () => {
    expect(parseVideoFeedCursor("v2:1753182000000:50", 1753182999999)).toEqual({
      offset: 50,
      rankedAt: 1753182000000,
    })
  })
})

describe("videoFeedOrderSql", () => {
  test("uses the proven portable engagement ordering for best", () => {
    const orderBy = videoFeedOrderSql("best")

    expect(orderBy).toContain("CASE WHEN")
    expect(orderBy).not.toMatch(/\bpow(?:er)?\s*\(/iu)
    expect(orderBy).not.toContain("unixepoch(")
  })
})

import type { HomeFeedProjectionRow, InternalHomeFeedCommunitySummary } from "./home-feed-service"
import { buildTestEnv, createControlPlaneTestClient, withMockedFetch } from "../../../tests/helpers"

let cleanup: (() => Promise<void>) | null = null

function videoCandidateRow(input: {
  postId: string
  ageHours?: number
  upvotes?: number
  downvotes?: number
  comments?: number
  likes?: number
  communityId?: string
  authorUserId?: string | null
  identityMode?: "anonymous" | "public"
}): HomeFeedProjectionRow {
  const rankedAt = Date.parse("2026-07-26T12:00:00.000Z")
  return {
    author_user_id: input.authorUserId === undefined ? `usr_${input.postId}` : input.authorUserId,
    comment_count: input.comments ?? 0,
    community_id: input.communityId ?? `cmt_${input.postId}`,
    downvote_count: input.downvotes ?? 0,
    identity_mode: input.identityMode ?? "public",
    like_count: input.likes ?? 0,
    post_type: "video",
    source_created_at: new Date(rankedAt - (input.ageHours ?? 0) * 3_600_000).toISOString(),
    source_post_id: input.postId,
    upvote_count: input.upvotes ?? 0,
    visibility: "public",
  }
}

describe("best video candidate selection", () => {
  const rankedAt = Date.parse("2026-07-26T12:00:00.000Z")

  test("merges the engagement and recency legs without duplicate projections", () => {
    const shared = videoCandidateRow({ postId: "pst_shared" })
    const merged = mergeVideoFeedCandidateRows(
      [shared, videoCandidateRow({ postId: "pst_engaged" })],
      [shared, videoCandidateRow({ postId: "pst_recent" })],
    )
    expect(merged.map((row) => row.source_post_id)).toEqual([
      "pst_shared",
      "pst_engaged",
      "pst_recent",
    ])
  })

  test("can promote a cold-start post supplied only by the recency leg", () => {
    const engagementLeg = Array.from({ length: 30 }, (_, index) => videoCandidateRow({
      ageHours: 72 + index,
      postId: `pst_engaged_${index}`,
      upvotes: 1,
    }))
    const fresh = videoCandidateRow({ postId: "pst_fresh" })
    const candidates = mergeVideoFeedCandidateRows(engagementLeg, [fresh])
    const page = selectBestVideoFeedProjectionPage({
      cursor: { offset: 0, rankedAt },
      rows: candidates,
    })
    expect(page.rows[0]?.source_post_id).toBe("pst_fresh")
  })

  test("carries projected likes into explicit engagement ranking", () => {
    const liked = videoCandidateRow({ postId: "pst_liked", likes: 5 })
    const neutral = videoCandidateRow({ postId: "pst_neutral" })
    const page = selectBestVideoFeedProjectionPage({
      cursor: { offset: 0, rankedAt },
      rows: [neutral, liked],
    })
    expect(page.rows[0]?.source_post_id).toBe("pst_liked")
  })

  test("uses one ranking clock and returns non-overlapping cursor pages", () => {
    const candidates = Array.from({ length: 40 }, (_, index) => videoCandidateRow({
      ageHours: index,
      postId: `pst_${String(index).padStart(2, "0")}`,
      upvotes: index % 4,
    }))
    const first = selectBestVideoFeedProjectionPage({
      cursor: { offset: 0, rankedAt },
      rows: candidates,
    })
    const second = selectBestVideoFeedProjectionPage({
      cursor: { offset: 25, rankedAt },
      rows: candidates,
    })
    const firstIds = new Set(first.rows.map((row) => row.source_post_id))
    expect(first.rows).toHaveLength(25)
    expect(second.rows.length).toBeGreaterThan(0)
    expect(second.rows.every((row) => !firstIds.has(row.source_post_id))).toBe(true)
    expect(first.hasMore).toBe(true)
    expect(second.hasMore).toBe(false)
  })

  test("keeps cursor continuity for a sovereign feed with one creator", () => {
    const candidates = Array.from({ length: 12 }, (_, index) => videoCandidateRow({
      authorUserId: "usr_only_creator",
      communityId: "cmt_sovereign",
      postId: `pst_sovereign_${String(index).padStart(2, "0")}`,
      upvotes: 12 - index,
    }))
    const first = selectBestVideoFeedProjectionPage({
      cursor: { offset: 0, rankedAt },
      pageSize: 6,
      rows: candidates,
      selectionPolicy: SINGLE_COMMUNITY_VIDEO_FEED_SELECTION_POLICY,
    })
    const second = selectBestVideoFeedProjectionPage({
      cursor: { offset: first.nextOffset, rankedAt },
      pageSize: 6,
      priorRows: first.rows,
      rows: candidates,
      selectionPolicy: SINGLE_COMMUNITY_VIDEO_FEED_SELECTION_POLICY,
    })
    const firstIds = new Set(first.rows.map((row) => row.source_post_id))
    expect(first.rows).toHaveLength(6)
    expect(second.rows).toHaveLength(6)
    expect(second.rows.every((row) => !firstIds.has(row.source_post_id))).toBe(true)
    expect(second.hasMore).toBe(false)
  })

  test("does not discard candidates deferred into a later diversity-policy page", () => {
    const candidates = [
      ...Array.from({ length: 6 }, (_, index) => videoCandidateRow({
        authorUserId: `usr_loud_${index}`,
        communityId: "cmt_loud",
        postId: `pst_loud_${index}`,
        upvotes: 100 - index,
      })),
      ...Array.from({ length: 4 }, (_, index) => videoCandidateRow({
        authorUserId: `usr_singleton_${index}`,
        communityId: `cmt_singleton_${index}`,
        postId: `pst_singleton_${index}`,
        upvotes: 50 - index,
      })),
    ]
    const page = selectBestVideoFeedProjectionPage({
      cursor: { offset: 0, rankedAt },
      rows: candidates,
    })
    expect(page.rows).toHaveLength(candidates.length)
    expect(new Set(page.rows.map((row) => row.source_post_id))).toEqual(
      new Set(candidates.map((row) => row.source_post_id)),
    )
    expect(page.nextOffset).toBe(candidates.length)
    expect(page.hasMore).toBe(false)
  })

  test("supports exact small batches for hydration backfill without repeating candidates", () => {
    const candidates = Array.from({ length: 40 }, (_, index) => videoCandidateRow({
      ageHours: index,
      postId: `pst_backfill_${String(index).padStart(2, "0")}`,
    }))
    const first = selectBestVideoFeedProjectionPage({
      cursor: { offset: 0, rankedAt },
      rows: candidates,
    })
    const backfill = selectBestVideoFeedProjectionPage({
      cursor: { offset: 25, rankedAt },
      pageSize: 5,
      rows: candidates,
    })
    const firstIds = new Set(first.rows.map((row) => row.source_post_id))
    expect(backfill.rows).toHaveLength(5)
    expect(backfill.rows.every((row) => !firstIds.has(row.source_post_id))).toBe(true)
    expect(backfill.hasMore).toBe(true)
  })

  test("keeps diversity caps across the hydration backfill seam", () => {
    const candidates = [
      ...Array.from({ length: 4 }, (_, index) => videoCandidateRow({
        authorUserId: "usr_repeated",
        communityId: "cmt_repeated",
        postId: `pst_repeated_${index}`,
        upvotes: 100 - index,
      })),
      ...Array.from({ length: 30 }, (_, index) => videoCandidateRow({
        authorUserId: `usr_unique_${index}`,
        communityId: `cmt_unique_${index}`,
        postId: `pst_unique_${index}`,
        upvotes: 50 - index,
      })),
    ]
    const first = selectBestVideoFeedProjectionPage({
      cursor: { offset: 0, rankedAt },
      rows: candidates,
    })
    const deliveredBeforeBackfill = first.rows.filter((row) => row.source_post_id !== "pst_unique_22")
    const backfill = selectBestVideoFeedProjectionPage({
      cursor: { offset: 25, rankedAt },
      pageSize: 4,
      priorRows: deliveredBeforeBackfill,
      rows: candidates,
    })
    const delivered = [...deliveredBeforeBackfill, ...backfill.rows]
    expect(delivered.filter((row) => row.author_user_id === "usr_repeated")).toHaveLength(2)
    expect(delivered.filter((row) => row.community_id === "cmt_repeated")).toHaveLength(2)
    expect(backfill.nextOffset).toBeGreaterThan(29)
  })

  test("does not apply a shared internal author cap to anonymous projections", () => {
    const candidates = Array.from({ length: 6 }, (_, index) => videoCandidateRow({
      authorUserId: "usr_hidden_author",
      communityId: `cmt_anon_${index}`,
      identityMode: "anonymous",
      postId: `pst_anon_${index}`,
    }))
    const page = selectBestVideoFeedProjectionPage({
      cursor: { offset: 0, rankedAt },
      pageSize: 6,
      rows: candidates,
    })
    expect(page.rows).toHaveLength(6)
  })
})

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
    description: null,
    avatar_ref: null,
    banner_ref: null,
    branding_json: "{}",
    default_surface: "threads",
    video_feed_enabled: true,
    status: "active",
    provisioning_state: "active",
    transfer_state: "none",
    route_slug: input.communityId,
    namespace_verification_id: null,
    pending_namespace_verification_session_id: null,
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
  test("uses a service-owned scope in production and filters inactive ids", () => {
    const activeCommunities = [
      createCommunityRow({ communityId: "cmt_scoped", creatorUserId: "usr_owner" }),
      createCommunityRow({ communityId: "cmt_other", creatorUserId: "usr_owner" }),
    ]
    expect(resolveHomeFeedCandidateCommunityIds({
      activeCommunities,
      allowOverride: false,
      followRows: [],
      membershipRows: [],
      override: ["cmt_other"],
      scope: ["cmt_scoped", "cmt_missing", "cmt_scoped"],
      userId: null,
    })).toEqual(["cmt_scoped"])
  })

  test("uses the explicit operator scope without leaking duplicate community reads", () => {
    expect(resolveHomeFeedCandidateCommunityIds({
      activeCommunities: [],
      allowOverride: true,
      followRows: [],
      membershipRows: [],
      userId: "benchmark-user",
      override: ["community-a", "community-b", "community-a"],
    })).toEqual(["community-a", "community-b"])
  })

  test("ignores an explicit operator scope when the environment disallows overrides", () => {
    const activeCommunities = [
      createCommunityRow({
        communityId: "community-production",
        creatorUserId: "production-owner",
      }),
    ]
    expect(resolveHomeFeedCandidateCommunityIds({
      activeCommunities,
      allowOverride: false,
      followRows: [],
      membershipRows: [],
      userId: "benchmark-user",
      override: ["community-override"],
    })).toEqual(["community-production"])
  })

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

describe("homeFeedCorpusMemberCommunityIds", () => {
  test("removes membership from corpus selection for viewer-aware public feeds", () => {
    const memberships = new Set(["cmt_member"])
    expect(homeFeedCorpusMemberCommunityIds(memberships, true)).toEqual(new Set())
    expect(homeFeedCorpusMemberCommunityIds(memberships, false)).toBe(memberships)
  })
})

describe("listHomeFeedProjectionPage", () => {
  test("uses native date arithmetic for each control-plane dialect", () => {
    const postgres = homeFeedBestRankSql({
      engagementScore: "score",
      rankedAtPlaceholder: "?1",
      postgres: true,
    })
    expect(postgres).toStartWith("CAST(")
    expect(postgres).toEndWith(" AS DOUBLE PRECISION)")
    expect(postgres).toContain("GREATEST(0.0")
    expect(postgres).toContain("EXTRACT(EPOCH FROM (?1::timestamptz - source_created_at::timestamptz))")
    expect(postgres).not.toContain("julianday")
    expect(postgres).not.toContain("MAX(0.0")

    const sqlite = homeFeedBestRankSql({
      engagementScore: "score",
      rankedAtPlaceholder: "?1",
      postgres: false,
    })
    expect(sqlite).toContain("MAX(0.0")
    expect(sqlite).toContain("julianday(?1)")
    expect(sqlite).not.toContain("EXTRACT(EPOCH")
    expect(sqlite).not.toContain("DOUBLE PRECISION")
  })

  async function setupProjectionRows(rows: Array<{
    id: string
    createdAt: string
    postType?: "text" | "video"
    visibility?: "public" | "members_only"
    upvotes?: number
    comments?: number
    likes?: number
  }>) {
    const setup = await createControlPlaneTestClient({ includeAllMigrations: true })
    cleanup = setup.cleanup
    const now = "2026-04-18T12:00:00.000Z"
    await setup.client.execute({
      sql: `
        INSERT INTO users (
          user_id, verification_state, verification_capabilities_json, created_at, updated_at
        ) VALUES ('usr_feed_operator', 'verified', '{}', ?1, ?1)
      `,
      args: [now],
    })
    await setup.client.execute({
      sql: `
        INSERT INTO communities (
          community_id, creator_user_id, display_name, membership_mode, status,
          provisioning_state, transfer_state, route_slug, created_at, updated_at
        ) VALUES (
          'cmt_feed', 'usr_feed_operator', 'Feed', 'open', 'active',
          'active', 'none', 'feed', ?1, ?1
        )
      `,
      args: [now],
    })
    await setup.client.batch(rows.map((row) => ({
      sql: `
        INSERT INTO community_post_projections (
          projection_id, community_id, source_post_id, author_user_id, identity_mode,
          post_type, status, visibility, upvote_count, downvote_count, comment_count,
          like_count, source_created_at, projected_payload_json, projection_version,
          created_at, updated_at
        ) VALUES (
          ?1, 'cmt_feed', ?2, 'usr_feed_operator', 'public',
          ?3, 'published', ?4, ?5, 0, ?6,
          ?7, ?8, '{}', 1, ?9, ?9
        )
      `,
      args: [
        `cpp_${row.id}`,
        row.id,
        row.postType ?? "text",
        row.visibility ?? "public",
        row.upvotes ?? 0,
        row.comments ?? 0,
        row.likes ?? 0,
        row.createdAt,
        now,
      ],
    })), "write")

    return {
      client: setup.client,
      env: buildTestEnv({
        CONTROL_PLANE_DATABASE_URL: `file:${setup.databasePath}`,
        DEV_MEMORY_STORE_ENABLED: "false",
      }),
    }
  }

  test("returns a bounded page and excludes inaccessible member projections before pagination", async () => {
    const rows = Array.from({ length: 29 }, (_, index) => ({
      id: `pst_${String(index).padStart(2, "0")}`,
      createdAt: new Date(Date.parse("2026-04-18T10:00:00.000Z") + index * 60_000).toISOString(),
      visibility: index === 28 ? "members_only" as const : "public" as const,
    }))
    const { env } = await setupProjectionRows(rows)
    const now = Date.parse("2026-04-18T12:00:00.000Z")

    const first = await listHomeFeedProjectionPage({
      env,
      communityIds: ["cmt_feed"],
      memberCommunityIds: [],
      sort: "new",
      now,
      cutoffIso: null,
      anchor: null,
    })
    const anchorRow = first.rows[first.rows.length - 1]
    const second = await listHomeFeedProjectionPage({
      env,
      communityIds: ["cmt_feed"],
      memberCommunityIds: [],
      sort: "new",
      now,
      cutoffIso: null,
      anchor: {
        now,
        sortKey: null,
        createdIso: anchorRow?.source_created_at ?? "",
        postId: anchorRow?.source_post_id ?? "",
      },
    })

    expect(first.rows).toHaveLength(25)
    expect(first.hasMore).toBe(true)
    expect(first.rows[0]?.source_post_id).toBe("pst_27")
    expect(second.rows.map((row) => row.source_post_id)).toEqual(["pst_02", "pst_01", "pst_00"])
    expect(second.hasMore).toBe(false)
    const firstIds = new Set(first.rows.map((row) => row.source_post_id))
    expect(second.rows.some((row) => firstIds.has(row.source_post_id))).toBe(false)
  }, 20000)

  test("preserves distinct time-decayed best and engagement-only top ordering in SQL", async () => {
    const { env } = await setupProjectionRows([
      { id: "pst_recent_zero", createdAt: "2026-04-18T11:59:00.000Z" },
      { id: "pst_recent_liked", createdAt: "2026-04-18T11:00:00.000Z", likes: 1 },
      { id: "pst_cutoff_liked", createdAt: "2026-04-18T10:00:00.000Z", likes: 1 },
      { id: "pst_old_upvoted", createdAt: "2026-04-18T00:00:00.000Z", upvotes: 2 },
      { id: "pst_member", createdAt: "2026-04-18T11:58:00.000Z", visibility: "members_only", comments: 3 },
    ])
    const common = {
      env,
      communityIds: ["cmt_feed"],
      memberCommunityIds: ["cmt_feed"],
      now: Date.parse("2026-04-18T12:00:00.000Z"),
      cutoffIso: "2026-04-18T10:00:00.000Z",
      anchor: null,
    }

    const best = await listHomeFeedProjectionPage({ ...common, sort: "best" })
    const top = await listHomeFeedProjectionPage({ ...common, sort: "top" })

    expect(best.rows.map((row) => row.source_post_id)).toEqual([
      "pst_member",
      "pst_recent_liked",
      "pst_recent_zero",
      "pst_cutoff_liked",
    ])
    expect(top.rows.map((row) => row.source_post_id)).toEqual([
      "pst_member",
      "pst_recent_liked",
      "pst_cutoff_liked",
      "pst_recent_zero",
    ])
  }, 20000)

  test("keyset pagination does not duplicate a row whose engagement rises between pages", async () => {
    const rows = Array.from({ length: 27 }, (_, index) => ({
      id: `pst_${String(index).padStart(2, "0")}`,
      createdAt: new Date(Date.parse("2026-04-18T00:00:00.000Z") + index * 60_000).toISOString(),
      upvotes: index,
    }))
    const { client, env } = await setupProjectionRows(rows)
    const now = Date.parse("2026-04-18T12:00:00.000Z")
    const first = await listHomeFeedProjectionPage({
      env,
      communityIds: ["cmt_feed"],
      memberCommunityIds: [],
      sort: "top",
      now,
      cutoffIso: null,
      anchor: null,
    })
    const anchorRow = first.rows[first.rows.length - 1]
    await client.execute({
      sql: "UPDATE community_post_projections SET upvote_count = ?1 WHERE source_post_id = ?2",
      args: [500, "pst_10"],
    })

    const second = await listHomeFeedProjectionPage({
      env,
      communityIds: ["cmt_feed"],
      memberCommunityIds: [],
      sort: "top",
      now,
      cutoffIso: null,
      anchor: {
        now,
        sortKey: (anchorRow?.upvote_count ?? 0) * 3
          + (anchorRow?.comment_count ?? 0) * 2
          + (anchorRow?.like_count ?? 0),
        createdIso: anchorRow?.source_created_at ?? "",
        postId: anchorRow?.source_post_id ?? "",
      },
    })

    expect(second.rows.map((row) => row.source_post_id)).toEqual(["pst_01", "pst_00"])
    const firstIds = new Set(first.rows.map((row) => row.source_post_id))
    expect(second.rows.some((row) => firstIds.has(row.source_post_id))).toBe(false)
  }, 20000)

  test("uses a stable keyset for video top pages", async () => {
    const rows = Array.from({ length: 27 }, (_, index) => ({
      id: `video_${String(index).padStart(2, "0")}`,
      createdAt: new Date(Date.parse("2026-04-18T00:00:00.000Z") + index * 60_000).toISOString(),
      postType: "video" as const,
      upvotes: index,
    }))
    const { client, env } = await setupProjectionRows(rows)
    const now = Date.parse("2026-04-18T12:00:00.000Z")
    const first = await listVideoHomeFeedProjectionRows({
      communityIds: ["cmt_feed"],
      env,
      memberCommunityIdSet: new Set(),
      now,
      sort: "top",
      timeRange: "all",
    })

    expect(first.rows).toHaveLength(25)
    expect(first.rows[0]?.source_post_id).toBe("video_26")
    expect(first.rows[0]?.author_user_id).toBe("usr_feed_operator")
    expect(first.nextCursor?.startsWith("k:")).toBe(true)

    await client.execute({
      sql: "UPDATE community_post_projections SET upvote_count = ?1 WHERE source_post_id = ?2",
      args: [500, "video_10"],
    })
    const second = await listVideoHomeFeedProjectionRows({
      communityIds: ["cmt_feed"],
      cursor: first.nextCursor,
      env,
      memberCommunityIdSet: new Set(),
      now,
      sort: "top",
      timeRange: "all",
    })

    expect(second.rows.map((row) => row.source_post_id)).toEqual(["video_01", "video_00"])
    const firstIds = new Set(first.rows.map((row) => row.source_post_id))
    expect(second.rows.some((row) => firstIds.has(row.source_post_id))).toBe(false)
  }, 20000)

  test("uses a stable keyset for video new pages", async () => {
    const rows = Array.from({ length: 27 }, (_, index) => ({
      id: `video_new_${String(index).padStart(2, "0")}`,
      createdAt: new Date(Date.parse("2026-04-18T00:00:00.000Z") + index * 60_000).toISOString(),
      postType: "video" as const,
    }))
    const { env } = await setupProjectionRows(rows)
    const now = Date.parse("2026-04-18T12:00:00.000Z")
    const first = await listVideoHomeFeedProjectionRows({
      communityIds: ["cmt_feed"],
      env,
      memberCommunityIdSet: new Set(),
      now,
      sort: "new",
      timeRange: "all",
    })
    const second = await listVideoHomeFeedProjectionRows({
      communityIds: ["cmt_feed"],
      cursor: first.nextCursor,
      env,
      memberCommunityIdSet: new Set(),
      now,
      sort: "new",
      timeRange: "all",
    })

    expect(first.nextCursor?.startsWith("k:")).toBe(true)
    expect(first.rows[0]?.source_post_id).toBe("video_new_26")
    expect(second.rows.map((row) => row.source_post_id)).toEqual(["video_new_01", "video_new_00"])
  }, 20000)

  test("rejects legacy v1/v2 video offset cursors as a fresh first page", async () => {
    const rows = Array.from({ length: 27 }, (_, index) => ({
      id: `video_legacy_${String(index).padStart(2, "0")}`,
      createdAt: new Date(Date.parse("2026-04-18T00:00:00.000Z") + index * 60_000).toISOString(),
      postType: "video" as const,
    }))
    const { env } = await setupProjectionRows(rows)
    const now = Date.parse("2026-04-18T12:00:00.000Z")
    // Legacy cursors encode a future ranking timestamp and an offset that a
    // tuple keyset cannot translate. Both must be discarded: the page restarts
    // from the newest row with a fresh ranking time instead of applying a stale
    // time-range cutoff built from the orphaned timestamp.
    for (const cursor of ["v1:1870000000000:3", "v2:1870000000000:3"]) {
      const first = await listVideoHomeFeedProjectionRows({
        communityIds: ["cmt_feed"],
        cursor,
        env,
        memberCommunityIdSet: new Set(),
        now,
        sort: "new",
        timeRange: "day",
      })

      expect(first.rows).toHaveLength(25)
      expect(first.rows[0]?.source_post_id).toBe("video_legacy_26")
      expect(first.nextCursor?.startsWith("k:")).toBe(true)
    }
  }, 20000)
})

function createCommunitySummary(input: {
  communityId: string
  displayName?: string
  updatedAt?: string
  viewCount?: number | null
}): InternalHomeFeedCommunitySummary {
  return {
    id: `com_${input.communityId}`,
    object: "home_feed_community_summary",
    community_id: input.communityId,
    display_name: input.displayName ?? input.communityId,
    route_slug: input.communityId,
    avatar_ref: null,
    branding: {
      accent_color: null,
      header_style: "standard",
      tagline: null,
      theme: "system",
    },
    default_surface: "threads",
    video_feed_enabled: true,
    member_count: null,
    follower_count: null,
    view_count: input.viewCount ?? null,
    updated_at: input.updatedAt ?? "2026-04-18T00:00:00.000Z",
  }
}

describe("sortCommunitySummariesByViews", () => {
  test("selects viewed communities before zero-view feed-ranked communities", () => {
    const palestine = createCommunitySummary({ communityId: "cmt_palestine", viewCount: 130 })
    const baddie = createCommunitySummary({ communityId: "cmt_baddie", viewCount: 0 })
    const kuwait = createCommunitySummary({ communityId: "cmt_kuwait", viewCount: 0 })

    const result = sortCommunitySummariesByViews([baddie, kuwait, palestine])

    expect(result.map((summary) => summary.community_id)).toEqual([
      "cmt_palestine",
      "cmt_baddie",
      "cmt_kuwait",
    ])
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
  }, 20000)

  test("fails without bootstrapping analytics or widening schema when the health counts migration is missing", async () => {
    const setup = await createControlPlaneTestClient()
    cleanup = setup.cleanup
    let fetchCalled = false

    await withMockedFetch(() => (async () => {
      fetchCalled = true
      return new Response(JSON.stringify({
        data: [
          { day: "2026-05-01", community_id: "cmt_alpha", views: 2 },
          { day: "2026-05-02", community_id: "cmt_alpha", views: 3 },
          { day: "2026-05-01", community_id: "cmt_beta", views: 7 },
        ],
      }), { status: 200 })
    }), async () => {
      await expect(listHomeFeedCommunityViewCounts({
        env: buildTestEnv({
          CONTROL_PLANE_DATABASE_URL: `file:${setup.databasePath}`,
          DEV_MEMORY_STORE_ENABLED: "false",
          TINYBIRD_READ_TOKEN: "tb_read_test",
        }),
        communityIds: ["cmt_alpha"],
      })).rejects.toThrow(/community_health_counts/i)
    })

    expect(fetchCalled).toBe(false)
    const tables = await setup.client.execute({
      sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?1",
      args: ["community_health_counts"],
    })
    expect(tables.rows).toEqual([])
  })
})
