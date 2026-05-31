import type { Client } from "@libsql/client"
import type { CommunityDatabaseBindingRepository } from "../src/lib/communities/db-community-repository"
import { getCommentById } from "../src/lib/comments/community-comment-store"
import type { CommentStatus } from "../src/lib/comments/comment-types"
import type { Env } from "../src/types"
import {
  buildTestCommunityRepository,
  buildUserRepository,
  buildVerifiedUser,
  cleanupCommunityTestArtifacts,
  createCommunityTestRoot,
  seedTestCommunityState,
  type TestCommunityRepository,
} from "./community-test-helpers"

export { buildUserRepository, buildVerifiedUser }
export type { TestCommunityRepository }

const cleanupPaths: string[] = []

export async function cleanupCommentServiceArtifacts(): Promise<void> {
  await cleanupCommunityTestArtifacts(cleanupPaths)
}

export async function createCommentServiceRoot(prefix: string): Promise<string> {
  return await createCommunityTestRoot(cleanupPaths, prefix)
}

export function buildCommunityRepository(databasePath: string, communityId: string): TestCommunityRepository {
  return buildTestCommunityRepository({
    databasePath,
    communityId,
    displayName: "Comments Test Community",
    primaryDatabaseBindingId: "cdb_comments",
    databaseName: "community-comments",
  })
}

export async function seedCommunityState(input: {
  env: Env
  repo: CommunityDatabaseBindingRepository
  communityId: string
  memberUserIds: string[]
}): Promise<{ postId: string }> {
  return await seedTestCommunityState({
    ...input,
    displayName: "Comments Test Community",
    rootPostTitle: "Thread Root",
  })
}

export async function fetchCommunityJobs(client: Client): Promise<Array<{ job_type: string; subject_id: string; payload_json: string | null }>> {
  const result = await client.execute(`
    SELECT job_type, subject_id, payload_json
    FROM community_jobs
    ORDER BY created_at ASC, job_id ASC
  `)
  return result.rows.map((row) => ({
    job_type: String(row.job_type),
    subject_id: String(row.subject_id),
    payload_json: row.payload_json == null ? null : String(row.payload_json),
  }))
}

export async function fetchPostCounters(client: Client, postId: string): Promise<{ comment_count: number; top_level_comment_count: number; last_comment_at: string | null }> {
  const result = await client.execute({
    sql: `
      SELECT comment_count, top_level_comment_count, last_comment_at
      FROM posts
      WHERE post_id = ?1
      LIMIT 1
    `,
    args: [postId],
  })
  const row = result.rows[0] ?? {}
  return {
    comment_count: Number(row.comment_count ?? 0),
    top_level_comment_count: Number(row.top_level_comment_count ?? 0),
    last_comment_at: row.last_comment_at == null ? null : String(row.last_comment_at),
  }
}

export async function fetchClosureRows(client: Client): Promise<Array<{ ancestor_comment_id: string; descendant_comment_id: string; distance: number }>> {
  const result = await client.execute(`
    SELECT ancestor_comment_id, descendant_comment_id, distance
    FROM comment_closure
    ORDER BY ancestor_comment_id ASC, descendant_comment_id ASC, distance ASC
  `)
  return result.rows.map((row) => ({
    ancestor_comment_id: String(row.ancestor_comment_id),
    descendant_comment_id: String(row.descendant_comment_id),
    distance: Number(row.distance),
  }))
}

export async function fetchCommentStatus(client: Client, commentId: string): Promise<{ status: CommentStatus; body: string | null; upvote_count: number; downvote_count: number; score: number; direct_reply_count: number; descendant_count: number }> {
  const comment = await getCommentById(client, commentId)
  if (!comment) {
    throw new Error("Missing comment")
  }
  return {
    status: comment.status,
    body: comment.body,
    upvote_count: comment.upvote_count,
    downvote_count: comment.downvote_count,
    score: comment.score,
    direct_reply_count: comment.direct_reply_count,
    descendant_count: comment.descendant_count,
  }
}
