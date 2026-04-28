export type MembershipResult = {
  community_id: string
  status: "joined" | "requested" | "left"
}

export type CommunityFollowResult = {
  community_id: string
  following: boolean
  follower_count: number | null
}
