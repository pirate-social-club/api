import { authError } from "../errors"
import { requireBearerToken } from "../helpers"
import { verifyPirateAccessToken } from "../auth/pirate-session-token"
import type { CommunityRepository } from "../communities/control-plane-community-repository"
import { openCommunityDb } from "../communities/community-db-factory"
import {
  canAccessCommunity,
  getCommunityMembershipState,
} from "../communities/community-membership-store"
import { getLocalizedFeedItemByPostId } from "../posts/community-post-store"
import type { Env, LocalizedPostResponse } from "../../types"

type FeedResponse = {
  items: LocalizedPostResponse[]
  next_cursor: string | null
}

function parseFeedLimit(limit: string | null | undefined): number {
  const normalized = String(limit ?? "").trim()
  if (!normalized) {
    return 25
  }
  const parsed = Number(normalized)
  if (!Number.isFinite(parsed)) {
    return 25
  }
  return Math.min(100, Math.max(1, Math.trunc(parsed)))
}

function parseFeedCursor(cursor: string | null | undefined): { createdAt: string; postId: string } | null {
  if (!cursor) {
    return null
  }
  const [createdAt, postId] = cursor.split("|")
  if (!createdAt || !postId) {
    return null
  }
  return { createdAt, postId }
}

function formatFeedCursor(cursor: { createdAt: string; postId: string } | null): string | null {
  return cursor ? `${cursor.createdAt}|${cursor.postId}` : null
}

async function resolveOptionalViewerUserId(env: Env, authorizationHeader: string | undefined): Promise<string | null> {
  if (!authorizationHeader) {
    return null
  }
  if (!authorizationHeader.startsWith("Bearer ")) {
    throw authError("Authentication failed")
  }
  const session = await verifyPirateAccessToken({
    env,
    token: requireBearerToken(authorizationHeader),
  })
  return session.userId
}

async function listJoinedCommunityIds(
  repo: CommunityRepository,
  userId: string,
): Promise<string[]> {
  const communities = await repo.listActiveCommunities()
  const joinedCommunityIds: string[] = []

  for (const community of communities) {
    const db = await openCommunityDb(repo, community.community_id)
    try {
      const membership = await getCommunityMembershipState(db.client, community.community_id, userId)
      if (canAccessCommunity(membership)) {
        joinedCommunityIds.push(community.community_id)
      }
    } finally {
      db.close()
    }
  }

  return joinedCommunityIds
}

async function hydrateFeedFromProjections(input: {
  repo: CommunityRepository
  projections: Awaited<ReturnType<CommunityRepository["listRecentCommunityPostProjections"]>>
  locale?: string | null
  viewerUserId?: string | null
  limit: number
}): Promise<{ items: LocalizedPostResponse[]; nextCursor: { createdAt: string; postId: string } | null }> {
  const dbCache = new Map<string, Awaited<ReturnType<typeof openCommunityDb>>>()
  try {
    const pageProjections = input.projections.slice(0, input.limit)
    const items: LocalizedPostResponse[] = []

    for (const projection of pageProjections) {
      let db = dbCache.get(projection.community_id)
      if (!db) {
        db = await openCommunityDb(input.repo, projection.community_id)
        dbCache.set(projection.community_id, db)
      }

      const item = await getLocalizedFeedItemByPostId({
        client: db.client,
        postId: projection.source_post_id,
        viewerUserId: input.viewerUserId ?? null,
        locale: input.locale ?? undefined,
      })
      if (item) {
        items.push(item)
      }
    }

    const overflowRow = input.projections.length > input.limit ? input.projections[input.limit] : null
    const nextCursor = overflowRow
      ? {
          createdAt: overflowRow.source_created_at,
          postId: overflowRow.source_post_id,
        }
      : null

    return { items, nextCursor }
  } finally {
    for (const db of dbCache.values()) {
      db.close()
    }
  }
}

export async function getHomeFeed(input: {
  env: Env
  authorizationHeader?: string
  locale?: string | null
  limit?: string | null
  cursor?: string | null
  communityRepository: CommunityRepository
}): Promise<FeedResponse> {
  const viewerUserId = await resolveOptionalViewerUserId(input.env, input.authorizationHeader)
  const limit = parseFeedLimit(input.limit)
  const projections = await input.communityRepository.listRecentCommunityPostProjections({
    limit: limit + 1,
    cursor: parseFeedCursor(input.cursor),
  })

  const feed = await hydrateFeedFromProjections({
    repo: input.communityRepository,
    projections,
    locale: input.locale,
    viewerUserId,
    limit,
  })

  return {
    items: feed.items,
    next_cursor: formatFeedCursor(feed.nextCursor),
  }
}

export async function getYourCommunitiesFeed(input: {
  env: Env
  bearerToken: string
  locale?: string | null
  limit?: string | null
  cursor?: string | null
  communityRepository: CommunityRepository
}): Promise<FeedResponse> {
  const session = await verifyPirateAccessToken({ env: input.env, token: input.bearerToken })
  const joinedCommunityIds = await listJoinedCommunityIds(input.communityRepository, session.userId)
  if (joinedCommunityIds.length === 0) {
    return { items: [], next_cursor: null }
  }

  const limit = parseFeedLimit(input.limit)
  const projections = await input.communityRepository.listRecentCommunityPostProjections({
    limit: limit + 1,
    cursor: parseFeedCursor(input.cursor),
    communityIds: joinedCommunityIds,
  })

  const feed = await hydrateFeedFromProjections({
    repo: input.communityRepository,
    projections,
    locale: input.locale,
    viewerUserId: session.userId,
    limit,
  })

  return {
    items: feed.items,
    next_cursor: formatFeedCursor(feed.nextCursor),
  }
}
