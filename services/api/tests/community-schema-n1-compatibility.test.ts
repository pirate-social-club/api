import { describe, expect, test } from "bun:test"
import { createClient } from "@libsql/client"
import {
  createCommunityDbThroughMigration,
  getMigrationBeforeCommunityMigration,
  getNMinusOneCommunityMigrationName,
} from "./community-db-test-harness"
import { REQUIRED_COMMUNITY_DB_MIGRATION } from "../src/lib/community-db-schema-requirement"
import { HttpError } from "../src/lib/errors"
import { insertComment, listTopLevelComments } from "../src/lib/comments/community-comment-store"
import { getCommunityMembershipState } from "../src/lib/communities/membership/membership-state-store"
import { insertPostForTest as insertPost } from "./community-test-helpers"
import { listPublishedLocalizedPosts } from "../src/lib/posts/community-post-feed"
import { getPostById } from "../src/lib/posts/community-post-query-store"
import { upsertPostVote } from "../src/lib/posts/community-post-vote-store"

const communityId = "cmt_schema_n1"
const userId = "usr_schema_n1"
const now = "2026-05-16T00:00:00.000Z"

async function seedCommunityAndMember(client: ReturnType<typeof createClient>): Promise<void> {
  await client.execute({
    sql: `
      INSERT INTO communities (
        community_id, display_name, status, artist_governance_state, membership_mode,
        default_age_gate_policy, donation_policy_mode, donation_partner_status,
        governance_mode, created_by_user_id, created_at, updated_at
      ) VALUES (
        ?1, 'Schema N-1', 'active', 'fan_run', 'open',
        'none', 'none', 'unconfigured',
        'centralized', ?2, ?3, ?3
      )
    `,
    args: [communityId, userId, now],
  })
  await client.execute({
    sql: `
      INSERT INTO community_memberships (
        membership_id, community_id, user_id, status, joined_at, left_at, banned_at, created_at, updated_at
      ) VALUES (
        'mbr_schema_n1', ?1, ?2, 'member', ?3, NULL, NULL, ?3, ?3
      )
    `,
    args: [communityId, userId, now],
  })
}

function expectNotRawSqlError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  expect(message).not.toContain("no such column")
  expect(message).not.toContain("SQL_INPUT_ERROR")
}

describe("N-1 community schema compatibility", () => {
  test("core post, comment, vote, reaction, and membership paths work on the previous community schema", async () => {
    const client = createClient({ url: "file::memory:" })
    try {
      await createCommunityDbThroughMigration(client, await getNMinusOneCommunityMigrationName())
      await seedCommunityAndMember(client)

      const post = await insertPost({
        client,
        communityId,
        authorUserId: userId,
        body: {
          idempotency_key: "schema-n1-post",
          post_type: "text",
          title: "N-1 post",
          body: "Existing post behavior should survive one migration of drift.",
        },
        createdAt: now,
      })
      const readPost = await getPostById(client, post.post_id)
      expect(readPost?.title).toBe("N-1 post")
      expect(readPost?.comments_locked).toBe(false)

      const comment = await insertComment({
        executor: client,
        communityId,
        threadRootPostId: post.post_id,
        parentCommentId: null,
        authorUserId: userId,
        body: {
          idempotency_key: "schema-n1-comment",
          body: "N-1 comment",
        },
        sourceLanguage: "en",
        depth: 0,
        createdAt: now,
        contentHash: null,
      })
      const comments = await listTopLevelComments({
        executor: client,
        threadRootPostId: post.post_id,
        viewerUserId: userId,
        limit: 10,
        sort: "new",
      })
      expect(comments.items.map((item) => item.comment.comment_id)).toContain(comment.comment_id)

      await upsertPostVote({
        client,
        postId: post.post_id,
        communityId,
        userId,
        value: 1,
        now,
      })
      await client.execute({
        sql: `
          INSERT INTO post_reactions (
            post_reaction_id, post_id, community_id, user_id, reaction_key, created_at
          ) VALUES (
            'prx_schema_n1', ?1, ?2, ?3, 'like', ?4
          )
        `,
        args: [post.post_id, communityId, userId, now],
      })
      const feed = await listPublishedLocalizedPosts({
        client,
        communityId,
        viewerUserId: userId,
        limit: 10,
        sort: "new",
      })
      const feedItem = feed.items.find((item) => item.post.post_id === post.post_id)
      expect(feedItem?.upvote_count).toBe(1)
      expect(feedItem?.like_count).toBe(1)

      const membership = await getCommunityMembershipState(client, communityId, userId)
      expect(membership.membership_status).toBe("member")
    } catch (error) {
      expectNotRawSqlError(error)
      throw error
    } finally {
      client.close()
    }
  })

  test("crosspost creation fails gracefully before its required migration is present", async () => {
    const client = createClient({ url: "file::memory:" })
    try {
      await createCommunityDbThroughMigration(client, await getMigrationBeforeCommunityMigration(REQUIRED_COMMUNITY_DB_MIGRATION))
      await seedCommunityAndMember(client)

      await insertPost({
        client,
        communityId,
        authorUserId: userId,
        body: {
          idempotency_key: "schema-pre-crosspost",
          post_type: "crosspost",
          title: "Crosspost before migration",
          source_post: "post_pst_source",
          source_community: "com_cmt_source",
          crosspost_source: {
            post_id: "pst_source",
            community_id: "cmt_source",
            captured_at: now,
          },
        } as Parameters<typeof insertPost>[0]["body"],
        createdAt: now,
      })
      throw new Error("Expected crosspost creation to fail before required migration")
    } catch (error) {
      expectNotRawSqlError(error)
      expect(error).toBeInstanceOf(HttpError)
      expect((error as HttpError).code).toBe("provider_unavailable")
      expect((error as HttpError).details).toMatchObject({
        missing_column: "posts.crosspost_source_json",
      })
    } finally {
      client.close()
    }
  })
})
