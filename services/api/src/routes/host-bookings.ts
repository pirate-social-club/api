import { Hono } from "hono"
import type { AuthenticatedEnv } from "../lib/auth-middleware"
import { authenticateAdminOrUser } from "../lib/auth-middleware"
import {
  createAvailabilityException,
  createAvailabilityRule,
  createPriceRule,
  deleteAvailabilityException,
  deleteAvailabilityRule,
  deletePriceRule,
  getBookingProfile,
  listAvailabilityExceptions,
  listAvailabilityRules,
  listPriceRules,
  setProfilePublished,
  updateAvailabilityException,
  updateAvailabilityRule,
  updatePriceRule,
  upsertBookingProfile,
} from "../lib/communities/bookings/host-authoring-service"
import {
  emptyBookingProfileResponse,
  serializeAvailabilityException,
  serializeAvailabilityRule,
  serializeBookingProfile,
  serializePriceRule,
} from "../serializers/host-bookings"

const hostBookings = new Hono<AuthenticatedEnv>()

hostBookings.use("/me", authenticateAdminOrUser)
hostBookings.use("/me/*", authenticateAdminOrUser)

function errStatus(reason: string): 400 | 404 | 409 {
  if (reason === "not_found") return 404
  if (reason === "limit_exceeded" || reason === "profile_not_found" || reason === "payout_wallet_required") return 409
  return 400
}

hostBookings.get("/me/profile", async (c) => {
  const actor = c.get("actor")
  const profile = await getBookingProfile(c.env, actor.userId)
  if (!profile) {
    return c.json(emptyBookingProfileResponse(actor.userId), 200)
  }
  return c.json(serializeBookingProfile(profile), 200)
})

hostBookings.post("/me/profile", async (c) => {
  const actor = c.get("actor")
  const body = await c.req.json<{
    host_timezone?: unknown
    base_price_cents?: unknown
    default_slot_duration_seconds?: unknown
    display_headline?: unknown
    bio?: unknown
    topics?: unknown
    intro_video_ref?: unknown
    platform_fee_bps?: unknown
    payout_wallet_address?: unknown
  }>().catch(() => null)
  if (!body || typeof body !== "object") {
    return c.json({ error: "invalid_payload" }, 400)
  }

  const input: Record<string, unknown> = {}
  if (body.host_timezone !== undefined) input.host_timezone = body.host_timezone
  if (body.base_price_cents !== undefined) input.base_price_cents = body.base_price_cents
  if (body.default_slot_duration_seconds !== undefined) input.default_slot_duration_seconds = body.default_slot_duration_seconds
  if (body.display_headline !== undefined) input.display_headline = body.display_headline
  if (body.bio !== undefined) input.bio = body.bio
  if (body.topics !== undefined) input.topics = body.topics
  if (body.intro_video_ref !== undefined) input.intro_video_ref = body.intro_video_ref
  if (body.platform_fee_bps !== undefined) input.platform_fee_bps = body.platform_fee_bps
  if (body.payout_wallet_address !== undefined) input.payout_wallet_address = body.payout_wallet_address

  const result = await upsertBookingProfile(c.env, actor.userId, input as Parameters<typeof upsertBookingProfile>[2])
  if (!result.ok) {
    return c.json({ error: result.reason, ...(result.fields ? { fields: result.fields } : {}) }, errStatus(result.reason))
  }
  return c.json(serializeBookingProfile(result.data.profile), result.data.created ? 201 : 200)
})

hostBookings.post("/me/profile/publish", async (c) => {
  const actor = c.get("actor")
  const result = await setProfilePublished(c.env, actor.userId, true)
  if (!result.ok) {
    return c.json({ error: result.reason }, errStatus(result.reason))
  }
  return c.json(serializeBookingProfile(result.data), 200)
})

hostBookings.post("/me/profile/unpublish", async (c) => {
  const actor = c.get("actor")
  const result = await setProfilePublished(c.env, actor.userId, false)
  if (!result.ok) {
    return c.json({ error: result.reason }, errStatus(result.reason))
  }
  return c.json(serializeBookingProfile(result.data), 200)
})

hostBookings.get("/me/availability-rules", async (c) => {
  const actor = c.get("actor")
  const rules = await listAvailabilityRules(c.env, actor.userId)
  return c.json({ object: "list", data: rules.map(serializeAvailabilityRule), has_more: false }, 200)
})

hostBookings.post("/me/availability-rules", async (c) => {
  const actor = c.get("actor")
  const body = await c.req.json<{
    by_weekday?: unknown
    start_local?: unknown
    end_local?: unknown
    slot_duration_seconds?: unknown
    effective_from_utc?: unknown
    effective_until_utc?: unknown
  }>().catch(() => null)
  if (!body || typeof body !== "object") {
    return c.json({ error: "invalid_payload" }, 400)
  }

  const input = {
    by_weekday: body.by_weekday,
    start_local: body.start_local,
    end_local: body.end_local,
    slot_duration_seconds: body.slot_duration_seconds,
    ...(body.effective_from_utc !== undefined ? { effective_from_utc: body.effective_from_utc } : {}),
    ...(body.effective_until_utc !== undefined ? { effective_until_utc: body.effective_until_utc } : {}),
  }

  const result = await createAvailabilityRule(c.env, actor.userId, input as never)
  if (!result.ok) {
    return c.json({ error: result.reason, ...(result.fields ? { fields: result.fields } : {}) }, errStatus(result.reason))
  }
  return c.json(serializeAvailabilityRule(result.data), 201)
})

hostBookings.post("/me/availability-rules/:ruleId", async (c) => {
  const actor = c.get("actor")
  const ruleId = c.req.param("ruleId")
  const body = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!body || typeof body !== "object") {
    return c.json({ error: "invalid_payload" }, 400)
  }

  const input: Record<string, unknown> = {}
  if (body.by_weekday !== undefined) input.by_weekday = body.by_weekday
  if (body.start_local !== undefined) input.start_local = body.start_local
  if (body.end_local !== undefined) input.end_local = body.end_local
  if (body.slot_duration_seconds !== undefined) input.slot_duration_seconds = body.slot_duration_seconds
  if (body.effective_from_utc !== undefined) input.effective_from_utc = body.effective_from_utc
  if (body.effective_until_utc !== undefined) input.effective_until_utc = body.effective_until_utc

  const result = await updateAvailabilityRule(c.env, actor.userId, ruleId, input as never)
  if (!result.ok) {
    return c.json({ error: result.reason, ...(result.fields ? { fields: result.fields } : {}) }, errStatus(result.reason))
  }
  return c.json(serializeAvailabilityRule(result.data), 200)
})

hostBookings.delete("/me/availability-rules/:ruleId", async (c) => {
  const actor = c.get("actor")
  const ruleId = c.req.param("ruleId")
  const deleted = await deleteAvailabilityRule(c.env, actor.userId, ruleId)
  if (!deleted) {
    return c.json({ error: "not_found" }, 404)
  }
  return c.json({ id: ruleId, object: "availability_rule", deleted: true }, 200)
})

hostBookings.get("/me/availability-exceptions", async (c) => {
  const actor = c.get("actor")
  const exceptions = await listAvailabilityExceptions(c.env, actor.userId)
  return c.json({ object: "list", data: exceptions.map(serializeAvailabilityException), has_more: false }, 200)
})

hostBookings.post("/me/availability-exceptions", async (c) => {
  const actor = c.get("actor")
  const body = await c.req.json<{
    kind?: unknown
    start_utc?: unknown
    end_utc?: unknown
  }>().catch(() => null)
  if (!body || typeof body !== "object") {
    return c.json({ error: "invalid_payload" }, 400)
  }

  const input = {
    kind: body.kind,
    start_utc: body.start_utc,
    end_utc: body.end_utc,
  }

  const result = await createAvailabilityException(c.env, actor.userId, input as never)
  if (!result.ok) {
    return c.json({ error: result.reason, ...(result.fields ? { fields: result.fields } : {}) }, errStatus(result.reason))
  }
  return c.json(serializeAvailabilityException(result.data), 201)
})

hostBookings.post("/me/availability-exceptions/:exceptionId", async (c) => {
  const actor = c.get("actor")
  const exceptionId = c.req.param("exceptionId")
  const body = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!body || typeof body !== "object") {
    return c.json({ error: "invalid_payload" }, 400)
  }

  const input: Record<string, unknown> = {}
  if (body.kind !== undefined) input.kind = body.kind
  if (body.start_utc !== undefined) input.start_utc = body.start_utc
  if (body.end_utc !== undefined) input.end_utc = body.end_utc

  const result = await updateAvailabilityException(c.env, actor.userId, exceptionId, input as never)
  if (!result.ok) {
    return c.json({ error: result.reason, ...(result.fields ? { fields: result.fields } : {}) }, errStatus(result.reason))
  }
  return c.json(serializeAvailabilityException(result.data), 200)
})

hostBookings.delete("/me/availability-exceptions/:exceptionId", async (c) => {
  const actor = c.get("actor")
  const exceptionId = c.req.param("exceptionId")
  const deleted = await deleteAvailabilityException(c.env, actor.userId, exceptionId)
  if (!deleted) {
    return c.json({ error: "not_found" }, 404)
  }
  return c.json({ id: exceptionId, object: "availability_exception", deleted: true }, 200)
})

hostBookings.get("/me/price-rules", async (c) => {
  const actor = c.get("actor")
  const rules = await listPriceRules(c.env, actor.userId)
  return c.json({ object: "list", data: rules.map(serializePriceRule), has_more: false }, 200)
})

hostBookings.post("/me/price-rules", async (c) => {
  const actor = c.get("actor")
  const body = await c.req.json<{
    match_weekday?: unknown
    match_local_start?: unknown
    match_local_end?: unknown
    match_duration_seconds?: unknown
    price_cents?: unknown
    priority?: unknown
  }>().catch(() => null)
  if (!body || typeof body !== "object") {
    return c.json({ error: "invalid_payload" }, 400)
  }

  if (body.priority !== undefined && (typeof body.priority !== "number" || !Number.isInteger(body.priority))) {
    return c.json({
      error: "validation_failed",
      fields: [{ field: "priority", reason: "must be an integer" }],
    }, 400)
  }
  const priority = body.priority ?? 0

  const input = {
    ...(body.match_weekday !== undefined ? { match_weekday: body.match_weekday } : {}),
    ...(body.match_local_start !== undefined ? { match_local_start: body.match_local_start } : {}),
    ...(body.match_local_end !== undefined ? { match_local_end: body.match_local_end } : {}),
    ...(body.match_duration_seconds !== undefined ? { match_duration_seconds: body.match_duration_seconds } : {}),
    price_cents: body.price_cents,
  }

  const result = await createPriceRule(c.env, actor.userId, input as never, priority)
  if (!result.ok) {
    return c.json({ error: result.reason, ...(result.fields ? { fields: result.fields } : {}) }, errStatus(result.reason))
  }
  return c.json(serializePriceRule(result.data), 201)
})

hostBookings.post("/me/price-rules/:priceRuleId", async (c) => {
  const actor = c.get("actor")
  const priceRuleId = c.req.param("priceRuleId")
  const body = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!body || typeof body !== "object") {
    return c.json({ error: "invalid_payload" }, 400)
  }

  const input: Record<string, unknown> = {}
  if (body.match_weekday !== undefined) input.match_weekday = body.match_weekday
  if (body.match_local_start !== undefined) input.match_local_start = body.match_local_start
  if (body.match_local_end !== undefined) input.match_local_end = body.match_local_end
  if (body.match_duration_seconds !== undefined) input.match_duration_seconds = body.match_duration_seconds
  if (body.price_cents !== undefined) input.price_cents = body.price_cents
  if (body.priority !== undefined && (typeof body.priority !== "number" || !Number.isInteger(body.priority))) {
    return c.json({
      error: "validation_failed",
      fields: [{ field: "priority", reason: "must be an integer" }],
    }, 400)
  }
  if (body.priority !== undefined) input.priority = body.priority

  const result = await updatePriceRule(c.env, actor.userId, priceRuleId, input as never)
  if (!result.ok) {
    return c.json({ error: result.reason, ...(result.fields ? { fields: result.fields } : {}) }, errStatus(result.reason))
  }
  return c.json(serializePriceRule(result.data), 200)
})

hostBookings.delete("/me/price-rules/:priceRuleId", async (c) => {
  const actor = c.get("actor")
  const priceRuleId = c.req.param("priceRuleId")
  const deleted = await deletePriceRule(c.env, actor.userId, priceRuleId)
  if (!deleted) {
    return c.json({ error: "not_found" }, 404)
  }
  return c.json({ id: priceRuleId, object: "price_rule", deleted: true }, 200)
})

export default hostBookings
