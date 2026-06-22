import { notFoundError } from "../errors"
import type { CommunityRow } from "../auth/auth-db-rows"

type CommunityStatusLike = {
  provisioning_state: string
  status: string
}

export function isCommunityLive<T extends CommunityStatusLike>(community: T | null | undefined): community is T {
  return community?.provisioning_state === "active" && community.status === "active"
}

/**
 * Boundary guard for write entry points: loads the control-plane community row and
 * throws unless it is live (active provisioning + active status). Returns the row so
 * callers can replace their existing existence fetch with this call. Use this at public
 * entry points (e.g. live-room create/publish, listing create) rather than inside shared
 * transaction helpers — the control-plane read does not belong inside an open shard write tx.
 */
export async function requireLiveCommunity(
  repo: { getCommunityById(communityId: string): Promise<CommunityRow | null> },
  communityId: string,
): Promise<CommunityRow> {
  const community = await repo.getCommunityById(communityId)
  if (!isCommunityLive(community)) {
    throw notFoundError("Community not found")
  }
  return community
}
