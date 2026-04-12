import {
  canAccessCommunity,
  canModerateMembershipRequests,
  getCommunityRoleAccessState,
  getCommunityJoinMode,
  getCommunityMembershipState,
  getMembershipRequestById,
  listActiveCommunityMemberUserIds,
  listActiveMembershipGateRules,
  listPendingMembershipRequests,
  resolveMembershipRequestAsApproved,
  resolveMembershipRequestAsRejected,
  resolvePendingMembershipRequestsAsApproved,
  type MembershipRequestRow,
  satisfiesMembershipGateRules,
  upsertCommunityMembership,
  upsertMembershipRequest,
} from "./community-membership-store"
import { openCommunityDb } from "./community-db-factory"
import { evaluateTokenHoldingGate } from "./community-token-gate-runtime"
import type { UserRepository } from "../auth/repositories"
import type { CommunityRepository } from "./control-plane-community-repository"
import { conflictError, gateFailed, internalError, notFoundError } from "../errors"
import { nowIso } from "../helpers"
import { verifyPirateAccessToken } from "../auth/pirate-session-token"
import {
  recomputeAndPersistCommunityMembershipStats,
  requireCommunityModerationAccess,
  satisfiesBaselineJoinGate,
} from "./community-service-shared"
import type { Env, User } from "../../types"

type MembershipResult = {
  community_id: string
  status: "joined" | "requested" | "left"
}

type MembershipRequestResponse = MembershipRequestRow

export async function joinCommunity(input: {
  env: Env
  bearerToken: string
  communityId: string
  userRepository: UserRepository
  communityRepository: CommunityRepository
}): Promise<MembershipResult> {
  const session = await verifyPirateAccessToken({ env: input.env, token: input.bearerToken })
  const user = await input.userRepository.getUserById(session.userId)
  if (!user) {
    throw internalError("Resolved user row is missing for community join")
  }
  const walletAttachments = await input.userRepository.getWalletAttachmentsByUserId(session.userId)
  if (!satisfiesBaselineJoinGate(user)) {
    throw gateFailed("A platform trust credential is required to join this community")
  }

  const community = await input.communityRepository.getCommunityById(input.communityId)
  if (!community || community.provisioning_state !== "active" || community.status !== "active") {
    throw notFoundError("Community not found")
  }

  const db = await openCommunityDb(input.communityRepository, input.communityId)
  try {
    const membership = await getCommunityMembershipState(db.client, input.communityId, session.userId)
    if (canAccessCommunity(membership)) {
      return {
        community_id: input.communityId,
        status: "joined",
      }
    }
    if (membership.membership_status === "banned") {
      throw gateFailed("Community membership is not available for this account")
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
        userId: session.userId,
        now,
      })
      await resolvePendingMembershipRequestsAsApproved({
        client: db.client,
        communityId: input.communityId,
        userId: session.userId,
        reviewerUserId: null,
        reviewReason: "resolved_by_membership",
        now,
      })
      await recomputeAndPersistCommunityMembershipStats({
        repository: input.communityRepository,
        userRepository: input.userRepository,
        communityId: input.communityId,
      })
      return {
        community_id: input.communityId,
        status: "joined",
      }
    }

    if (membershipMode === "request") {
      await upsertMembershipRequest({
        client: db.client,
        communityId: input.communityId,
        userId: session.userId,
        now,
      })
      return {
        community_id: input.communityId,
        status: "requested",
      }
    }

    const rules = await listActiveMembershipGateRules(db.client, input.communityId)
    if (!(await satisfiesMembershipGateRules(rules, {
      user,
      wallets: walletAttachments,
      tokenGateEvaluator: (tokenInput) => evaluateTokenHoldingGate({
        env: input.env,
        ...tokenInput,
      }),
    }))) {
      throw gateFailed("Community membership requirements are not satisfied")
    }
    await upsertCommunityMembership({
      client: db.client,
      communityId: input.communityId,
      userId: session.userId,
      now,
    })
    await resolvePendingMembershipRequestsAsApproved({
      client: db.client,
      communityId: input.communityId,
      userId: session.userId,
      reviewerUserId: null,
      reviewReason: "resolved_by_membership",
      now,
    })
    await recomputeAndPersistCommunityMembershipStats({
      repository: input.communityRepository,
      userRepository: input.userRepository,
      communityId: input.communityId,
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
  bearerToken: string
  communityId: string
  communityRepository: CommunityRepository
}): Promise<{ membership_requests: MembershipRequestResponse[] }> {
  const session = await verifyPirateAccessToken({ env: input.env, token: input.bearerToken })
  const community = await input.communityRepository.getCommunityById(input.communityId)
  if (!community || community.provisioning_state !== "active" || community.status !== "active") {
    throw notFoundError("Community not found")
  }

  const db = await openCommunityDb(input.communityRepository, input.communityId)
  try {
    await requireCommunityModerationAccess({
      dbClient: db.client,
      communityId: input.communityId,
      userId: session.userId,
    })
    const membershipRequests = await listPendingMembershipRequests(db.client, input.communityId)
    return { membership_requests: membershipRequests }
  } finally {
    db.close()
  }
}

export async function approveMembershipRequest(input: {
  env: Env
  bearerToken: string
  communityId: string
  membershipRequestId: string
  reviewReason: string | null
  communityRepository: CommunityRepository
  userRepository: UserRepository
}): Promise<MembershipRequestResponse> {
  const session = await verifyPirateAccessToken({ env: input.env, token: input.bearerToken })
  const community = await input.communityRepository.getCommunityById(input.communityId)
  if (!community || community.provisioning_state !== "active" || community.status !== "active") {
    throw notFoundError("Community not found")
  }

  const db = await openCommunityDb(input.communityRepository, input.communityId)
  try {
    await requireCommunityModerationAccess({
      dbClient: db.client,
      communityId: input.communityId,
      userId: session.userId,
    })

    const existing = await getMembershipRequestById(db.client, input.communityId, input.membershipRequestId)
    if (!existing) {
      throw notFoundError("Membership request not found")
    }
    if (existing.status !== "pending") {
      throw conflictError("Membership request is not pending")
    }

    const now = nowIso()
    const tx = await db.client.transaction("write")
    try {
      await upsertCommunityMembership({
        client: tx,
        communityId: input.communityId,
        userId: existing.applicant_user_id,
        now,
      })
      await resolveMembershipRequestAsApproved({
        client: tx,
        membershipRequestId: input.membershipRequestId,
        reviewerUserId: session.userId,
        reviewReason: input.reviewReason,
        now,
      })
      await resolvePendingMembershipRequestsAsApproved({
        client: tx,
        communityId: input.communityId,
        userId: existing.applicant_user_id,
        reviewerUserId: session.userId,
        reviewReason: input.reviewReason,
        now,
      })
      await tx.commit()
    } catch (error) {
      try {
        await tx.rollback()
      } catch {}
      throw error
    } finally {
      tx.close()
    }

    await recomputeAndPersistCommunityMembershipStats({
      repository: input.communityRepository,
      userRepository: input.userRepository,
      communityId: input.communityId,
    })

    const resolved = await getMembershipRequestById(db.client, input.communityId, input.membershipRequestId)
    if (!resolved) {
      throw internalError("Resolved membership request is missing after approval")
    }
    return resolved
  } finally {
    db.close()
  }
}

export async function rejectMembershipRequest(input: {
  env: Env
  bearerToken: string
  communityId: string
  membershipRequestId: string
  reviewReason: string | null
  communityRepository: CommunityRepository
}): Promise<MembershipRequestResponse> {
  const session = await verifyPirateAccessToken({ env: input.env, token: input.bearerToken })
  const community = await input.communityRepository.getCommunityById(input.communityId)
  if (!community || community.provisioning_state !== "active" || community.status !== "active") {
    throw notFoundError("Community not found")
  }

  const db = await openCommunityDb(input.communityRepository, input.communityId)
  try {
    await requireCommunityModerationAccess({
      dbClient: db.client,
      communityId: input.communityId,
      userId: session.userId,
    })

    const existing = await getMembershipRequestById(db.client, input.communityId, input.membershipRequestId)
    if (!existing) {
      throw notFoundError("Membership request not found")
    }
    if (existing.status !== "pending") {
      throw conflictError("Membership request is not pending")
    }

    const now = nowIso()
    await resolveMembershipRequestAsRejected({
      client: db.client,
      membershipRequestId: input.membershipRequestId,
      reviewerUserId: session.userId,
      reviewReason: input.reviewReason,
      now,
    })

    const resolved = await getMembershipRequestById(db.client, input.communityId, input.membershipRequestId)
    if (!resolved) {
      throw internalError("Resolved membership request is missing after rejection")
    }
    return resolved
  } finally {
    db.close()
  }
}
