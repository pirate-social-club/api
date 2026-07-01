import type { Client } from "../sql-client"
import type { DbExecutor } from "../db-helpers"
import { sha256Hex } from "../crypto"
import { openCommunityWriteClient } from "../communities/community-read-access"
import { isCommunityLive } from "../communities/community-status"
import { safeRollback } from "../transactions"
import { enqueueCommunityJob } from "../communities/jobs/store"
import { loadCommunityProjection } from "../communities/create/repository"
import { detectSourceLanguageFromText } from "../localization/content-locale"
import { emitCommentReply, emitPostCommented } from "../notifications/notification-emitters"
import {
  ANY_COMMUNITY_ROLE,
  canAccessCommunity,
  getCommunityMembershipState,
  hasCommunityRole,
  upsertCommunityMembership,
  type CommunityMembershipRow,
} from "../communities/membership/membership-state-store"
import { enforceCommunityActionGate, evaluateGatedMembership } from "../communities/membership/eligibility-service"
import { throwUnsatisfiedMembershipGate } from "../communities/membership/gate-failure-service"
import { missingCapabilitiesFromRequiredActionSet } from "../communities/membership/gate-utils"
import { getMembershipGatePolicy } from "../communities/membership/gate-policy-store"
import type { GatePolicyEvaluation } from "../communities/membership/gate-types"
import type {
  CommunityCommentProjectionRepository,
  CommunityDatabaseBindingRepository,
  CommunityPostProjectionRepository,
  CommunityReadRepository,
} from "../communities/db-community-repository"
import { badRequestError, commentMediaRejected, communityMembershipRequiredError, communityShardSettingsMissingError, eligibilityFailed, internalError, notFoundError } from "../errors"
import { nowIso } from "../helpers"
import type { ProfileRepository, UserRepository } from "../auth/repositories"
import { authorizeAgentWrite } from "../agents/agent-write-authorization"
import { getPostProjectionMetrics } from "../posts/community-post-metrics-store"
import { getPostById } from "../posts/community-post-query-store"
import { resolveOpenAIModerationOutcome } from "../posts/openai-moderation"
import {
  assertCreateCommentRequest,
  type CommentWriteDraft,
  findCommentByIdempotencyKey,
  getCommentById,
  getCommunityCommentPolicy,
  insertComment,
  getExistingCommentVoteValue,
  markCommentDeleted,
  setCommentRepliesLocked,
  setCommentStatus,
  upsertCommentVote,
} from "./community-comment-store"
import { incrementAncestorCommentCounters, incrementThreadPostCommentCounters, insertCommentClosureRows } from "./comment-closure-store"
import { enqueueCommentTranslationPrewarmJobs } from "./comment-translation-jobs"
import type { Comment, CommentAnonymousScope, CreateCommentRequest } from "./comment-types"
import type { Env } from "../../env"
import type { CreatePostRequest } from "../../types"
import { verifyAndConsumeAltchaProof, type AltchaProofInput, type VerifiedAltchaProof } from "../verification/altcha-provider"

export {
  getCommentContext,
  listCommentReplies,
  listPostComments,
  listPublicCommentReplies,
  listPublicPostComments,
} from "./comment-read-service"

type CommentServiceCommunityRepository =
  & CommunityReadRepository
  & CommunityDatabaseBindingRepository
  & Pick<CommunityPostProjectionRepository, "updateCommunityPostProjectionMetrics">
  & CommunityCommentProjectionRepository

async function requireMemberAccess(client: Client, communityId: string, userId: string): Promise<CommunityMembershipRow> {
  const membership = await getCommunityMembershipState(client, communityId, userId)
  if (!canAccessCommunity(membership)) {
    // Opaque, membership-privacy-preserving 404. Used by role-gated mod actions
    // and (for now) reply/vote author checks; the solvable PoW discriminator is
    // applied to top-level comment-create via requireCommentAuthorAccess and
    // will be extended to replies/votes in a follow-up.
    throw communityMembershipRequiredError({ community_id: communityId })
  }
  return membership
}

type CommentAuthorAccess = {
  membership: CommunityMembershipRow
  /**
   * True when the author is a non-member of a PoW-gated community who supplied a
   * proof: the caller must verify+consume it via enforceCommunityActionGate and,
   * only if that passes, enroll them as a `comment_pow` participant
   * (verify-then-persist).
   */
  provisionalParticipant: boolean
}

/**
 * Decide whether an author may comment. Members pass through. A non-member is
 * discriminated by decideNonMemberCommentAccess: PoW-gated + proof present →
 * provisional participant (enrolled later, after verification); PoW-gated + no
 * proof → solvable gate_failed; otherwise → opaque community_membership_required.
 *
 * This does NOT verify the proof (preview-mode eval only, no consume) and does
 * NOT write a membership row. Verification and enrollment happen in the caller,
 * in that order.
 */
async function resolveCommentAuthorAccess(input: {
  env: Env
  client: Client
  communityId: string
  userId: string
  userRepository: UserRepository
  hasProof: boolean
}): Promise<CommentAuthorAccess> {
  const membership = await getCommunityMembershipState(input.client, input.communityId, input.userId)
  if (canAccessCommunity(membership)) {
    return { membership, provisionalParticipant: false }
  }
  // Non-member.
  const policy = await getMembershipGatePolicy(input.client, input.communityId)
  const user = await input.userRepository.getUserById(input.userId)
  if (!policy || !user) {
    // No evaluable gate/user → stay opaque (don't advertise a requirement we
    // can't reason about).
    throw communityMembershipRequiredError({ community_id: input.communityId })
  }
  const { gateSummaries, walletScoreStatus, evaluation } = await evaluateGatedMembership({
    env: input.env,
    user,
    userRepository: input.userRepository,
    communityId: input.communityId,
    policy,
    mode: "preview",
    altchaScope: "comment_create",
  })
  // Throws for the non-provisional branches; returns only when the community is
  // PoW-only and a proof is present.
  decideNonMemberCommentAccess({
    communityId: input.communityId,
    evaluation,
    gateSummaries,
    walletScoreStatus,
    hasProof: input.hasProof,
  })
  return { membership, provisionalParticipant: true }
}

/**
 * Pure decision (no I/O, so it is unit-testable): given a non-member's gate
 * evaluation for a comment and whether the request carried a PoW proof, either
 * return `"provisional_participant"` (the caller should verify+consume the proof
 * and enroll a `comment_pow` participant) or throw.
 *
 * Branches (positive invariant: the solvable/provisional path requires the
 * missing-capability set to be *exactly* `{altcha_pow}` — a new gate type is
 * opaque-by-default until explicitly opted in here, with its test updated):
 * - only-missing = {altcha_pow} AND a proof is present → `"provisional_participant"`.
 * - only-missing = {altcha_pow} AND no proof → solvable comment-scoped
 *   `gate_failed` (so the client fetches a challenge and retries).
 * - anything else (approval/attribute gate, or none) → opaque
 *   `community_membership_required` 404. A proof does NOT rescue an attribute
 *   gate: PoW can't satisfy a nationality/age requirement.
 *
 * NOTE: this only *decides*. It never verifies or consumes the proof — that is
 * the caller's job via enforceCommunityActionGate (single consume), and the
 * participant row is written only AFTER that verification passes
 * (verify-then-persist). Never enroll before verification: that is the spam hole.
 *
 * Privacy oracle: the solvable branch reveals to a non-member that this community
 * is PoW-only. Safe *today* only because `membership_gate_summaries` is already
 * exposed in the public community preview; if that preview is ever narrowed,
 * revisit — otherwise the 403-vs-404 split becomes a gate-shape leak.
 */
export function decideNonMemberCommentAccess(input: {
  communityId: string
  evaluation: GatePolicyEvaluation
  gateSummaries: Parameters<typeof throwUnsatisfiedMembershipGate>[0]["gateSummaries"]
  walletScoreStatus: Parameters<typeof throwUnsatisfiedMembershipGate>[0]["walletScoreStatus"]
  hasProof: boolean
}): "provisional_participant" {
  const missing = missingCapabilitiesFromRequiredActionSet(input.evaluation.requiredActionSet)
  const onlyMissingIsPow = missing.length === 1 && missing[0] === "altcha_pow"
  if (onlyMissingIsPow) {
    if (input.hasProof) {
      return "provisional_participant"
    }
    throwUnsatisfiedMembershipGate({
      evaluation: input.evaluation,
      gateSummaries: input.gateSummaries,
      walletScoreStatus: input.walletScoreStatus,
      altchaScope: "comment_create",
    })
  }
  throw communityMembershipRequiredError({ community_id: input.communityId })
}

async function syncThreadRootPostProjectionMetrics(input: {
  client: Client
  communityRepository: Pick<CommunityPostProjectionRepository, "updateCommunityPostProjectionMetrics">
  threadRootPostId: string
  updatedAt: string
}): Promise<void> {
  if (typeof input.communityRepository.updateCommunityPostProjectionMetrics !== "function") {
    return
  }
  const metrics = await getPostProjectionMetrics(input.client, input.threadRootPostId)
  await input.communityRepository.updateCommunityPostProjectionMetrics({
    postId: input.threadRootPostId,
    upvoteCount: metrics.upvoteCount,
    downvoteCount: metrics.downvoteCount,
    commentCount: metrics.commentCount,
    likeCount: metrics.likeCount,
    updatedAt: input.updatedAt,
  })
}

function resolveAnonymousScope(input: {
  policyScope: CommentAnonymousScope
  requestedScope: Exclude<CommentAnonymousScope, null> | undefined
}): Exclude<CommentAnonymousScope, null> {
  const allowedScope = input.policyScope === "community_stable" ? "community_stable" : "thread_stable"
  const requestedScope = input.requestedScope ?? allowedScope
  if (requestedScope !== allowedScope) {
    throw badRequestError("anonymous_scope does not match the community policy")
  }
  return requestedScope
}

async function enqueueProjectionRetry(input: {
  client: DbExecutor
  communityId: string
  comment: Comment
  createdAt: string
}): Promise<void> {
  try {
    await enqueueCommunityJob({
      client: input.client,
      communityId: input.communityId,
      jobType: "comment_projection_sync",
      subjectType: "comment",
      subjectId: input.comment.comment_id,
      payloadJson: JSON.stringify({
        comment_id: input.comment.comment_id,
        thread_root_post_id: input.comment.thread_root_post_id,
        parent_comment_id: input.comment.parent_comment_id,
        depth: input.comment.depth,
        status: input.comment.status,
        source_created_at: input.comment.created_at,
      }),
      createdAt: input.createdAt,
    })
  } catch (error) {
    console.error("[comments] failed to enqueue comment projection retry", {
      communityId: input.communityId,
      commentId: input.comment.comment_id,
      error,
    })
  }
}

async function assertCommentMediaModeration(input: {
  env: Env
  community: Awaited<ReturnType<typeof loadCommunityProjection>>
  body: CreateCommentRequest
}): Promise<void> {
  if (!input.body.media_refs?.length) {
    return
  }

  const moderationBody: CreatePostRequest = {
    idempotency_key: input.body.idempotency_key?.trim() || "comment-media-moderation",
    post_type: "image",
    media_refs: input.body.media_refs as NonNullable<Extract<CreatePostRequest, { post_type: "image" }>["media_refs"]>,
    title: null,
    caption: input.body.body?.trim() || undefined,
  }
  const outcome = await resolveOpenAIModerationOutcome({
    env: input.env,
    community: input.community,
    body: moderationBody,
  })

  // Comments do not have an age-gate render path, so adult-gated media is rejected for v1.
  if (outcome.analysis_state !== "allow" || outcome.age_gate_policy === "18_plus") {
    throw commentMediaRejected("Comment image was rejected by media moderation", {
      analysis_state: outcome.analysis_state,
      content_safety_state: outcome.content_safety_state,
      age_gate_policy: outcome.age_gate_policy,
      provider_result: outcome.providerResult,
    })
  }
}

function commentNotificationExcerpt(comment: Comment): string {
  const body = comment.body?.trim()
  if (body) {
    return body
  }
  return comment.media_refs?.length ? "sent an image" : ""
}

function commentNotificationActorIdentity(comment: Comment) {
  if (comment.identity_mode !== "anonymous") {
    return undefined
  }

  return {
    actorAvatarUrl: null,
    actorDisplayName: comment.anonymous_label ?? "anon",
    exposeActorUser: false,
  }
}

export async function createComment(input: {
  env: Env
  requestUrl?: string
  userId: string
  communityId: string
  threadRootPostId: string
  parentCommentId?: string | null
  body: CreateCommentRequest
  bypassAuthorAccessChecks?: boolean
  altchaProof?: AltchaProofInput
  userRepository: UserRepository
  profileRepository?: ProfileRepository
  communityRepository: CommentServiceCommunityRepository
}): Promise<Comment> {
  const communityRow = await input.communityRepository.getCommunityById(input.communityId)
  if (!isCommunityLive(communityRow)) {
    throw eligibilityFailed("Community is not available for commenting")
  }
  const community = await loadCommunityProjection(input.env, input.communityRepository, communityRow)

  assertCreateCommentRequest(input.body)
  const isGuestComment = (input.body.authorship_mode ?? "human_direct") === "guest"
  let verifiedAltchaProof: VerifiedAltchaProof | undefined
  if (isGuestComment) {
    if (!input.userId.startsWith("usr_guest_")) {
      throw eligibilityFailed("Guest comments must use the MCP guest flow")
    }
    if (community.guest_comment_policy !== "altcha_required") {
      throw eligibilityFailed("Guest comments are not enabled in this community")
    }
    if (!input.altchaProof?.payload) {
      throw eligibilityFailed("ALTCHA proof is required for guest comments")
    }
    const altchaResult = await verifyAndConsumeAltchaProof({
      env: input.env,
      actorUserId: input.userId,
      proof: input.altchaProof,
    })
    if (!altchaResult.verified) {
      throw eligibilityFailed(`ALTCHA verification failed: ${altchaResult.reason}`)
    }
    verifiedAltchaProof = {
      actorUserId: input.userId,
      scope: input.altchaProof.scope,
      action: input.altchaProof.action,
    }
  }

  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.communityId)
  try {
    let membership: CommunityMembershipRow | null = null
    if (!input.bypassAuthorAccessChecks) {
      const access = await resolveCommentAuthorAccess({
        env: input.env,
        client: db.client,
        communityId: input.communityId,
        userId: input.userId,
        userRepository: input.userRepository,
        hasProof: Boolean(input.altchaProof?.payload),
      })
      membership = access.membership
      // Verify+consume the PoW proof exactly once (for members and provisional
      // participants alike; a plain member with no mod role re-verifies per
      // comment). This throws gate_failed on a missing/invalid/consumed proof.
      await enforceCommunityActionGate({
        env: input.env,
        client: db.client,
        userId: input.userId,
        userRepository: input.userRepository,
        communityId: input.communityId,
        altchaScope: "comment_create",
        altchaProof: input.altchaProof,
        verifiedAltchaProof,
      })
      // Verify-then-persist: only AFTER the proof verified do we enroll a
      // non-member as a `comment_pow` participant (Reddit-style, no visible join;
      // excluded from subscriber counts/rosters/projection — see migration 1116).
      if (access.provisionalParticipant) {
        await upsertCommunityMembership({
          client: db.client,
          communityId: input.communityId,
          userId: input.userId,
          now: nowIso(),
          participationSource: "comment_pow",
        })
      }
    }
    const canBypassLocks = input.bypassAuthorAccessChecks === true
      || (membership != null && hasCommunityRole(membership, ANY_COMMUNITY_ROLE))

    const idempotencyKey = input.body.idempotency_key?.trim() ?? ""
    const existing = idempotencyKey
      ? await findCommentByIdempotencyKey({
          executor: db.client,
          communityId: input.communityId,
          authorUserId: input.userId,
          idempotencyKey,
        })
      : null
    if (existing) {
      return existing
    }

    const threadRootPost = await getPostById(db.client, input.threadRootPostId)
    if (!threadRootPost || threadRootPost.community_id !== input.communityId || threadRootPost.status !== "published") {
      throw notFoundError("Post not found")
    }
    if (!input.parentCommentId && threadRootPost.comments_locked && !canBypassLocks) {
      throw eligibilityFailed("Comments are locked for this post")
    }

    const policy = await getCommunityCommentPolicy(db.client, input.communityId)
    if (!policy) {
      // Community resolved + live in the control plane, but its shard has no
      // `communities` row — a provisioning/migration defect, not a real 404.
      throw communityShardSettingsMissingError({ community_id: input.communityId })
    }

    let writeBody = input.body
    if ((input.body.identity_mode ?? "public") === "anonymous") {
      const isGuestComment = (input.body.authorship_mode ?? "human_direct") === "guest"
      if (!policy.allow_anonymous_identity && !isGuestComment) {
        throw eligibilityFailed("Anonymous comments are not enabled in this community")
      }
      writeBody = {
        ...input.body,
        anonymous_scope: resolveAnonymousScope({
          policyScope: policy.anonymous_identity_scope ?? (isGuestComment ? "community_stable" : null),
          requestedScope: input.body.anonymous_scope ?? undefined,
        }),
      }
    }

    const parentComment = input.parentCommentId ? await getCommentById(db.client, input.parentCommentId) : null
    if (input.parentCommentId && !parentComment) {
      throw notFoundError("Parent comment not found")
    }
    if (parentComment && parentComment.thread_root_post_id !== input.threadRootPostId) {
      throw badRequestError("Parent comment does not belong to this thread")
    }
    if (parentComment && parentComment.status !== "published") {
      throw eligibilityFailed("Replies are not allowed on removed or deleted comments")
    }
    if (parentComment && parentComment.replies_locked && !canBypassLocks) {
      throw eligibilityFailed("Replies are locked for this comment")
    }

    const agentWriteAuthorization = await authorizeAgentWrite({
      env: input.env,
      requestUrl: input.requestUrl ?? "http://localhost/",
      userId: input.userId,
      body: input.body,
      community,
      communityDbClient: db.client,
      profileRepository: input.profileRepository ?? {
        async getProfileByUserId() { return null },
        async resolvePublicProfileByHandle() { return null },
        async resolvePublicProfileByWalletAddress() { return null },
        async updateXmtpInboxId() { return null },
        async updateProfile() { return null },
        async renameGlobalHandle() { return null },
        async claimRedditGlobalHandle() { return null },
        async quoteGlobalHandleUpgrade() { return null },
        async claimPaidGlobalHandle() { return null },
        async syncLinkedHandles() { return null },
        async setPrimaryPublicHandle() { return null },
      },
      writeTarget: "comment",
    })

    await assertCommentMediaModeration({
      env: input.env,
      community,
      body: writeBody,
    })

    const createdAt = nowIso()
    const depth = parentComment ? parentComment.depth + 1 : 0
    const tx = await db.client.transaction("write")
    let draft: CommentWriteDraft

    try {
      draft = await insertComment({
        executor: tx,
        communityId: input.communityId,
        threadRootPostId: input.threadRootPostId,
        parentCommentId: input.parentCommentId ?? null,
        authorUserId: input.userId,
        body: writeBody,
        sourceLanguage: detectSourceLanguageFromText([writeBody.body ?? ""]),
        depth,
        createdAt,
        contentHash: `0x${await sha256Hex(JSON.stringify({
          body: writeBody.body?.trim() ?? "",
          media_refs: writeBody.media_refs ?? [],
        }))}`,
        agentWriteAuthorization: agentWriteAuthorization ?? undefined,
      })

      await insertCommentClosureRows({
        executor: tx,
        commentId: draft.comment_id,
        parentCommentId: input.parentCommentId ?? null,
      })

      await incrementAncestorCommentCounters({
        executor: tx,
        parentCommentId: input.parentCommentId ?? null,
        repliedAt: draft.created_at,
      })

      await incrementThreadPostCommentCounters({
        executor: tx,
        threadRootPostId: input.threadRootPostId,
        isTopLevel: !input.parentCommentId,
        commentedAt: draft.created_at,
      })

      await enqueueCommunityJob({
        client: tx,
        communityId: input.communityId,
        jobType: "comment_body_mirror",
        subjectType: "comment",
        subjectId: draft.comment_id,
        payloadJson: JSON.stringify({
          comment_id: draft.comment_id,
          thread_root_post_id: draft.thread_root_post_id,
        }),
        createdAt,
        dedupe: false, // inside write tx: INSERT-only (fresh comment, no dedup SELECT)
      })

      await enqueueCommunityJob({
        client: tx,
        communityId: input.communityId,
        jobType: "thread_snapshot_publish",
        subjectType: "thread",
        subjectId: input.threadRootPostId,
        payloadJson: JSON.stringify({
          thread_root_post_id: input.threadRootPostId,
        }),
        createdAt,
        dedupe: false, // inside write tx: INSERT-only (idempotent thread snapshot republish)
      })

      await enqueueCommentTranslationPrewarmJobs({
        client: tx,
        communityId: input.communityId,
        comment: draft,
        createdAt,
        dedupe: false, // inside write tx: INSERT-only prewarm jobs (fresh comment)
      })

      await tx.commit()

      // Hydrate the full Comment AFTER commit — the buffered write tx can't read the
      // inserted row back. Keep this failure hard: a missing row means the write was
      // not durable.
      const createdComment = await getCommentById(db.client, draft.comment_id)
      if (!createdComment) {
        throw internalError("Comment row is missing after insert")
      }

      try {
        await input.communityRepository.recordCommunityCommentProjection({
          communityId: input.communityId,
          threadRootPostId: createdComment.thread_root_post_id,
          sourceCommentId: createdComment.comment_id,
          parentCommentId: createdComment.parent_comment_id,
          depth: createdComment.depth,
          status: createdComment.status,
          sourceCreatedAt: createdComment.created_at,
          actorUserId: input.userId,
          createdAt,
        })
      } catch {
        await enqueueProjectionRetry({
          client: db.client,
          communityId: input.communityId,
          comment: createdComment,
          createdAt,
        })
      }

      await syncThreadRootPostProjectionMetrics({
        client: db.client,
        communityRepository: input.communityRepository,
        threadRootPostId: createdComment.thread_root_post_id,
        updatedAt: createdAt,
      })

      try {
        const notifiedUserIds = new Set<string>()
        const threadRootPost = await getPostById(db.client, input.threadRootPostId)

        if (parentComment && parentComment.author_user_id) {
          await emitCommentReply({
            env: input.env,
            actorIdentity: commentNotificationActorIdentity(createdComment),
            actorUserId: input.userId,
            commentExcerpt: commentNotificationExcerpt(createdComment),
            postTitle: threadRootPost?.title ?? null,
            recipientUserId: parentComment.author_user_id,
            communityId: input.communityId,
            threadRootPostId: input.threadRootPostId,
            parentCommentId: parentComment.comment_id,
            replyCommentId: createdComment.comment_id,
          })
          notifiedUserIds.add(parentComment.author_user_id)
        }

        if (threadRootPost?.author_user_id && threadRootPost.author_user_id !== input.userId && !notifiedUserIds.has(threadRootPost.author_user_id)) {
          await emitPostCommented({
            env: input.env,
            actorIdentity: commentNotificationActorIdentity(createdComment),
            actorUserId: input.userId,
            commentExcerpt: commentNotificationExcerpt(createdComment),
            postAuthorUserId: threadRootPost.author_user_id,
            communityId: input.communityId,
            postId: input.threadRootPostId,
            postTitle: threadRootPost.title ?? null,
            commentId: createdComment.comment_id,
          })
        }
      } catch (error) {
        console.error("[comments] failed to emit comment notifications", {
          communityId: input.communityId,
          postId: input.threadRootPostId,
          commentId: createdComment.comment_id,
          error,
        })
      }

      return createdComment
    } catch (error) {
      await safeRollback(tx, "[comments] rollback failed while creating comment")
      throw error
    } finally {
      tx.close()
    }
  } finally {
    db.close()
  }
}

export async function castCommentVote(input: {
  env: Env
  userId: string
  commentId: string
  value: -1 | 1
  bypassVoterAccessChecks?: boolean
  altchaProof?: AltchaProofInput
  userRepository: UserRepository
  communityRepository: CommentServiceCommunityRepository
}): Promise<{ comment_id: string; value: -1 | 1 }> {
  const projection = await input.communityRepository.getCommunityCommentProjectionByCommentId(input.commentId)
  if (!projection) {
    throw notFoundError("Comment not found")
  }

  const db = await openCommunityWriteClient(input.env, input.communityRepository, projection.community_id)
  try {
    if (!input.bypassVoterAccessChecks) {
      await requireMemberAccess(db.client, projection.community_id, input.userId)
      await enforceCommunityActionGate({
        env: input.env,
        client: db.client,
        userId: input.userId,
        userRepository: input.userRepository,
        communityId: projection.community_id,
        altchaScope: "vote",
        altchaProof: input.altchaProof,
      })
    }
    const comment = await getCommentById(db.client, input.commentId)
    if (!comment || comment.status !== "published") {
      throw notFoundError("Comment not found")
    }

    // Read the prior vote BEFORE the tx — buffer-safe (a write tx can't read it
    // back), so the count deltas computed in upsertCommentVote stay correct.
    const previousValue = await getExistingCommentVoteValue(db.client, input.commentId, input.userId)
    const tx = await db.client.transaction("write")
    try {
      const result = await upsertCommentVote({
        executor: tx,
        commentId: input.commentId,
        userId: input.userId,
        value: input.value,
        previousValue,
        now: nowIso(),
      })
      await tx.commit()
      return result
    } catch (error) {
      await safeRollback(tx, "[comments] rollback failed while casting comment vote")
      throw error
    } finally {
      tx.close()
    }
  } finally {
    db.close()
  }
}

export async function deleteComment(input: {
  env: Env
  userId: string
  commentId: string
  userRepository: UserRepository
  communityRepository: CommentServiceCommunityRepository
}): Promise<Comment> {
  const projection = await input.communityRepository.getCommunityCommentProjectionByCommentId(input.commentId)
  if (!projection) {
    throw notFoundError("Comment not found")
  }

  const db = await openCommunityWriteClient(input.env, input.communityRepository, projection.community_id)
  try {
    await requireMemberAccess(db.client, projection.community_id, input.userId)

    const comment = await getCommentById(db.client, input.commentId)
    if (!comment) {
      throw notFoundError("Comment not found")
    }
    if (comment.status === "deleted") {
      return comment
    }
    if (comment.author_user_id !== input.userId) {
      throw eligibilityFailed("You do not have permission to delete this comment")
    }

    const updatedAt = nowIso()
    const tx = await db.client.transaction("write")
    try {
      await markCommentDeleted({
        executor: tx,
        commentId: input.commentId,
        now: updatedAt,
      })
      await tx.commit()

      // Reconstruct deterministically from the pre-tx row: the write tx can't read
      // the updated row back, and markCommentDeleted sets exactly these fields.
      const deleted: Comment = { ...comment, status: "deleted", body: "[deleted]", media_refs: [], updated_at: updatedAt }

      try {
        await input.communityRepository.recordCommunityCommentProjection({
          communityId: deleted.community_id,
          threadRootPostId: deleted.thread_root_post_id,
          sourceCommentId: deleted.comment_id,
          parentCommentId: deleted.parent_comment_id,
          depth: deleted.depth,
          status: deleted.status,
          sourceCreatedAt: deleted.created_at,
          actorUserId: input.userId,
          createdAt: updatedAt,
        })
      } catch {
        await enqueueProjectionRetry({
          client: db.client,
          communityId: deleted.community_id,
          comment: deleted,
          createdAt: updatedAt,
        })
      }

      await syncThreadRootPostProjectionMetrics({
        client: db.client,
        communityRepository: input.communityRepository,
        threadRootPostId: deleted.thread_root_post_id,
        updatedAt,
      })

      return deleted
    } catch (error) {
      await safeRollback(tx, "[comments] rollback failed while deleting comment")
      throw error
    } finally {
      tx.close()
    }
  } finally {
    db.close()
  }
}

export async function removeCommentAsModerator(input: {
  env: Env
  userId: string
  commentId: string
  communityRepository: CommentServiceCommunityRepository
}): Promise<Comment> {
  const projection = await input.communityRepository.getCommunityCommentProjectionByCommentId(input.commentId)
  if (!projection) {
    throw notFoundError("Comment not found")
  }

  const db = await openCommunityWriteClient(input.env, input.communityRepository, projection.community_id)
  try {
    const membership = await requireMemberAccess(db.client, projection.community_id, input.userId)
    if (!hasCommunityRole(membership, ANY_COMMUNITY_ROLE)) {
      throw eligibilityFailed("Moderator access is required")
    }

    const comment = await getCommentById(db.client, input.commentId)
    if (!comment) {
      throw notFoundError("Comment not found")
    }
    if (comment.status === "deleted") {
      throw badRequestError("Cannot remove a deleted comment")
    }
    if (comment.status === "removed") {
      return comment
    }

    const updatedAt = nowIso()
    const tx = await db.client.transaction("write")
    try {
      await setCommentStatus({
        executor: tx,
        commentId: input.commentId,
        status: "removed",
        now: updatedAt,
      })
      await tx.commit()

      // Reconstruct deterministically from the pre-tx row (buffered write tx can't
      // read it back); setCommentStatus only changes status + updated_at.
      const removed: Comment = { ...comment, status: "removed", updated_at: updatedAt }

      try {
        await input.communityRepository.recordCommunityCommentProjection({
          communityId: removed.community_id,
          threadRootPostId: removed.thread_root_post_id,
          sourceCommentId: removed.comment_id,
          parentCommentId: removed.parent_comment_id,
          depth: removed.depth,
          status: removed.status,
          sourceCreatedAt: removed.created_at,
          actorUserId: input.userId,
          createdAt: updatedAt,
        })
      } catch {
        await enqueueProjectionRetry({
          client: db.client,
          communityId: removed.community_id,
          comment: removed,
          createdAt: updatedAt,
        })
      }

      await syncThreadRootPostProjectionMetrics({
        client: db.client,
        communityRepository: input.communityRepository,
        threadRootPostId: removed.thread_root_post_id,
        updatedAt,
      })

      return removed
    } catch (error) {
      await safeRollback(tx, "[comments] rollback failed while removing comment")
      throw error
    } finally {
      tx.close()
    }
  } finally {
    db.close()
  }
}

export async function setCommentReplyLock(input: {
  env: Env
  userId: string
  commentId: string
  locked: boolean
  reason?: string | null
  communityRepository: CommentServiceCommunityRepository
}): Promise<Comment> {
  const projection = await input.communityRepository.getCommunityCommentProjectionByCommentId(input.commentId)
  if (!projection) {
    throw notFoundError("Comment not found")
  }

  const db = await openCommunityWriteClient(input.env, input.communityRepository, projection.community_id)
  try {
    const membership = await requireMemberAccess(db.client, projection.community_id, input.userId)
    if (!hasCommunityRole(membership, ANY_COMMUNITY_ROLE)) {
      throw eligibilityFailed("Moderator access is required")
    }

    const comment = await getCommentById(db.client, input.commentId)
    if (!comment) {
      throw notFoundError("Comment not found")
    }
    if (comment.status !== "published") {
      throw badRequestError("Cannot lock replies on a comment that is not published")
    }

    const updatedAt = nowIso()
    const updated = await setCommentRepliesLocked({
      executor: db.client,
      commentId: input.commentId,
      locked: input.locked,
      actorUserId: input.userId,
      reason: input.reason?.trim() || null,
      now: updatedAt,
    })

    return updated
  } finally {
    db.close()
  }
}
