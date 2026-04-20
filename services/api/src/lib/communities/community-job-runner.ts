import { internalError } from "../errors"
import { nowIso } from "../helpers"
import {
  getCommentById,
  getCommunityVisibility,
  getLatestThreadSnapshot,
  insertThreadSnapshot,
  listThreadCommentsForSnapshot,
  updateCommentSwarmBodyRef,
} from "../comments/community-comment-store"
import { materializeCommentTranslation } from "../localization/comment-translation-materializer"
import {
  materializeCommunityTextTranslations,
  parseCommunityTextMaterializePayload,
} from "../localization/community-localization-service"
import { getPostById } from "../posts/community-post-store"
import { materializePostTranslation } from "../localization/post-translation-materializer"
import {
  buildThreadFeedTopic,
  publishCollectionToSwarm,
  publishFeedReference,
  publishJsonToSwarm,
} from "../swarm/swarm-publisher"
import type { Env } from "../../types"
import type { CommunityRepository } from "./db-community-repository"
import { loadCommunityProjection } from "./community-create-service"
import { openCommunityDb } from "./community-db-factory"
import {
  findNextRunnableCommunityJob,
  getCommunityJobById,
  markCommunityJobFailed,
  markCommunityJobRunning,
  markCommunityJobSucceeded,
  type CommunityJobRow,
} from "./community-job-store"

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

type CommentTranslationPayload = {
  comment_id?: string
  locale?: string | null
}

const COMMUNITY_JOB_MAX_ATTEMPTS = 8
const COMMUNITY_JOB_RETRY_BASE_MS = 30_000
const COMMUNITY_JOB_RETRY_MAX_MS = 30 * 60_000
const THREAD_SNAPSHOT_MIN_INTERVAL_MS = 60_000

type CommunityJobRepository = Pick<
  CommunityRepository,
  | "getCommunityById"
  | "listActiveCommunities"
  | "getPrimaryCommunityDatabaseBinding"
  | "getActiveCommunityDbCredential"
  | "recordCommunityCommentProjection"
  | "getCommunityCommentProjectionByCommentId"
>

function parseCommentProjectionPayload(raw: string | null): CommentProjectionSyncPayload | null {
  if (!raw) {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === "object" ? parsed as CommentProjectionSyncPayload : null
  } catch {
    return null
  }
}

function parseCommentBodyMirrorPayload(raw: string | null): CommentBodyMirrorPayload | null {
  if (!raw) {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === "object" ? parsed as CommentBodyMirrorPayload : null
  } catch {
    return null
  }
}

function parseThreadSnapshotPayload(raw: string | null): ThreadSnapshotPayload | null {
  if (!raw) {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === "object" ? parsed as ThreadSnapshotPayload : null
  } catch {
    return null
  }
}

function parsePostTranslationPayload(raw: string | null): PostTranslationPayload | null {
  if (!raw) {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === "object" ? parsed as PostTranslationPayload : null
  } catch {
    return null
  }
}

function parseCommentTranslationPayload(raw: string | null): CommentTranslationPayload | null {
  if (!raw) {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === "object" ? parsed as CommentTranslationPayload : null
  } catch {
    return null
  }
}

type CommunityTextTranslationPayload = {
  locale?: string | null
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

function computeRetryDelayMs(attemptCount: number): number {
  const exponent = Math.max(0, attemptCount - 1)
  return Math.min(COMMUNITY_JOB_RETRY_BASE_MS * (2 ** exponent), COMMUNITY_JOB_RETRY_MAX_MS)
}

function computeNextRetryAt(now: string, attemptCount: number): string {
  return new Date(Date.parse(now) + computeRetryDelayMs(attemptCount)).toISOString()
}

async function runCommentProjectionSync(input: {
  job: CommunityJobRow
  env: Env
  communityRepository: CommunityJobRepository
}): Promise<string | null> {
  const db = await openCommunityDb(input.env, input.communityRepository, input.job.community_id)
  try {
    const payload = parseCommentProjectionPayload(input.job.payload_json)
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
    const payload = parseCommentBodyMirrorPayload(input.job.payload_json)
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
    const payload = parseThreadSnapshotPayload(input.job.payload_json)
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
    const payload = parsePostTranslationPayload(input.job.payload_json)
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

async function runCommentTranslationMaterialize(input: {
  job: CommunityJobRow
  env: Env
  communityRepository: CommunityJobRepository
}): Promise<string | null> {
  const db = await openCommunityDb(input.env, input.communityRepository, input.job.community_id)
  try {
    const payload = parseCommentTranslationPayload(input.job.payload_json)
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

async function runCommunityJob(input: {
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
    case "post_translation_materialize":
      return runPostTranslationMaterialize(input)
    case "comment_translation_materialize":
      return runCommentTranslationMaterialize(input)
    case "community_text_translation_materialize":
      return runCommunityTextTranslationMaterialize(input)
    default:
      throw internalError(`Unsupported community job type: ${input.job.job_type}`)
  }
}

export async function processCommunityJobById(input: {
  env: Env
  communityId: string
  jobId: string
  communityRepository: CommunityJobRepository
}): Promise<CommunityJobRow | null> {
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    const existing = await getCommunityJobById({
      client: db.client,
      jobId: input.jobId,
    })
    if (!existing || existing.community_id !== input.communityId) {
      return null
    }

    const running = await markCommunityJobRunning({
      client: db.client,
      jobId: input.jobId,
      now: nowIso(),
    })
    if (!running) {
      return null
    }

    try {
      const resultRef = await runCommunityJob({
        job: running,
        env: input.env,
        communityRepository: input.communityRepository,
      })

      return await markCommunityJobSucceeded({
        client: db.client,
        jobId: running.job_id,
        resultRef,
        now: nowIso(),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const failedAt = nowIso()
      return await markCommunityJobFailed({
        client: db.client,
        jobId: running.job_id,
        errorCode: message || "community_job_failed",
        availableAt: running.attempt_count >= COMMUNITY_JOB_MAX_ATTEMPTS
          ? null
          : computeNextRetryAt(failedAt, running.attempt_count),
        now: failedAt,
      })
    }
  } finally {
    db.close()
  }
}

export async function processNextCommunityJob(input: {
  env: Env
  communityId: string
  communityRepository: CommunityJobRepository
}): Promise<CommunityJobRow | null> {
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    const next = await findNextRunnableCommunityJob({
      client: db.client,
      communityId: input.communityId,
      now: nowIso(),
      maxAttempts: COMMUNITY_JOB_MAX_ATTEMPTS,
    })
    if (!next) {
      return null
    }
    return processCommunityJobById({
      env: input.env,
      communityId: input.communityId,
      jobId: next.job_id,
      communityRepository: input.communityRepository,
    })
  } finally {
    db.close()
  }
}

export async function processCommunityJobsForCommunity(input: {
  env: Env
  communityId: string
  communityRepository: CommunityJobRepository
  maxJobs?: number
}): Promise<{
  community_id: string
  processed_jobs: number
  jobs: CommunityJobRow[]
}> {
  const maxJobs = Math.max(1, Math.trunc(input.maxJobs ?? 25))
  const jobs: CommunityJobRow[] = []

  while (jobs.length < maxJobs) {
    const processed = await processNextCommunityJob({
      env: input.env,
      communityId: input.communityId,
      communityRepository: input.communityRepository,
    })
    if (!processed) {
      break
    }
    jobs.push(processed)
  }

  return {
    community_id: input.communityId,
    processed_jobs: jobs.length,
    jobs,
  }
}

export async function processAvailableCommunityJobs(input: {
  env: Env
  communityRepository: CommunityJobRepository
  communityIds?: string[] | null
  maxCommunities?: number
  maxJobsPerCommunity?: number
}): Promise<{
  processed_jobs: number
  communities: Array<{
    community_id: string
    processed_jobs: number
    jobs: CommunityJobRow[]
  }>
}> {
  const communityIds = (input.communityIds?.length
    ? input.communityIds
    : (await input.communityRepository.listActiveCommunities()).map((community) => community.community_id))
    .slice(0, Math.max(1, Math.trunc(input.maxCommunities ?? 100)))

  const communities: Array<{
    community_id: string
    processed_jobs: number
    jobs: CommunityJobRow[]
  }> = []

  for (const communityId of communityIds) {
    const processed = await processCommunityJobsForCommunity({
      env: input.env,
      communityId,
      communityRepository: input.communityRepository,
      maxJobs: input.maxJobsPerCommunity ?? 25,
    })
    if (processed.processed_jobs > 0) {
      communities.push(processed)
    }
  }

  return {
    processed_jobs: communities.reduce((sum, community) => sum + community.processed_jobs, 0),
    communities,
  }
}

export async function runCommunityJobWorkerLoop(input: {
  env: Env
  communityRepository: CommunityJobRepository
  communityIds?: string[] | null
  maxCommunities?: number
  maxJobsPerCommunity?: number
  pollIntervalMs?: number
  stopWhenIdle?: boolean
  signal?: AbortSignal
  onTick?: (summary: {
    processed_jobs: number
    communities: Array<{
      community_id: string
      processed_jobs: number
      jobs: CommunityJobRow[]
    }>
  }) => void | Promise<void>
}): Promise<void> {
  const pollIntervalMs = Math.max(100, Math.trunc(input.pollIntervalMs ?? 2000))

  while (!input.signal?.aborted) {
    const summary = await processAvailableCommunityJobs({
      env: input.env,
      communityRepository: input.communityRepository,
      communityIds: input.communityIds ?? null,
      maxCommunities: input.maxCommunities ?? 100,
      maxJobsPerCommunity: input.maxJobsPerCommunity ?? 25,
    })

    await input.onTick?.(summary)

    if (summary.processed_jobs === 0 && input.stopWhenIdle) {
      return
    }

    if (input.signal?.aborted) {
      return
    }

    await sleep(pollIntervalMs)
  }
}
