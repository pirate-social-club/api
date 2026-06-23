import type { Hono } from "hono"

import type { AuthenticatedEnv } from "../lib/auth-middleware"
import { resolveBookingAvailability } from "../lib/communities/bookings/booking-availability-service"
import { confirmBookingHold, quoteBookingHold } from "../lib/communities/bookings/booking-confirm-service"
import { createBookingHold } from "../lib/communities/bookings/booking-hold-service"
import { cancelBooking, completeBooking, noShowBooking, startBookingSession } from "../lib/communities/bookings/booking-lifecycle-service"
import { getResolvedCommunityRouteContext, requireJsonBody } from "./communities-route-helpers"

const DEFAULT_WINDOW_DAYS = 14

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
    const result = await quoteBookingHold({
      env: c.env,
      communityRepository,
      communityId,
      holdId: c.req.param("holdId"),
      nowUtc: new Date().toISOString(),
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

    const result = await confirmBookingHold({
      env: c.env,
      communityRepository,
      userRepository,
      communityId,
      holdId: c.req.param("holdId"),
      bookerUserId: actor.userId,
      fundingTxRef: body.funding_tx_ref,
      walletAttachmentId: body.wallet_attachment_id,
      nowUtc: new Date().toISOString(),
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
}
