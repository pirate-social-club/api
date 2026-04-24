import {
  canAccessCommunity,
  buildMembershipGateSummary,
  evaluateMembershipGateRules,
  countPendingMembershipRequests,
  getCommunityJoinMode,
  getCommunityMembershipState,
  getPendingMembershipRequestByApplicant,
  listPendingMembershipRequests,
  listActiveMembershipGateRules,
  resolveMembershipRequest,
  setCommunityFollowActive,
  setCommunityFollowInactive,
  upsertCommunityMembership,
  upsertMembershipRequest,
} from "./store"
import type { CommunityGateRuleRow } from "./gates"
import { openCommunityDb } from "../community-db-factory"
import {
  buildLocalizedCommunity,
  enqueueCommunityTextTranslationOnReadIfNeeded,
} from "../../localization/community-localization-service"
import type { ProfileRepository, UserRepository } from "../../auth/repositories"
import type { CommunityRepository } from "../db-community-repository"
import { conflictError, gateFailedWithDetails, internalError, notFoundError } from "../../errors"
import { nowIso } from "../../helpers"
import { loadCommunityProjection, requireOwnedCommunity } from "../create/service"
import {
  emitMembershipRequestReceived,
  resolveMembershipReviewTask,
} from "../../notifications/notification-service"

import { serializeJob } from "../community-serialization"
import type {
  Community,
  Env,
  JoinEligibility,
  Job,
  MembershipRequestListResponse,
  MembershipRequestSummary,
  User,
} from "../../../types"

type MembershipResult = {
  community_id: string
  status: "joined" | "requested" | "left"
}

type CommunityFollowResult = {
  community_id: string
  following: boolean
  follower_count: number | null
}

export { getCommunityPreview, getPublicCommunityPreview } from "../community-preview-service"

function sanitizeMembershipRequestNote(note: string | null | undefined): string | null {
  const trimmed = typeof note === "string" ? note.trim() : ""
  return trimmed ? trimmed.slice(0, 500) : null
}

async function enrichMembershipRequestProfiles(
  profileRepository: ProfileRepository,
  requests: MembershipRequestSummary[],
): Promise<MembershipRequestSummary[]> {
  return Promise.all(requests.map(async (request) => {
    const profile = await profileRepository.getProfileByUserId(request.applicant_user_id).catch(() => null)
    return {
      ...request,
      applicant_handle: profile?.primary_public_handle?.label ?? profile?.global_handle.label ?? null,
      applicant_avatar_ref: profile?.avatar_ref ?? null,
    }
  }))
}

export function satisfiesBaselineJoinGate(user: User): boolean {
  if (user.verification_capabilities.unique_human.state === "verified") {
    return true
  }

  return user.verification_capabilities.wallet_score.state === "verified"
    && user.verification_capabilities.wallet_score.provider === "passport"
    && user.verification_capabilities.wallet_score.passing_score === true
}

function getRequiredWalletScore(rules: CommunityGateRuleRow[]): number | null {
  let requiredScore: number | null = null
  for (const summary of rules.map(buildMembershipGateSummary)) {
    if (summary.gate_type !== "wallet_score" || typeof summary.minimum_score !== "number") {
      continue
    }
    requiredScore = requiredScore == null ? summary.minimum_score : Math.max(requiredScore, summary.minimum_score)
  }
  return requiredScore
}

function buildWalletScoreStatus(user: User, rules: CommunityGateRuleRow[]): JoinEligibility["wallet_score_status"] {
  const requiredScore = getRequiredWalletScore(rules)
  if (requiredScore == null) {
    return null
  }
  const capability = user.verification_capabilities.wallet_score
  return {
    current_score: typeof capability.score === "number" ? capability.score : null,
    required_score: requiredScore,
    passing_score: typeof capability.passing_score === "boolean" ? capability.passing_score : null,
    last_score_timestamp: capability.last_score_timestamp ?? null,
  }
}

async function syncCommunityFollowProjection(input: {
  communityRepository: CommunityRepository
  communityId: string
  userId: string
  followState: "active" | "inactive"
  changed: boolean
  now: string
}): Promise<void> {
  await input.communityRepository.upsertCommunityFollowProjection({
    communityId: input.communityId,
    userId: input.userId,
    followState: input.followState,
    sourceUpdatedAt: input.now,
    unfollowedAt: input.followState === "inactive" ? input.now : null,
    createdAt: input.now,
  })
  if (input.changed) {
    await input.communityRepository.incrementCommunityFollowerCount({
      communityId: input.communityId,
      delta: input.followState === "active" ? 1 : -1,
      updatedAt: input.now,
    })
  }
}

async function followCommunityForHomeFeed(input: {
  db: Awaited<ReturnType<typeof openCommunityDb>>
  communityRepository: CommunityRepository
  communityId: string
  userId: string
  now: string
}): Promise<CommunityFollowResult> {
  const result = await setCommunityFollowActive({
    client: input.db.client,
    communityId: input.communityId,
    userId: input.userId,
    now: input.now,
  })
  await syncCommunityFollowProjection({
    communityRepository: input.communityRepository,
    communityId: input.communityId,
    userId: input.userId,
    followState: "active",
    changed: result.changed,
    now: input.now,
  })

  return {
    community_id: input.communityId,
    following: true,
    follower_count: result.followerCount,
  }
}

async function projectMembershipAndFollow(input: {
  db: Awaited<ReturnType<typeof openCommunityDb>>
  communityRepository: CommunityRepository
  communityId: string
  userId: string
  now: string
}): Promise<void> {
  await input.communityRepository.upsertCommunityMembershipProjection({
    communityId: input.communityId,
    userId: input.userId,
    membershipState: "member",
    sourceUpdatedAt: input.now,
    createdAt: input.now,
  })
  await followCommunityForHomeFeed({
    db: input.db,
    communityRepository: input.communityRepository,
    communityId: input.communityId,
    userId: input.userId,
    now: input.now,
  })
}

export async function setPendingNamespaceVerificationSession(input: {
  env: Env
  userId: string
  communityId: string
  sessionId: string | null
  communityRepository: CommunityRepository
}): Promise<Community> {
  await requireOwnedCommunity(input.communityRepository, input.communityId, input.userId)
  await input.communityRepository.setPendingNamespaceVerificationSession({
    communityId: input.communityId,
    sessionId: input.sessionId,
    updatedAt: nowIso(),
  })

  const updated = await input.communityRepository.getCommunityById(input.communityId)
  if (!updated) {
    throw notFoundError("Community not found")
  }
  return loadCommunityProjection(input.env, input.communityRepository, updated)
}

export async function getCommunity(input: {
  env: Env
  userId: string
  communityId: string
  locale?: string | null
  repository: CommunityRepository
}): Promise<Community> {
  const community = await requireOwnedCommunity(input.repository, input.communityId, input.userId)
  const canonical = await loadCommunityProjection(input.env, input.repository, community)
  if (input.locale == null) {
    return canonical
  }

  const db = await openCommunityDb(input.env, input.repository, input.communityId)
  try {
    const localized = await buildLocalizedCommunity({
      executor: db.client,
      community: canonical,
      locale: input.locale ?? null,
    })
    await enqueueCommunityTextTranslationOnReadIfNeeded({
      executor: db.client,
      communityId: input.communityId,
      localization: localized.localized_text,
    })
    return localized
  } finally {
    db.close()
  }
}

export async function getJoinEligibility(input: {
  env: Env
  userId: string
  communityId: string
  userRepository: UserRepository
  communityRepository: CommunityRepository
}): Promise<JoinEligibility> {
  const user = await input.userRepository.getUserById(input.userId)
  if (!user) {
    throw internalError("Resolved user row is missing for join eligibility")
  }

  const community = await input.communityRepository.getCommunityById(input.communityId)
  if (!community || community.provisioning_state !== "active" || community.status !== "active") {
    throw notFoundError("Community not found")
  }

  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    const localResult = await db.client.execute({
      sql: `SELECT membership_mode FROM communities WHERE community_id = ?1 LIMIT 1`,
      args: [input.communityId],
    })
    const membershipMode: Community["membership_mode"] =
      localResult.rows[0]?.membership_mode === "open" || localResult.rows[0]?.membership_mode === "request" || localResult.rows[0]?.membership_mode === "gated"
        ? (localResult.rows[0].membership_mode as Community["membership_mode"])
        : "open"

    const membership = await getCommunityMembershipState(db.client, input.communityId, input.userId)
    if (canAccessCommunity(membership)) {
      return {
        community_id: input.communityId,
        membership_mode: membershipMode,
        human_verification_lane: "self",
        joinable_now: false,
        status: "already_joined",
        membership_gate_summaries: [],
        missing_capabilities: [],
      }
    }

    if (membership.membership_status === "banned") {
      return {
        community_id: input.communityId,
        membership_mode: membershipMode,
        human_verification_lane: "self",
        joinable_now: false,
        status: "banned",
        membership_gate_summaries: [],
        missing_capabilities: [],
      }
    }

    if (!satisfiesBaselineJoinGate(user)) {
      return {
        community_id: input.communityId,
        membership_mode: membershipMode,
        human_verification_lane: "self",
        joinable_now: false,
        status: "verification_required",
        membership_gate_summaries: [],
        missing_capabilities: ["unique_human"],
        suggested_verification_provider: "self",
        suggested_verification_intent: "community_join",
      }
    }

    if (membershipMode === "open") {
      return {
        community_id: input.communityId,
        membership_mode: "open",
        human_verification_lane: "self",
        joinable_now: true,
        status: "joinable",
        membership_gate_summaries: [],
        missing_capabilities: [],
      }
    }

    if (membershipMode === "request") {
      const pendingRequest = await getPendingMembershipRequestByApplicant({
        client: db.client,
        communityId: input.communityId,
        userId: input.userId,
      })
      if (pendingRequest) {
        return {
          community_id: input.communityId,
          membership_mode: "request",
          human_verification_lane: "self",
          joinable_now: false,
          status: "pending_request",
          membership_gate_summaries: [],
          missing_capabilities: [],
        }
      }
      return {
        community_id: input.communityId,
        membership_mode: "request",
        human_verification_lane: "self",
        joinable_now: false,
        status: "requestable",
        membership_gate_summaries: [],
        missing_capabilities: [],
      }
	}

    const rules = await listActiveMembershipGateRules(db.client, input.communityId)
    const gateSummaries = rules.map(buildMembershipGateSummary)
    const walletScoreStatus = buildWalletScoreStatus(user, rules)
    const walletAttachments = await input.userRepository.getWalletAttachmentsByUserId(input.userId)
    const evaluation = await evaluateMembershipGateRules({
      env: input.env,
      rules,
      user,
      walletAttachments,
    })
    if (evaluation.satisfied) {
      return {
        community_id: input.communityId,
        membership_mode: membershipMode,
        human_verification_lane: "self",
        joinable_now: true,
        status: "joinable",
        membership_gate_summaries: gateSummaries,
        missing_capabilities: [],
      }
    }

    if (evaluation.missingCapabilities.length > 0) {
      return {
        community_id: input.communityId,
        membership_mode: membershipMode,
        human_verification_lane: "self",
        joinable_now: false,
        status: "verification_required",
        membership_gate_summaries: gateSummaries,
        missing_capabilities: evaluation.missingCapabilities,
        ...(walletScoreStatus ? { wallet_score_status: walletScoreStatus } : {}),
        suggested_verification_provider: evaluation.suggestedVerificationProvider,
        suggested_verification_intent: evaluation.suggestedVerificationProvider === "self"
          ? "community_join"
          : null,
      }
    }

    const failureReason = evaluation.mismatchReasons.includes("token_inventory_unavailable")
      ? "token_inventory_unavailable"
      : evaluation.mismatchReasons.includes("erc721_inventory_match_required")
        ? "erc721_inventory_match_required"
        : evaluation.mismatchReasons.includes("erc721_holding_required")
          ? "erc721_holding_required"
          : evaluation.mismatchReasons.includes("minimum_age_mismatch")
            ? "minimum_age_mismatch"
            : evaluation.mismatchReasons.includes("wallet_score_too_low")
              ? "wallet_score_too_low"
              : evaluation.mismatchReasons.includes("mechanism_not_accepted")
                ? "provider_not_accepted"
                : null
    return {
      community_id: input.communityId,
      membership_mode: membershipMode,
      human_verification_lane: "self",
      joinable_now: false,
      status: "gate_failed",
      membership_gate_summaries: gateSummaries,
      missing_capabilities: [],
      failure_reason: failureReason,
      ...(walletScoreStatus ? { wallet_score_status: walletScoreStatus } : {}),
    }
  } finally {
    db.close()
  }
}

export async function followCommunity(input: {
  env: Env
  userId: string
  communityId: string
  communityRepository: CommunityRepository
}): Promise<CommunityFollowResult> {
  const community = await input.communityRepository.getCommunityById(input.communityId)
  if (!community || community.provisioning_state !== "active" || community.status !== "active") {
    throw notFoundError("Community not found")
  }

  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    return await followCommunityForHomeFeed({
      db,
      communityRepository: input.communityRepository,
      communityId: input.communityId,
      userId: input.userId,
      now: nowIso(),
    })
  } finally {
    db.close()
  }
}

export async function unfollowCommunity(input: {
  env: Env
  userId: string
  communityId: string
  communityRepository: CommunityRepository
}): Promise<CommunityFollowResult> {
  const community = await input.communityRepository.getCommunityById(input.communityId)
  if (!community || community.provisioning_state !== "active" || community.status !== "active") {
    throw notFoundError("Community not found")
  }

  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    const membership = await getCommunityMembershipState(db.client, input.communityId, input.userId)
    if (canAccessCommunity(membership)) {
      throw conflictError("Citizens cannot unfollow. Leave the community first.")
    }

    const now = nowIso()
    const result = await setCommunityFollowInactive({
      client: db.client,
      communityId: input.communityId,
      userId: input.userId,
      now,
    })
    await syncCommunityFollowProjection({
      communityRepository: input.communityRepository,
      communityId: input.communityId,
      userId: input.userId,
      followState: "inactive",
      changed: result.changed,
      now,
    })

    return {
      community_id: input.communityId,
      following: false,
      follower_count: result.followerCount,
    }
  } finally {
    db.close()
  }
}

export async function joinCommunity(input: {
  env: Env
  userId: string
  communityId: string
  note?: string | null
  userRepository: UserRepository
  profileRepository?: ProfileRepository
  communityRepository: CommunityRepository
}): Promise<MembershipResult> {
  const user = await input.userRepository.getUserById(input.userId)
  if (!user) {
    throw internalError("Resolved user row is missing for community join")
  }
  if (!satisfiesBaselineJoinGate(user)) {
    throw gateFailedWithDetails("A platform trust credential is required to join this community", {
      missing_capabilities: ["unique_human"],
      suggested_verification_provider: "self",
      suggested_verification_intent: "community_join",
      failure_reason: "missing_verification",
    })
  }

  const community = await input.communityRepository.getCommunityById(input.communityId)
  if (!community || community.provisioning_state !== "active" || community.status !== "active") {
    throw notFoundError("Community not found")
  }

  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    const membership = await getCommunityMembershipState(db.client, input.communityId, input.userId)
    if (canAccessCommunity(membership)) {
      return {
        community_id: input.communityId,
        status: "joined",
      }
    }
    if (membership.membership_status === "banned") {
      throw gateFailedWithDetails("Community membership is not available for this account", {
        failure_reason: "banned",
      })
    }

    const membershipMode = await getCommunityJoinMode(db.client, input.communityId)
    if (!membershipMode) {
      throw notFoundError("Community not found")
    }

    const now = nowIso()
    if (membershipMode === "open") {
      await upsertCommunityMembership({
        client: db.client,
        communityId: input.communityId,
        userId: input.userId,
        now,
      })
      await projectMembershipAndFollow({
        db,
        communityRepository: input.communityRepository,
        communityId: input.communityId,
        userId: input.userId,
        now,
      })
      return {
        community_id: input.communityId,
        status: "joined",
      }
    }

    if (membershipMode === "request") {
      const existingRequest = await getPendingMembershipRequestByApplicant({
        client: db.client,
        communityId: input.communityId,
        userId: input.userId,
      })
      const request = existingRequest ?? await upsertMembershipRequest({
        client: db.client,
        communityId: input.communityId,
        userId: input.userId,
        note: sanitizeMembershipRequestNote(input.note),
        now,
      })
      await input.communityRepository.upsertCommunityMembershipProjection({
        communityId: input.communityId,
        userId: input.userId,
        membershipState: "pending_request",
        sourceUpdatedAt: now,
        createdAt: now,
      })
      if (!existingRequest) {
        const applicantProfile = input.profileRepository
          ? await input.profileRepository.getProfileByUserId(input.userId).catch(() => null)
          : null
        await emitMembershipRequestReceived({
          env: input.env,
          reviewerUserId: community.creator_user_id,
          communityId: input.communityId,
          communityDisplayName: community.display_name,
          applicantUserId: input.userId,
          applicantHandle: applicantProfile?.primary_public_handle?.label ?? applicantProfile?.global_handle.label ?? null,
          requestCount: await countPendingMembershipRequests({
            client: db.client,
            communityId: input.communityId,
          }),
          requestId: request.membership_request_id,
        })
      }
      return {
        community_id: input.communityId,
        status: "requested",
      }
    }

    const rules = await listActiveMembershipGateRules(db.client, input.communityId)
    const gateSummaries = rules.map(buildMembershipGateSummary)
    const walletScoreStatus = buildWalletScoreStatus(user, rules)
    const walletAttachments = await input.userRepository.getWalletAttachmentsByUserId(input.userId)
    const evaluation = await evaluateMembershipGateRules({
      env: input.env,
      rules,
      user,
      walletAttachments,
    })
    if (!evaluation.satisfied) {
      if (evaluation.missingCapabilities.length > 0) {
        throw gateFailedWithDetails("Verification is required to join this community", {
          membership_gate_summaries: gateSummaries,
          missing_capabilities: evaluation.missingCapabilities,
          suggested_verification_provider: evaluation.suggestedVerificationProvider,
          suggested_verification_intent: evaluation.suggestedVerificationProvider === "self"
            ? "community_join"
            : null,
          failure_reason: "missing_verification",
          ...(walletScoreStatus ? { wallet_score_status: walletScoreStatus } : {}),
        })
      }
      if (evaluation.mismatchReasons.includes("nationality_mismatch")) {
        throw gateFailedWithDetails("Your verified nationality does not satisfy this community requirement", {
          membership_gate_summaries: gateSummaries,
          failure_reason: "nationality_mismatch",
        })
      }
      if (evaluation.mismatchReasons.includes("gender_mismatch")) {
        throw gateFailedWithDetails("Your verified gender does not satisfy this community requirement", {
          membership_gate_summaries: gateSummaries,
          failure_reason: "gender_mismatch",
        })
      }
      if (evaluation.mismatchReasons.includes("mechanism_not_accepted")) {
        throw gateFailedWithDetails("Your verification method does not satisfy this community requirement", {
          membership_gate_summaries: gateSummaries,
          failure_reason: "provider_not_accepted",
        })
      }
      if (evaluation.mismatchReasons.includes("wallet_score_too_low")) {
        throw gateFailedWithDetails("Your Passport score does not satisfy this community requirement", {
          membership_gate_summaries: gateSummaries,
          failure_reason: "wallet_score_too_low",
          ...(walletScoreStatus ? { wallet_score_status: walletScoreStatus } : {}),
        })
      }
      if (evaluation.mismatchReasons.includes("minimum_age_mismatch")) {
        throw gateFailedWithDetails("Your verified age does not satisfy this community requirement", {
          membership_gate_summaries: gateSummaries,
          failure_reason: "minimum_age_mismatch",
        })
      }
      if (evaluation.mismatchReasons.includes("erc721_holding_required")) {
        throw gateFailedWithDetails("A linked Ethereum wallet holding this NFT collection is required to join", {
          membership_gate_summaries: gateSummaries,
          failure_reason: "erc721_holding_required",
        })
      }
      if (evaluation.mismatchReasons.includes("token_inventory_unavailable")) {
        throw gateFailedWithDetails("Collectible inventory could not be checked right now", {
          membership_gate_summaries: gateSummaries,
          failure_reason: "token_inventory_unavailable",
        })
      }
      if (evaluation.mismatchReasons.includes("erc721_inventory_match_required")) {
        throw gateFailedWithDetails("A linked wallet holding the required collectible inventory is required to join", {
          membership_gate_summaries: gateSummaries,
          failure_reason: "erc721_inventory_match_required",
        })
      }
      throw gateFailedWithDetails("Community membership requirements are not satisfied", {
        membership_gate_summaries: gateSummaries,
        failure_reason: "unsupported",
      })
    }
    await upsertCommunityMembership({
      client: db.client,
      communityId: input.communityId,
      userId: input.userId,
      now,
    })
    await projectMembershipAndFollow({
      db,
      communityRepository: input.communityRepository,
      communityId: input.communityId,
      userId: input.userId,
      now,
    })
    return {
      community_id: input.communityId,
      status: "joined",
    }
  } finally {
    db.close()
  }
}

export async function listMembershipRequests(input: {
  env: Env
  userId: string
  communityId: string
  cursor?: string | null
  limit?: number
  communityRepository: CommunityRepository
  profileRepository: ProfileRepository
}): Promise<MembershipRequestListResponse> {
  await requireOwnedCommunity(input.communityRepository, input.communityId, input.userId)
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    const result = await listPendingMembershipRequests({
      client: db.client,
      communityId: input.communityId,
      cursor: input.cursor,
      limit: input.limit,
    })
    return {
      items: await enrichMembershipRequestProfiles(input.profileRepository, result.items),
      next_cursor: result.next_cursor,
    }
  } finally {
    db.close()
  }
}

export async function reviewMembershipRequest(input: {
  env: Env
  userId: string
  communityId: string
  requestId: string
  decision: "approved" | "rejected"
  communityRepository: CommunityRepository
  profileRepository: ProfileRepository
}): Promise<MembershipRequestSummary> {
  const community = await requireOwnedCommunity(input.communityRepository, input.communityId, input.userId)
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    const now = nowIso()
    const request = await resolveMembershipRequest({
      client: db.client,
      communityId: input.communityId,
      requestId: input.requestId,
      reviewerUserId: input.userId,
      decision: input.decision,
      now,
    })
    if (!request) {
      throw conflictError("Membership request is no longer pending")
    }

    if (input.decision === "approved") {
      await projectMembershipAndFollow({
        db,
        communityRepository: input.communityRepository,
        communityId: input.communityId,
        userId: request.applicant_user_id,
        now,
      })
    }

    const remainingCount = await countPendingMembershipRequests({
      client: db.client,
      communityId: input.communityId,
    })
    if (remainingCount === 0) {
      await resolveMembershipReviewTask({
        env: input.env,
        reviewerUserId: community.creator_user_id,
        communityId: input.communityId,
      })
    } else {
      await emitMembershipRequestReceived({
        env: input.env,
        reviewerUserId: community.creator_user_id,
        communityId: input.communityId,
        communityDisplayName: community.display_name,
        applicantUserId: request.applicant_user_id,
        requestCount: remainingCount,
        requestId: request.membership_request_id,
      })
    }

    const [enriched] = await enrichMembershipRequestProfiles(input.profileRepository, [request])
    return enriched
  } finally {
    db.close()
  }
}

export async function getJob(input: {
  env: Env
  userId: string
  jobId: string
  repository: CommunityRepository
}): Promise<Job> {
  const job = await input.repository.getJobById(input.jobId)
  if (!job) {
    throw notFoundError("Job not found")
  }
  if (!job.community_id) {
    throw notFoundError("Job not found")
  }
  await requireOwnedCommunity(input.repository, job.community_id, input.userId)
  return serializeJob(job)
}
