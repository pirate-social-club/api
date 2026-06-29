import { Hono, type Context } from "hono"

import { authenticateAdminOrUser, type AuthenticatedEnv } from "../lib/auth-middleware"
import { getUserRepository as getRealUserRepository } from "../lib/auth/repositories"
import {
  confirmGlobalBookingHold as realConfirmGlobalBookingHold,
  quoteGlobalBookingHold as realQuoteGlobalBookingHold,
} from "../lib/bookings/booking-confirm-service"
import {
  createGlobalBookingHold as realCreateGlobalBookingHold,
  resolveGlobalBookingAvailability as realResolveGlobalBookingAvailability,
} from "../lib/bookings/booking-hold-service"
import {
  attachGlobalBookingSession as realAttachGlobalBookingSession,
  cancelGlobalBooking as realCancelGlobalBooking,
  completeGlobalBooking as realCompleteGlobalBooking,
  heartbeatGlobalBookingSession as realHeartbeatGlobalBookingSession,
  noShowGlobalBooking as realNoShowGlobalBooking,
  startGlobalBookingSession as realStartGlobalBookingSession,
} from "../lib/bookings/booking-lifecycle-service"
import {
  getGlobalBookingForParty as realGetGlobalBookingForParty,
  listGlobalBookingsForUser as realListGlobalBookingsForUser,
  type BookingViewerRole,
} from "../lib/bookings/booking-read-service"
import { getControlPlaneClient as getRealControlPlaneClient } from "../lib/runtime-deps"
import { requireJsonBody } from "./communities-route-helpers"

const DEFAULT_WINDOW_DAYS = 14

const bookings = new Hono<AuthenticatedEnv>()

bookings.use("*", authenticateAdminOrUser)

type BookingContext = Context<AuthenticatedEnv>

export type GlobalBookingRouteServices = {
  getControlPlaneClient: typeof getRealControlPlaneClient
  getUserRepository: typeof getRealUserRepository
  resolveGlobalBookingAvailability: typeof realResolveGlobalBookingAvailability
  createGlobalBookingHold: typeof realCreateGlobalBookingHold
  quoteGlobalBookingHold: typeof realQuoteGlobalBookingHold
  confirmGlobalBookingHold: typeof realConfirmGlobalBookingHold
  getGlobalBookingForParty: typeof realGetGlobalBookingForParty
  listGlobalBookingsForUser: typeof realListGlobalBookingsForUser
  cancelGlobalBooking: typeof realCancelGlobalBooking
  startGlobalBookingSession: typeof realStartGlobalBookingSession
  completeGlobalBooking: typeof realCompleteGlobalBooking
  noShowGlobalBooking: typeof realNoShowGlobalBooking
  attachGlobalBookingSession: typeof realAttachGlobalBookingSession
  heartbeatGlobalBookingSession: typeof realHeartbeatGlobalBookingSession
}

const realServices: GlobalBookingRouteServices = {
  getControlPlaneClient: getRealControlPlaneClient,
  getUserRepository: getRealUserRepository,
  resolveGlobalBookingAvailability: realResolveGlobalBookingAvailability,
  createGlobalBookingHold: realCreateGlobalBookingHold,
  quoteGlobalBookingHold: realQuoteGlobalBookingHold,
  confirmGlobalBookingHold: realConfirmGlobalBookingHold,
  getGlobalBookingForParty: realGetGlobalBookingForParty,
  listGlobalBookingsForUser: realListGlobalBookingsForUser,
  cancelGlobalBooking: realCancelGlobalBooking,
  startGlobalBookingSession: realStartGlobalBookingSession,
  completeGlobalBooking: realCompleteGlobalBooking,
  noShowGlobalBooking: realNoShowGlobalBooking,
  attachGlobalBookingSession: realAttachGlobalBookingSession,
  heartbeatGlobalBookingSession: realHeartbeatGlobalBookingSession,
}

let servicesForTests: GlobalBookingRouteServices | null = null

export function setGlobalBookingRouteServicesForTests(services: GlobalBookingRouteServices | null): void {
  servicesForTests = services
}

function routeServices(): GlobalBookingRouteServices {
  return servicesForTests ?? realServices
}

function executor(c: BookingContext): ReturnType<typeof getRealControlPlaneClient> {
  return routeServices().getControlPlaneClient(c.env)
}

function routeParam(c: BookingContext, name: string): string {
  const value = c.req.param(name)
  if (!value) throw new Error(`missing route param: ${name}`)
  return value
}

function optionalSourceCommunityId(value: string | null): string | null | undefined {
  if (value === null) return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed === "null") return null
  return trimmed
}

function sourceCommunityIdFromBody(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function conflictOrNotFound(reason: string): 404 | 409 {
  return reason === "not_found" || reason === "hold_not_found" ? 404 : 409
}

async function slotsHandler(c: BookingContext) {
  const hostUserId = routeParam(c, "hostUserId")
  const url = new URL(c.req.url)
  const nowUtc = new Date().toISOString()
  const windowStartUtc = url.searchParams.get("from") ?? nowUtc
  const windowEndUtc = url.searchParams.get("to")
    ?? new Date(Date.parse(nowUtc) + DEFAULT_WINDOW_DAYS * 86400_000).toISOString()
  const viewerTimezone = url.searchParams.get("tz") ?? "UTC"

  const result = await routeServices().resolveGlobalBookingAvailability({
    executor: executor(c),
    hostUserId,
    windowStartUtc,
    windowEndUtc,
    viewerTimezone,
    nowUtc,
  })
  if (!result.bookable) return c.json({ error: "host_not_bookable" }, 404)
  return c.json({
    host_timezone: result.hostTimezone,
    viewer_timezone: result.viewerTimezone,
    slots: result.slots,
  }, 200)
}

async function createHoldHandler(c: BookingContext) {
  const actor = c.get("actor")
  const hostUserId = routeParam(c, "hostUserId")
  const body = await requireJsonBody<{
    slot_start_utc?: string
    slot_end_utc?: string
    source_community_id?: unknown
  }>(c, "slot_start_utc and slot_end_utc are required")
  if (!body.slot_start_utc || !body.slot_end_utc) {
    return c.json({ error: "slot_start_utc and slot_end_utc are required" }, 400)
  }

  const result = await routeServices().createGlobalBookingHold({
    client: executor(c),
    sourceCommunityId: sourceCommunityIdFromBody(body.source_community_id),
    hostUserId,
    bookerUserId: actor.userId,
    slotStartUtc: body.slot_start_utc,
    slotEndUtc: body.slot_end_utc,
    nowUtc: new Date().toISOString(),
  })
  if (!result.ok) return c.json({ error: result.reason }, 409)
  return c.json({ hold: result.hold }, 201)
}

async function quoteHoldHandler(c: BookingContext) {
  const result = await routeServices().quoteGlobalBookingHold({
    env: c.env,
    executor: executor(c),
    holdId: routeParam(c, "holdId"),
    nowUtc: new Date().toISOString(),
  })
  if (!result.ok) return c.json({ error: result.reason }, conflictOrNotFound(result.reason))
  return c.json({ quote: result.quote }, 200)
}

async function confirmHoldHandler(c: BookingContext) {
  const actor = c.get("actor")
  const body = await requireJsonBody<{ funding_tx_ref?: string; wallet_attachment_id?: string }>(
    c,
    "funding_tx_ref and wallet_attachment_id are required",
  )
  if (!body.funding_tx_ref || !body.wallet_attachment_id) {
    return c.json({ error: "funding_tx_ref and wallet_attachment_id are required" }, 400)
  }

  const result = await routeServices().confirmGlobalBookingHold({
    env: c.env,
    executor: executor(c),
    userRepository: routeServices().getUserRepository(c.env),
    holdId: routeParam(c, "holdId"),
    bookerUserId: actor.userId,
    fundingTxRef: body.funding_tx_ref,
    walletAttachmentId: body.wallet_attachment_id,
    nowUtc: new Date().toISOString(),
  })
  if (!result.ok) return c.json({ error: result.reason }, conflictOrNotFound(result.reason))
  return c.json({ booking: result.booking, already_confirmed: result.already }, result.already ? 200 : 201)
}

bookings.get("/", async (c) => {
  const actor = c.get("actor")
  const url = new URL(c.req.url)
  const role: BookingViewerRole = url.searchParams.get("role") === "host" ? "host" : "booker"
  const statusParam = url.searchParams.get("status")
  const statuses = statusParam ? statusParam.split(",").map((status) => status.trim()).filter(Boolean) : undefined
  const sourceCommunityId = optionalSourceCommunityId(url.searchParams.get("source_community_id"))
  const data = await routeServices().listGlobalBookingsForUser({
    executor: executor(c),
    actorUserId: actor.userId,
    role,
    sourceCommunityId,
    statuses,
  })
  return c.json({ object: "list", data, has_more: false }, 200)
})

bookings.get("/hosts/:hostUserId/slots", slotsHandler)
bookings.get("/booking-hosts/:hostUserId/slots", slotsHandler)
bookings.post("/hosts/:hostUserId/holds", createHoldHandler)
bookings.post("/booking-hosts/:hostUserId/holds", createHoldHandler)
bookings.post("/holds/:holdId/quote", quoteHoldHandler)
bookings.post("/booking-holds/:holdId/quote", quoteHoldHandler)
bookings.post("/holds/:holdId/confirm", confirmHoldHandler)
bookings.post("/booking-holds/:holdId/confirm", confirmHoldHandler)

bookings.get("/:bookingId", async (c) => {
  const booking = await routeServices().getGlobalBookingForParty({
    executor: executor(c),
    bookingId: routeParam(c, "bookingId"),
    actorUserId: c.get("actor").userId,
  })
  if (!booking) return c.json({ error: "not_found" }, 404)
  return c.json({ booking }, 200)
})

bookings.post("/:bookingId/cancel", async (c) => {
  const result = await routeServices().cancelGlobalBooking({
    env: c.env,
    executor: executor(c),
    bookingId: routeParam(c, "bookingId"),
    actorUserId: c.get("actor").userId,
    nowUtc: new Date().toISOString(),
  })
  if (!result.ok) return c.json({ error: result.reason }, conflictOrNotFound(result.reason))
  return c.json({ booking: result.booking, cancelled_by: result.cancelledBy, already_cancelled: result.already }, 200)
})

bookings.post("/:bookingId/start", async (c) => {
  const result = await routeServices().startGlobalBookingSession({
    executor: executor(c),
    bookingId: routeParam(c, "bookingId"),
    actorUserId: c.get("actor").userId,
    nowUtc: new Date().toISOString(),
  })
  if (!result.ok) return c.json({ error: result.reason }, conflictOrNotFound(result.reason))
  return c.json({ booking: result.booking, already_live: result.already }, 200)
})

bookings.post("/:bookingId/complete", async (c) => {
  const result = await routeServices().completeGlobalBooking({
    env: c.env,
    executor: executor(c),
    bookingId: routeParam(c, "bookingId"),
    actorUserId: c.get("actor").userId,
    nowUtc: new Date().toISOString(),
  })
  if (!result.ok) return c.json({ error: result.reason }, conflictOrNotFound(result.reason))
  return c.json({ booking: result.booking, already_settled: result.already }, 200)
})

bookings.post("/:bookingId/no-show", async (c) => {
  const result = await routeServices().noShowGlobalBooking({
    env: c.env,
    executor: executor(c),
    bookingId: routeParam(c, "bookingId"),
    actorUserId: c.get("actor").userId,
    nowUtc: new Date().toISOString(),
  })
  if (!result.ok) return c.json({ error: result.reason }, conflictOrNotFound(result.reason))
  return c.json({ booking: result.booking, already_resolved: result.already }, 200)
})

bookings.post("/:bookingId/session/attach", async (c) => {
  const result = await routeServices().attachGlobalBookingSession({
    env: c.env,
    executor: executor(c),
    bookingId: routeParam(c, "bookingId"),
    actorUserId: c.get("actor").userId,
    nowUtc: new Date().toISOString(),
  })
  if (!result.ok) return c.json({ error: result.reason }, conflictOrNotFound(result.reason))
  return c.json({ session_id: result.sessionId, party: result.party, channel: result.channel, agora: result.agora }, 200)
})

bookings.post("/:bookingId/session/heartbeat", async (c) => {
  const body = await c.req.json<{ session_id?: unknown }>().catch(() => null)
  const sessionId = body && typeof body.session_id === "string" ? body.session_id : ""
  if (!sessionId) return c.json({ error: "invalid_payload" }, 400)
  const result = await routeServices().heartbeatGlobalBookingSession({
    executor: executor(c),
    bookingId: routeParam(c, "bookingId"),
    actorUserId: c.get("actor").userId,
    sessionId,
    nowUtc: new Date().toISOString(),
  })
  if (!result.ok) return c.json({ error: result.reason }, conflictOrNotFound(result.reason))
  return c.json({ ok: true }, 200)
})

export default bookings
