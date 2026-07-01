import { Hono } from "hono"
import { notFoundError } from "../lib/errors"
import { getProfileRepository } from "../lib/auth/repositories"
import { getCommunityRepository } from "../lib/communities/db-community-repository"
import { getProfileActivity, parseProfileActivityLimit, parseProfileActivityTab } from "../lib/profile/profile-activity-read-service"
import { decodePublicUserId } from "../lib/public-ids"
import type { Env } from "../env"
import { resolveHostBookable } from "../lib/bookings/host-bookable"
import { serializePublicProfileResolution } from "../serializers/profile"
import { serializeProfileActivityResponse } from "../serializers/profile-activity"

const publicProfiles = new Hono<{ Bindings: Env }>()

publicProfiles.get("/by-wallet/:walletAddress", async (c) => {
  const repository = getProfileRepository(c.env)
  const resolved = await repository.resolvePublicProfileByWalletAddress(c.req.param("walletAddress"))
  if (!resolved) {
    throw notFoundError("Profile not found")
  }
  resolved.profile.is_bookable = await resolveHostBookable(c.env, resolved.profile.id)
  return c.json(serializePublicProfileResolution(resolved), 200)
})

publicProfiles.get("/:handleLabel/activity", async (c) => {
  const repository = getProfileRepository(c.env)
  const resolved = await repository.resolvePublicProfileByHandle(c.req.param("handleLabel"))
  if (!resolved) {
    throw notFoundError("Profile not found")
  }
  const result = await getProfileActivity({
    env: c.env,
    repository: getCommunityRepository(c.env),
    targetUserId: decodePublicUserId(resolved.profile.id),
    viewerUserId: null,
    tab: parseProfileActivityTab(c.req.query("tab")),
    cursor: c.req.query("cursor") ?? null,
    limit: parseProfileActivityLimit(c.req.query("limit")),
    locale: c.req.query("locale") ?? null,
  })
  return c.json(serializeProfileActivityResponse(result), 200)
})

publicProfiles.get("/:handleLabel", async (c) => {
  const repository = getProfileRepository(c.env)
  const resolved = await repository.resolvePublicProfileByHandle(c.req.param("handleLabel"))
  if (!resolved) {
    throw notFoundError("Profile not found")
  }
  resolved.profile.is_bookable = await resolveHostBookable(c.env, resolved.profile.id)
  return c.json(serializePublicProfileResolution(resolved), 200)
})

export default publicProfiles
