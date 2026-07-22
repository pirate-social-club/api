import type {
  CommunityDatabaseBindingRepository,
  CommunityMembershipProjectionRepository,
  CommunityPostProjectionRepository,
  CommunityReadRepository,
} from "../communities/db-community-repository"
import type { HomeFeedCommunitySummary } from "../../types"

export type HomeFeedProjectionRow = {
  community_id: string
  source_post_id: string
  source_created_at: string
  visibility: "public" | "members_only"
  upvote_count: number
  downvote_count: number
  comment_count: number
  like_count: number
  post_type?: "text" | "image" | "video" | "link" | "song" | "crosspost"
}

export type InternalHomeFeedCommunitySummary = HomeFeedCommunitySummary & {
  community_id: string
  updated_at: string
}

export type HomeFeedTimeRange = "hour" | "day" | "week" | "month" | "year" | "all"

export type HomeFeedCommunityRepository =
  & CommunityReadRepository
  & CommunityDatabaseBindingRepository
  & Pick<
    CommunityMembershipProjectionRepository,
    "listCommunityMembershipProjectionsByUserId" | "listCommunityFollowProjectionsByUserId"
  >
  & Pick<CommunityPostProjectionRepository, "getCommunityPostProjectionByPostId">
