import { afterEach, describe, expect, test } from "bun:test"
import { DatabaseCommunityRepository } from "../src/lib/communities/db-community-repository"
import { createControlPlaneTestClient } from "./helpers"

let cleanup: (() => Promise<void>) | null = null

afterEach(async () => {
  if (cleanup) {
    await cleanup()
    cleanup = null
  }
})

describe("community comment projection repository", () => {
  test("records and fetches comment projections by comment id", async () => {
    const setup = await createControlPlaneTestClient({ includeAllMigrations: true })
    cleanup = setup.cleanup

    const now = new Date().toISOString()
    await setup.client.execute({
      sql: `
        INSERT INTO users (
          user_id, primary_wallet_attachment_id, verification_state, capability_provider,
          verification_capabilities_json, verified_at, current_verification_session_id, created_at, updated_at
        ) VALUES (
          ?1, NULL, 'verified', NULL,
          ?2, NULL, NULL, ?3, ?3
        )
      `,
      args: ["usr_comment_projection", "{}", now],
    })

    await setup.client.execute({
      sql: `
        INSERT INTO communities (
          community_id, creator_user_id, display_name, membership_mode, status, provisioning_state,
          transfer_state, route_slug, namespace_verification_id, pending_namespace_verification_session_id,
          primary_database_binding_id, created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, 'open', 'active', 'active',
          'none', NULL, NULL, NULL,
          NULL, ?4, ?4
        )
      `,
      args: ["cmt_comment_projection", "usr_comment_projection", "Comment Projection Test", now],
    })

    const repo = new DatabaseCommunityRepository(setup.client)
    const created = await repo.recordCommunityCommentProjection({
      communityId: "cmt_comment_projection",
      threadRootPostId: "pst_thread_root",
      sourceCommentId: "cmt_01",
      parentCommentId: "cmt_parent",
      depth: 2,
      status: "published",
      sourceCreatedAt: now,
      actorUserId: "usr_comment_projection",
      createdAt: now,
    })

    expect(created.community_id).toBe("cmt_comment_projection")
    expect(created.thread_root_post_id).toBe("pst_thread_root")
    expect(created.source_comment_id).toBe("cmt_01")
    expect(created.parent_comment_id).toBe("cmt_parent")
    expect(created.depth).toBe(2)
    expect(created.status).toBe("published")

    const fetched = await repo.getCommunityCommentProjectionByCommentId("cmt_01")
    expect(fetched).not.toBeNull()
    expect(fetched?.projection_id).toBe(created.projection_id)
    expect(fetched?.thread_root_post_id).toBe("pst_thread_root")

    const auditRows = await setup.client.execute({
      sql: `
        SELECT action, target_type, target_id
        FROM audit_log
        WHERE target_id = ?1
      `,
      args: ["cmt_01"],
    })
    expect(auditRows.rows).toHaveLength(1)
    expect(auditRows.rows[0]?.action).toBe("community.comment_created")
    expect(auditRows.rows[0]?.target_type).toBe("comment")
  })
})
