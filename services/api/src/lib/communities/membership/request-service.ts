import type { ProfileRepository, UserRepository } from "../../auth/repositories"
import { conflictError, gateFailedWithDetails, internalError, notFoundError } from "../../errors"
import { nowIso } from "../../helpers"
import {
  emitMembershipRequestReceived,
  resolveMembershipReviewTask,
} from "../../notifications/notification-task-service"
import type {
  Env,
  MembershipRequestListResponse,
  MembershipRequestSummary,
} from "../../../types"
import { openCommunityDb } from "../community-db-factory"
import { isCommunityLive } from "../community-status"
import {
  canAccessCommunity,
  getCommunityMembershipState,
  upsertCommunityMembership,
} from "./membership-state-store"
import {
  countPendingMembershipRequests,
  getCommunityJoinMode,
  getPendingMembershipRequestByApplicant,
  listPendingMembershipRequests,
  resolveMembershipRequest,
  upsertMembershipRequest,
  type MembershipRequestRow,
} from "./membership-request-store"
import { getMembershipGatePolicy } from "./gate-policy-store"
import { evaluateGatedMembership } from "./eligibility-service"
import { throwUnsatisfiedMembershipGate } from "./gate-failure-service"
import { projectMembershipAndFollow } from "./projection-service"
import type { CommunityMembershipRepository, MembershipResult } from "./types"
import { requireOwnedCommunity } from "../create/service"
import { unixSeconds } from "../../../serializers/time"
import { publicCommunityId } from "../../public-ids"
import type { AltchaProofInput } from "../../verification/altcha-provider"

function sanitizeMembershipRequestNote(note: string | null | undefined): string | null {
  const trimmed = typeof note === "string" ? note.trim() : ""
  return trimmed ? trimmed.slice(0, 500) : null
}

async function enrichMembershipRequestProfiles(
  profileRepository: ProfileRepository,
  requests: MembershipRequestRow[],
): Promise<MembershipRequestSummary[]> {
  return Promise.all(requests.map(async (request) => {
    const profile = await profileRepository.getProfileByUserId(request.applicant_user_id).catch(() => null)
    return {
      id: `mrq_${request.membership_request_id}`,
      object: "membership_request_summary",
      community: `com_${request.community_id}`,
      applicant_user: `usr_${request.applicant_user_id}`,
      applicant_handle: profile?.primary_public_handle?.label ?? profile?.global_handle.label ?? null,
      applicant_avatar_ref: profile?.avatar_ref ?? null,
      status: request.status,
      note: request.note,
      created: unixSeconds(request.created_at),
    }
  }))
}

export async function joinCommunity(input: {
  env: Env
  userId: string
  communityId: string
  note?: string | null
  bypassMembershipGateChecks?: boolean
  altchaProof?: AltchaProofInput
  userRepository: UserRepository
  profileRepository?: ProfileRepository
  communityRepository: CommunityMembershipRepository
}): Promise<MembershipResult> {
  const user = await input.userRepository.getUserById(input.userId)
  if (!user) {
    throw internalError("Resolved user row is missing for community join")
  }
  const community = await input.communityRepository.getCommunityById(input.communityId)
  if (!isCommunityLive(community)) {
    throw notFoundError("Community not found")
  }

  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    const membership = await getCommunityMembershipState(db.client, input.communityId, input.userId)
    if (canAccessCommunity(membership)) {
      return {
        community: publicCommunityId(input.communityId),
        status: "joined",
      }
    }
    if (membership.membership_status === "banned") {
      throw gateFailedWithDetails("Community membership is not available for this account", {
        failure_reason: "banned",
      })
    }

    const now = nowIso()
    if (input.bypassMembershipGateChecks) {
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
        community: publicCommunityId(input.communityId),
        status: "joined",
      }
    }

    const membershipMode = await getCommunityJoinMode(db.client, input.communityId)
    if (!membershipMode) {
      throw notFoundError("Community not found")
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
        community: publicCommunityId(input.communityId),
        status: "requested",
      }
    }

    const policy = await getMembershipGatePolicy(db.client, input.communityId)
    const { gateSummaries, walletScoreStatus, evaluation } = await evaluateGatedMembership({
      env: input.env,
      user,
      userRepository: input.userRepository,
      communityId: input.communityId,
      policy,
      mode: "enforce",
      altchaScope: "community_join",
      altchaProof: input.altchaProof,
    })
    if (!evaluation.satisfied) {
      throwUnsatisfiedMembershipGate({ evaluation, gateSummaries, walletScoreStatus })
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
      community: publicCommunityId(input.communityId),
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
  communityRepository: CommunityMembershipRepository
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
  communityRepository: CommunityMembershipRepository
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
