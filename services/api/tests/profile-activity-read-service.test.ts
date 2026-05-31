import { afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { createComment } from "../src/lib/comments/comment-service"
import { openCommunityDb } from "../src/lib/communities/community-db-factory"
import { insertPost } from "../src/lib/posts/community-post-create-store"
import { getPostById } from "../src/lib/posts/community-post-query-store"
import { getProfileActivity } from "../src/lib/profile/profile-activity-read-service"
import type { Env } from "../src/types"
import { createControlPlaneTestClient } from "./helpers"
import {
  buildTestCommunityRepository,
  buildUserRepository,
  buildVerifiedUser,
  cleanupCommunityTestArtifacts,
  createCommunityTestRoot,
  seedTestCommunityState,
} from "./community-test-helpers"

const cleanupPaths: string[] = []
const cleanupTasks: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanupTasks.splice(0).map((cleanup) => cleanup()))
  await cleanupCommunityTestArtifacts(cleanupPaths)
})

async function seedControlPlaneCommunity(input: {
  client: Awaited<ReturnType<typeof createControlPlaneTestClient>>["client"]
  communityId: string
  now: string
}) {
  await input.client.execute({
    sql: `
      INSERT INTO users (
        user_id, verification_state, capability_provider, verification_capabilities_json,
        verified_at, created_at, updated_at
      ) VALUES
        ('usr_owner', 'verified', 'self', '{}', ?1, ?1, ?1),
        ('usr_alice', 'verified', 'self', '{}', ?1, ?1, ?1)
    `,
    args: [input.now],
  })
  await input.client.execute({
    sql: `
      INSERT INTO communities (
        community_id, creator_user_id, display_name, membership_mode, status,
        provisioning_state, transfer_state, route_slug, namespace_verification_id,
        pending_namespace_verification_session_id, primary_database_binding_id,
        created_at, updated_at
      ) VALUES (
        ?1, 'usr_owner', 'Profile Activity Club', 'request', 'active',
        'active', 'none', NULL, NULL,
        NULL, 'cdb_profile_activity',
        ?2, ?2
      )
    `,
    args: [input.communityId, input.now],
  })
}

describe("getProfileActivity", () => {
  test("returns only public profile activity and interleaves overview items", async () => {
    const rootDir = await createCommunityTestRoot(cleanupPaths, "pirate-profile-activity-")
    const control = await createControlPlaneTestClient({ includeAllMigrations: true })
    cleanupTasks.push(control.cleanup)

    const communityId = "cmt_profile_activity"
    const databasePath = join(rootDir, "community.db")
    const env: Env = {
      CONTROL_PLANE_DATABASE_URL: `file:${control.databasePath}`,
      LOCAL_COMMUNITY_DB_ROOT: rootDir,
    }
    const repo = buildTestCommunityRepository({
      databasePath,
      communityId,
      displayName: "Profile Activity Club",
      primaryDatabaseBindingId: "cdb_profile_activity",
      databaseName: "profile-activity.db",
    })
    const users = buildUserRepository({
      usr_owner: buildVerifiedUser("usr_owner"),
      usr_alice: buildVerifiedUser("usr_alice"),
    })
    const now = "2026-05-12T10:00:00.000Z"
    await seedControlPlaneCommunity({ client: control.client, communityId, now })
    const { postId: threadRootPostId } = await seedTestCommunityState({
      env,
      repo,
      communityId,
      memberUserIds: ["usr_owner", "usr_alice"],
      displayName: "Profile Activity Club",
      rootPostTitle: "Thread root",
    })

    let publicPostPayload = ""
    let publicPostId = ""
    let anonymousPostPayload = ""
    let anonymousPostId = ""
    const db = await openCommunityDb(env, repo, communityId)
    try {
      const publicPost = await insertPost({
        client: db.client,
        communityId,
        authorUserId: "usr_alice",
        body: {
          post_type: "text",
          title: "Public profile post",
          body: "Visible on profile",
          idempotency_key: "profile-public-post",
        },
        createdAt: "2026-05-12T10:04:00.000Z",
      })
      const anonymousPost = await insertPost({
        client: db.client,
        communityId,
        authorUserId: "usr_alice",
        body: {
          post_type: "text",
          identity_mode: "anonymous",
          anonymous_scope: "thread_stable",
          title: "Anonymous profile post",
          body: "Hidden from profile",
          idempotency_key: "profile-anonymous-post",
        },
        createdAt: "2026-05-12T10:03:00.000Z",
      })
      publicPostId = publicPost.post_id
      anonymousPostId = anonymousPost.post_id
      publicPostPayload = JSON.stringify(await getPostById(db.client, publicPost.post_id))
      anonymousPostPayload = JSON.stringify(await getPostById(db.client, anonymousPost.post_id))
    } finally {
      db.close()
    }

    const publicComment = await createComment({
      env,
      userId: "usr_alice",
      communityId,
      threadRootPostId,
      body: { body: "Public comment" },
      userRepository: users,
      communityRepository: repo,
    })
    const anonymousComment = await createComment({
      env,
      userId: "usr_alice",
      communityId,
      threadRootPostId,
      body: {
        body: "Anonymous comment",
        identity_mode: "anonymous",
        anonymous_scope: "thread_stable",
      },
      userRepository: users,
      communityRepository: repo,
    })

    await control.client.batch([
      {
        sql: `
          INSERT INTO community_post_projections (
            projection_id, community_id, source_post_id, author_user_id, identity_mode,
            post_type, status, visibility, upvote_count, downvote_count, comment_count,
            like_count, source_created_at, projected_payload_json, projection_version,
            created_at, updated_at
          ) VALUES
            ('cpp_public', ?1, ?2, 'usr_alice', 'public',
             'text', 'published', 'public', 0, 0, 0,
             0, '2026-05-12T10:04:00.000Z', ?3, 1,
             ?5, ?5),
            ('cpp_anonymous', ?1, ?4, 'usr_alice', 'anonymous',
             'text', 'published', 'public', 0, 0, 0,
             0, '2026-05-12T10:03:00.000Z', ?6, 1,
             ?5, ?5)
        `,
        args: [communityId, publicPostId, publicPostPayload, anonymousPostId, now, anonymousPostPayload],
      },
      {
        sql: `
          INSERT INTO comment_projections (
            projection_id, community_id, thread_root_post_id, source_comment_id,
            parent_comment_id, depth, status, source_created_at, created_at, updated_at
          ) VALUES
            ('ccp_public', ?1, ?2, ?3, NULL, 0, 'published', '2026-05-12T10:02:00.000Z', ?5, ?5),
            ('ccp_anonymous', ?1, ?2, ?4, NULL, 0, 'published', '2026-05-12T10:01:00.000Z', ?5, ?5)
        `,
        args: [communityId, threadRootPostId, publicComment.comment_id, anonymousComment.comment_id, now],
      },
      {
        sql: `
          INSERT INTO audit_log (
            audit_event_id, actor_type, actor_id, action, target_type, target_id,
            community_id, metadata_json, created_at
          ) VALUES
            ('aud_public_comment', 'user', 'usr_alice', 'community.comment_created', 'comment', ?2,
             ?1, '{}', '2026-05-12T10:02:00.000Z'),
            ('aud_anonymous_comment', 'user', 'usr_alice', 'community.comment_created', 'comment', ?3,
             ?1, '{}', '2026-05-12T10:01:00.000Z')
        `,
        args: [communityId, publicComment.comment_id, anonymousComment.comment_id],
      },
    ])

    const posts = await getProfileActivity({
      env,
      repository: repo,
      targetUserId: "usr_alice",
      viewerUserId: "usr_alice",
      tab: "posts",
      limit: 10,
    })
    expect(posts.posts.map((item) => item.post.post.title)).toEqual(["Public profile post"])

    const comments = await getProfileActivity({
      env,
      repository: repo,
      targetUserId: "usr_alice",
      viewerUserId: "usr_alice",
      tab: "comments",
      limit: 10,
    })
    expect(comments.comments.map((item) => item.comment.comment.body)).toEqual(["Public comment"])

    const overview = await getProfileActivity({
      env,
      repository: repo,
      targetUserId: "usr_alice",
      viewerUserId: "usr_alice",
      tab: "overview",
      limit: 10,
    })
    expect(overview.overview_items.map((item) => item.kind)).toEqual(["post", "comment"])
    expect(overview.next_cursor).toBeNull()
  })
})
