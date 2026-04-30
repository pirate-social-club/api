type CommunityStatusLike = {
  provisioning_state: string
  status: string
}

export function isCommunityLive<T extends CommunityStatusLike>(community: T | null | undefined): community is T {
  return community?.provisioning_state === "active" && community.status === "active"
}
