import type { CommunityRepository } from "./db-community-repository"

export async function resolveCommunityIdentifier(
  communityRepository: CommunityRepository,
  communityIdentifier: string,
): Promise<string | null> {
  const byId = await communityRepository.getCommunityById(communityIdentifier)
  if (byId) {
    return byId.community_id
  }

  const byRouteSlug = await communityRepository.getCommunityByRouteSlug(communityIdentifier)
  if (byRouteSlug) {
    return byRouteSlug.community_id
  }

  return null
}
