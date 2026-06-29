import type { Hono } from "hono"

import type { AuthenticatedEnv } from "../lib/auth-middleware"
import { resolveBookingAvailability } from "../lib/communities/bookings/booking-availability-service"
import { confirmBookingHold, quoteBookingHold } from "../lib/communities/bookings/booking-confirm-service"
import { createBookingHold } from "../lib/communities/bookings/booking-hold-service"
import { cancelBooking, completeBooking, noShowBooking, startBookingSession } from "../lib/communities/bookings/booking-lifecycle-service"
import { attachBookingSession, heartbeatBookingSession } from "../lib/communities/bookings/booking-session-service"
import { getBookingForParty, listBookingsForUser, type BookingViewerRole } from "../lib/communities/bookings/booking-read-service"
import { confirmGlobalBookingHold, quoteGlobalBookingHold } from "../lib/bookings/booking-confirm-service"
import { getControlPlaneClient } from "../lib/runtime-deps"
import { getResolvedCommunityRouteContext, requireJsonBody } from "./communities-route-helpers"

const DEFAULT_WINDOW_DAYS = 14

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

export function registerCommunityBookingsRoutes(communities: Hono<AuthenticatedEnv>): void {
  // Read-only availability for a host within a community (Slice A): resolves the host's
  // published profile + availability rules/exceptions/pricing (control-plane) against the
  // community's active holds/bookings (per-community D1) via @pirate/bookings-domain.
  // No hold creation, quote, settlement, or video session here.
  communities.get("/:communityId/booking-hosts/:hostUserId/slots", async (c) => {
    const { communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const hostUserId = c.req.param("hostUserId")

    const url = new URL(c.req.url)
    const nowUtc = new Date().toISOString()
    const windowStartUtc = url.searchParams.get("from") ?? nowUtc
    const windowEndUtc = url.searchParams.get("to")
      ?? new Date(Date.parse(nowUtc) + DEFAULT_WINDOW_DAYS * 86400_000).toISOString()
    const viewerTimezone = url.searchParams.get("tz") ?? "UTC"

    const result = await resolveBookingAvailability({
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
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const url = new URL(c.req.url)
    const role: BookingViewerRole = url.searchParams.get("role") === "host" ? "host" : "booker"
    const statusParam = url.searchParams.get("status")
    const statuses = statusParam ? statusParam.split(",").map((s) => s.trim()).filter(Boolean) : undefined
    const data = await listBookingsForUser({ env: c.env, communityRepository, communityId, actorUserId: actor.userId, role, statuses })
    return c.json({ object: "list", data, has_more: false }, 200)
  })

  // Read: retrieve a single booking — only if the caller is a party (host or booker), else 404.
  communities.get("/:communityId/bookings/:bookingId", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const booking = await getBookingForParty({ env: c.env, communityRepository, communityId, bookingId: c.req.param("bookingId"), actorUserId: actor.userId })
    if (!booking) return c.json({ error: "not_found" }, 404)
    return c.json({ booking }, 200)
  })

  // Slice B: create a short-lived hold on a slot. Acquires the cross-community control-plane
  // lock first, then inserts the per-community hold; releases the lock if the D1 insert fails.
  // No quote / settlement / video session here (that is Slice C).
  communities.post("/:communityId/booking-hosts/:hostUserId/holds", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const hostUserId = c.req.param("hostUserId")
    const body = await requireJsonBody<{ slot_start_utc?: string; slot_end_utc?: string }>(
      c,
      "slot_start_utc and slot_end_utc are required",
    )
    if (!body.slot_start_utc || !body.slot_end_utc) {
      return c.json({ error: "slot_start_utc and slot_end_utc are required" }, 400)
    }

    const result = await createBookingHold({
      env: c.env,
      communityRepository,
      communityId,
      hostUserId,
      bookerUserId: actor.userId,
      slotStartUtc: body.slot_start_utc,
      slotEndUtc: body.slot_end_utc,
      nowUtc: new Date().toISOString(),
    })

    if (!result.ok) {
      const status = result.reason === "hold_insert_failed" ? 500 : 409
      return c.json({ error: result.reason }, status)
    }
    return c.json({ hold: result.hold }, 201)
  })

  // Slice C: immutable quote preview derived from the hold's price snapshot (no quote table).
  communities.post("/:communityId/booking-holds/:holdId/quote", async (c) => {
    const { communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const holdId = c.req.param("holdId")
    const nowUtc = new Date().toISOString()
    try {
      const globalResult = await quoteGlobalBookingHold({
        env: c.env,
        executor: getControlPlaneClient(c.env),
        holdId,
        nowUtc,
      })
      if (globalResult.ok) {
        return c.json({ quote: globalResult.quote }, 200)
      }
      if (globalResult.reason !== "hold_not_found") {
        return c.json({ error: globalResult.reason }, 409)
      }
    } catch (error) {
      if (!isMissingGlobalBookingsSchema(error)) throw error
    }
    const result = await quoteBookingHold({
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
    const { actor, communityId, communityRepository, userRepository } = await getResolvedCommunityRouteContext(c)
    const body = await requireJsonBody<{ funding_tx_ref?: string; wallet_attachment_id?: string }>(
      c,
      "funding_tx_ref and wallet_attachment_id are required",
    )
    if (!body.funding_tx_ref || !body.wallet_attachment_id) {
      return c.json({ error: "funding_tx_ref and wallet_attachment_id are required" }, 400)
    }

    const holdId = c.req.param("holdId")
    const nowUtc = new Date().toISOString()
    try {
      const globalResult = await confirmGlobalBookingHold({
        env: c.env,
        executor: getControlPlaneClient(c.env),
        userRepository,
        holdId,
        bookerUserId: actor.userId,
        fundingTxRef: body.funding_tx_ref,
        walletAttachmentId: body.wallet_attachment_id,
        nowUtc,
      })
      if (globalResult.ok) {
        return c.json({ booking: globalResult.booking, already_confirmed: globalResult.already }, globalResult.already ? 200 : 201)
      }
      if (globalResult.reason !== "hold_not_found") {
        return c.json({ error: globalResult.reason }, 409)
      }
    } catch (error) {
      if (!isMissingGlobalBookingsSchema(error)) throw error
    }

    const result = await confirmBookingHold({
      env: c.env,
      communityRepository,
      userRepository,
      communityId,
      holdId,
      bookerUserId: actor.userId,
      fundingTxRef: body.funding_tx_ref,
      walletAttachmentId: body.wallet_attachment_id,
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
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const result = await cancelBooking({
      env: c.env,
      communityRepository,
      communityId,
      bookingId: c.req.param("bookingId"),
      actorUserId: actor.userId,
      nowUtc: new Date().toISOString(),
    })
    if (!result.ok) {
      return c.json({ error: result.reason }, result.reason === "not_found" ? 404 : 409)
    }
    return c.json({ booking: result.booking, cancelled_by: result.cancelledBy, already_cancelled: result.already }, 200)
  })

  // Slice D: start the 1:1 session (confirmed → live). Either party may start; no money moves.
  communities.post("/:communityId/bookings/:bookingId/start", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const result = await startBookingSession({
      env: c.env, communityRepository, communityId,
      bookingId: c.req.param("bookingId"), actorUserId: actor.userId, nowUtc: new Date().toISOString(),
    })
    if (!result.ok) return c.json({ error: result.reason }, result.reason === "not_found" ? 404 : 409)
    return c.json({ booking: result.booking, already_live: result.already }, 200)
  })

  // Slice D: complete a live session (live → completed → settled); pays the host. Host-only.
  communities.post("/:communityId/bookings/:bookingId/complete", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const result = await completeBooking({
      env: c.env, communityRepository, communityId,
      bookingId: c.req.param("bookingId"), actorUserId: actor.userId, nowUtc: new Date().toISOString(),
    })
    if (!result.ok) return c.json({ error: result.reason }, result.reason === "not_found" ? 404 : 409)
    return c.json({ booking: result.booking, already_settled: result.already }, 200)
  })

  // Slice D: report a no-show on a live booking. The actor reports the OTHER party absent.
  communities.post("/:communityId/bookings/:bookingId/no-show", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const result = await noShowBooking({
      env: c.env, communityRepository, communityId,
      bookingId: c.req.param("bookingId"), actorUserId: actor.userId, nowUtc: new Date().toISOString(),
    })
    if (!result.ok) return c.json({ error: result.reason }, result.reason === "not_found" ? 404 : 409)
    return c.json({ booking: result.booking, already_resolved: result.already }, 200)
  })

  // Slice D2/D3: attach to the booking's private 1:1 session (host/booker only). Mints an Agora
  // token for the derived channel and opens an attendance session.
  communities.post("/:communityId/bookings/:bookingId/session/attach", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const result = await attachBookingSession({
      env: c.env, communityRepository, communityId,
      bookingId: c.req.param("bookingId"), actorUserId: actor.userId, nowUtc: new Date().toISOString(),
    })
    if (!result.ok) return c.json({ error: result.reason }, result.reason === "not_found" ? 404 : 409)
    return c.json({ session_id: result.sessionId, party: result.party, channel: result.channel, agora: result.agora }, 200)
  })

  // Slice D3: liveness heartbeat for an attendance session (identity-bound to the session owner).
  communities.post("/:communityId/bookings/:bookingId/session/heartbeat", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const body = await c.req.json<{ session_id?: unknown }>().catch(() => null)
    const sessionId = body && typeof body.session_id === "string" ? body.session_id : ""
    if (!sessionId) return c.json({ error: "invalid_payload" }, 400)
    const result = await heartbeatBookingSession({
      env: c.env, communityRepository, communityId,
      bookingId: c.req.param("bookingId"), actorUserId: actor.userId, nowUtc: new Date().toISOString(), sessionId,
    })
    if (!result.ok) return c.json({ error: result.reason }, 404)
    return c.json({ ok: true }, 200)
  })
}
