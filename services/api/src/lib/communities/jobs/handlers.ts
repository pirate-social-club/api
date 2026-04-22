import { internalError } from "../../errors"
import { nowIso } from "../../helpers"
import {
  getCommentById,
  getCommunityVisibility,
  getLatestThreadSnapshot,
  insertThreadSnapshot,
  listThreadCommentsForSnapshot,
  updateCommentSwarmBodyRef,
} from "../../comments/community-comment-store"
import { materializeCommentTranslation } from "../../localization/comment-translation-materializer"
import {
  materializeCommunityTextTranslations,
  parseCommunityTextMaterializePayload,
} from "../../localization/community-localization-service"
import { getPostById, updatePostLinkPreviewMetadata } from "../../posts/community-post-store"
import { fetchLinkPreviewMetadata } from "../../posts/link-preview-fetcher"
import { materializePostLabel } from "../../posts/post-label-materializer"
import { materializePostTranslation } from "../../localization/post-translation-materializer"
import { generateSongPreviewForBundle } from "../../song-artifacts/song-artifact-service"
import {
  buildThreadFeedTopic,
  publishCollectionToSwarm,
  publishFeedReference,
  publishJsonToSwarm,
} from "../../swarm/swarm-publisher"
import type { Env } from "../../../types"
import type { CommunityRepository } from "../db-community-repository"
import { loadCommunityProjection } from "../create/service"
import { openCommunityDb } from "../community-db-factory"
import type { CommunityJobRow } from "./store"
import {
  type CommunityJobRepository,
  THREAD_SNAPSHOT_MIN_INTERVAL_MS,
} from "./runner-types"

type CommentProjectionSyncPayload = {
  comment_id?: string
  thread_root_post_id?: string
  parent_comment_id?: string | null
  depth?: number
  status?: "published" | "hidden" | "removed" | "deleted"
  source_created_at?: string
}

type CommentBodyMirrorPayload = {
  comment_id?: string
  thread_root_post_id?: string
}

type ThreadSnapshotPayload = {
  thread_root_post_id?: string
}

type PostTranslationPayload = {
  post_id?: string
  locale?: string | null
}

type PostLabelPayload = {
  post_id?: string
  reason?: "publish" | "edit"
}

type LinkPreviewFetchPayload = {
  post_id?: string
  link_url?: string | null
}

type CommentTranslationPayload = {
  comment_id?: string
  locale?: string | null
}

type CommunityTextTranslationPayload = {
  locale?: string | null
}

type SongPreviewGeneratePayload = {
  song_artifact_bundle_id?: string | null
  primary_audio_content_hash?: string | null
  preview_window?: {
    start_ms: number
    duration_ms: number
  } | null
}

function parseJobPayload<T extends object>(raw: string | null): T | null {
  if (!raw) {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === "object" ? parsed as T : null
  } catch {
    return null
  }
}

async function runCommentProjectionSync(input: {
  job: CommunityJobRow
  env: Env
  communityRepository: CommunityJobRepository
}): Promise<string | null> {
  const db = await openCommunityDb(input.env, input.communityRepository, input.job.community_id)
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

async function runCommentBodyMirror(input: {
  job: CommunityJobRow
  env: Env
  communityRepository: CommunityJobRepository
}): Promise<string | null> {
  const db = await openCommunityDb(input.env, input.communityRepository, input.job.community_id)
  try {
    const payload = parseJobPayload<CommentBodyMirrorPayload>(input.job.payload_json)
    const commentId = payload?.comment_id ?? input.job.subject_id
    const comment = await getCommentById(db.client, commentId)
    if (!comment) {
      throw internalError("Comment is missing for swarm mirror")
    }
    if (comment.swarm_body_ref) {
      return comment.swarm_body_ref
    }

    const community = await getCommunityVisibility(db.client, input.job.community_id)
    if (!community || community.status !== "active") {
      throw internalError("Community is missing for swarm mirror")
    }
    if (community.membership_mode !== "open") {
      return "skipped:non_public_community"
    }
    if (comment.status !== "published") {
      return `skipped:${comment.status}`
    }

    const result = await publishJsonToSwarm({
      env: input.env,
      path: `comments/${comment.comment_id}.json`,
      payload: {
        schema_version: 1,
        community_id: comment.community_id,
        thread_root_post_id: comment.thread_root_post_id,
        comment,
      },
    })

    await updateCommentSwarmBodyRef({
      executor: db.client,
      commentId: comment.comment_id,
      swarmBodyRef: result.reference,
      now: nowIso(),
    })

    return result.reference
  } finally {
    db.close()
  }
}

async function runThreadSnapshotPublish(input: {
  job: CommunityJobRow
  env: Env
  communityRepository: CommunityJobRepository
}): Promise<string | null> {
  const db = await openCommunityDb(input.env, input.communityRepository, input.job.community_id)
  try {
    const payload = parseJobPayload<ThreadSnapshotPayload>(input.job.payload_json)
    const threadRootPostId = payload?.thread_root_post_id ?? input.job.subject_id
    const community = await getCommunityVisibility(db.client, input.job.community_id)
    if (!community || community.status !== "active") {
      throw internalError("Community is missing for thread snapshot publish")
    }
    if (community.membership_mode !== "open") {
      return "skipped:non_public_community"
    }

    const post = await getPostById(db.client, threadRootPostId)
    if (!post) {
      throw internalError("Thread root post is missing for snapshot publish")
    }
    if (post.status !== "published") {
      return `skipped:${post.status}`
    }

    const latestSnapshot = await getLatestThreadSnapshot(db.client, threadRootPostId)
    if (
      latestSnapshot
      && Number.isFinite(Date.parse(latestSnapshot.created_at))
      && (Date.now() - Date.parse(latestSnapshot.created_at)) < THREAD_SNAPSHOT_MIN_INTERVAL_MS
    ) {
      return latestSnapshot.swarm_manifest_ref
    }

    const comments = await listThreadCommentsForSnapshot(db.client, threadRootPostId)
    const latestCommentCreatedAt = comments.at(-1)?.created_at ?? post.created_at
    if (
      latestSnapshot
      && latestSnapshot.comment_count === comments.length
      && latestSnapshot.published_through_comment_created_at === latestCommentCreatedAt
    ) {
      return latestSnapshot.swarm_manifest_ref
    }

    const snapshotSeq = (latestSnapshot?.snapshot_seq ?? 0) + 1
    const result = await publishCollectionToSwarm({
      env: input.env,
      indexDocument: "thread.json",
      files: [
        {
          path: "thread.json",
          payload: {
            schema_version: 1,
            community_id: input.job.community_id,
            thread_root_post_id: threadRootPostId,
            snapshot_seq: snapshotSeq,
            comment_count: comments.length,
            published_through_comment_created_at: latestCommentCreatedAt,
            post,
            comments: comments.map((comment) => ({
              comment_id: comment.comment_id,
              path: `comments/${comment.comment_id}.json`,
              swarm_body_ref: comment.swarm_body_ref,
              parent_comment_id: comment.parent_comment_id,
              depth: comment.depth,
              created_at: comment.created_at,
            })),
          },
        },
        ...comments.map((comment) => ({
          path: `comments/${comment.comment_id}.json`,
          payload: comment,
        })),
      ],
    })

    let swarmFeedRef = latestSnapshot?.swarm_feed_ref ?? null
    if (String(input.env.SWARM_FEED_PRIVATE_KEY || "").trim()) {
      const topic = buildThreadFeedTopic({
        env: input.env,
        communityId: input.job.community_id,
        threadRootPostId,
      })
      const feed = await publishFeedReference({
        env: input.env,
        topic,
        reference: result.reference,
      })
      swarmFeedRef = feed.feedReference
    }

    await insertThreadSnapshot({
      executor: db.client,
      communityId: input.job.community_id,
      threadRootPostId,
      snapshotSeq,
      publishedThroughCommentCreatedAt: latestCommentCreatedAt,
      commentCount: comments.length,
      swarmManifestRef: result.reference,
      swarmFeedRef,
      createdAt: nowIso(),
    })

    return result.reference
  } finally {
    db.close()
  }
}

async function runPostTranslationMaterialize(input: {
  job: CommunityJobRow
  env: Env
  communityRepository: CommunityJobRepository
}): Promise<string | null> {
  const db = await openCommunityDb(input.env, input.communityRepository, input.job.community_id)
  try {
    const payload = parseJobPayload<PostTranslationPayload>(input.job.payload_json)
    const postId = payload?.post_id ?? input.job.subject_id.split(":")[0] ?? input.job.subject_id
    const locale = payload?.locale ?? null
    const post = await getPostById(db.client, postId)
    if (!post) {
      throw internalError("Post is missing for translation materialize")
    }
    return await materializePostTranslation({
      executor: db.client,
      env: input.env,
      post,
      locale,
    })
  } finally {
    db.close()
  }
}

async function runPostLabelMaterialize(input: {
  job: CommunityJobRow
  env: Env
  communityRepository: CommunityJobRepository
}): Promise<string | null> {
  const db = await openCommunityDb(input.env, input.communityRepository, input.job.community_id)
  try {
    const payload = parseJobPayload<PostLabelPayload>(input.job.payload_json)
    const postId = payload?.post_id ?? input.job.subject_id
    const post = await getPostById(db.client, postId)
    if (!post) {
      throw internalError("Post is missing for label materialize")
    }

    const communityRow = await input.communityRepository.getCommunityById(input.job.community_id)
    if (!communityRow) {
      throw internalError("Community is missing for label materialize")
    }

    const community = await loadCommunityProjection(
      input.env,
      input.communityRepository as CommunityRepository,
      communityRow,
    )

    return await materializePostLabel({
      executor: db.client,
      env: input.env,
      community,
      post,
    })
  } finally {
    db.close()
  }
}

async function runLinkPreviewFetch(input: {
  job: CommunityJobRow
  env: Env
  communityRepository: CommunityJobRepository
}): Promise<string | null> {
  const db = await openCommunityDb(input.env, input.communityRepository, input.job.community_id)
  try {
    const payload = parseJobPayload<LinkPreviewFetchPayload>(input.job.payload_json)
    const postId = payload?.post_id ?? input.job.subject_id
    const post = await getPostById(db.client, postId)
    if (!post) {
      throw internalError("Post is missing for link preview fetch")
    }
    if (post.post_type !== "link") {
      return "skipped:not_link_post"
    }
    if (post.link_og_image_url && post.link_og_title) {
      return post.link_og_image_url
    }

    const linkUrl = post.link_url ?? payload?.link_url ?? null
    if (!linkUrl?.trim()) {
      return "skipped:missing_link_url"
    }

    const metadata = await fetchLinkPreviewMetadata({ url: linkUrl })
    if (!metadata.imageUrl && !metadata.title) {
      return "skipped:no_preview_metadata"
    }

    await updatePostLinkPreviewMetadata({
      client: db.client,
      postId: post.post_id,
      linkOgImageUrl: metadata.imageUrl,
      linkOgTitle: metadata.title,
      updatedAt: nowIso(),
    })

    return metadata.imageUrl ?? metadata.title
  } finally {
    db.close()
  }
}

async function runCommentTranslationMaterialize(input: {
  job: CommunityJobRow
  env: Env
  communityRepository: CommunityJobRepository
}): Promise<string | null> {
  const db = await openCommunityDb(input.env, input.communityRepository, input.job.community_id)
  try {
    const payload = parseJobPayload<CommentTranslationPayload>(input.job.payload_json)
    const commentId = payload?.comment_id ?? input.job.subject_id.split(":")[0] ?? input.job.subject_id
    const locale = payload?.locale ?? null
    const comment = await getCommentById(db.client, commentId)
    if (!comment) {
      throw internalError("Comment is missing for translation materialize")
    }
    return await materializeCommentTranslation({
      executor: db.client,
      env: input.env,
      comment,
      locale,
    })
  } finally {
    db.close()
  }
}

async function runCommunityTextTranslationMaterialize(input: {
  job: CommunityJobRow
  env: Env
  communityRepository: CommunityJobRepository
}): Promise<string | null> {
  const db = await openCommunityDb(input.env, input.communityRepository, input.job.community_id)
  try {
    const payload = parseCommunityTextMaterializePayload(input.job.payload_json) as CommunityTextTranslationPayload | null
    const locale = payload?.locale ?? null
    const communityRow = await input.communityRepository.getCommunityById(input.job.community_id)
    if (!communityRow) {
      throw internalError("Community is missing for text translation materialize")
    }

    const community = await loadCommunityProjection(
      input.env,
      input.communityRepository as CommunityRepository,
      communityRow,
    )
    return await materializeCommunityTextTranslations({
      executor: db.client,
      env: input.env,
      community,
      locale,
    })
  } finally {
    db.close()
  }
}

async function runSongPreviewGenerate(input: {
  job: CommunityJobRow
  env: Env
  communityRepository: CommunityJobRepository
}): Promise<string | null> {
  const payload = parseJobPayload<SongPreviewGeneratePayload>(input.job.payload_json)
  return await generateSongPreviewForBundle({
    env: input.env,
    communityId: input.job.community_id,
    songArtifactBundleId: payload?.song_artifact_bundle_id ?? input.job.subject_id,
    expectedPrimaryAudioContentHash: payload?.primary_audio_content_hash ?? null,
  })
}

export async function runCommunityJob(input: {
  job: CommunityJobRow
  env: Env
  communityRepository: CommunityJobRepository
}): Promise<string | null> {
  switch (input.job.job_type) {
    case "comment_projection_sync":
      return runCommentProjectionSync(input)
    case "comment_body_mirror":
      return runCommentBodyMirror(input)
    case "thread_snapshot_publish":
      return runThreadSnapshotPublish(input)
    case "link_preview_fetch":
      return runLinkPreviewFetch(input)
    case "post_label_materialize":
      return runPostLabelMaterialize(input)
    case "post_translation_materialize":
      return runPostTranslationMaterialize(input)
    case "comment_translation_materialize":
      return runCommentTranslationMaterialize(input)
    case "community_text_translation_materialize":
      return runCommunityTextTranslationMaterialize(input)
    case "song_preview_generate":
      return runSongPreviewGenerate(input)
    default:
      throw internalError(`Unsupported community job type: ${input.job.job_type}`)
  }
}
