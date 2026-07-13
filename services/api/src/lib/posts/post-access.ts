import type { Client } from "../sql-client"
import {
  ANY_COMMUNITY_ROLE,
  canAccessCommunity,
  getCommunityMembershipState,
  hasCommunityRole,
  type CommunityMembershipRow,
} from "../communities/membership/membership-state-store"
import { notFoundError } from "../errors"
import type { Post } from "../../types"

export function isPubliclyReadablePost(post: Pick<Post, "status" | "visibility">): boolean {
  return post.status === "published" && post.visibility === "public"
}

export function isAssetBackedPostMissingAsset(post: Pick<Post, "asset_id" | "asset_story" | "post_type">): boolean {
  return (post.post_type === "song" || post.post_type === "video")
    && Boolean(post.asset_id?.trim())
    && post.asset_story == null
}

export function shouldHidePostForMissingAsset(post: Pick<Post, "asset_id" | "asset_story" | "post_type" | "status">): boolean {
  return post.status === "published" && isAssetBackedPostMissingAsset(post)
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
