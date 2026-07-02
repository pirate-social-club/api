import type { Client } from "../sql-client"
import type { UserRepository } from "../auth/repositories"
import {
  ANY_COMMUNITY_ROLE,
  canAccessCommunity,
  getCommunityMembershipState,
  hasCommunityRole,
  type CommunityMembershipRow,
} from "../communities/membership/membership-state-store"
import { notFoundError, verificationRequired } from "../errors"
import type { Post } from "../../types"

export function isPubliclyReadablePost(post: Pick<Post, "status" | "visibility">): boolean {
  return post.status === "published" && post.visibility === "public"
}

export function isAssetBackedPostMissingAsset(post: Pick<Post, "asset_id" | "asset_story" | "post_type">): boolean {
  return (post.post_type === "song" || post.post_type === "video")
    && Boolean(post.asset_id?.trim())
    && post.asset_story == null
}

export async function requireMemberAccess(
  client: Client,
  communityId: string,
  userId: string,
): Promise<CommunityMembershipRow> {
  const membership = await getCommunityMembershipState(client, communityId, userId)
  if (!canAccessCommunity(membership)) {
    throw notFoundError("Community not found")
  }
  return membership
}

export function canReadNonPublishedPost(
  post: Pick<Post, "author_user_id">,
  membership: CommunityMembershipRow,
  userId: string,
): boolean {
  return hasCommunityRole(membership, ANY_COMMUNITY_ROLE) || post.author_user_id === userId
}

export async function requireVerifiedHuman(userRepository: UserRepository, userId: string): Promise<void> {
  const user = await userRepository.getUserById(userId)
  if (!user) {
    throw notFoundError("User not found")
  }
  if (user.verification_capabilities.unique_human.state !== "verified") {
    throw verificationRequired("unique_human verification is required")
  }
}
