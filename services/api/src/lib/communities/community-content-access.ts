import type { DbExecutor } from "../db-helpers"
import { eligibilityFailed, notFoundError } from "../errors"
import type { CommunityReadRepository } from "./db-community-repository"
import { isCommunityLive } from "./community-status"
import {
  canAccessCommunity,
  getCommunityMembershipState,
} from "./membership/membership-state-store"

type CommunityMembershipRow = Awaited<ReturnType<typeof getCommunityMembershipState>>

export async function requireMemberAccess(
  client: DbExecutor,
  communityId: string,
  userId: string,
): Promise<CommunityMembershipRow> {
  const membership = await getCommunityMembershipState(client, communityId, userId)
  if (!canAccessCommunity(membership)) {
    throw notFoundError("Community not found")
  }
  return membership
}

export async function requireActiveCommunity(
  communityRepository: Pick<CommunityReadRepository, "getCommunityById">,
  communityId: string,
): Promise<void> {
  const community = await communityRepository.getCommunityById(communityId)
  if (!isCommunityLive(community)) {
    throw eligibilityFailed("Community is not available for posting")
  }
}
