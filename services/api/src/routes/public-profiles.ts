import { Hono } from "hono"
import { notFoundError } from "../lib/errors"
import { getProfileRepository } from "../lib/auth/repositories"
import {
  isPostgresControlPlaneUrl,
  resolvePublicProfileByHandleFromPostgres,
} from "../lib/auth/control-plane-public-profile-postgres"
import type { Env } from "../types"

const publicProfiles = new Hono<{ Bindings: Env }>()

publicProfiles.get("/:handleLabel", async (c) => {
  const handleLabel = c.req.param("handleLabel")
  const controlPlaneUrl = String(c.env.CONTROL_PLANE_DATABASE_URL || c.env.TURSO_CONTROL_PLANE_DATABASE_URL || "").trim()
  const resolved = isPostgresControlPlaneUrl(controlPlaneUrl)
    ? await resolvePublicProfileByHandleFromPostgres({ env: c.env, handleLabel })
    : await getProfileRepository(c.env).resolvePublicProfileByHandle(handleLabel)
  if (!resolved) {
    throw notFoundError("Profile not found")
  }
  return c.json(resolved, 200)
})

export default publicProfiles
