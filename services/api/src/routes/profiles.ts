import { Hono } from "hono"
import { authError, badRequestError, notFoundError } from "../lib/errors"
import { getProfileRepository } from "../lib/auth/repositories"
import { authenticateAdminOrUser, type AuthenticatedEnv } from "../lib/auth-middleware"
import { trackApiEvent } from "../lib/analytics/track"
import { makeId, nowIso } from "../lib/helpers"
import { getControlPlaneClient } from "../lib/runtime-deps"
import { decodePublicUserId } from "../lib/public-ids"

const profiles = new Hono<AuthenticatedEnv>()

profiles.use("/me", authenticateAdminOrUser)
profiles.use("/me/*", authenticateAdminOrUser)

function requireStringOrNull(value: unknown, field: string): string | null {
  if (value === null) {
    return null
  }
  if (typeof value !== "string") {
    throw badRequestError(`Invalid ${field}`)
  }
  return value.trim()
}

function requireSourceValue<T extends string>(value: unknown, field: string, allowed: readonly T[]): T | null {
  if (value === null) {
    return null
  }
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw badRequestError(`Invalid ${field}`)
  }
  return value as T
}

function requireXmtpInboxId(value: unknown): string | null {
  if (value === null) {
    return null
  }
  if (typeof value !== "string") {
    throw badRequestError("Invalid xmtp_inbox_id")
  }
  const trimmed = value.trim()
  if (
    trimmed.length < 8
    || trimmed.length > 256
    || /\s/u.test(trimmed)
    || /[\u0000-\u001f\u007f]/u.test(trimmed)
  ) {
    throw badRequestError("Invalid xmtp_inbox_id")
  }
  return trimmed
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

profiles.post("/me", async (c) => {
  const actor = c.get("actor")
  const body = await c.req
    .json<{
      display_name?: unknown
      avatar_ref?: unknown
      avatar_source?: unknown
      cover_ref?: unknown
      cover_source?: unknown
      bio?: unknown
      bio_source?: unknown
      preferred_locale?: unknown
      display_verified_nationality_badge?: unknown
    }>()
    .catch(() => null)
  if (!body || typeof body !== "object") {
    throw badRequestError("Invalid profile update payload")
  }

  const input: {
    display_name?: string | null
    avatar_ref?: string | null
    avatar_source?: "ens" | "upload" | "none" | null
    cover_ref?: string | null
    cover_source?: "ens" | "upload" | "none" | null
    bio?: string | null
    bio_source?: "ens" | "manual" | "none" | null
    preferred_locale?: string | null
    display_verified_nationality_badge?: boolean | null
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
  if ("avatar_source" in body) {
    input.avatar_source = requireSourceValue(body.avatar_source, "avatar_source", ["ens", "upload", "none"] as const)
  }
  if ("cover_ref" in body) {
    input.cover_ref = requireStringOrNull(body.cover_ref, "cover_ref")
  }
  if ("cover_source" in body) {
    input.cover_source = requireSourceValue(body.cover_source, "cover_source", ["ens", "upload", "none"] as const)
  }
  if ("bio" in body) {
    input.bio = requireStringOrNull(body.bio, "bio")
  }
  if ("bio_source" in body) {
    input.bio_source = requireSourceValue(body.bio_source, "bio_source", ["ens", "manual", "none"] as const)
  }
  if ("preferred_locale" in body) {
    input.preferred_locale = requireStringOrNull(body.preferred_locale, "preferred_locale")
  }
  if ("display_verified_nationality_badge" in body) {
    if (body.display_verified_nationality_badge !== null && typeof body.display_verified_nationality_badge !== "boolean") {
      throw badRequestError("Invalid display_verified_nationality_badge")
    }
    input.display_verified_nationality_badge = body.display_verified_nationality_badge
  }

  const repository = getProfileRepository(c.env)
  const profile = await repository.updateProfile(actor.userId, input)
  if (!profile) {
    throw authError("Authentication failed")
  }
  if (actor.authType === "admin") {
    await getControlPlaneClient(c.env).execute({
      sql: `
        INSERT INTO audit_log (
          audit_event_id, actor_type, actor_id, action, target_type, target_id, community_id, metadata_json, created_at
        ) VALUES (
          ?1, 'operator', ?2, 'community.admin_profile_updated', 'user', ?3, NULL, ?4, ?5
        )
      `,
      args: [
        makeId("aud"),
        actor.adminOverride.adminActorId,
        actor.userId,
        JSON.stringify({
          acting_user_id: actor.userId,
          updated_fields: Object.keys(input),
        }),
        nowIso(),
      ],
    })
  }
  return c.json(profile, 200)
})

profiles.post("/me/xmtp-inbox", async (c) => {
  const actor = c.get("actor")
  const body = await c.req.json<{ xmtp_inbox_id?: unknown }>().catch(() => null)
  if (!body || typeof body !== "object" || !("xmtp_inbox_id" in body)) {
    throw badRequestError("Invalid XMTP inbox payload")
  }

  const repository = getProfileRepository(c.env)
  const profile = await repository.updateXmtpInboxId(actor.userId, requireXmtpInboxId(body.xmtp_inbox_id))
  if (!profile) {
    throw authError("Authentication failed")
  }
  return c.json(profile, 200)
})

profiles.post("/me/rename_global_handle", async (c) => {
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
  await trackApiEvent(c.env, c.req, {
    eventName: "handle_claim_succeeded",
    userId: actor.userId,
    properties: {
      source: globalHandle.issuance_source,
      tier: globalHandle.tier,
      handle_length: globalHandle.label.replace(/\.pirate$/i, "").length,
    },
  })
  return c.json(globalHandle, 200)
})

profiles.post("/me/global-handle/reddit-claim", async (c) => {
  const actor = c.get("actor")
  const body = await c.req.json<{ desired_label?: unknown }>().catch(() => null)
  if (!body || typeof body.desired_label !== "string") {
    throw badRequestError("Invalid reddit handle claim payload")
  }

  const repository = getProfileRepository(c.env)
  const globalHandle = await repository.claimRedditGlobalHandle(actor.userId, body.desired_label)
  if (!globalHandle) {
    throw authError("Authentication failed")
  }
  await trackApiEvent(c.env, c.req, {
    eventName: "handle_claim_succeeded",
    userId: actor.userId,
    properties: {
      source: "verified_reddit_username",
      tier: globalHandle.tier,
      handle_length: globalHandle.label.replace(/\.pirate$/i, "").length,
      shorter_by: Math.max(0, 8 - globalHandle.label.replace(/\.pirate$/i, "").length),
    },
  })
  return c.json(globalHandle, 200)
})

profiles.post("/me/quote_handle_upgrade", async (c) => {
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

profiles.post("/me/sync_linked_handles", async (c) => {
  const actor = c.get("actor")
  const repository = getProfileRepository(c.env)
  const profile = await repository.syncLinkedHandles(actor.userId)
  if (!profile) {
    throw authError("Authentication failed")
  }
  return c.json(profile, 200)
})

profiles.post("/me/set_primary_public_handle", async (c) => {
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
  const profile = await repository.getProfileByUserId(decodePublicUserId(c.req.param("userId")))
  if (!profile) {
    throw notFoundError("Profile not found")
  }
  return c.json(profile, 200)
})

export default profiles
