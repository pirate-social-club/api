import { Hono } from "hono"
import { notFoundError } from "../lib/errors"
import { getProfileRepository } from "../lib/auth/repositories"
import type { Env } from "../env"
import { serializePublicProfileResolution } from "../serializers/profile"

const publicProfiles = new Hono<{ Bindings: Env }>()

publicProfiles.get("/by-wallet/:walletAddress", async (c) => {
  const repository = getProfileRepository(c.env)
  const resolved = await repository.resolvePublicProfileByWalletAddress(c.req.param("walletAddress"))
  if (!resolved) {
    throw notFoundError("Profile not found")
  }
  return c.json(serializePublicProfileResolution(resolved), 200)
})

publicProfiles.get("/:handleLabel", async (c) => {
  const repository = getProfileRepository(c.env)
  const resolved = await repository.resolvePublicProfileByHandle(c.req.param("handleLabel"))
  if (!resolved) {
    throw notFoundError("Profile not found")
  }
  return c.json(serializePublicProfileResolution(resolved), 200)
})

export default publicProfiles
