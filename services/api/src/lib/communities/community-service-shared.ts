import {
  listActiveCommunityMemberUserIds,
  canModerateMembershipRequests,
  getCommunityRoleAccessState,
} from "./community-membership-store"
import { openCommunityDb } from "./community-db-factory"
import type { UserRepository } from "../auth/repositories"
import type { CommunityRepository } from "./control-plane-community-repository"
import { eligibilityFailed } from "../errors"
import { nowIso } from "../helpers"
import {
  updateLocalCommunityMembershipStatsWithExecutor,
} from "./community-local-db"
import type { Env, User } from "../../types"

export function satisfiesBaselineJoinGate(user: User): boolean {
  if (user.verification_capabilities.unique_human.state === "verified") {
    return true
  }

  return user.verification_capabilities.wallet_score.state === "verified"
    && user.verification_capabilities.wallet_score.provider === "passport"
    && user.verification_capabilities.wallet_score.passing_score === true
}

export async function requireCommunityModerationAccess(input: {
  dbClient: Awaited<ReturnType<typeof openCommunityDb>>["client"]
  communityId: string
  userId: string
}): Promise<void> {
  const access = await getCommunityRoleAccessState(input.dbClient, input.communityId, input.userId)
  if (!canModerateMembershipRequests(access)) {
    throw eligibilityFailed("Community moderation access is required")
  }
}

export async function recomputeAndPersistCommunityMembershipStats(input: {
  repository: CommunityRepository
  userRepository: UserRepository
  communityId: string
  localDb?: Awaited<ReturnType<typeof openCommunityDb>> | null
  community?: Awaited<ReturnType<CommunityRepository["getCommunityById"]>>
}): Promise<void> {
  const community = input.community ?? await input.repository.getCommunityById(input.communityId)
  if (!community) {
    return
  }
  const db = input.localDb ?? await openCommunityDb(input.repository, input.communityId)
  try {
    const memberUserIds = await listActiveCommunityMemberUserIds(db.client, input.communityId)
    const countedUserIds = community.creator_user_id && !memberUserIds.includes(community.creator_user_id)
      ? [...memberUserIds, community.creator_user_id]
      : memberUserIds
    const users = await input.userRepository.listUsersByIds(countedUserIds)
    const usersById = new Map(users.map((user) => [user.user_id, user]))
    let qualifiedMemberCount = 0
    for (const userId of countedUserIds) {
      if (usersById.get(userId)?.verification_capabilities.unique_human.state === "verified") {
        qualifiedMemberCount += 1
      }
    }
    await updateLocalCommunityMembershipStatsWithExecutor(db.client, {
      communityId: input.communityId,
      memberCount: countedUserIds.length,
      qualifiedMemberCount,
      updatedAt: nowIso(),
    })
    await input.repository.updateCommunityProjectedMembershipCounts({
      communityId: input.communityId,
      memberCount: countedUserIds.length,
      qualifiedMemberCount,
    })
  } finally {
    if (!input.localDb) {
      db.close()
    }
  }
}
