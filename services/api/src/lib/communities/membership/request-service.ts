import type { ProfileRepository, UserRepository } from "../../auth/repositories"
import type { CommunityRepository } from "../db-community-repository"
import { conflictError, gateFailedWithDetails, internalError, notFoundError } from "../../errors"
import { nowIso } from "../../helpers"
import { openCommunityDb } from "../community-db-factory"
import { requireOwnedCommunity } from "../create/repository"
import {
  emitMembershipRequestReceived,
  resolveMembershipReviewTask,
} from "../../notifications/notification-task-service"
import {
  canAccessCommunity,
  getCommunityJoinMode,
  getCommunityMembershipState,
  upsertCommunityMembership,
} from "./membership-state-store"
import {
  countPendingMembershipRequests,
  getPendingMembershipRequestByApplicant,
  listPendingMembershipRequests,
  resolveMembershipRequest,
  upsertMembershipRequest,
} from "./membership-request-store"
import { listActiveMembershipGateRules } from "./gate-rule-store"
import {
  buildMembershipGateSummary,
  evaluateMembershipGateRules,
} from "./gates"
import {
  assertBaselineJoinGate,
  buildWalletScoreStatus,
} from "./eligibility-service"
import { projectMembershipAndFollow } from "./projection-service"
import type { MembershipResult } from "./types"
import type {
  Env,
  MembershipRequestListResponse,
  MembershipRequestSummary,
} from "../../../types"

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
  assertBaselineJoinGate(user)

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
