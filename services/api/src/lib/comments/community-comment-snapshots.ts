import type { DbExecutor } from "../db-helpers"
import { executeFirst } from "../db-helpers"
import { internalError } from "../errors"
import { makeId } from "../helpers"
import type { CommentThreadSnapshot } from "./comment-types"
import {
  type ThreadSnapshotRow,
  serializeThreadSnapshot,
  toThreadSnapshotRow,
} from "./community-comment-serialization"

export async function getLatestThreadSnapshot(
  executor: DbExecutor,
  threadRootPostId: string,
): Promise<ThreadSnapshotRow | null> {
  const row = await executeFirst(executor, {
    sql: `
      SELECT thread_snapshot_id, community_id, thread_root_post_id, snapshot_seq,
             published_through_comment_created_at, comment_count, swarm_manifest_ref,
             swarm_feed_ref, created_at
      FROM thread_snapshots
      WHERE thread_root_post_id = ?1
      ORDER BY snapshot_seq DESC, created_at DESC
      LIMIT 1
    `,
    args: [threadRootPostId],
  })

  return row ? toThreadSnapshotRow(row) : null
}

export async function getLatestThreadSnapshotForRead(
  executor: DbExecutor,
  threadRootPostId: string,
): Promise<CommentThreadSnapshot | null> {
  const snapshot = await getLatestThreadSnapshot(executor, threadRootPostId)
  return snapshot ? serializeThreadSnapshot(snapshot) : null
}

export async function insertThreadSnapshot(input: {
  executor: DbExecutor
  communityId: string
  threadRootPostId: string
  snapshotSeq: number
  publishedThroughCommentCreatedAt: string
  commentCount: number
  swarmManifestRef: string
  swarmFeedRef?: string | null
  createdAt: string
}): Promise<ThreadSnapshotRow> {
  const threadSnapshotId = makeId("tsn")
  await input.executor.execute({
    sql: `
      INSERT INTO thread_snapshots (
        thread_snapshot_id, community_id, thread_root_post_id, snapshot_seq,
        published_through_comment_created_at, comment_count, swarm_manifest_ref,
        swarm_feed_ref, created_at
      ) VALUES (
        ?1, ?2, ?3, ?4,
        ?5, ?6, ?7,
        ?8, ?9
      )
    `,
    args: [
      threadSnapshotId,
      input.communityId,
      input.threadRootPostId,
      input.snapshotSeq,
      input.publishedThroughCommentCreatedAt,
      input.commentCount,
      input.swarmManifestRef,
      input.swarmFeedRef ?? null,
      input.createdAt,
    ],
  })

  const created = await executeFirst(input.executor, {
    sql: `
      SELECT thread_snapshot_id, community_id, thread_root_post_id, snapshot_seq,
             published_through_comment_created_at, comment_count, swarm_manifest_ref,
             swarm_feed_ref, created_at
      FROM thread_snapshots
      WHERE thread_snapshot_id = ?1
      LIMIT 1
    `,
    args: [threadSnapshotId],
  })

  if (!created) {
    throw internalError("Thread snapshot row is missing after insert")
  }

  return toThreadSnapshotRow(created)
}
