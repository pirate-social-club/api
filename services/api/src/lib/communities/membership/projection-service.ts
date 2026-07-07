import {
  countActiveCommunityFollows,
  setCommunityFollowActive,
} from "./follow-store"
import {
  listCommunityFollowProjectionSources,
  listCommunityMembershipProjectionSources,
} from "./projection-source-store"
import { openCommunityReadClient } from "../community-read-access"
import { nowIso } from "../../helpers"
import { publicCommunityId } from "../../public-ids"
import type { Env } from "../../../env"
import type {
  CommunityFollowResult,
  CommunityMembershipProjectionReconciliationSummary,
  CommunityMembershipRepository,
} from "./types"

type CommunityDb = Awaited<ReturnType<typeof openCommunityReadClient>>

export async function syncCommunityFollowProjection(input: {
  communityRepository: CommunityMembershipRepository
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

export async function activateCommunityFollow(input: {
  db: CommunityDb
  communityRepository: CommunityMembershipRepository
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
    community: publicCommunityId(input.communityId),
    following: true,
    follower_count: result.followerCount,
  }
}

export async function projectMembershipAndFollow(input: {
  db: CommunityDb
  communityRepository: CommunityMembershipRepository
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
  await activateCommunityFollow({
    db: input.db,
    communityRepository: input.communityRepository,
    communityId: input.communityId,
    userId: input.userId,
    now: input.now,
  })
}

export async function reconcileCommunityMembershipAndFollowProjections(input: {
  env: Env
  communityRepository: CommunityMembershipRepository
  maxCommunities?: number
  maxRowsPerCommunity?: number
}): Promise<CommunityMembershipProjectionReconciliationSummary> {
  const maxCommunities = Math.max(0, input.maxCommunities ?? 100)
  const maxRowsPerCommunity = Math.max(1, input.maxRowsPerCommunity ?? 500)
  const summary: CommunityMembershipProjectionReconciliationSummary = {
    checked_communities: 0,
    synced_membership_projections: 0,
    synced_follow_projections: 0,
    corrected_follower_counts: 0,
    failed_communities: 0,
  }

  const communities = (await input.communityRepository.listActiveCommunities({ requireReadyRouting: true })).slice(0, maxCommunities)
  for (const community of communities) {
    let db: CommunityDb | null = null
    try {
      db = await openCommunityReadClient(input.env, input.communityRepository, community.community_id)
      summary.checked_communities += 1

      const membershipRows = await listCommunityMembershipProjectionSources({
        client: db.client,
        communityId: community.community_id,
        limit: maxRowsPerCommunity,
      })
      for (const row of membershipRows) {
        await input.communityRepository.upsertCommunityMembershipProjection({
          communityId: row.community_id,
          userId: row.user_id,
          membershipState: row.membership_state,
          sourceUpdatedAt: row.source_updated_at,
          createdAt: row.source_updated_at,
        })
        summary.synced_membership_projections += 1
      }

      const followRows = await listCommunityFollowProjectionSources({
        client: db.client,
        communityId: community.community_id,
        limit: maxRowsPerCommunity,
      })
      for (const row of followRows) {
        await input.communityRepository.upsertCommunityFollowProjection({
          communityId: row.community_id,
          userId: row.user_id,
          followState: row.follow_state,
          sourceUpdatedAt: row.source_updated_at,
          unfollowedAt: row.unfollowed_at,
          createdAt: row.source_updated_at,
        })
        summary.synced_follow_projections += 1
      }

      const activeFollowCount = await countActiveCommunityFollows(db.client, community.community_id)
      const currentCommunity = await input.communityRepository.getCommunityById(community.community_id)
      if ((currentCommunity?.follower_count ?? community.follower_count ?? 0) !== activeFollowCount) {
        await input.communityRepository.setCommunityFollowerCount({
          communityId: community.community_id,
          followerCount: activeFollowCount,
          updatedAt: nowIso(),
        })
        summary.corrected_follower_counts += 1
      }
    } catch {
      summary.failed_communities += 1
    } finally {
      db?.close()
    }
  }

  return summary
}
