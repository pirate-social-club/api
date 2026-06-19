import {
  canAccessCommunity,
  getCommunityMembershipState,
} from "./membership-state-store"
import { isCommunityLive } from "../community-status"
import { setCommunityFollowInactive } from "./follow-store"
import { openCommunityWriteClient } from "../community-read-access"
import { conflictError, notFoundError } from "../../errors"
import { nowIso } from "../../helpers"
import type { Env } from "../../../env"
import { activateCommunityFollow, syncCommunityFollowProjection } from "./projection-service"
import type { CommunityFollowResult, CommunityMembershipRepository } from "./types"

export async function followCommunity(input: {
  env: Env
  userId: string
  communityId: string
  communityRepository: CommunityMembershipRepository
}): Promise<CommunityFollowResult> {
  const community = await input.communityRepository.getCommunityById(input.communityId)
  if (!isCommunityLive(community)) {
    throw notFoundError("Community not found")
  }

  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.communityId)
  try {
    return await activateCommunityFollow({
      db,
      communityRepository: input.communityRepository,
      communityId: input.communityId,
      userId: input.userId,
      now: nowIso(),
    })
  } finally {
    db.close()
  }
}

export async function unfollowCommunity(input: {
  env: Env
  userId: string
  communityId: string
  communityRepository: CommunityMembershipRepository
}): Promise<CommunityFollowResult> {
  const community = await input.communityRepository.getCommunityById(input.communityId)
  if (!isCommunityLive(community)) {
    throw notFoundError("Community not found")
  }

  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.communityId)
  try {
    const membership = await getCommunityMembershipState(db.client, input.communityId, input.userId)
    if (canAccessCommunity(membership)) {
      throw conflictError("Citizens cannot unfollow. Leave the community first.")
    }

    const now = nowIso()
    const result = await setCommunityFollowInactive({
      client: db.client,
      communityId: input.communityId,
      userId: input.userId,
      now,
    })
    await syncCommunityFollowProjection({
      communityRepository: input.communityRepository,
      communityId: input.communityId,
      userId: input.userId,
      followState: "inactive",
      changed: result.changed,
      now,
    })

    return {
      community_id: input.communityId,
      following: false,
      follower_count: result.followerCount,
    }
  } finally {
    db.close()
  }
}
