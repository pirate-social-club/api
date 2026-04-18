import { Hono } from "hono"
import { authError, badRequestError, notFoundError } from "../lib/errors"
import { getProfileRepository } from "../lib/auth/repositories"
import { authenticate, type AuthenticatedEnv } from "../lib/auth-middleware"

const profiles = new Hono<AuthenticatedEnv>()

profiles.use("/me", authenticate)
profiles.use("/me/*", authenticate)

function requireStringOrNull(value: unknown, field: string): string | null {
  if (value === null) {
    return null
  }
  if (typeof value !== "string") {
    throw badRequestError(`Invalid ${field}`)
  }
  return value.trim()
}

profiles.get("/me", async (c) => {
  const actor = c.get("actor")
  const repository = getProfileRepository(c.env)
  const profile = await repository.getProfileByUserId(actor.userId)
  if (!profile) {
    throw authError("Authentication failed")
  }
  return c.json(profile, 200)
})

profiles.patch("/me", async (c) => {
  const actor = c.get("actor")
  const body = await c.req
    .json<{
      display_name?: unknown
      avatar_ref?: unknown
      cover_ref?: unknown
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
    cover_ref?: string | null
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
  if ("cover_ref" in body) {
    input.cover_ref = requireStringOrNull(body.cover_ref, "cover_ref")
  }
  if ("bio" in body) {
    input.bio = requireStringOrNull(body.bio, "bio")
  }
  if ("preferred_locale" in body) {
    input.preferred_locale = requireStringOrNull(body.preferred_locale, "preferred_locale")
  }

  const repository = getProfileRepository(c.env)
  const profile = await repository.updateProfile(actor.userId, input)
  if (!profile) {
    throw authError("Authentication failed")
  }
  return c.json(profile, 200)
})

profiles.post("/me/global-handle/rename", async (c) => {
  const actor = c.get("actor")
  const body = await c.req.json<{ desired_label?: unknown }>().catch(() => null)
  if (!body || typeof body.desired_label !== "string") {
    throw badRequestError("Invalid handle rename payload")
  }

  const repository = getProfileRepository(c.env)
  const globalHandle = await repository.renameGlobalHandle(actor.userId, body.desired_label)
  if (!globalHandle) {
    throw authError("Authentication failed")
  }
  return c.json(globalHandle, 200)
})

profiles.post("/me/global-handle/upgrade-quote", async (c) => {
  const actor = c.get("actor")
  const body = await c.req.json<{ desired_label?: unknown }>().catch(() => null)
  if (!body || typeof body.desired_label !== "string") {
    throw badRequestError("Invalid handle upgrade quote payload")
  }

  const repository = getProfileRepository(c.env)
  const quote = await repository.quoteGlobalHandleUpgrade(actor.userId, body.desired_label)
  if (!quote) {
    throw authError("Authentication failed")
  }
  return c.json(quote, 200)
})

profiles.post("/me/linked-handles/sync", async (c) => {
  const actor = c.get("actor")
  const repository = getProfileRepository(c.env)
  const profile = await repository.syncLinkedHandles(actor.userId)
  if (!profile) {
    throw authError("Authentication failed")
  }
  return c.json(profile, 200)
})

profiles.post("/me/primary-public-handle", async (c) => {
  const actor = c.get("actor")
  const body = await c.req.json<{ linked_handle_id?: unknown }>().catch(() => null)
  if (!body || typeof body !== "object") {
    throw badRequestError("Invalid primary public handle payload")
  }

  const linkedHandleId = "linked_handle_id" in body
    ? requireStringOrNull(body.linked_handle_id, "linked_handle_id")
    : null

  const repository = getProfileRepository(c.env)
  const profile = await repository.setPrimaryPublicHandle(actor.userId, linkedHandleId)
  if (!profile) {
    throw authError("Authentication failed")
  }
  return c.json(profile, 200)
})

profiles.get("/:userId", async (c) => {
  const repository = getProfileRepository(c.env)
  const profile = await repository.getProfileByUserId(c.req.param("userId"))
  if (!profile) {
    throw notFoundError("Profile not found")
  }
  return c.json(profile, 200)
})

export default profiles
