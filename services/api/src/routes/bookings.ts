import { Hono, type Context } from "hono"

import { authenticateAdminOrUser, type AuthenticatedEnv } from "../lib/auth-middleware"
import {
  authenticateOperatorCredential,
  BOOKING_SETTLEMENT_RESOLVE_SCOPE,
  requireOperatorScope,
} from "../lib/operator-credential-auth"
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
  previewGlobalBookingCancellation as realPreviewGlobalBookingCancellation,
  resolveGlobalBookingSettlementReview as realResolveGlobalBookingSettlementReview,
  startGlobalBookingSession as realStartGlobalBookingSession,
} from "../lib/bookings/booking-lifecycle-service"
import { resolveGlobalBookingByParty as realResolveGlobalBookingByParty } from "../lib/bookings/booking-settlement-evaluator"
import {
  getGlobalBookingSettlementReview as realGetGlobalBookingSettlementReview,
  getGlobalBookingForParty as realGetGlobalBookingForParty,
  InvalidBookingSettlementReviewCursorError,
  listPendingGlobalBookingSettlementReviews as realListPendingGlobalBookingSettlementReviews,
  listGlobalBookingsForUser as realListGlobalBookingsForUser,
  type BookingViewerRole,
} from "../lib/bookings/booking-read-service"
import { getControlPlaneClient as getRealControlPlaneClient } from "../lib/runtime-deps"
import { decodePublicUserId } from "../lib/public-ids"
import { requireJsonBody } from "./communities-route-helpers"

const DEFAULT_WINDOW_DAYS = 14
const SETTLEMENT_REVIEW_RESOLUTIONS = new Set(["completed", "no_show_host", "no_show_booker"])

const bookings = new Hono<AuthenticatedEnv>()

function isSettlementReviewOperatorPath(pathname: string): boolean {
  return pathname.endsWith("/bookings/settlement-review/pending")
    || /\/bookings\/[^/]+\/settlement-review(?:\/resolve)?$/u.test(pathname)
}

function isPublicSlotsRead(method: string, pathname: string): boolean {
  return method.toUpperCase() === "GET"
    && /\/bookings\/(?:booking-)?hosts\/[^/]+\/slots$/u.test(pathname)
}

bookings.use("*", async (c, next) => {
  const pathname = new URL(c.req.url).pathname
  if (isSettlementReviewOperatorPath(pathname) || isPublicSlotsRead(c.req.method, pathname)) return next()
  return authenticateAdminOrUser(c, next)
})

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
  getGlobalBookingSettlementReview: typeof realGetGlobalBookingSettlementReview
  listPendingGlobalBookingSettlementReviews: typeof realListPendingGlobalBookingSettlementReviews
  resolveGlobalBookingSettlementReview: typeof realResolveGlobalBookingSettlementReview
  cancelGlobalBooking: typeof realCancelGlobalBooking
  startGlobalBookingSession: typeof realStartGlobalBookingSession
  completeGlobalBooking: typeof realCompleteGlobalBooking
  noShowGlobalBooking: typeof realNoShowGlobalBooking
  previewGlobalBookingCancellation: typeof realPreviewGlobalBookingCancellation
  resolveGlobalBookingByParty: typeof realResolveGlobalBookingByParty
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
  getGlobalBookingSettlementReview: realGetGlobalBookingSettlementReview,
  listPendingGlobalBookingSettlementReviews: realListPendingGlobalBookingSettlementReviews,
  resolveGlobalBookingSettlementReview: realResolveGlobalBookingSettlementReview,
  cancelGlobalBooking: realCancelGlobalBooking,
  startGlobalBookingSession: realStartGlobalBookingSession,
  completeGlobalBooking: realCompleteGlobalBooking,
  noShowGlobalBooking: realNoShowGlobalBooking,
  previewGlobalBookingCancellation: realPreviewGlobalBookingCancellation,
  resolveGlobalBookingByParty: realResolveGlobalBookingByParty,
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

function hostUserIdParam(c: BookingContext): string {
  return decodePublicUserId(routeParam(c, "hostUserId"))
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

function settlementReasonStatus(reason: "not_found" | "not_settleable" | "session_not_ended" | "settlement_failed"): 404 | 409 | 502 {
  if (reason === "not_found") return 404
  if (reason === "settlement_failed") return 502 // on-chain terminal failure; the cron/operator review will follow up
  return 409
}

async function slotsHandler(c: BookingContext) {
  const hostUserId = hostUserIdParam(c)
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
  const hostUserId = hostUserIdParam(c)
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

bookings.get("/settlement-review/pending", async (c) => {
  const operatorActor = await authenticateOperatorCredential({
    env: c.env,
    authorization: c.req.header("authorization"),
  })
  requireOperatorScope(operatorActor, BOOKING_SETTLEMENT_RESOLVE_SCOPE)

  const url = new URL(c.req.url)
  const limitParam = url.searchParams.get("limit")
  const limit = limitParam == null ? undefined : Number(limitParam)
  if (limit != null && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
    return c.json({ error: "invalid_limit" }, 400)
  }
  try {
    const page = await routeServices().listPendingGlobalBookingSettlementReviews({
      executor: executor(c),
      sourceCommunityId: optionalSourceCommunityId(url.searchParams.get("source_community_id")),
      limit,
      cursor: url.searchParams.get("cursor"),
    })
    return c.json(page, 200)
  } catch (error) {
    if (error instanceof InvalidBookingSettlementReviewCursorError) {
      return c.json({ error: "invalid_cursor" }, 400)
    }
    throw error
  }
})

bookings.get("/:bookingId", async (c) => {
  const booking = await routeServices().getGlobalBookingForParty({
    executor: executor(c),
    bookingId: routeParam(c, "bookingId"),
    actorUserId: c.get("actor").userId,
  })
  if (!booking) return c.json({ error: "not_found" }, 404)
  return c.json({ booking }, 200)
})

bookings.get("/:bookingId/cancellation-preview", async (c) => {
  const result = await routeServices().previewGlobalBookingCancellation({
    executor: executor(c),
    bookingId: routeParam(c, "bookingId"),
    actorUserId: c.get("actor").userId,
    nowUtc: new Date().toISOString(),
  })
  if (!result.ok) return c.json({ error: result.reason }, conflictOrNotFound(result.reason))
  return c.json(result.preview, 200)
})

bookings.get("/:bookingId/settlement-review", async (c) => {
  const operatorActor = await authenticateOperatorCredential({
    env: c.env,
    authorization: c.req.header("authorization"),
  })
  requireOperatorScope(operatorActor, BOOKING_SETTLEMENT_RESOLVE_SCOPE)

  const review = await routeServices().getGlobalBookingSettlementReview({
    executor: executor(c),
    bookingId: routeParam(c, "bookingId"),
  })
  if (!review) return c.json({ error: "not_found" }, 404)
  return c.json({ review }, 200)
})

bookings.post("/:bookingId/settlement-review/resolve", async (c) => {
  const operatorActor = await authenticateOperatorCredential({
    env: c.env,
    authorization: c.req.header("authorization"),
  })
  requireOperatorScope(operatorActor, BOOKING_SETTLEMENT_RESOLVE_SCOPE)

  const body = await requireJsonBody<{
    resolution?: unknown
    expected_review_version?: unknown
    note?: unknown
  }>(c, "resolution and expected_review_version are required")
  const resolution = typeof body.resolution === "string" ? body.resolution.trim() : ""
  if (!SETTLEMENT_REVIEW_RESOLUTIONS.has(resolution)) {
    return c.json({ error: "invalid_resolution" }, 400)
  }
  const expectedReviewVersion = Number(body.expected_review_version)
  if (!Number.isInteger(expectedReviewVersion) || expectedReviewVersion < 0) {
    return c.json({ error: "invalid_expected_review_version" }, 400)
  }

  const result = await routeServices().resolveGlobalBookingSettlementReview({
    env: c.env,
    executor: executor(c),
    bookingId: routeParam(c, "bookingId"),
    resolution: resolution as "completed" | "no_show_host" | "no_show_booker",
    expectedReviewVersion,
    operatorCredentialId: operatorActor.operatorCredentialId,
    operatorActorId: operatorActor.operatorActorId,
    note: typeof body.note === "string" ? body.note : null,
    nowUtc: new Date().toISOString(),
    confirmPollMs: [],
  })
  if (!result.ok) {
    const status = result.reason === "not_found"
      ? 404
      : result.reason === "version_conflict" || result.reason === "resolution_conflict"
        ? 409
        : 400
    return c.json({ error: result.reason }, status)
  }
  const pendingSettlement = result.outcome === "resolved_pending"
  return c.json({
    booking: result.booking,
    resolution,
    pending_settlement: pendingSettlement,
    replayed: result.outcome === "replayed",
  }, pendingSettlement ? 202 : 200)
})

bookings.post("/:bookingId/cancel", async (c) => {
  const body = await requireJsonBody<{ expected_refund_cents?: unknown }>(c, "expected_refund_cents is required")
  const expectedRefundCents = Number(body.expected_refund_cents)
  if (!Number.isSafeInteger(expectedRefundCents) || expectedRefundCents < 0) {
    return c.json({ error: "invalid_expected_refund_cents" }, 400)
  }
  const result = await routeServices().cancelGlobalBooking({
    env: c.env,
    executor: executor(c),
    bookingId: routeParam(c, "bookingId"),
    actorUserId: c.get("actor").userId,
    nowUtc: new Date().toISOString(),
    expectedRefundCents,
  })
  if (!result.ok) {
    if (result.reason === "cancellation_terms_changed") {
      return c.json({ error: result.reason, preview: result.preview }, 409)
    }
    return c.json({ error: result.reason }, conflictOrNotFound(result.reason))
  }
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

// /complete and /no-show no longer let a party assert an outcome and move money. Both trigger the SAME
// attendance-based resolution (only after the slot window closes): recorded heartbeats decide
// completed / no_show_*, and genuine ambiguity is parked in operator settlement review with no automatic
// funds. Kept as two paths for client compatibility; the server decides the outcome, not the caller.
async function resolveByAttendanceHandler(c: BookingContext) {
  const bookingId = routeParam(c, "bookingId")
  const actorUserId = c.get("actor").userId
  const result = await routeServices().resolveGlobalBookingByParty({
    env: c.env,
    executor: executor(c),
    bookingId,
    actorUserId,
    nowUtc: new Date().toISOString(),
  })
  if (!result.ok) return c.json({ error: result.reason }, settlementReasonStatus(result.reason))
  const booking = await routeServices().getGlobalBookingForParty({
    executor: executor(c),
    bookingId,
    actorUserId,
  })
  return c.json({
    booking,
    outcome: result.outcome,
    settled: result.settled,
    under_review: result.underReview,
    settlement_pending: result.pending,
  }, result.pending ? 202 : 200)
}

bookings.post("/:bookingId/complete", resolveByAttendanceHandler)
bookings.post("/:bookingId/no-show", resolveByAttendanceHandler)

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
