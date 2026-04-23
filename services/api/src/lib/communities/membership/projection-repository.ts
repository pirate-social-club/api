import type { Client } from "../../sql-client"
import {
  incrementCommunityFollowerCountRow,
  upsertCommunityFollowProjectionRow,
  upsertCommunityMembershipProjectionRow,
} from "../../auth/auth-db-queries"
import type {
  CommunityFollowProjectionRow,
  CommunityMembershipProjectionRow,
} from "../../auth/auth-db-rows"

export async function upsertCommunityMembershipProjection(
  client: Client,
  input: {
    communityId: string
    userId: string
    membershipState: CommunityMembershipProjectionRow["membership_state"]
    sourceUpdatedAt: string
    createdAt: string
  },
): Promise<void> {
  await upsertCommunityMembershipProjectionRow({
    executor: client,
    communityId: input.communityId,
    userId: input.userId,
    membershipState: input.membershipState,
    sourceUpdatedAt: input.sourceUpdatedAt,
    createdAt: input.createdAt,
  })
}

export async function upsertCommunityFollowProjection(
  client: Client,
  input: {
    communityId: string
    userId: string
    followState: CommunityFollowProjectionRow["follow_state"]
    sourceUpdatedAt: string
    unfollowedAt: string | null
    createdAt: string
  },
): Promise<void> {
  await upsertCommunityFollowProjectionRow({
    executor: client,
    communityId: input.communityId,
    userId: input.userId,
    followState: input.followState,
    sourceUpdatedAt: input.sourceUpdatedAt,
    unfollowedAt: input.unfollowedAt,
    createdAt: input.createdAt,
  })
}

export async function incrementCommunityFollowerCount(
  client: Client,
  input: {
    communityId: string
    delta: 1 | -1
    updatedAt: string
  },
): Promise<void> {
  await incrementCommunityFollowerCountRow({
    executor: client,
    communityId: input.communityId,
    delta: input.delta,
    updatedAt: input.updatedAt,
  })
}
