import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import type { Env } from "../../../src/env"
import type { AuthenticatedEnv } from "../../../src/lib/auth-middleware"
import {
  registerCommunityBookingsRoutes,
  setCommunityBookingsRouteServicesForTests,
  type CommunityBookingsRouteServices,
} from "../../../src/routes/communities-bookings"

const dummyExecutor = {
  execute: async () => ({ rows: [] }),
  transaction: async () => dummyExecutor,
}

const actor = { userId: "usr_actor", authType: "admin", adminOverride: { adminActorId: "admin", scope: "full" } }
const bookingView = {
  object: "booking",
  booking_id: "bkg_global",
  community_id: "cmt_route",
  host_user_id: "usr_host",
  booker_user_id: "usr_actor",
  status: "confirmed",
  viewer_role: "booker",
}

let globalListResult: unknown
let globalGetResult: unknown
let globalQuoteResult: unknown
let globalCancelResult: unknown
let globalResolveResult: unknown
let communityCancelResult: unknown
let throwMissingSchema = false

const calls: Record<string, unknown[]> = {
  globalList: [],
  globalGet: [],
  globalQuote: [],
  globalCancel: [],
  globalResolve: [],
  communityList: [],
  communityGet: [],
  communityQuote: [],
  communityCancel: [],
}

function resetMocks(): void {
  for (const entries of Object.values(calls)) entries.length = 0
  globalListResult = [bookingView]
  globalGetResult = bookingView
  globalQuoteResult = {
    ok: true,
    quote: { hold_id: "hld_global", gross_cents: 5000 },
  }
  globalCancelResult = { ok: true, already: false, cancelledBy: "booker", booking: bookingView }
  globalResolveResult = { ok: true, outcome: "completed", settled: true, underReview: false, pending: false }
  communityCancelResult = { ok: true, already: false, cancelledBy: "booker", booking: bookingView }
  throwMissingSchema = false
}

function missingSchemaIfRequested(): void {
  if (!throwMissingSchema) return
  const error = new Error("relation \"bookings.booking_holds\" does not exist") as Error & { code: string }
  error.code = "42P01"
  throw error
}

function routeServices(): CommunityBookingsRouteServices {
  return {
    getResolvedCommunityRouteContext: async () => ({
      actor,
      communityId: "cmt_route",
      communityRepository: {},
      userRepository: {},
      profileRepository: {},
    }),
    getControlPlaneClient: () => dummyExecutor,
    enrichGlobalBookingCounterparties: async ({ bookings }: { bookings: unknown[] }) => bookings,
    resolveCommunityBookingAvailability: async () => ({ bookable: false }),
    listCommunityBookingsForUser: async (input: unknown) => {
      calls.communityList.push(input)
      return [{ ...bookingView, booking_id: "bkg_legacy" }]
    },
    getCommunityBookingForParty: async (input: unknown) => {
      calls.communityGet.push(input)
      return { ...bookingView, booking_id: "bkg_legacy" }
    },
    createCommunityBookingHold: async () => ({ ok: false, reason: "slot_unavailable" }),
    quoteCommunityBookingHold: async (input: unknown) => {
      calls.communityQuote.push(input)
      return { ok: true, quote: { hold_id: "hld_legacy", gross_cents: 5000 } }
    },
    confirmCommunityBookingHold: async () => ({ ok: false, reason: "hold_not_found" }),
    cancelCommunityBooking: async (input: unknown) => {
      calls.communityCancel.push(input)
      return communityCancelResult
    },
    startCommunityBookingSession: async () => ({ ok: false, reason: "not_found" }),
    completeCommunityBooking: async () => ({ ok: false, reason: "not_found" }),
    noShowCommunityBooking: async () => ({ ok: false, reason: "not_found" }),
    attachCommunityBookingSession: async () => ({ ok: false, reason: "not_found" }),
    heartbeatCommunityBookingSession: async () => ({ ok: false, reason: "not_found" }),
    resolveGlobalBookingAvailability: async () => ({ bookable: false }),
    listGlobalBookingsForUser: async (input: unknown) => {
      missingSchemaIfRequested()
      calls.globalList.push(input)
      return globalListResult
    },
    getGlobalBookingForParty: async (input: unknown) => {
      missingSchemaIfRequested()
      calls.globalGet.push(input)
      return globalGetResult
    },
    createGlobalBookingHold: async () => ({ ok: false, reason: "slot_unavailable" }),
    quoteGlobalBookingHold: async (input: unknown) => {
      missingSchemaIfRequested()
      calls.globalQuote.push(input)
      return globalQuoteResult
    },
    confirmGlobalBookingHold: async () => ({ ok: false, reason: "hold_not_found" }),
    cancelGlobalBooking: async (input: unknown) => {
      missingSchemaIfRequested()
      calls.globalCancel.push(input)
      return globalCancelResult
    },
    startGlobalBookingSession: async () => ({ ok: false, reason: "not_found" }),
    resolveGlobalBookingByParty: async (input: unknown) => {
      calls.globalResolve.push(input)
      return globalResolveResult
    },
    attachGlobalBookingSession: async () => ({ ok: false, reason: "not_found" }),
    heartbeatGlobalBookingSession: async () => ({ ok: false, reason: "not_found" }),
  } as unknown as CommunityBookingsRouteServices
}

beforeEach(() => {
  resetMocks()
  setCommunityBookingsRouteServicesForTests(routeServices())
})

afterEach(() => {
  setCommunityBookingsRouteServicesForTests(null)
})

function loadApp(): Hono<AuthenticatedEnv> {
  const app = new Hono<AuthenticatedEnv>()
  registerCommunityBookingsRoutes(app)
  return app
}

function env(): Env {
  return {
    CONTROL_PLANE_DATABASE_URL: "postgresql://user:pass@example.test/pirate",
  } as Env
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>
}

describe("community booking global routing", () => {
  test("treats an empty global booking list as authoritative", async () => {
    globalListResult = []
    const res = await loadApp().request("http://pirate.test/cmt_route/bookings", {}, env())

    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({ object: "list", data: [], has_more: false })
    expect(calls.globalList).toHaveLength(1)
    expect(calls.communityList).toHaveLength(0)
  })

  test("does not fall back to legacy D1 when global lookup hides a booking", async () => {
    globalGetResult = null
    const res = await loadApp().request("http://pirate.test/cmt_route/bookings/bkg_hidden", {}, env())

    expect(res.status).toBe(404)
    expect(await json(res)).toEqual({ error: "not_found" })
    expect(calls.globalGet).toHaveLength(1)
    expect(calls.communityGet).toHaveLength(0)
  })

  test("does not fall back to legacy D1 when global quote returns hold_not_found", async () => {
    globalQuoteResult = { ok: false, reason: "hold_not_found" }
    const res = await loadApp().request("http://pirate.test/cmt_route/booking-holds/hld_missing/quote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }, env())

    expect(res.status).toBe(404)
    expect(await json(res)).toEqual({ error: "hold_not_found" })
    expect(calls.globalQuote).toHaveLength(1)
    expect(calls.communityQuote).toHaveLength(0)
  })

  test("forwards optional cancellation terms and rejects malformed values", async () => {
    const protectedCancel = await loadApp().request("http://pirate.test/cmt_route/bookings/bkg_global/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expected_refund_cents: 5000 }),
    }, env())
    expect(protectedCancel.status).toBe(200)
    expect(calls.globalCancel[0]).toMatchObject({ expectedRefundCents: 5000 })

    const bodylessCancel = await loadApp().request("http://pirate.test/cmt_route/bookings/bkg_global/cancel", {
      method: "POST",
    }, env())
    expect(bodylessCancel.status).toBe(200)
    expect(calls.globalCancel[1]).toMatchObject({ expectedRefundCents: undefined })

    const malformed = await loadApp().request("http://pirate.test/cmt_route/bookings/bkg_global/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expected_refund_cents: "5000" }),
    }, env())
    expect(malformed.status).toBe(400)
    expect(calls.globalCancel).toHaveLength(2)
  })

  test("keeps the legacy fallback when the global bookings schema is not migrated", async () => {
    throwMissingSchema = true
    const res = await loadApp().request("http://pirate.test/cmt_route/bookings", {}, env())

    expect(res.status).toBe(200)
    expect(await json(res)).toMatchObject({ object: "list", data: [{ booking_id: "bkg_legacy" }] })
    expect(calls.communityList).toHaveLength(1)
  })

  test("preserves cancellation term protection in the legacy fallback", async () => {
    throwMissingSchema = true
    communityCancelResult = {
      ok: false,
      reason: "cancellation_terms_changed",
      preview: { object: "booking_cancellation_preview", booking_id: "bkg_legacy", refund_cents: 0 },
    }
    const res = await loadApp().request("http://pirate.test/cmt_route/bookings/bkg_legacy/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expected_refund_cents: 5000 }),
    }, env())
    expect(res.status).toBe(409)
    expect(await json(res)).toMatchObject({ error: "cancellation_terms_changed", preview: { refund_cents: 0 } })
    expect(calls.communityCancel[0]).toMatchObject({ expectedRefundCents: 5000 })
  })

  test("uses attendance-decided settlement for both legacy outcome labels", async () => {
    for (const action of ["complete", "no-show"]) {
      const res = await loadApp().request(`http://pirate.test/cmt_route/bookings/bkg_global/${action}`, {
        method: "POST",
      }, env())

      expect(res.status).toBe(200)
      expect(await json(res)).toMatchObject({
        booking: { booking_id: "bkg_global" },
        outcome: "completed",
        settled: true,
        under_review: false,
        settlement_pending: false,
      })
    }

    expect(calls.globalResolve).toHaveLength(2)
    expect(calls.globalResolve[0]).toMatchObject({ bookingId: "bkg_global", actorUserId: "usr_actor" })
    expect(calls.globalResolve[1]).toMatchObject({ bookingId: "bkg_global", actorUserId: "usr_actor" })
  })

  test("blocks premature compatibility settlement and reports pending effects", async () => {
    globalResolveResult = { ok: false, reason: "session_not_ended" }
    const early = await loadApp().request("http://pirate.test/cmt_route/bookings/bkg_global/complete", {
      method: "POST",
    }, env())
    expect(early.status).toBe(409)
    expect(await json(early)).toEqual({ error: "session_not_ended" })

    globalResolveResult = { ok: true, outcome: "settling", settled: true, underReview: false, pending: true }
    const pending = await loadApp().request("http://pirate.test/cmt_route/bookings/bkg_global/no-show", {
      method: "POST",
    }, env())
    expect(pending.status).toBe(202)
    expect(await json(pending)).toMatchObject({ settlement_pending: true, outcome: "settling" })
  })
})
