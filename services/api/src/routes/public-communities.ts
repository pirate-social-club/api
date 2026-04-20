import { Hono } from "hono"
import { getCommunityRepository } from "../lib/communities/db-community-repository"
import { getPublicCommunityPreview } from "../lib/communities/community-service"
import { listPublicCommunityPosts } from "../lib/posts/post-service"
import { badRequestError, notFoundError } from "../lib/errors"
import type { Env } from "../types"

const publicCommunities = new Hono<{ Bindings: Env }>()

function rankPublicCommunitySearchMatch(
  candidate: { display_name: string; route_slug: string | null },
  query: string,
): number | null {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) {
    return 4
  }

  const routeSlug = candidate.route_slug?.trim().toLowerCase() ?? ""
  const displayName = candidate.display_name.trim().toLowerCase()
  if (routeSlug && routeSlug === normalizedQuery) {
    return 0
  }
  if (displayName === normalizedQuery) {
    return 1
  }
  if (routeSlug && routeSlug.startsWith(normalizedQuery)) {
    return 2
  }
  if (displayName.startsWith(normalizedQuery)) {
    return 3
  }
  if (routeSlug && routeSlug.includes(normalizedQuery)) {
    return 4
  }
  if (displayName.includes(normalizedQuery)) {
    return 5
  }
  return null
}

async function resolveCommunityId(
  env: Env,
  communityIdentifier: string,
): Promise<string> {
  const repository = getCommunityRepository(env)
  const byId = await repository.getCommunityById(communityIdentifier)
  if (byId) {
    return byId.community_id
  }

  const byRouteSlug = await repository.getCommunityByRouteSlug(communityIdentifier)
  if (byRouteSlug) {
    return byRouteSlug.community_id
  }

  throw notFoundError("Community not found")
}

publicCommunities.get("/:communityId", async (c) => {
  const communityRepository = getCommunityRepository(c.env)
  const communityId = await resolveCommunityId(c.env, c.req.param("communityId"))
  const result = await getPublicCommunityPreview({
    env: c.env,
    communityId,
    locale: c.req.query("locale") ?? null,
    communityRepository,
  })
  return c.json(result, 200)
})

publicCommunities.get("/", async (c) => {
  const repository = getCommunityRepository(c.env)
  const query = String(c.req.query("query") ?? "").trim()
  if (query.length < 2) {
    throw badRequestError("query must be at least 2 characters")
  }
  const rawLimit = Number.parseInt(String(c.req.query("limit") ?? "10"), 10)
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(rawLimit, 1), 25)
    : 10

  const matches = (await repository.listActiveCommunities())
    .map((community) => ({
      community_id: community.community_id,
      display_name: community.display_name,
      route_slug: community.route_slug,
      match_rank: rankPublicCommunitySearchMatch(community, query),
    }))
    .filter((community) => query.length === 0 || community.match_rank != null)
    .sort((left, right) => {
      const rankCompare = (left.match_rank ?? 99) - (right.match_rank ?? 99)
      if (rankCompare !== 0) {
        return rankCompare
      }
      return left.display_name.localeCompare(right.display_name, "en", { sensitivity: "base" })
    })
    .slice(0, limit)
    .map(({ match_rank: _matchRank, ...community }) => community)

  return c.json({
    query: query || null,
    communities: matches,
  }, 200)
})

publicCommunities.get("/:communityId/posts", async (c) => {
  const communityRepository = getCommunityRepository(c.env)
  const communityId = await resolveCommunityId(c.env, c.req.param("communityId"))
  const result = await listPublicCommunityPosts({
    env: c.env,
    communityId,
    communityRepository,
    cursor: c.req.query("cursor"),
    flairId: c.req.query("flair_id"),
    limit: c.req.query("limit"),
    locale: c.req.query("locale"),
    sort: c.req.query("sort"),
  })
  return c.json(result, 200)
})

export default publicCommunities
