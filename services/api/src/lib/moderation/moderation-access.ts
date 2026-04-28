import { canAccessCommunity, getCommunityMembershipState } from "../communities/membership/membership-state-store"
import type { UserRepository } from "../auth/repositories"
import { eligibilityFailed, notFoundError, verificationRequired } from "../errors"

export async function requireVerifiedHuman(userRepository: UserRepository, userId: string): Promise<void> {
  const user = await userRepository.getUserById(userId)
  if (!user) {
    throw notFoundError("User not found")
  }
  if (user.verification_capabilities.unique_human.state !== "verified") {
    throw verificationRequired("unique_human verification is required")
  }
}

export async function requireCommunityAccess(input: {
  client: Parameters<typeof getCommunityMembershipState>[0]
  communityId: string
  userId: string
}): Promise<{ role_status: "active" | "revoked" | null }> {
  const membership = await getCommunityMembershipState(input.client, input.communityId, input.userId)
  if (!canAccessCommunity(membership)) {
    throw notFoundError("Community not found")
  }
  return membership
}

export async function requireOwner(input: {
  client: Parameters<typeof getCommunityMembershipState>[0]
  communityId: string
  userId: string
}): Promise<void> {
  const membership = await requireCommunityAccess(input)
  if (membership.role_status !== "active") {
    throw eligibilityFailed("Moderator access is required")
  }
}
