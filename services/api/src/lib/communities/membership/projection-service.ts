import type { CommunityRepository } from "../db-community-repository"
import { openCommunityDb } from "../community-db-factory"
import { setCommunityFollowActive } from "./follow-store"
import type { CommunityFollowResult } from "./types"

type CommunityDb = Awaited<ReturnType<typeof openCommunityDb>>

export async function syncCommunityFollowProjection(input: {
  communityRepository: CommunityRepository
  communityId: string
  userId: string
  followState: "active" | "inactive"
  changed: boolean
  now: string
}): Promise<void> {
  await input.communityRepository.upsertCommunityFollowProjection({
    communityId: input.communityId,
    userId: input.userId,
    followState: input.followState,
    sourceUpdatedAt: input.now,
    unfollowedAt: input.followState === "inactive" ? input.now : null,
    createdAt: input.now,
  })
  if (input.changed) {
    await input.communityRepository.incrementCommunityFollowerCount({
      communityId: input.communityId,
      delta: input.followState === "active" ? 1 : -1,
      updatedAt: input.now,
    })
  }
}

export async function followCommunityForHomeFeed(input: {
  db: CommunityDb
  communityRepository: CommunityRepository
  communityId: string
  userId: string
  now: string
}): Promise<CommunityFollowResult> {
  const result = await setCommunityFollowActive({
    client: input.db.client,
    communityId: input.communityId,
    userId: input.userId,
    now: input.now,
  })
  await syncCommunityFollowProjection({
    communityRepository: input.communityRepository,
    communityId: input.communityId,
    userId: input.userId,
    followState: "active",
    changed: result.changed,
    now: input.now,
  })

  return {
    community_id: input.communityId,
    following: true,
    follower_count: result.followerCount,
  }
}

export async function projectMembershipAndFollow(input: {
  db: CommunityDb
  communityRepository: CommunityRepository
  communityId: string
  userId: string
  now: string
}): Promise<void> {
  await input.communityRepository.upsertCommunityMembershipProjection({
    communityId: input.communityId,
    userId: input.userId,
    membershipState: "member",
    sourceUpdatedAt: input.now,
    createdAt: input.now,
  })
  await followCommunityForHomeFeed({
    db: input.db,
    communityRepository: input.communityRepository,
    communityId: input.communityId,
    userId: input.userId,
    now: input.now,
  })
}
