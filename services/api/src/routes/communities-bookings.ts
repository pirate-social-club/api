import type { Hono } from "hono"

import type { AuthenticatedEnv } from "../lib/auth-middleware"
import { resolveBookingAvailability as resolveCommunityBookingAvailability } from "../lib/communities/bookings/booking-availability-service"
import { confirmBookingHold as confirmCommunityBookingHold, quoteBookingHold as quoteCommunityBookingHold } from "../lib/communities/bookings/booking-confirm-service"
import { createBookingHold as createCommunityBookingHold } from "../lib/communities/bookings/booking-hold-service"
import {
  cancelBooking as cancelCommunityBooking,
  completeBooking as completeCommunityBooking,
  noShowBooking as noShowCommunityBooking,
  resolveBookingSettlementReview,
  startBookingSession as startCommunityBookingSession,
  type BookingSettlementReviewResolution,
} from "../lib/communities/bookings/booking-lifecycle-service"
import {
  attachBookingSession as attachCommunityBookingSession,
  heartbeatBookingSession as heartbeatCommunityBookingSession,
} from "../lib/communities/bookings/booking-session-service"
import {
  getBookingForParty as getCommunityBookingForParty,
  getBookingSettlementReview,
  InvalidBookingSettlementReviewCursorError,
  listBookingsForUser as listCommunityBookingsForUser,
  listPendingBookingSettlementReviews,
  type BookingViewerRole,
} from "../lib/communities/bookings/booking-read-service"
import { resolveCommunityIdentifier } from "../lib/communities/community-identifier"
import { getCommunityRepository } from "../lib/communities/db-community-repository"
import {
  authenticateOperatorCredential,
  BOOKING_SETTLEMENT_RESOLVE_SCOPE,
  requireOperatorScope,
} from "../lib/operator-credential-auth"
import {
  confirmGlobalBookingHold as confirmGlobalBookingHoldReal,
  quoteGlobalBookingHold as quoteGlobalBookingHoldReal,
} from "../lib/bookings/booking-confirm-service"
import {
  createGlobalBookingHold as createGlobalBookingHoldReal,
  resolveGlobalBookingAvailability as resolveGlobalBookingAvailabilityReal,
} from "../lib/bookings/booking-hold-service"
import {
  attachGlobalBookingSession as attachGlobalBookingSessionReal,
  cancelGlobalBooking as cancelGlobalBookingReal,
  completeGlobalBooking as completeGlobalBookingReal,
  heartbeatGlobalBookingSession as heartbeatGlobalBookingSessionReal,
  noShowGlobalBooking as noShowGlobalBookingReal,
  startGlobalBookingSession as startGlobalBookingSessionReal,
} from "../lib/bookings/booking-lifecycle-service"
import {
  enrichGlobalBookingCounterparties as enrichGlobalBookingCounterpartiesReal,
  getGlobalBookingForParty as getGlobalBookingForPartyReal,
  listGlobalBookingsForUser as listGlobalBookingsForUserReal,
} from "../lib/bookings/booking-read-service"
import { getControlPlaneClient as getControlPlaneClientReal } from "../lib/runtime-deps"
import {
  getResolvedCommunityRouteContext as getResolvedCommunityRouteContextReal,
  requireJsonBody,
} from "./communities-route-helpers"
import { logBodylessBookingCancellation, parseOptionalExpectedRefundCents } from "./booking-cancellation-compat"

const DEFAULT_WINDOW_DAYS = 14
const SETTLEMENT_REVIEW_RESOLUTIONS = new Set<string>(["completed", "no_show_host", "no_show_booker"])

type ControlPlaneExecutor = ReturnType<typeof getControlPlaneClientReal>

export type CommunityBookingsRouteServices = {
  getResolvedCommunityRouteContext: typeof getResolvedCommunityRouteContextReal
  getControlPlaneClient: typeof getControlPlaneClientReal
  resolveCommunityBookingAvailability: typeof resolveCommunityBookingAvailability
  listCommunityBookingsForUser: typeof listCommunityBookingsForUser
  getCommunityBookingForParty: typeof getCommunityBookingForParty
  createCommunityBookingHold: typeof createCommunityBookingHold
  quoteCommunityBookingHold: typeof quoteCommunityBookingHold
  confirmCommunityBookingHold: typeof confirmCommunityBookingHold
  cancelCommunityBooking: typeof cancelCommunityBooking
  startCommunityBookingSession: typeof startCommunityBookingSession
  completeCommunityBooking: typeof completeCommunityBooking
  noShowCommunityBooking: typeof noShowCommunityBooking
  attachCommunityBookingSession: typeof attachCommunityBookingSession
  heartbeatCommunityBookingSession: typeof heartbeatCommunityBookingSession
  resolveGlobalBookingAvailability: typeof resolveGlobalBookingAvailabilityReal
  listGlobalBookingsForUser: typeof listGlobalBookingsForUserReal
  getGlobalBookingForParty: typeof getGlobalBookingForPartyReal
  enrichGlobalBookingCounterparties: typeof enrichGlobalBookingCounterpartiesReal
  createGlobalBookingHold: typeof createGlobalBookingHoldReal
  quoteGlobalBookingHold: typeof quoteGlobalBookingHoldReal
  confirmGlobalBookingHold: typeof confirmGlobalBookingHoldReal
  cancelGlobalBooking: typeof cancelGlobalBookingReal
  startGlobalBookingSession: typeof startGlobalBookingSessionReal
  completeGlobalBooking: typeof completeGlobalBookingReal
  noShowGlobalBooking: typeof noShowGlobalBookingReal
  attachGlobalBookingSession: typeof attachGlobalBookingSessionReal
  heartbeatGlobalBookingSession: typeof heartbeatGlobalBookingSessionReal
}

const realCommunityBookingsRouteServices: CommunityBookingsRouteServices = {
  getResolvedCommunityRouteContext: getResolvedCommunityRouteContextReal,
  getControlPlaneClient: getControlPlaneClientReal,
  resolveCommunityBookingAvailability,
  listCommunityBookingsForUser,
  getCommunityBookingForParty,
  createCommunityBookingHold,
  quoteCommunityBookingHold,
  confirmCommunityBookingHold,
  cancelCommunityBooking,
  startCommunityBookingSession,
  completeCommunityBooking,
  noShowCommunityBooking,
  attachCommunityBookingSession,
  heartbeatCommunityBookingSession,
  resolveGlobalBookingAvailability: resolveGlobalBookingAvailabilityReal,
  listGlobalBookingsForUser: listGlobalBookingsForUserReal,
  getGlobalBookingForParty: getGlobalBookingForPartyReal,
  enrichGlobalBookingCounterparties: enrichGlobalBookingCounterpartiesReal,
  createGlobalBookingHold: createGlobalBookingHoldReal,
  quoteGlobalBookingHold: quoteGlobalBookingHoldReal,
  confirmGlobalBookingHold: confirmGlobalBookingHoldReal,
  cancelGlobalBooking: cancelGlobalBookingReal,
  startGlobalBookingSession: startGlobalBookingSessionReal,
  completeGlobalBooking: completeGlobalBookingReal,
  noShowGlobalBooking: noShowGlobalBookingReal,
  attachGlobalBookingSession: attachGlobalBookingSessionReal,
  heartbeatGlobalBookingSession: heartbeatGlobalBookingSessionReal,
}

let communityBookingsRouteServicesForTests: CommunityBookingsRouteServices | null = null

export function setCommunityBookingsRouteServicesForTests(services: CommunityBookingsRouteServices | null): void {
  communityBookingsRouteServicesForTests = services
}

function routeServices(): CommunityBookingsRouteServices {
  return communityBookingsRouteServicesForTests ?? realCommunityBookingsRouteServices
}

function isMissingGlobalBookingsSchema(error: unknown): boolean {
  let current: unknown = error
  while (current && typeof current === "object") {
    const code = "code" in current ? String((current as { code?: unknown }).code) : ""
    if (code === "42P01") return true
    current = "cause" in current ? (current as { cause?: unknown }).cause : null
  }
  const message = String((error as { message?: unknown })?.message ?? error).toLowerCase()
  return message.includes("no such table: bookings.") || message.includes('relation "bookings.')
}

function hasPostgresControlPlane(env: AuthenticatedEnv["Bindings"]): boolean {
  return /^(postgres|postgresql):\/\//iu.test(String(env.CONTROL_PLANE_DATABASE_URL ?? "").trim())
}

async function tryGlobalBookings<T>(
  env: AuthenticatedEnv["Bindings"],
  operation: (executor: ControlPlaneExecutor) => Promise<T>,
): Promise<{ available: true; value: T } | { available: false }> {
  if (!hasPostgresControlPlane(env)) return { available: false }
  try {
    return { available: true, value: await operation(routeServices().getControlPlaneClient(env)) }
  } catch (error) {
    if (!isMissingGlobalBookingsSchema(error)) throw error
    return { available: false }
  }
}

export function registerCommunityBookingsRoutes(communities: Hono<AuthenticatedEnv>): void {
  // Read-only availability for a host within a community (Slice A): resolves the host's
  // published profile + availability rules/exceptions/pricing (control-plane) against the
  // community's active holds/bookings (per-community D1) via @pirate/bookings-domain.
  // No hold creation, quote, settlement, or video session here.
  communities.get("/:communityId/booking-hosts/:hostUserId/slots", async (c) => {
    const services = routeServices()
    const { communityId, communityRepository } = await services.getResolvedCommunityRouteContext(c)
    const hostUserId = c.req.param("hostUserId")

    const url = new URL(c.req.url)
    const nowUtc = new Date().toISOString()
    const windowStartUtc = url.searchParams.get("from") ?? nowUtc
    const windowEndUtc = url.searchParams.get("to")
      ?? new Date(Date.parse(nowUtc) + DEFAULT_WINDOW_DAYS * 86400_000).toISOString()
    const viewerTimezone = url.searchParams.get("tz") ?? "UTC"

    const globalResult = await tryGlobalBookings(c.env, (executor) =>
      services.resolveGlobalBookingAvailability({
        executor,
        hostUserId,
        windowStartUtc,
        windowEndUtc,
        viewerTimezone,
        nowUtc,
      })
    )
    if (globalResult.available) {
      if (!globalResult.value.bookable) {
        return c.json({ error: "host_not_bookable" }, 404)
      }
      return c.json({
        host_timezone: globalResult.value.hostTimezone,
        viewer_timezone: globalResult.value.viewerTimezone,
        slots: globalResult.value.slots,
      }, 200)
    }

    const result = await services.resolveCommunityBookingAvailability({
      env: c.env,
      communityRepository,
      communityId,
      hostUserId,
      windowStartUtc,
      windowEndUtc,
      viewerTimezone,
      nowUtc,
    })

    if (!result.bookable) {
      return c.json({ error: "host_not_bookable" }, 404)
    }

    return c.json({
      host_timezone: result.hostTimezone,
      viewer_timezone: result.viewerTimezone,
      slots: result.slots,
    }, 200)
  })

  // Read: list the caller's own bookings within a community, as host or booker (party-authorized:
  // only the caller's rows are returned). Optional status filter (comma-separated). Authoritative
  // source for booking management — never trust browser-local cache for this.
  communities.get("/:communityId/bookings", async (c) => {
    const services = routeServices()
    const { actor, communityId, communityRepository, profileRepository } = await services.getResolvedCommunityRouteContext(c)
    const url = new URL(c.req.url)
    const role: BookingViewerRole = url.searchParams.get("role") === "host" ? "host" : "booker"
    const statusParam = url.searchParams.get("status")
    const statuses = statusParam ? statusParam.split(",").map((s) => s.trim()).filter(Boolean) : undefined
    const globalData = await tryGlobalBookings(c.env, (executor) =>
      services.listGlobalBookingsForUser({
        executor,
        actorUserId: actor.userId,
        role,
        sourceCommunityId: communityId,
        statuses,
      })
    )
    if (globalData.available) {
      const data = await services.enrichGlobalBookingCounterparties({ bookings: globalData.value, profileRepository })
      return c.json({ object: "list", data, has_more: false }, 200)
    }
    const data = await services.listCommunityBookingsForUser({ env: c.env, communityRepository, communityId, actorUserId: actor.userId, role, statuses })
    return c.json({ object: "list", data, has_more: false }, 200)
  })

  communities.get("/:communityId/bookings/settlement-review/pending", async (c) => {
    const operatorActor = await authenticateOperatorCredential({
      env: c.env,
      authorization: c.req.header("authorization"),
    })
    requireOperatorScope(operatorActor, BOOKING_SETTLEMENT_RESOLVE_SCOPE)

    const communityRepository = getCommunityRepository(c.env)
    const routeCommunityId = c.req.param("communityId")
    const communityId = await resolveCommunityIdentifier(communityRepository, routeCommunityId) ?? routeCommunityId
    const url = new URL(c.req.url)
    const limitParam = url.searchParams.get("limit")
    const limit = limitParam == null ? undefined : Number(limitParam)
    if (limit != null && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
      return c.json({ error: "invalid_limit" }, 400)
    }
    let page
    try {
      page = await listPendingBookingSettlementReviews({
        env: c.env,
        communityRepository,
        communityId,
        limit,
        cursor: url.searchParams.get("cursor"),
      })
    } catch (error) {
      if (error instanceof InvalidBookingSettlementReviewCursorError) {
        return c.json({ error: "invalid_cursor" }, 400)
      }
      throw error
    }
    return c.json(page, 200)
  })

  // Read: retrieve a single booking — only if the caller is a party (host or booker), else 404.
  communities.get("/:communityId/bookings/:bookingId", async (c) => {
    const services = routeServices()
    const { actor, communityId, communityRepository, profileRepository } = await services.getResolvedCommunityRouteContext(c)
    const bookingId = c.req.param("bookingId")
    const globalBooking = await tryGlobalBookings(c.env, (executor) =>
      services.getGlobalBookingForParty({
        executor,
        bookingId,
        actorUserId: actor.userId,
      })
    )
    if (globalBooking.available) {
      if (!globalBooking.value) return c.json({ error: "not_found" }, 404)
      const [booking] = await services.enrichGlobalBookingCounterparties({ bookings: [globalBooking.value], profileRepository })
      return c.json({ booking }, 200)
    }
    const booking = await services.getCommunityBookingForParty({ env: c.env, communityRepository, communityId, bookingId, actorUserId: actor.userId })
    if (!booking) return c.json({ error: "not_found" }, 404)
    return c.json({ booking }, 200)
  })

  communities.get("/:communityId/bookings/:bookingId/settlement-review", async (c) => {
    const operatorActor = await authenticateOperatorCredential({
      env: c.env,
      authorization: c.req.header("authorization"),
    })
    requireOperatorScope(operatorActor, BOOKING_SETTLEMENT_RESOLVE_SCOPE)

    const communityRepository = getCommunityRepository(c.env)
    const routeCommunityId = c.req.param("communityId")
    const communityId = await resolveCommunityIdentifier(communityRepository, routeCommunityId) ?? routeCommunityId
    const review = await getBookingSettlementReview({
      env: c.env,
      communityRepository,
      communityId,
      bookingId: c.req.param("bookingId"),
    })
    if (!review) return c.json({ error: "not_found" }, 404)
    return c.json({ review }, 200)
  })

  // Slice B: create a short-lived hold on a slot. Acquires the cross-community control-plane
  // lock first, then inserts the per-community hold; releases the lock if the D1 insert fails.
  // No quote / settlement / video session here (that is Slice C).
  communities.post("/:communityId/booking-hosts/:hostUserId/holds", async (c) => {
    const services = routeServices()
    const { actor, communityId, communityRepository } = await services.getResolvedCommunityRouteContext(c)
    const hostUserId = c.req.param("hostUserId")
    const body = await requireJsonBody<{ slot_start_utc?: string; slot_end_utc?: string }>(
      c,
      "slot_start_utc and slot_end_utc are required",
    )
    if (!body.slot_start_utc || !body.slot_end_utc) {
      return c.json({ error: "slot_start_utc and slot_end_utc are required" }, 400)
    }

    const slotStartUtc = body.slot_start_utc
    const slotEndUtc = body.slot_end_utc
    const nowUtc = new Date().toISOString()
    const globalResult = await tryGlobalBookings(c.env, (executor) =>
      services.createGlobalBookingHold({
        client: executor,
        sourceCommunityId: communityId,
        hostUserId,
        bookerUserId: actor.userId,
        slotStartUtc,
        slotEndUtc,
        nowUtc,
      })
    )
    if (globalResult.available) {
      if (globalResult.value.ok) {
        return c.json({ hold: globalResult.value.hold }, 201)
      }
      return c.json({ error: globalResult.value.reason }, 409)
    }

    const result = await services.createCommunityBookingHold({
      env: c.env,
      communityRepository,
      communityId,
      hostUserId,
      bookerUserId: actor.userId,
      slotStartUtc,
      slotEndUtc,
      nowUtc,
    })

    if (!result.ok) {
      const status = result.reason === "hold_insert_failed" ? 500 : 409
      return c.json({ error: result.reason }, status)
    }
    return c.json({ hold: result.hold }, 201)
  })

  // Slice C: immutable quote preview derived from the hold's price snapshot (no quote table).
  communities.post("/:communityId/booking-holds/:holdId/quote", async (c) => {
    const services = routeServices()
    const { communityId, communityRepository } = await services.getResolvedCommunityRouteContext(c)
    const holdId = c.req.param("holdId")
    const nowUtc = new Date().toISOString()
    const globalResult = await tryGlobalBookings(c.env, (executor) =>
      services.quoteGlobalBookingHold({
        env: c.env,
        executor,
        holdId,
        nowUtc,
      })
    )
    if (globalResult.available) {
      if (globalResult.value.ok) {
        return c.json({ quote: globalResult.value.quote }, 200)
      }
      return c.json({ error: globalResult.value.reason }, globalResult.value.reason === "hold_not_found" ? 404 : 409)
    }
    const result = await services.quoteCommunityBookingHold({
      env: c.env,
      communityRepository,
      communityId,
      holdId,
      nowUtc,
    })
    if (!result.ok) {
      return c.json({ error: result.reason }, result.reason === "hold_not_found" ? 404 : 409)
    }
    return c.json({ quote: result.quote }, 200)
  })

  // Slice C: confirm a hold into a booking after server-side USDC receipt verification (PR0 gate).
  // Creates the confirmed booking, consumes the hold, and makes the cross-community lock permanent.
  // No host payout and no video session here (payout = lifecycle resolution; session = lazy follow-up).
  communities.post("/:communityId/booking-holds/:holdId/confirm", async (c) => {
    const services = routeServices()
    const { actor, communityId, communityRepository, userRepository } = await services.getResolvedCommunityRouteContext(c)
    const body = await requireJsonBody<{ funding_tx_ref?: string; wallet_attachment_id?: string }>(
      c,
      "funding_tx_ref and wallet_attachment_id are required",
    )
    if (!body.funding_tx_ref || !body.wallet_attachment_id) {
      return c.json({ error: "funding_tx_ref and wallet_attachment_id are required" }, 400)
    }

    const fundingTxRef = body.funding_tx_ref
    const walletAttachmentId = body.wallet_attachment_id
    const holdId = c.req.param("holdId")
    const nowUtc = new Date().toISOString()
    const globalResult = await tryGlobalBookings(c.env, (executor) =>
      services.confirmGlobalBookingHold({
        env: c.env,
        executor,
        userRepository,
        holdId,
        bookerUserId: actor.userId,
        fundingTxRef,
        walletAttachmentId,
        nowUtc,
      })
    )
    if (globalResult.available) {
      if (globalResult.value.ok) {
        return c.json({ booking: globalResult.value.booking, already_confirmed: globalResult.value.already }, globalResult.value.already ? 200 : 201)
      }
      return c.json({ error: globalResult.value.reason }, globalResult.value.reason === "hold_not_found" ? 404 : 409)
    }

    const result = await services.confirmCommunityBookingHold({
      env: c.env,
      communityRepository,
      userRepository,
      communityId,
      holdId,
      bookerUserId: actor.userId,
      fundingTxRef,
      walletAttachmentId,
      nowUtc,
    })
    if (!result.ok) {
      return c.json({ error: result.reason }, result.reason === "hold_not_found" ? 404 : 409)
    }
    return c.json({ booking: result.booking, already_confirmed: result.already }, result.already ? 200 : 201)
  })

  // Slice D: cancel a confirmed booking. The actor's role (host vs booker) is inferred and
  // determines the refund policy; resolves the operator refund/payout, releases the slot lock.
  communities.post("/:communityId/bookings/:bookingId/cancel", async (c) => {
    const services = routeServices()
    const { actor, communityId, communityRepository } = await services.getResolvedCommunityRouteContext(c)
    const bookingId = c.req.param("bookingId")
    const terms = await parseOptionalExpectedRefundCents(() => c.req.text())
    if (!terms.ok) return c.json({ error: "invalid_expected_refund_cents" }, 400)
    const nowUtc = new Date().toISOString()
    const globalResult = await tryGlobalBookings(c.env, (executor) =>
      services.cancelGlobalBooking({
        env: c.env,
        executor,
        bookingId,
        actorUserId: actor.userId,
        nowUtc,
        expectedRefundCents: terms.provided ? terms.expectedRefundCents : undefined,
      })
    )
    if (globalResult.available) {
      if (globalResult.value.ok) {
        if (!terms.provided) logBodylessBookingCancellation({ bookingId, actorRole: globalResult.value.cancelledBy })
        return c.json({ booking: globalResult.value.booking, cancelled_by: globalResult.value.cancelledBy, already_cancelled: globalResult.value.already }, 200)
      }
      if (globalResult.value.reason === "cancellation_terms_changed") {
        return c.json({ error: globalResult.value.reason, preview: globalResult.value.preview }, 409)
      }
      return c.json({ error: globalResult.value.reason }, globalResult.value.reason === "not_found" ? 404 : 409)
    }
    const result = await services.cancelCommunityBooking({
      env: c.env,
      communityRepository,
      communityId,
      bookingId,
      actorUserId: actor.userId,
      nowUtc,
      expectedRefundCents: terms.provided ? terms.expectedRefundCents : undefined,
    })
    if (!result.ok) {
      if (result.reason === "cancellation_terms_changed") {
        return c.json({ error: result.reason, preview: result.preview }, 409)
      }
      return c.json({ error: result.reason }, result.reason === "not_found" ? 404 : 409)
    }
    if (!terms.provided) logBodylessBookingCancellation({ bookingId, actorRole: result.cancelledBy })
    return c.json({ booking: result.booking, cancelled_by: result.cancelledBy, already_cancelled: result.already }, 200)
  })

  // Slice D: start the 1:1 session (confirmed → live). Either party may start; no money moves.
  communities.post("/:communityId/bookings/:bookingId/start", async (c) => {
    const services = routeServices()
    const { actor, communityId, communityRepository } = await services.getResolvedCommunityRouteContext(c)
    const bookingId = c.req.param("bookingId")
    const nowUtc = new Date().toISOString()
    const globalResult = await tryGlobalBookings(c.env, (executor) =>
      services.startGlobalBookingSession({
        executor,
        bookingId,
        actorUserId: actor.userId,
        nowUtc,
      })
    )
    if (globalResult.available) {
      if (globalResult.value.ok) {
        return c.json({ booking: globalResult.value.booking, already_live: globalResult.value.already }, 200)
      }
      return c.json({ error: globalResult.value.reason }, globalResult.value.reason === "not_found" ? 404 : 409)
    }
    const result = await services.startCommunityBookingSession({
      env: c.env, communityRepository, communityId,
      bookingId, actorUserId: actor.userId, nowUtc,
    })
    if (!result.ok) return c.json({ error: result.reason }, result.reason === "not_found" ? 404 : 409)
    return c.json({ booking: result.booking, already_live: result.already }, 200)
  })

  // Slice D: complete a live session (live → completed → settled); pays the host. Host-only.
  communities.post("/:communityId/bookings/:bookingId/complete", async (c) => {
    const services = routeServices()
    const { actor, communityId, communityRepository } = await services.getResolvedCommunityRouteContext(c)
    const bookingId = c.req.param("bookingId")
    const nowUtc = new Date().toISOString()
    const globalResult = await tryGlobalBookings(c.env, (executor) =>
      services.completeGlobalBooking({
        env: c.env,
        executor,
        bookingId,
        actorUserId: actor.userId,
        nowUtc,
      })
    )
    if (globalResult.available) {
      if (globalResult.value.ok) return c.json({ booking: globalResult.value.booking, already_settled: globalResult.value.already }, 200)
      return c.json({ error: globalResult.value.reason }, globalResult.value.reason === "not_found" ? 404 : 409)
    }
    const result = await services.completeCommunityBooking({
      env: c.env, communityRepository, communityId,
      bookingId, actorUserId: actor.userId, nowUtc,
    })
    if (!result.ok) return c.json({ error: result.reason }, result.reason === "not_found" ? 404 : 409)
    return c.json({ booking: result.booking, already_settled: result.already }, 200)
  })

  // Slice D: report a no-show on a live booking. The actor reports the OTHER party absent.
  communities.post("/:communityId/bookings/:bookingId/no-show", async (c) => {
    const services = routeServices()
    const { actor, communityId, communityRepository } = await services.getResolvedCommunityRouteContext(c)
    const bookingId = c.req.param("bookingId")
    const nowUtc = new Date().toISOString()
    const globalResult = await tryGlobalBookings(c.env, (executor) =>
      services.noShowGlobalBooking({
        env: c.env,
        executor,
        bookingId,
        actorUserId: actor.userId,
        nowUtc,
      })
    )
    if (globalResult.available) {
      if (globalResult.value.ok) return c.json({ booking: globalResult.value.booking, already_resolved: globalResult.value.already }, 200)
      return c.json({ error: globalResult.value.reason }, globalResult.value.reason === "not_found" ? 404 : 409)
    }
    const result = await services.noShowCommunityBooking({
      env: c.env, communityRepository, communityId,
      bookingId, actorUserId: actor.userId, nowUtc,
    })
    if (!result.ok) return c.json({ error: result.reason }, result.reason === "not_found" ? 404 : 409)
    return c.json({ booking: result.booking, already_resolved: result.already }, 200)
  })

  communities.post("/:communityId/bookings/:bookingId/settlement-review/resolve", async (c) => {
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

    const communityRepository = getCommunityRepository(c.env)
    const routeCommunityId = c.req.param("communityId")
    const communityId = await resolveCommunityIdentifier(communityRepository, routeCommunityId) ?? routeCommunityId
    const result = await resolveBookingSettlementReview({
      env: c.env,
      communityRepository,
      communityId,
      bookingId: c.req.param("bookingId"),
      resolution: resolution as BookingSettlementReviewResolution,
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

  // Slice D2/D3: attach to the booking's private 1:1 session (host/booker only). Mints an Agora
  // token for the derived channel and opens an attendance session.
  communities.post("/:communityId/bookings/:bookingId/session/attach", async (c) => {
    const services = routeServices()
    const { actor, communityId, communityRepository } = await services.getResolvedCommunityRouteContext(c)
    const bookingId = c.req.param("bookingId")
    const nowUtc = new Date().toISOString()
    const globalResult = await tryGlobalBookings(c.env, (executor) =>
      services.attachGlobalBookingSession({
        env: c.env,
        executor,
        bookingId,
        actorUserId: actor.userId,
        nowUtc,
      })
    )
    if (globalResult.available) {
      if (globalResult.value.ok) {
        return c.json({ session_id: globalResult.value.sessionId, party: globalResult.value.party, channel: globalResult.value.channel, agora: globalResult.value.agora }, 200)
      }
      return c.json({ error: globalResult.value.reason }, globalResult.value.reason === "not_found" ? 404 : 409)
    }
    const result = await services.attachCommunityBookingSession({
      env: c.env, communityRepository, communityId,
      bookingId, actorUserId: actor.userId, nowUtc,
    })
    if (!result.ok) return c.json({ error: result.reason }, result.reason === "not_found" ? 404 : 409)
    return c.json({ session_id: result.sessionId, party: result.party, channel: result.channel, agora: result.agora }, 200)
  })

  // Slice D3: liveness heartbeat for an attendance session (identity-bound to the session owner).
  communities.post("/:communityId/bookings/:bookingId/session/heartbeat", async (c) => {
    const services = routeServices()
    const { actor, communityId, communityRepository } = await services.getResolvedCommunityRouteContext(c)
    const body = await c.req.json<{ session_id?: unknown }>().catch(() => null)
    const sessionId = body && typeof body.session_id === "string" ? body.session_id : ""
    if (!sessionId) return c.json({ error: "invalid_payload" }, 400)
    const bookingId = c.req.param("bookingId")
    const nowUtc = new Date().toISOString()
    const globalResult = await tryGlobalBookings(c.env, (executor) =>
      services.heartbeatGlobalBookingSession({
        executor,
        bookingId,
        actorUserId: actor.userId,
        nowUtc,
        sessionId,
      })
    )
    if (globalResult.available) {
      if (globalResult.value.ok) return c.json({ ok: true }, 200)
      return c.json({ error: globalResult.value.reason }, 404)
    }
    const result = await services.heartbeatCommunityBookingSession({
      env: c.env, communityRepository, communityId,
      bookingId, actorUserId: actor.userId, nowUtc, sessionId,
    })
    if (!result.ok) return c.json({ error: result.reason }, 404)
    return c.json({ ok: true }, 200)
  })
}
