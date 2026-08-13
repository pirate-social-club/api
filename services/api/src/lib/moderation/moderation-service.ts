import { openCommunityReadClient, openCommunityWriteClient } from "../communities/community-read-access"
import type {
  CommunityDatabaseBindingRepository,
  CommunityPostProjectionRepository,
} from "../communities/db-community-repository"
import type { ProfileRepository, UserRepository } from "../auth/repositories"
import { getProfilePublicHandleLabel } from "../auth/auth-serializers"
import type { DbExecutor } from "../db-helpers"
import { badRequestError, internalError, notFoundError } from "../errors"
import { nowIso } from "../helpers"
import { withTransaction } from "../transactions"
import { logPipelineInfo } from "../observability/pipeline-log"
import { updateStoryRegisteredAssetPostStatus } from "../communities/commerce/derivative-source-projection"
import { getAssetEnforcement } from "../communities/commerce/generic-asset-repository"
import { isGenericAssetKind } from "../communities/commerce/asset-kind-policy"
import { getAssetRow } from "../communities/commerce/queries"
import { getPostById } from "../posts/community-post-query-store"
import { getCommentById } from "../comments/community-comment-store"
import type { Env } from "../../env"
import { schedulePublicPostCachePurge } from "../public-read-cache-invalidation"
import {
  createModerationAction,
  createModerationCase,
  createUserReport,
  findExistingUserReport,
  getModerationCaseById,
  getOpenModerationCaseForTarget,
  listModerationActionsForCase,
  listModerationCases,
  listModerationSignalsForCase,
  listUserReportsForCase,
  resolveModerationCase,
  setCommentModerationStatus,
  setPostAgeGatePolicy,
  setPostContentRating,
  setPostModerationStatus,
  setAssetModerationEnforcement,
  approveReviewHeldPost,
  updateModerationCaseOpenedBy,
} from "./community-moderation-store"
import type {
  CreateModerationActionRequest,
  CreateUserReportRequest,
  ModerationCase,
  ModerationCaseDetail,
  ModerationCaseListResponse,
  ModerationSignalSeverity,
  UserReport,
} from "./moderation-types"
import {
  requireAnyCommunityRole,
  requireCommunityAccess,
  requireVerifiedHuman,
} from "./moderation-access"

type ModerationCommunityRepository =
  & CommunityDatabaseBindingRepository
  & Pick<CommunityPostProjectionRepository, "updateCommunityPostProjectionPayload" | "updateCommunityPostProjectionStatus">

async function updateDerivativeSourceProjectionStatus(input: {
  env: Env
  communityId: string
  postId: string
  status: "published" | "hidden" | "removed" | "deleted" | "draft"
  updatedAt: string
}): Promise<void> {
  try {
    await updateStoryRegisteredAssetPostStatus({
      env: input.env,
      communityId: input.communityId,
      sourcePostId: input.postId,
      sourcePostStatus: input.status,
      updatedAt: input.updatedAt,
    })
  } catch (error) {
    logPipelineInfo("[moderation] Story registered asset projection status update failed", {
      level: "warn",
      community_id: input.communityId,
      post_id: input.postId,
      status: input.status,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

function reportPriority(reasonCode: CreateUserReportRequest["reason_code"]): ModerationSignalSeverity {
  switch (reasonCode) {
    case "harassment":
    case "hate":
    case "sexual_content":
    case "graphic_content":
      return "high"
    case "spam":
    case "misleading":
      return "medium"
    case "other":
    default:
      return "low"
  }
}

function assertCreateUserReportRequest(body: CreateUserReportRequest): void {
  if (!body.reason_code) {
    throw badRequestError("reason_code is required")
  }
}

function assertCreateModerationActionRequest(body: CreateModerationActionRequest): void {
  if (!body.action_type) {
    throw badRequestError("action_type is required")
  }
  if (body.action_type === "set_content_rating") {
    if (!body.content_safety_state || !["safe", "sensitive", "adult"].includes(body.content_safety_state)) {
      throw badRequestError("content_safety_state is required for set_content_rating")
    }
    if (!body.note?.trim()) {
      throw badRequestError("note is required for set_content_rating")
    }
    if (!body.evidence_ref?.trim()) {
      throw badRequestError("evidence_ref is required for set_content_rating")
    }
  }
}

async function buildModerationCaseDetail(input: {
  caseRow: ModerationCase
  dbClient: DbExecutor
}): Promise<ModerationCaseDetail> {
  const post = input.caseRow.post_id ? await getPostById(input.dbClient, input.caseRow.post_id) : null
  const comment = input.caseRow.comment_id ? await getCommentById(input.dbClient, input.caseRow.comment_id) : null
  return {
    case: input.caseRow,
    post,
    comment,
    signals: await listModerationSignalsForCase({
      executor: input.dbClient,
      moderationCaseId: input.caseRow.moderation_case_id,
    }),
    reports: await listUserReportsForCase({
      executor: input.dbClient,
      moderationCaseId: input.caseRow.moderation_case_id,
    }),
    actions: await listModerationActionsForCase({
      executor: input.dbClient,
      moderationCaseId: input.caseRow.moderation_case_id,
    }),
  }
}

export async function reportPost(input: {
  env: Env
  userId: string
  communityId: string
  postId: string
  body: CreateUserReportRequest
  userRepository: UserRepository
  communityRepository: ModerationCommunityRepository
}): Promise<UserReport> {
  assertCreateUserReportRequest(input.body)
  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.communityId)
  try {
    await requireCommunityAccess({
      client: db.client,
      communityId: input.communityId,
      userId: input.userId,
    })
    await requireVerifiedHuman(input.userRepository, input.userId)
    const post = await getPostById(db.client, input.postId)
    if (!post || post.community_id !== input.communityId) {
      throw notFoundError("Post not found")
    }
    const existingReport = await findExistingUserReport({
      executor: db.client,
      communityId: input.communityId,
      reporterUserId: input.userId,
      target: { postId: input.postId },
    })
    if (existingReport) {
      return existingReport
    }
    const now = nowIso()
    // Read the open case BEFORE the tx — a buffered D1 write tx can't read it back
    // mid-flight. createModerationCase/createUserReport are deterministic (no
    // readback), so the tx body below is write-only.
    const existingCase = await getOpenModerationCaseForTarget({
      executor: db.client,
      communityId: input.communityId,
      target: { postId: input.postId },
    })
    return await withTransaction(db.client, "write", async (tx) => {
      let moderationCase = existingCase
      if (!moderationCase) {
        moderationCase = await createModerationCase({
          executor: tx,
          communityId: input.communityId,
          target: { postId: input.postId },
          priority: reportPriority(input.body.reason_code),
          openedBy: "user_report",
          now,
        })
      } else if (moderationCase.opened_by === "platform_analysis") {
        await updateModerationCaseOpenedBy({
          executor: tx,
          moderationCaseId: moderationCase.moderation_case_id,
          openedBy: "mixed",
          now,
        })
      }
      return await createUserReport({
        executor: tx,
        communityId: input.communityId,
        moderationCaseId: moderationCase.moderation_case_id,
        reporterUserId: input.userId,
        target: { postId: input.postId },
        body: input.body,
        now,
      })
    })
  } finally {
    db.close()
  }
}

export async function reportComment(input: {
  env: Env
  userId: string
  communityId: string
  commentId: string
  body: CreateUserReportRequest
  userRepository: UserRepository
  communityRepository: ModerationCommunityRepository
}): Promise<UserReport> {
  assertCreateUserReportRequest(input.body)
  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.communityId)
  try {
    await requireCommunityAccess({
      client: db.client,
      communityId: input.communityId,
      userId: input.userId,
    })
    await requireVerifiedHuman(input.userRepository, input.userId)
    const comment = await getCommentById(db.client, input.commentId)
    if (!comment || comment.community_id !== input.communityId) {
      throw notFoundError("Comment not found")
    }
    const existingReport = await findExistingUserReport({
      executor: db.client,
      communityId: input.communityId,
      reporterUserId: input.userId,
      target: { commentId: input.commentId },
    })
    if (existingReport) {
      return existingReport
    }
    const now = nowIso()
    // Read the open case BEFORE the tx (see reportPost) — the tx body stays write-only.
    const existingCase = await getOpenModerationCaseForTarget({
      executor: db.client,
      communityId: input.communityId,
      target: { commentId: input.commentId },
    })
    return await withTransaction(db.client, "write", async (tx) => {
      let moderationCase = existingCase
      if (!moderationCase) {
        moderationCase = await createModerationCase({
          executor: tx,
          communityId: input.communityId,
          target: { commentId: input.commentId },
          priority: reportPriority(input.body.reason_code),
          openedBy: "user_report",
          now,
        })
      } else if (moderationCase.opened_by === "platform_analysis") {
        await updateModerationCaseOpenedBy({
          executor: tx,
          moderationCaseId: moderationCase.moderation_case_id,
          openedBy: "mixed",
          now,
        })
      }
      return await createUserReport({
        executor: tx,
        communityId: input.communityId,
        moderationCaseId: moderationCase.moderation_case_id,
        reporterUserId: input.userId,
        target: { commentId: input.commentId },
        body: input.body,
        now,
      })
    })
  } finally {
    db.close()
  }
}

export async function listCommunityModerationCases(input: {
  env: Env
  userId: string
  communityId: string
  communityRepository: ModerationCommunityRepository
  profileRepository?: ProfileRepository
}): Promise<ModerationCaseListResponse> {
  const db = await openCommunityReadClient(input.env, input.communityRepository, input.communityId)
  try {
    await requireAnyCommunityRole({
      client: db.client,
      communityId: input.communityId,
      userId: input.userId,
    })
    const items = await listModerationCases({
        executor: db.client,
        communityId: input.communityId,
      })
    if (input.profileRepository) {
      const authorHandleByUserId = new Map<string, string | null>()
      for (const item of items) {
        const authorUserId = item.post?.identity_mode === "public" ? item.post.author_user_id : null
        if (!authorUserId || authorHandleByUserId.has(authorUserId)) {
          continue
        }
        const profile = await input.profileRepository.getProfileByUserId(authorUserId).catch(() => null)
        authorHandleByUserId.set(authorUserId, profile ? getProfilePublicHandleLabel(profile) : null)
      }
      for (const item of items) {
        const authorUserId = item.post?.identity_mode === "public" ? item.post.author_user_id : null
        if (item.post && authorUserId) {
          item.post.author_handle = authorHandleByUserId.get(authorUserId) ?? null
        }
      }
    }
    return {
      items,
      next_cursor: null,
    }
  } finally {
    db.close()
  }
}

export async function getModerationCaseDetail(input: {
  env: Env
  userId: string
  communityId: string
  moderationCaseId: string
  communityRepository: ModerationCommunityRepository
}): Promise<ModerationCaseDetail> {
  const db = await openCommunityReadClient(input.env, input.communityRepository, input.communityId)
  try {
    await requireAnyCommunityRole({
      client: db.client,
      communityId: input.communityId,
      userId: input.userId,
    })
    const caseRow = await getModerationCaseById({
      executor: db.client,
      moderationCaseId: input.moderationCaseId,
    })
    if (!caseRow || caseRow.community_id !== input.communityId) {
      throw notFoundError("Moderation case not found")
    }
    return await buildModerationCaseDetail({
      caseRow,
      dbClient: db.client,
    })
  } finally {
    db.close()
  }
}

type ModerationActionMutation = {
  previousStatus?: "draft" | "processing" | "published" | "failed" | "hidden" | "removed" | "deleted" | null
  nextStatus?: "draft" | "processing" | "published" | "failed" | "hidden" | "removed" | "deleted" | null
  previousAgeGatePolicy?: "none" | "18_plus" | null
  nextAgeGatePolicy?: "none" | "18_plus" | null
  previousContentSafetyState?: "pending" | "safe" | "sensitive" | "adult" | null
  nextContentSafetyState?: "safe" | "sensitive" | "adult" | null
  evidenceRef?: string | null
  publicReadPostId?: string | null
  assetId?: string | null
  previousAssetEnforcementState?: "active" | "quarantined" | "blocked" | null
  nextAssetEnforcementState?: "active" | "quarantined" | "blocked" | null
}

type ModerationActionPlan = {
  mutation: ModerationActionMutation
  /** Write-only — safe to run inside a buffered D1 write tx. */
  applyWrites: (executor: DbExecutor, moderationActionId: string) => Promise<void>
}

async function applyPostStatusTransition(input: {
  executor: DbExecutor
  postId: string
  previousStatus: "draft" | "processing" | "published" | "failed" | "hidden" | "removed" | "deleted"
  analysisState: "pending" | "allow" | "allow_with_required_reference" | "review_required" | "blocked"
  nextStatus: "hidden" | "removed" | "published"
  now: string
}): Promise<void> {
  if (
    input.nextStatus === "published"
    && input.previousStatus === "draft"
    && input.analysisState === "review_required"
  ) {
    await approveReviewHeldPost({ executor: input.executor, postId: input.postId, now: input.now })
    return
  }
  await setPostModerationStatus({
    executor: input.executor,
    postId: input.postId,
    status: input.nextStatus,
    now: input.now,
  })
}

export const moderationServiceTestOnly = { applyPostStatusTransition }

/**
 * Reads the target post/comment and validates/decides the action on the BASE client
 * BEFORE any write tx (a buffered D1 write tx can't read the target back or branch on
 * it mid-flight). Returns the audit mutation snapshot plus a write-only closure that
 * the caller runs inside the tx. All status-write helpers it calls are write-only.
 */
async function planModerationAction(input: {
  caseRow: ModerationCase
  dbClient: DbExecutor
  body: CreateModerationActionRequest
  now: string
}): Promise<ModerationActionPlan> {
  const noWrites = async () => {}
  if (input.caseRow.post_id) {
    const post = await getPostById(input.dbClient, input.caseRow.post_id)
    if (!post) {
      throw notFoundError("Post not found")
    }
    const postId = post.post_id
    const asset = post.asset_id
      ? await getAssetRow(input.dbClient, input.caseRow.community_id, post.asset_id)
      : null
    const genericAsset = asset && isGenericAssetKind(asset.asset_kind) ? asset : null
    const enforcement = genericAsset
      ? await getAssetEnforcement(input.dbClient, genericAsset.asset_id)
      : null
    const planPostAndAssetTransition = (
      nextPostStatus: "hidden" | "removed" | "published",
      nextAssetEnforcementState: "quarantined" | "blocked" | "active",
    ): ModerationActionPlan => {
      if (!genericAsset) {
        throw badRequestError("Asset moderation actions require a generic asset post")
      }
      const restrictive = nextAssetEnforcementState !== "active"
      if (!enforcement && !restrictive) {
        throw internalError("Generic asset enforcement state is missing")
      }
      const evidenceRef = input.body.evidence_ref?.trim()
      if (!evidenceRef) {
        throw badRequestError("evidence_ref is required when moderating a generic asset")
      }
      return {
        mutation: {
          previousStatus: post.status,
          nextStatus: nextPostStatus,
          publicReadPostId: postId,
          evidenceRef,
          assetId: genericAsset.asset_id,
          previousAssetEnforcementState: enforcement?.enforcement_state ?? null,
          nextAssetEnforcementState,
        },
        applyWrites: async (executor, moderationActionId) => {
          await applyPostStatusTransition({
            executor,
            postId,
            previousStatus: post.status,
            analysisState: post.analysis_state,
            nextStatus: nextPostStatus,
            now: input.now,
          })
          await setAssetModerationEnforcement({
            executor,
            assetId: genericAsset.asset_id,
            moderationActionId,
            enforcementState: nextAssetEnforcementState,
            reasonCode: input.body.action_type,
            evidenceRef,
            expectedEnforcementState: enforcement?.enforcement_state ?? null,
            allowMissingInsert: restrictive,
            now: input.now,
          })
        },
      }
    }

    const planPostTransition = (
      nextPostStatus: "hidden" | "removed" | "published",
    ): ModerationActionPlan => {
      if (genericAsset) {
        const nextEnforcement = nextPostStatus === "hidden"
          ? "quarantined"
          : nextPostStatus === "removed"
            ? "blocked"
            : "active"
        return planPostAndAssetTransition(nextPostStatus, nextEnforcement)
      }
      return {
        mutation: { previousStatus: post.status, nextStatus: nextPostStatus, publicReadPostId: postId },
        applyWrites: (executor) => applyPostStatusTransition({
          executor,
          postId,
          previousStatus: post.status,
          analysisState: post.analysis_state,
          nextStatus: nextPostStatus,
          now: input.now,
        }),
      }
    }
    switch (input.body.action_type) {
      case "dismiss":
        if (post.status === "draft") {
          throw badRequestError("Held draft posts must be approved, hidden, or removed")
        }
        return { mutation: { publicReadPostId: postId }, applyWrites: noWrites }
      case "hide":
        return planPostTransition("hidden")
      case "quarantine_asset":
        return planPostAndAssetTransition("hidden", "quarantined")
      case "remove":
        return planPostTransition("removed")
      case "block_asset":
        return planPostAndAssetTransition("removed", "blocked")
      case "restore": {
        return planPostTransition("published")
      }
      case "restore_asset":
        return planPostAndAssetTransition("published", "active")
      case "age_gate":
        return {
          mutation: { previousAgeGatePolicy: post.age_gate_policy, nextAgeGatePolicy: "18_plus", publicReadPostId: postId },
          applyWrites: (executor) => setPostAgeGatePolicy({ executor, postId, ageGatePolicy: "18_plus", now: input.now }),
        }
      case "set_content_rating": {
        const nextContentSafetyState = input.body.content_safety_state
        if (!nextContentSafetyState) {
          throw badRequestError("content_safety_state is required for set_content_rating")
        }
        if (post.content_safety_state === nextContentSafetyState) {
          throw badRequestError("Post already has that content rating")
        }
        const nextAgeGatePolicy = nextContentSafetyState === "adult" ? "18_plus" : "none"
        return {
          mutation: {
            previousAgeGatePolicy: post.age_gate_policy,
            nextAgeGatePolicy,
            previousContentSafetyState: post.content_safety_state,
            nextContentSafetyState,
            evidenceRef: input.body.evidence_ref?.trim() ?? null,
            publicReadPostId: postId,
          },
          applyWrites: (executor) => setPostContentRating({
            executor,
            postId,
            contentSafetyState: nextContentSafetyState,
            ageGatePolicy: nextAgeGatePolicy,
            now: input.now,
          }),
        }
      }
      default:
        throw badRequestError("Unsupported moderation action")
    }
  }

  if (!input.caseRow.comment_id) {
    throw notFoundError("Moderation case target is missing")
  }

  const comment = await getCommentById(input.dbClient, input.caseRow.comment_id)
  if (!comment) {
    throw notFoundError("Comment not found")
  }
  const commentId = comment.comment_id

  switch (input.body.action_type) {
    case "dismiss":
      return { mutation: { publicReadPostId: comment.thread_root_post_id }, applyWrites: noWrites }
    case "hide":
      return {
        mutation: { previousStatus: comment.status, nextStatus: "hidden", publicReadPostId: comment.thread_root_post_id },
        applyWrites: (executor) => setCommentModerationStatus({ executor, commentId, status: "hidden", now: input.now }),
      }
    case "remove":
      return {
        mutation: { previousStatus: comment.status, nextStatus: "removed", publicReadPostId: comment.thread_root_post_id },
        applyWrites: (executor) => setCommentModerationStatus({ executor, commentId, status: "removed", now: input.now }),
      }
    case "restore":
      return {
        mutation: { previousStatus: comment.status, nextStatus: "published", publicReadPostId: comment.thread_root_post_id },
        applyWrites: (executor) => setCommentModerationStatus({ executor, commentId, status: "published", now: input.now }),
      }
    case "age_gate":
      throw badRequestError("age_gate is only supported for posts")
    case "set_content_rating":
      throw badRequestError("set_content_rating is only supported for posts")
    default:
      throw badRequestError("Unsupported moderation action")
  }
}

export async function resolveModerationCaseWithAction(input: {
  env: Env
  userId: string
  communityId: string
  moderationCaseId: string
  body: CreateModerationActionRequest
  userRepository: UserRepository
  communityRepository: ModerationCommunityRepository
  waitUntil?: (promise: Promise<void>) => void
}): Promise<ModerationCaseDetail> {
  assertCreateModerationActionRequest(input.body)
  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.communityId)
  try {
    await requireAnyCommunityRole({
      client: db.client,
      communityId: input.communityId,
      userId: input.userId,
    })

    const caseRow = await getModerationCaseById({
      executor: db.client,
      moderationCaseId: input.moderationCaseId,
    })
    if (!caseRow || caseRow.community_id !== input.communityId) {
      throw notFoundError("Moderation case not found")
    }
    if (caseRow.status !== "open") {
      throw badRequestError("Moderation case is already resolved")
    }

    const now = nowIso()
    // Read the target + decide the action on the base client BEFORE the tx — a
    // buffered D1 write tx can't read post/comment back or branch on it mid-flight.
    // The complete audit action, planned target writes, and case resolution are all
    // write-only, so the tx body below is buffer-safe and commits as one batch.
    const plan = await planModerationAction({
      caseRow,
      dbClient: db.client,
      body: input.body,
      now,
    })
    const mutation = plan.mutation
    await withTransaction(db.client, "write", async (tx) => {
      const action = await createModerationAction({
        executor: tx,
        moderationCase: caseRow,
        actorUserId: input.userId,
        body: input.body,
        now,
        previousStatus: mutation.previousStatus,
        nextStatus: mutation.nextStatus,
        previousAgeGatePolicy: mutation.previousAgeGatePolicy,
        nextAgeGatePolicy: mutation.nextAgeGatePolicy,
        previousContentSafetyState: mutation.previousContentSafetyState,
        nextContentSafetyState: mutation.nextContentSafetyState,
        evidenceRef: mutation.evidenceRef,
        assetId: mutation.assetId,
        previousAssetEnforcementState: mutation.previousAssetEnforcementState,
        nextAssetEnforcementState: mutation.nextAssetEnforcementState,
      })
      await plan.applyWrites(tx, action.moderation_action_id)
      await resolveModerationCase({
        executor: tx,
        moderationCaseId: caseRow.moderation_case_id,
        now,
      })
    })

    if (caseRow.post_id && mutation?.nextStatus) {
      const nextStatus = mutation.nextStatus as "draft" | "published" | "hidden" | "removed" | "deleted"
      await input.communityRepository.updateCommunityPostProjectionStatus({
        postId: caseRow.post_id,
        status: nextStatus,
        updatedAt: now,
      })
      await updateDerivativeSourceProjectionStatus({
        env: input.env,
        communityId: input.communityId,
        postId: caseRow.post_id,
        status: nextStatus,
        updatedAt: now,
      })
    }
    if (
      caseRow.post_id
      && (mutation.nextAgeGatePolicy || mutation.nextContentSafetyState)
    ) {
      const updatedPost = await getPostById(db.client, caseRow.post_id)
      if (!updatedPost) {
        throw internalError("Post is missing after moderation action")
      }
      await input.communityRepository.updateCommunityPostProjectionPayload({
        postId: caseRow.post_id,
        projectedPayloadJson: JSON.stringify(updatedPost),
        updatedAt: now,
      })
    }
    if (
      mutation.publicReadPostId
      && (mutation.nextStatus || mutation.nextAgeGatePolicy)
    ) {
      schedulePublicPostCachePurge({
        env: input.env,
        communityId: input.communityId,
        postId: mutation.publicReadPostId,
        waitUntil: input.waitUntil,
      })
    }

    const updatedCase = await getModerationCaseById({
      executor: db.client,
      moderationCaseId: input.moderationCaseId,
    })
    if (!updatedCase) {
      throw internalError("Moderation case is missing after action")
    }
    return await buildModerationCaseDetail({
      caseRow: updatedCase,
      dbClient: db.client,
    })
  } finally {
    db.close()
  }
}
