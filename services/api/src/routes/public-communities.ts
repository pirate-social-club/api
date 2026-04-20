import { Hono } from "hono"
import { getCommunityRepository } from "../lib/communities/db-community-repository"
import { getPublicCommunityPreview } from "../lib/communities/community-service"
import { listPublicCommunityPosts } from "../lib/posts/post-service"
import { notFoundError } from "../lib/errors"
import type { Env } from "../types"

const publicCommunities = new Hono<{ Bindings: Env }>()

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
