import type { Client } from "../sql-client"
import { internalError } from "../errors"
import { makeId } from "../helpers"
import { auditEventInsert } from "../audit"
import {
  getCommunityPostProjectionRowByPostId,
  updateCommunityPostProjectionMetricsRow,
  updateCommunityPostProjectionPayloadRow,
  updateCommunityPostProjectionStatusRow,
} from "../auth/auth-db-community-queries"
import type { CommunityPostProjectionRow } from "../auth/auth-db-rows"

export async function recordCommunityPostProjection(
  client: Client,
  input: {
    communityId: string
    sourcePostId: string
    authorUserId: string | null
    identityMode: "public" | "anonymous"
    postType: "text" | "image" | "video" | "link" | "song" | "crosspost"
    status: "draft" | "published" | "hidden" | "removed" | "deleted"
    visibility: "public" | "members_only"
    sourceCreatedAt: string
    projectedPayloadJson: string
    actorUserId: string
    createdAt: string
  },
): Promise<CommunityPostProjectionRow> {
  const projectionId = makeId("cpp")
  const tx = await client.transaction("write")

  try {
    await tx.batch([
      {
        sql: `
          INSERT INTO community_post_projections (
            projection_id, community_id, source_post_id, author_user_id, identity_mode, post_type, status, visibility,
            source_created_at, projected_payload_json, upvote_count, downvote_count, comment_count, like_count,
            projection_version, created_at, updated_at
          ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
            ?9, ?10, 0, 0, 0, 0, 1, ?11, ?11
          )
        `,
        args: [
          projectionId,
          input.communityId,
          input.sourcePostId,
          input.authorUserId,
          input.identityMode,
          input.postType,
          input.status,
          input.visibility,
          input.sourceCreatedAt,
          input.projectedPayloadJson,
          input.createdAt,
        ],
      },
      auditEventInsert({
        action: "community.post_created",
        actorId: input.actorUserId,
        actorType: "user",
        communityId: input.communityId,
        createdAt: input.createdAt,
        targetId: input.sourcePostId,
        targetType: "post",
        metadata: {
          projection_id: projectionId,
          source_created_at: input.sourceCreatedAt,
        },
      }),
    ])

    const projection = await getCommunityPostProjectionRowByPostId(tx, input.sourcePostId)
    if (!projection) {
      throw internalError("Community post projection is missing after insert")
    }

    await tx.commit()
    return projection
  } catch (error) {
    try {
      await tx.rollback()
    } catch (rollbackError) {
      console.error("[community-post-projection] rollback failed while recording post projection", rollbackError)
    }
    throw error
  } finally {
    tx.close()
  }
}

export async function updateCommunityPostProjectionStatus(
  client: Client,
  input: {
    postId: string
    status: CommunityPostProjectionRow["status"]
    updatedAt: string
  },
): Promise<void> {
  await updateCommunityPostProjectionStatusRow({
    executor: client,
    postId: input.postId,
    status: input.status,
    updatedAt: input.updatedAt,
  })
}

export async function updateCommunityPostProjectionPayload(
  client: Client,
  input: {
    postId: string
    projectedPayloadJson: string
    updatedAt: string
  },
): Promise<void> {
  await updateCommunityPostProjectionPayloadRow({
    executor: client,
    postId: input.postId,
    projectedPayloadJson: input.projectedPayloadJson,
    updatedAt: input.updatedAt,
  })
}

export async function updateCommunityPostProjectionMetrics(
  client: Client,
  input: {
    postId: string
    upvoteCount: number
    downvoteCount: number
    commentCount: number
    likeCount: number
    updatedAt: string
  },
): Promise<void> {
  await updateCommunityPostProjectionMetricsRow({
    executor: client,
    postId: input.postId,
    upvoteCount: input.upvoteCount,
    downvoteCount: input.downvoteCount,
    commentCount: input.commentCount,
    likeCount: input.likeCount,
    updatedAt: input.updatedAt,
  })
}
