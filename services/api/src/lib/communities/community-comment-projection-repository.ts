import type { Client } from "../sql-client"
import { internalError } from "../errors"
import { makeId } from "../helpers"
import { getCommunityCommentProjectionRowByCommentId } from "../auth/auth-db-community-queries"
import type { CommunityCommentProjectionRow } from "../auth/auth-db-rows"

export async function recordCommunityCommentProjection(
  client: Client,
  input: {
    communityId: string
    threadRootPostId: string
    sourceCommentId: string
    parentCommentId: string | null
    depth: number
    status: "published" | "hidden" | "removed" | "deleted"
    sourceCreatedAt: string
    actorUserId: string
    createdAt: string
  },
): Promise<CommunityCommentProjectionRow> {
  const existing = await getCommunityCommentProjectionRowByCommentId(client, input.sourceCommentId)
  const projectionId = existing?.projection_id ?? makeId("ccp")
  const auditEventId = makeId("aud")
  const tx = await client.transaction("write")

  try {
    await tx.batch([
      {
        sql: `
          INSERT INTO comment_projections (
            projection_id, community_id, thread_root_post_id, source_comment_id, parent_comment_id,
            depth, status, source_created_at, created_at, updated_at
          ) VALUES (
            ?1, ?2, ?3, ?4, ?5,
            ?6, ?7, ?8, ?9, ?9
          )
          ON CONFLICT(community_id, source_comment_id) DO UPDATE SET
            thread_root_post_id = excluded.thread_root_post_id,
            parent_comment_id = excluded.parent_comment_id,
            depth = excluded.depth,
            status = excluded.status,
            source_created_at = excluded.source_created_at,
            updated_at = excluded.updated_at
        `,
        args: [
          projectionId,
          input.communityId,
          input.threadRootPostId,
          input.sourceCommentId,
          input.parentCommentId,
          input.depth,
          input.status,
          input.sourceCreatedAt,
          input.createdAt,
        ],
      },
      {
        sql: `
          INSERT INTO audit_log (
            audit_event_id, actor_type, actor_id, action, target_type, target_id, community_id, metadata_json, created_at
          ) VALUES (
            ?1, 'user', ?2, ?3, 'comment', ?4, ?5, ?6, ?7
          )
        `,
        args: [
          auditEventId,
          input.actorUserId,
          existing ? "community.comment_projection_synced" : "community.comment_created",
          input.sourceCommentId,
          input.communityId,
          JSON.stringify({
            projection_id: projectionId,
            thread_root_post_id: input.threadRootPostId,
            parent_comment_id: input.parentCommentId,
            previous_status: existing?.status ?? null,
            next_status: input.status,
            source_created_at: input.sourceCreatedAt,
          }),
          input.createdAt,
        ],
      },
    ])

    const projection = await getCommunityCommentProjectionRowByCommentId(tx, input.sourceCommentId)
    if (!projection) {
      throw internalError("Community comment projection is missing after insert")
    }

    await tx.commit()
    return projection
  } catch (error) {
    try {
      await tx.rollback()
    } catch {}
    throw error
  } finally {
    tx.close()
  }
}
