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
import { getPostById } from "../../posts/community-post-store"
import { hydrateLinkPostEmbed } from "../../posts/embed-hydrator"
import {
  generateAndStoreLinkSummary,
  listLinkSummaryFanoutUsages,
  markLinkSummaryFanoutSynced,
  writeLinkEnrichmentSnapshotToPost,
} from "../../posts/link-enrichment/summary-service"
import { upsertLinkEnrichmentUsage } from "../../posts/link-enrichment/repository"
import { materializePostLabel } from "../../posts/post-label-materializer"
import { materializePostTranslation } from "../../localization/post-translation-materializer"
import { generateSongPreviewForBundle } from "../../song-artifacts/song-artifact-preview-service"
import {
  buildThreadFeedTopic,
  publishCollectionToSwarm,
  publishFeedReference,
  publishJsonToSwarm,
} from "../../swarm/swarm-publisher"
import type { Env } from "../../../env"
import { getControlPlaneClient } from "../../runtime-deps"
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

type EmbedHydratePayload = {
  post_id?: string
  link_url?: string | null
}

type LinkSummaryMaterializePayload = {
  normalized_url?: string | null
  post_id?: string | null
}

type CommentTranslationPayload = {
  comment_id?: string
  locale?: string | null
}

type CommunityTextTranslationPayload = {
  locale?: string | null
}

type SongPreviewGeneratePayload = {
  song_artifact_bundle?: string | null
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
    if (String(community.membership_mode) !== "open") {
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
    if (String(community.membership_mode) !== "open") {
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
      input.communityRepository,
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

async function runEmbedHydrate(input: {
  job: CommunityJobRow
  env: Env
  communityRepository: CommunityJobRepository
}): Promise<string | null> {
  const db = await openCommunityDb(input.env, input.communityRepository, input.job.community_id)
  try {
    const payload = parseJobPayload<EmbedHydratePayload>(input.job.payload_json)
    const postId = payload?.post_id ?? input.job.subject_id
    const post = await getPostById(db.client, postId)
    if (!post) {
      throw internalError("Post is missing for embed hydration")
    }

    return await hydrateLinkPostEmbed({
      client: db.client,
      controlPlaneClient: input.env.CONTROL_PLANE_DATABASE_URL ? getControlPlaneClient(input.env) : null,
      env: input.env,
      post: {
        ...post,
        link_url: post.link_url ?? payload?.link_url ?? null,
      },
      checkedAt: nowIso(),
    })
  } finally {
    db.close()
  }
}

async function runLinkSummaryMaterialize(input: {
  job: CommunityJobRow
  env: Env
  communityRepository: CommunityJobRepository
}): Promise<string | null> {
  const payload = parseJobPayload<LinkSummaryMaterializePayload>(input.job.payload_json)
  const normalizedUrl = String(payload?.normalized_url ?? input.job.subject_id).trim()
  if (!normalizedUrl) {
    throw internalError("Link summary job is missing normalized URL")
  }
  if (!input.env.CONTROL_PLANE_DATABASE_URL) {
    throw internalError("Control-plane database is missing for link summary materialize")
  }

  const controlPlaneClient = getControlPlaneClient(input.env)
  const now = nowIso()
  const summary = await generateAndStoreLinkSummary({
    env: input.env,
    controlPlaneClient,
    normalizedUrl,
    now,
  })
  if (!summary.snapshotJson) {
    return summary.resultRef
  }

  const payloadPostId = typeof payload?.post_id === "string" && payload.post_id.trim()
    ? payload.post_id.trim()
    : null
  if (payloadPostId) {
    await upsertLinkEnrichmentUsage({
      client: controlPlaneClient,
      normalizedUrl,
      communityId: input.job.community_id,
      postId: payloadPostId,
      linkEnrichmentId: null,
      snapshotSyncedAt: null,
      now,
    })
  }

  const usages = await listLinkSummaryFanoutUsages({
    controlPlaneClient,
    normalizedUrl,
  })
  let synced = 0
  let failed = 0
  for (const usage of usages) {
    try {
      const db = await openCommunityDb(input.env, input.communityRepository, usage.community_id)
      try {
        await writeLinkEnrichmentSnapshotToPost({
          client: db.client,
          postId: usage.post_id,
          snapshotJson: summary.snapshotJson,
          syncedAt: now,
        })
        await markLinkSummaryFanoutSynced({
          controlPlaneClient,
          normalizedUrl,
          communityId: usage.community_id,
          postId: usage.post_id,
          syncedAt: now,
        })
        synced += 1
      } finally {
        db.close()
      }
    } catch (error) {
      failed += 1
      console.error("[link-summary] failed to fan out enrichment snapshot", {
        normalized_url: normalizedUrl,
        community_id: usage.community_id,
        post_id: usage.post_id,
        error,
      })
    }
  }

  return `${summary.resultRef}:synced:${synced}:failed:${failed}`
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
      input.communityRepository,
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
    songArtifactBundleId: payload?.song_artifact_bundle ?? input.job.subject_id,
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
    case "embed_hydrate":
    case "link_preview_fetch":
      return runEmbedHydrate(input)
    case "post_label_materialize":
      return runPostLabelMaterialize(input)
    case "post_translation_materialize":
      return runPostTranslationMaterialize(input)
    case "link_summary_materialize":
      return runLinkSummaryMaterialize(input)
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
