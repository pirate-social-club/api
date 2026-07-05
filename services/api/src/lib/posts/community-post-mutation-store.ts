import type { DbExecutor } from "../db-helpers"
import { internalError } from "../errors"
import { makeId } from "../helpers"
import type { CreatePostRequest, Post, SongArtifactBundle } from "../../types"
import { getPostById } from "./community-post-query-store"

type SongMediaRef = NonNullable<Extract<CreatePostRequest, { post_type: "song" }>["media_refs"]>[number]

/**
 * Marks a post deleted. WRITE-ONLY (no in-tx readback) so it is safe inside a
 * buffered D1 write transaction, where a read of the just-written row would see
 * nothing until commit. Callers that need the post read it after commit (or, for
 * the deterministic status/updated_at, construct it from their inputs).
 */
export async function markPostDeleted(input: {
  executor: DbExecutor
  postId: string
  now: string
}): Promise<void> {
  await input.executor.execute({
    sql: `
      UPDATE posts
      SET status = 'deleted',
          updated_at = ?2
      WHERE post_id = ?1
    `,
    args: [input.postId, input.now],
  })
}

export async function setPostStatus(input: {
  executor: DbExecutor
  postId: string
  status: "published" | "hidden" | "removed"
  now: string
}): Promise<Post> {
  await input.executor.execute({
    sql: `
      UPDATE posts
      SET status = ?2,
          updated_at = ?3
      WHERE post_id = ?1
    `,
    args: [input.postId, input.status, input.now],
  })

  const updated = await getPostById(input.executor, input.postId)
  if (!updated) {
    throw internalError("Post row is missing after status update")
  }
  return updated
}

export async function markPostPublishFailed(input: {
  executor: DbExecutor
  postId: string
  failureCode: NonNullable<Post["publish_failure_code"]>
  failureMessage: string
  retryable: boolean
  now: string
}): Promise<Post> {
  await input.executor.execute({
    sql: `
      UPDATE posts
      SET status = 'failed',
          publish_failure_code = ?2,
          publish_failure_message = ?3,
          publish_failure_retryable = ?4,
          publish_failed_at = ?5,
          updated_at = ?5
      WHERE post_id = ?1
    `,
    args: [input.postId, input.failureCode, input.failureMessage, input.retryable ? 1 : 0, input.now],
  })

  const updated = await getPostById(input.executor, input.postId)
  if (!updated) {
    throw internalError("Post row is missing after publish failure update")
  }
  return updated
}

export async function markPostPublished(input: {
  executor: DbExecutor
  postId: string
  analysisState: Post["analysis_state"]
  contentSafetyState: Post["content_safety_state"]
  ageGatePolicy: Post["age_gate_policy"]
  now: string
}): Promise<Post> {
  await input.executor.execute({
    sql: `
      UPDATE posts
      SET status = 'published',
          analysis_state = ?2,
          content_safety_state = ?3,
          age_gate_policy = ?4,
          publish_failure_code = NULL,
          publish_failure_message = NULL,
          publish_failure_retryable = NULL,
          publish_failed_at = NULL,
          updated_at = ?5
      WHERE post_id = ?1
    `,
    args: [input.postId, input.analysisState, input.contentSafetyState, input.ageGatePolicy, input.now],
  })

  const updated = await getPostById(input.executor, input.postId)
  if (!updated) {
    throw internalError("Post row is missing after publish update")
  }
  return updated
}

export async function assignPostAssetIdIfMissing(input: {
  executor: DbExecutor
  postId: string
  now: string
}): Promise<Post> {
  const assetId = makeId("ast")
  await input.executor.execute({
    sql: `
      UPDATE posts
      SET asset_id = ?2,
          updated_at = ?3
      WHERE post_id = ?1
        AND (asset_id IS NULL OR TRIM(asset_id) = '')
    `,
    args: [input.postId, assetId, input.now],
  })

  const updated = await getPostById(input.executor, input.postId)
  if (!updated) {
    throw internalError("Post row is missing after asset assignment")
  }
  if (!updated.asset_id?.trim()) {
    throw internalError("Post asset_id is missing after asset assignment")
  }
  return updated
}

export async function syncLockedSongPreviewMediaRefsForBundle(input: {
  executor: DbExecutor
  songArtifactBundleId: string
  previewAudio: NonNullable<SongArtifactBundle["preview_audio"]>
  now: string
}): Promise<Post[]> {
  if (!input.previewAudio.storage_ref?.trim() || !input.previewAudio.mime_type?.trim()) {
    return []
  }
  const mediaRef: SongMediaRef = {
    storage_ref: input.previewAudio.storage_ref,
    mime_type: input.previewAudio.mime_type,
    size_bytes: input.previewAudio.size_bytes ?? null,
    content_hash: input.previewAudio.content_hash ?? null,
    duration_ms: input.previewAudio.duration_ms ?? null,
    decentralized_storage: input.previewAudio.decentralized_storage ?? null,
  }
  const mediaRefsJson = JSON.stringify([mediaRef])
  const result = await input.executor.execute({
    sql: `
      UPDATE posts
      SET media_refs_json = ?2,
          updated_at = ?3
      WHERE song_artifact_bundle_id = ?1
        AND post_type = 'song'
        AND access_mode = 'locked'
        AND status IN ('processing', 'published')
        AND (media_refs_json IS NULL OR TRIM(media_refs_json) = '' OR media_refs_json = '[]')
      RETURNING post_id
    `,
    args: [input.songArtifactBundleId, mediaRefsJson, input.now],
  })

  const posts: Post[] = []
  for (const row of result.rows) {
    const postId = typeof row.post_id === "string" ? row.post_id : null
    if (!postId) {
      continue
    }
    const post = await getPostById(input.executor, postId)
    if (post) {
      posts.push(post)
    }
  }
  return posts
}

export async function setPostCommentsLocked(input: {
  executor: DbExecutor
  postId: string
  locked: boolean
  actorUserId: string
  reason: string | null
  now: string
}): Promise<Post> {
  await input.executor.execute({
    sql: `
      UPDATE posts
      SET comments_locked = ?2,
          comments_locked_at = CASE WHEN ?2 = 1 THEN ?3 ELSE NULL END,
          comments_locked_by_user_id = CASE WHEN ?2 = 1 THEN ?4 ELSE NULL END,
          comments_lock_reason = CASE WHEN ?2 = 1 THEN ?5 ELSE NULL END,
          updated_at = ?3
      WHERE post_id = ?1
    `,
    args: [input.postId, input.locked ? 1 : 0, input.now, input.actorUserId, input.reason],
  })

  const updated = await getPostById(input.executor, input.postId)
  if (!updated) {
    throw internalError("Post row is missing after lock update")
  }
  return {
    ...updated,
    comments_locked: input.locked,
    comments_locked_at: input.locked ? input.now : null,
    comments_locked_by_user_id: input.locked ? input.actorUserId : null,
    comments_lock_reason: input.locked ? input.reason : null,
  }
}
