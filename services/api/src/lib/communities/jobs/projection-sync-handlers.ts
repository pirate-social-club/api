import { getCommentById } from "../../comments/community-comment-store"
import { internalError } from "../../errors"
import { nowIso } from "../../helpers"
import { getPostById } from "../../posts/community-post-query-store"
import { openCommunityWriteClient } from "../community-read-access"
import type { CommunityJobHandlerInput } from "./handler-types"
import { parseJobPayload } from "./payload"

type CommentProjectionSyncPayload = {
  comment_id?: string
  thread_root_post_id?: string
  parent_comment_id?: string | null
  depth?: number
  status?: "published" | "hidden" | "removed" | "deleted"
  source_created_at?: string
}

type PostProjectionSyncPayload = {
  post_id?: string
  source_created_at?: string
}

export async function runCommentProjectionSync(input: CommunityJobHandlerInput): Promise<string | null> {
  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.job.community_id)
  try {
    const payload = parseJobPayload<CommentProjectionSyncPayload>(input.job.payload_json)
    const commentId = payload?.comment_id ?? input.job.subject_id
    const comment = await getCommentById(db.client, commentId)
    if (!comment) {
      throw internalError("Comment is missing for projection sync")
    }

    const community = await input.communityRepository.getCommunityById(input.job.community_id)
    if (!community) {
      throw internalError("Community is missing for projection sync")
    }

    const authorRow = await db.client.execute({
      sql: `
        SELECT author_user_id
        FROM comments
        WHERE comment_id = ?1
        LIMIT 1
      `,
      args: [commentId],
    })
    const actorUserId = String(authorRow.rows[0]?.author_user_id ?? "").trim() || community.creator_user_id

    await input.communityRepository.recordCommunityCommentProjection({
      communityId: comment.community_id,
      threadRootPostId: comment.thread_root_post_id,
      sourceCommentId: comment.comment_id,
      parentCommentId: comment.parent_comment_id,
      depth: comment.depth,
      status: comment.status,
      sourceCreatedAt: comment.created_at,
      actorUserId,
      createdAt: nowIso(),
    })

    return comment.comment_id
  } finally {
    db.close()
  }
}

export async function runPostProjectionSync(input: CommunityJobHandlerInput): Promise<string | null> {
  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.job.community_id)
  try {
    const payload = parseJobPayload<PostProjectionSyncPayload>(input.job.payload_json)
    const postId = payload?.post_id ?? input.job.subject_id
    const existing = await input.communityRepository.getCommunityPostProjectionByPostId(postId)
    if (existing) {
      return postId
    }

    const post = await getPostById(db.client, postId)
    if (!post) {
      throw internalError("Post is missing for projection sync")
    }

    const community = await input.communityRepository.getCommunityById(input.job.community_id)
    if (!community) {
      throw internalError("Community is missing for projection sync")
    }

    await input.communityRepository.recordCommunityPostProjection({
      communityId: post.community_id,
      sourcePostId: post.post_id,
      authorUserId: post.author_user_id ?? null,
      identityMode: post.identity_mode,
      postType: post.post_type,
      status: post.status,
      visibility: post.visibility,
      sourceCreatedAt: post.created_at,
      projectedPayloadJson: JSON.stringify(post),
      actorUserId: post.author_user_id ?? community.creator_user_id,
      createdAt: nowIso(),
    })

    return post.post_id
  } finally {
    db.close()
  }
}
