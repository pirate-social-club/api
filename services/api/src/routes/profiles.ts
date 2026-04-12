import { Hono } from "hono"
import { authError, badRequestError, notFoundError } from "../lib/errors"
import { requireBearerToken } from "../lib/helpers"
import { verifyPirateAccessToken } from "../lib/auth/pirate-session-token"
import { getProfileRepository } from "../lib/auth/repositories"
import { handleRoute } from "./route-helpers"
import type { Env } from "../types"

const profiles = new Hono<{ Bindings: Env }>()

function requireStringOrNull(value: unknown, field: string): string | null {
  if (value === null) {
    return null
  }
  if (typeof value !== "string") {
    throw badRequestError(`Invalid ${field}`)
  }
  return value.trim()
}

profiles.get("/me", handleRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const session = await verifyPirateAccessToken({ env: c.env, token })
  const repository = getProfileRepository(c.env)
  const profile = await repository.getProfileByUserId(session.userId)
  if (!profile) {
    throw authError("Authentication failed")
  }
  return c.json(profile, 200)
}))

profiles.patch("/me", handleRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const session = await verifyPirateAccessToken({ env: c.env, token })
  const body = await c.req
    .json<{
      display_name?: unknown
      avatar_ref?: unknown
      bio?: unknown
      preferred_locale?: unknown
    }>()
    .catch(() => null)
  if (!body || typeof body !== "object") {
    throw badRequestError("Invalid profile update payload")
  }

  const input: {
    display_name?: string | null
    avatar_ref?: string | null
    bio?: string | null
    preferred_locale?: string | null
  } = {}

  if ("display_name" in body) {
    const value = requireStringOrNull(body.display_name, "display_name")
    if (value === null || value === "") {
      throw badRequestError("Invalid display_name")
    }
    input.display_name = value
  }
  if ("avatar_ref" in body) {
    input.avatar_ref = requireStringOrNull(body.avatar_ref, "avatar_ref")
  }
  if ("bio" in body) {
    input.bio = requireStringOrNull(body.bio, "bio")
  }
  if ("preferred_locale" in body) {
    input.preferred_locale = requireStringOrNull(body.preferred_locale, "preferred_locale")
  }

  const repository = getProfileRepository(c.env)
  const profile = await repository.updateProfile(session.userId, input)
  if (!profile) {
    throw authError("Authentication failed")
  }
  return c.json(profile, 200)
}))

profiles.post("/me/global-handle/rename", handleRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const session = await verifyPirateAccessToken({ env: c.env, token })
  const body = await c.req.json<{ desired_label?: unknown }>().catch(() => null)
  if (!body || typeof body.desired_label !== "string") {
    throw badRequestError("Invalid handle rename payload")
  }

  const repository = getProfileRepository(c.env)
  const globalHandle = await repository.renameGlobalHandle(session.userId, body.desired_label)
  if (!globalHandle) {
    throw authError("Authentication failed")
  }
  return c.json(globalHandle, 200)
}))

profiles.post("/me/global-handle/upgrade-quote", handleRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const session = await verifyPirateAccessToken({ env: c.env, token })
  const body = await c.req.json<{ desired_label?: unknown }>().catch(() => null)
  if (!body || typeof body.desired_label !== "string") {
    throw badRequestError("Invalid handle upgrade quote payload")
  }

  const repository = getProfileRepository(c.env)
  const quote = await repository.quoteGlobalHandleUpgrade(session.userId, body.desired_label)
  if (!quote) {
    throw authError("Authentication failed")
  }
  return c.json(quote, 200)
}))

profiles.get("/:userId", handleRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  await verifyPirateAccessToken({ env: c.env, token })
  const repository = getProfileRepository(c.env)
  const profile = await repository.getProfileByUserId(c.req.param("userId"))
  if (!profile) {
    throw notFoundError("Profile not found")
  }
  return c.json(profile, 200)
}))

export default profiles
