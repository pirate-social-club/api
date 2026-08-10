import { describe, expect, test } from "bun:test"
import {
  toCommunityCommentProjectionRow,
  toCommunityFollowProjectionRow,
  toCommunityMembershipProjectionRow,
  toCommunityPostProjectionRow,
  toCommunityRow,
  toJobRow,
} from "./auth-db-community-rows"
import { resolveProvisioningRetryAction } from "../communities/create/repository"

function communityRow(createdAt: unknown, updatedAt: unknown): Record<string, unknown> {
  return {
    community_id: "cmt_timestamp",
    creator_user_id: "usr_owner",
    display_name: "Timestamp",
    description: null,
    avatar_ref: null,
    banner_ref: null,
    branding_json: "{}",
    default_surface: "threads",
    video_feed_enabled: 1,
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

describe("sibling control-plane row timestamp codecs", () => {
  const iso = "2026-08-02T12:00:00.000Z"

  test("canonicalizes pg Date values in jobs and preserves running-job heartbeats", async () => {
    const job = toJobRow({
      job_id: "job_timestamp",
      job_type: "provision_community_database",
      job_scope: "community",
      community_id: "cmt_timestamp",
      subject_type: "community",
      subject_id: "cmt_timestamp",
      status: "running",
      payload_json: null,
      result_ref: null,
      error_code: null,
      attempt_count: 1,
      available_at: new Date(iso),
      created_at: new Date(iso),
      updated_at: new Date(),
    })

    expect(job.available_at).toBe(iso)
    expect(job.created_at).toBe(iso)
    expect(Number.isFinite(Date.parse(job.updated_at))).toBe(true)

    const action = await resolveProvisioningRetryAction(
      {} as never,
      toCommunityRow(communityRow(new Date(iso), new Date(iso))),
      job,
    )
    expect(action).toEqual({ action: "return_existing" })
  })

  test("canonicalizes every TIMESTAMPTZ field in post projections", () => {
    const row = toCommunityPostProjectionRow({
      projection_id: "cpp_timestamp",
      community_id: "cmt_timestamp",
      source_post_id: "post_timestamp",
      author_user_id: "usr_owner",
      identity_mode: "public",
      post_type: "text",
      status: "published",
      visibility: "public",
      source_created_at: new Date(iso),
      projected_payload_json: "{}",
      upvote_count: 0,
      downvote_count: 0,
      comment_count: 0,
      like_count: 0,
      projection_version: 1,
      created_at: new Date(iso),
      updated_at: new Date(iso),
    })

    expect(row.source_created_at).toBe(iso)
    expect(row.created_at).toBe(iso)
    expect(row.updated_at).toBe(iso)
  })

  test("canonicalizes every TIMESTAMPTZ field in membership projections", () => {
    const row = toCommunityMembershipProjectionRow({
      projection_id: "cmp_timestamp",
      community_id: "cmt_timestamp",
      user_id: "usr_owner",
      membership_state: "member",
      role_summary_json: null,
      source_updated_at: new Date(iso),
      created_at: new Date(iso),
      updated_at: new Date(iso),
    })

    expect(row.source_updated_at).toBe(iso)
    expect(row.created_at).toBe(iso)
    expect(row.updated_at).toBe(iso)
  })

  test("canonicalizes every TIMESTAMPTZ field in comment projections", () => {
    const row = toCommunityCommentProjectionRow({
      projection_id: "ccp_timestamp",
      community_id: "cmt_timestamp",
      thread_root_post_id: "post_timestamp",
      source_comment_id: "comment_timestamp",
      parent_comment_id: null,
      depth: 0,
      status: "published",
      source_created_at: new Date(iso),
      created_at: new Date(iso),
      updated_at: new Date(iso),
    })

    expect(row.source_created_at).toBe(iso)
    expect(row.created_at).toBe(iso)
    expect(row.updated_at).toBe(iso)
  })

  test("keeps TEXT-backed follow projection timestamps as strings", () => {
    const row = toCommunityFollowProjectionRow({
      projection_id: "cfp_timestamp",
      community_id: "cmt_timestamp",
      user_id: "usr_owner",
      follow_state: "active",
      source_updated_at: iso,
      unfollowed_at: null,
      created_at: iso,
      updated_at: iso,
    })

    expect(row.source_updated_at).toBe(iso)
    expect(row.created_at).toBe(iso)
    expect(row.updated_at).toBe(iso)
  })
})
