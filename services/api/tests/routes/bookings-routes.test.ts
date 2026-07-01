import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import type { Env } from "../../src/env"
import type { AuthenticatedEnv } from "../../src/lib/auth-middleware"
import { errorResponse } from "../../src/lib/errors"
import bookings, {
  setGlobalBookingRouteServicesForTests,
  type GlobalBookingRouteServices,
} from "../../src/routes/bookings"

const dummyExecutor = {
  execute: async () => ({ rows: [] }),
  transaction: async () => dummyExecutor,
}

const dummyUserRepository = {
  getWalletAttachmentsByUserId: async () => [],
}

const bookingView = {
  object: "booking",
  booking_id: "bkg_route",
  community_id: "cmt_source",
  host_user_id: "host_route",
  booker_user_id: "actor_route",
  slot_start_utc: "2026-07-01T10:00:00.000Z",
  slot_end_utc: "2026-07-01T10:30:00.000Z",
  gross_cents: 5000,
  platform_fee_cents: 500,
  host_payout_cents: 4500,
  refund_cents: null,
  status: "confirmed",
  funding_tx_ref: "0xfunding",
  payout_tx_ref: null,
  refund_tx_ref: null,
  live_room_id: null,
  confirmed_at: "2026-07-01T09:00:00.000Z",
  completed_at: null,
  settled_at: null,
  cancelled_at: null,
  created_at: "2026-06-30T12:00:00.000Z",
  updated_at: "2026-06-30T12:00:00.000Z",
  viewer_role: "booker",
}

const bookingSnapshot = {
  booking_id: "bkg_route",
  hold_id: "hld_route",
  host_user_id: "host_route",
  booker_user_id: "actor_route",
  slot_start_utc: "2026-07-01T10:00:00.000Z",
  slot_end_utc: "2026-07-01T10:30:00.000Z",
  gross_cents: 5000,
  platform_fee_cents: 500,
  host_payout_cents: 4500,
  status: "confirmed",
  funding_tx_ref: "0xfunding",
}

const lifecycleSnapshot = {
  booking_id: "bkg_route",
  status: "live",
  refund_cents: 0,
  refund_tx_ref: null,
  payout_tx_ref: null,
}

let availabilityResult: unknown
let createHoldResult: unknown
let quoteResult: unknown
let confirmResult: unknown
let getBookingResult: unknown
let cancelResult: unknown
let startResult: unknown
let completeResult: unknown
let noShowResult: unknown
let resolveByPartyResult: unknown
let attachResult: unknown
let heartbeatResult: unknown

const calls: Record<string, unknown[]> = {
  listBookings: [],
  availability: [],
  createHold: [],
  quote: [],
  confirm: [],
  getBooking: [],
  cancel: [],
  start: [],
  complete: [],
  noShow: [],
  resolveByParty: [],
  attach: [],
  heartbeat: [],
}

function resetMocks(): void {
  for (const entries of Object.values(calls)) entries.length = 0
  availabilityResult = {
    bookable: true,
    hostTimezone: "Europe/Vienna",
    viewerTimezone: "America/New_York",
    slots: [{
      startUtc: "2026-07-01T10:00:00.000Z",
      endUtc: "2026-07-01T10:30:00.000Z",
      priceCents: 5000,
      available: true,
    }],
  }
  createHoldResult = {
    ok: true,
    hold: {
      hold_id: "hld_route",
      community_id: "cmt_source",
      host_user_id: "host_route",
      booker_user_id: "actor_route",
      slot_start_utc: "2026-07-01T10:00:00.000Z",
      slot_end_utc: "2026-07-01T10:30:00.000Z",
      price_cents: 5000,
      status: "active",
      expires_at_utc: "2026-07-01T09:10:00.000Z",
    },
  }
  quoteResult = {
    ok: true,
    quote: {
      hold_id: "hld_route",
      gross_cents: 5000,
      platform_fee_bps: 1000,
      platform_fee_cents: 500,
      host_payout_cents: 4500,
      expires_at_utc: "2026-07-01T09:10:00.000Z",
      payment: {
        payment_intent_id: "pi_route",
        version: 1,
        chain_id: 84532,
        token_address: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
        token_decimals: 6,
        token_symbol: "USDC",
        recipient_address: "0x1111111111111111111111111111111111111111",
        amount_atomic: "50000000",
        gross_cents: 5000,
        quote_expires_at: "2026-07-01T09:10:00.000Z",
        hold_expires_at: "2026-07-01T09:10:00.000Z",
        wallet_attachment_required: true,
      },
    },
  }
  confirmResult = { ok: true, already: false, booking: bookingSnapshot }
  getBookingResult = bookingView
  cancelResult = { ok: true, already: false, cancelledBy: "booker", booking: lifecycleSnapshot }
  startResult = { ok: true, already: false, booking: lifecycleSnapshot }
  completeResult = { ok: true, already: false, booking: { ...lifecycleSnapshot, status: "settled" } }
  noShowResult = { ok: true, already: false, booking: { ...lifecycleSnapshot, status: "refunded" } }
  resolveByPartyResult = { ok: true, outcome: "completed", settled: true, underReview: false, pending: false }
  attachResult = {
    ok: true,
    party: "booker",
    sessionId: "bas_route",
    channel: "pirate-booking-bkg_route",
    agora: {
      app_id: null,
      channel: "pirate-booking-bkg_route",
      uid: 42,
      token: null,
      token_expires_at: null,
      configured: false,
    },
  }
  heartbeatResult = { ok: true }
}

function routeServices(): GlobalBookingRouteServices {
  return {
    getControlPlaneClient: () => dummyExecutor,
    getUserRepository: () => dummyUserRepository,
    getGlobalBookingForParty: async (input: unknown) => {
      calls.getBooking.push(input)
      return getBookingResult
    },
    listGlobalBookingsForUser: async (input: unknown) => {
      calls.listBookings.push(input)
      return [bookingView]
    },
    createGlobalBookingHold: async (input: unknown) => {
      calls.createHold.push(input)
      return createHoldResult
    },
    resolveGlobalBookingAvailability: async (input: unknown) => {
      calls.availability.push(input)
      return availabilityResult
    },
    confirmGlobalBookingHold: async (input: unknown) => {
      calls.confirm.push(input)
      return confirmResult
    },
    quoteGlobalBookingHold: async (input: unknown) => {
      calls.quote.push(input)
      return quoteResult
    },
    attachGlobalBookingSession: async (input: unknown) => {
      calls.attach.push(input)
      return attachResult
    },
    cancelGlobalBooking: async (input: unknown) => {
      calls.cancel.push(input)
      return cancelResult
    },
    completeGlobalBooking: async (input: unknown) => {
      calls.complete.push(input)
      return completeResult
    },
    heartbeatGlobalBookingSession: async (input: unknown) => {
      calls.heartbeat.push(input)
      return heartbeatResult
    },
    noShowGlobalBooking: async (input: unknown) => {
      calls.noShow.push(input)
      return noShowResult
    },
    resolveGlobalBookingByParty: async (input: unknown) => {
      calls.resolveByParty.push(input)
      return resolveByPartyResult
    },
    startGlobalBookingSession: async (input: unknown) => {
      calls.start.push(input)
      return startResult
    },
  } as unknown as GlobalBookingRouteServices
}

beforeEach(() => {
  resetMocks()
  setGlobalBookingRouteServicesForTests(routeServices())
})

afterEach(() => {
  setGlobalBookingRouteServicesForTests(null)
})

function loadApp(): Hono<AuthenticatedEnv> {
  const app = new Hono<AuthenticatedEnv>()
  app.route("/bookings", bookings)
  app.onError((error) => {
    const response = errorResponse(error)
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { "content-type": "application/json" },
    })
  })
  return app
}

function env(): Env {
  return { PIRATE_ADMIN_TOKEN: "admin-token" } as Env
}

function adminHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "x-admin-token": "admin-token",
    "x-admin-as-user-id": "actor_route",
    ...extra,
  }
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>
}

describe("/bookings routes", () => {
  test("rejects unauthenticated requests", async () => {
    const app = loadApp()
    const res = await app.request("http://pirate.test/bookings", {}, env())
    expect(res.status).toBe(401)
  })

  test("lists bookings with normalized role, statuses, and source community filters", async () => {
    const app = loadApp()
    const res = await app.request(
      "http://pirate.test/bookings?role=host&status=confirmed, live,,&source_community_id=cmt_source",
      { headers: adminHeaders() },
      env(),
    )

    expect(res.status).toBe(200)
    expect(await json(res)).toMatchObject({ object: "list", data: [bookingView], has_more: false })
    expect(calls.listBookings).toHaveLength(1)
    expect(calls.listBookings[0]).toMatchObject({
      executor: dummyExecutor,
      actorUserId: "actor_route",
      role: "host",
      sourceCommunityId: "cmt_source",
      statuses: ["confirmed", "live"],
    })
  })

  test("resolves slots through the canonical host route and compatibility alias", async () => {
    const app = loadApp()
    const first = await app.request(
      "http://pirate.test/bookings/hosts/host_route/slots?from=2026-07-01T10:00:00.000Z&to=2026-07-01T12:00:00.000Z&tz=America/New_York",
      { headers: adminHeaders() },
      env(),
    )
    const alias = await app.request(
      "http://pirate.test/bookings/booking-hosts/host_route/slots?from=2026-07-01T10:00:00.000Z&to=2026-07-01T12:00:00.000Z&tz=America/New_York",
      { headers: adminHeaders() },
      env(),
    )

    expect(first.status).toBe(200)
    expect(alias.status).toBe(200)
    expect(calls.availability).toHaveLength(2)
    expect(calls.availability[0]).toMatchObject({
      executor: dummyExecutor,
      hostUserId: "host_route",
      windowStartUtc: "2026-07-01T10:00:00.000Z",
      windowEndUtc: "2026-07-01T12:00:00.000Z",
      viewerTimezone: "America/New_York",
    })
  })

  test("allows unauthenticated read-only slot discovery", async () => {
    const app = loadApp()
    const res = await app.request(
      "http://pirate.test/bookings/hosts/host_route/slots?from=2026-07-01T10:00:00.000Z&to=2026-07-01T12:00:00.000Z&tz=America/New_York",
      {},
      env(),
    )

    expect(res.status).toBe(200)
    expect(calls.availability).toHaveLength(1)
    expect(calls.availability[0]).toMatchObject({
      executor: dummyExecutor,
      hostUserId: "host_route",
      windowStartUtc: "2026-07-01T10:00:00.000Z",
      windowEndUtc: "2026-07-01T12:00:00.000Z",
      viewerTimezone: "America/New_York",
    })
  })

  test("normalizes public profile user ids for slot discovery", async () => {
    const app = loadApp()
    const res = await app.request(
      "http://pirate.test/bookings/hosts/usr_host_route/slots?from=2026-07-01T10:00:00.000Z&to=2026-07-01T12:00:00.000Z&tz=America/New_York",
      {},
      env(),
    )

    expect(res.status).toBe(200)
    expect(calls.availability).toHaveLength(1)
    expect(calls.availability[0]).toMatchObject({
      hostUserId: "host_route",
    })
  })

  test("keeps unauthenticated hold creation blocked", async () => {
    const app = loadApp()
    const res = await app.request("http://pirate.test/bookings/hosts/host_route/holds", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        slot_start_utc: "2026-07-01T10:00:00.000Z",
        slot_end_utc: "2026-07-01T10:30:00.000Z",
      }),
    }, env())

    expect(res.status).toBe(401)
    expect(calls.createHold).toHaveLength(0)
  })

  test("normalizes public profile user ids for hold creation", async () => {
    const app = loadApp()
    const res = await app.request("http://pirate.test/bookings/hosts/usr_host_route/holds", {
      method: "POST",
      headers: adminHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({
        slot_start_utc: "2026-07-01T10:00:00.000Z",
        slot_end_utc: "2026-07-01T10:30:00.000Z",
      }),
    }, env())

    expect(res.status).toBe(201)
    expect(calls.createHold).toHaveLength(1)
    expect(calls.createHold[0]).toMatchObject({
      hostUserId: "host_route",
    })
  })

  test("creates holds with optional source community metadata", async () => {
    const app = loadApp()
    const res = await app.request("http://pirate.test/bookings/hosts/host_route/holds", {
      method: "POST",
      headers: adminHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({
        slot_start_utc: "2026-07-01T10:00:00.000Z",
        slot_end_utc: "2026-07-01T10:30:00.000Z",
        source_community_id: " cmt_source ",
      }),
    }, env())

    expect(res.status).toBe(201)
    expect(await json(res)).toMatchObject({ hold: { hold_id: "hld_route", community_id: "cmt_source" } })
    expect(calls.createHold).toHaveLength(1)
    expect(calls.createHold[0]).toMatchObject({
      client: dummyExecutor,
      hostUserId: "host_route",
      bookerUserId: "actor_route",
      sourceCommunityId: "cmt_source",
      slotStartUtc: "2026-07-01T10:00:00.000Z",
      slotEndUtc: "2026-07-01T10:30:00.000Z",
    })
  })

  test("maps quote not-found and conflict responses to route statuses", async () => {
    const app = loadApp()

    quoteResult = { ok: false, reason: "hold_not_found" }
    const missing = await app.request("http://pirate.test/bookings/holds/hld_missing/quote", {
      method: "POST",
      headers: adminHeaders({ "content-type": "application/json" }),
      body: "{}",
    }, env())
    expect(missing.status).toBe(404)
    expect(await json(missing)).toMatchObject({ error: "hold_not_found" })

    quoteResult = { ok: false, reason: "hold_expired" }
    const expired = await app.request("http://pirate.test/bookings/booking-holds/hld_route/quote", {
      method: "POST",
      headers: adminHeaders({ "content-type": "application/json" }),
      body: "{}",
    }, env())
    expect(expired.status).toBe(409)
    expect(await json(expired)).toMatchObject({ error: "hold_expired" })
  })

  test("confirms holds with funding data and the user repository dependency", async () => {
    const app = loadApp()
    const res = await app.request("http://pirate.test/bookings/holds/hld_route/confirm", {
      method: "POST",
      headers: adminHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({
        funding_tx_ref: "0xfunding",
        wallet_attachment_id: "wal_route",
      }),
    }, env())

    expect(res.status).toBe(201)
    expect(await json(res)).toMatchObject({ booking: bookingSnapshot, already_confirmed: false })
    expect(calls.confirm).toHaveLength(1)
    expect(calls.confirm[0]).toMatchObject({
      executor: dummyExecutor,
      userRepository: dummyUserRepository,
      holdId: "hld_route",
      bookerUserId: "actor_route",
      fundingTxRef: "0xfunding",
      walletAttachmentId: "wal_route",
    })
  })

  test("reads booking details and maps hidden bookings to 404", async () => {
    const app = loadApp()
    const found = await app.request("http://pirate.test/bookings/bkg_route", {
      headers: adminHeaders(),
    }, env())
    expect(found.status).toBe(200)
    expect(await json(found)).toMatchObject({ booking: bookingView })

    getBookingResult = null
    const missing = await app.request("http://pirate.test/bookings/bkg_hidden", {
      headers: adminHeaders(),
    }, env())
    expect(missing.status).toBe(404)
    expect(await json(missing)).toMatchObject({ error: "not_found" })
  })

  test("wires cancel/start to their matching global services", async () => {
    const app = loadApp()
    const routeCases = [
      ["cancel", calls.cancel],
      ["start", calls.start],
    ] as const

    for (const [action, callLog] of routeCases) {
      const res = await app.request(`http://pirate.test/bookings/bkg_route/${action}`, {
        method: "POST",
        headers: adminHeaders({ "content-type": "application/json" }),
        body: "{}",
      }, env())
      expect(res.status).toBe(200)
      expect(callLog).toHaveLength(1)
      expect(callLog[0]).toMatchObject({
        executor: dummyExecutor,
        bookingId: "bkg_route",
        actorUserId: "actor_route",
      })
    }
  })

  test("routes /complete and /no-show through attendance-based settlement, not party claims", async () => {
    const app = loadApp()
    for (const action of ["complete", "no-show"] as const) {
      const res = await app.request(`http://pirate.test/bookings/bkg_route/${action}`, {
        method: "POST",
        headers: adminHeaders({ "content-type": "application/json" }),
        body: "{}",
      }, env())
      expect(res.status).toBe(200)
      expect(await json(res)).toMatchObject({ outcome: "completed", settled: true, under_review: false })
    }
    // Both endpoints funnel into the single attendance evaluator; the self-attested complete/no-show
    // services are no longer reachable from the routes.
    expect(calls.resolveByParty).toHaveLength(2)
    expect(calls.complete).toHaveLength(0)
    expect(calls.noShow).toHaveLength(0)
    expect(calls.resolveByParty[0]).toMatchObject({ bookingId: "bkg_route", actorUserId: "actor_route" })
  })

  test("returns 202 when attendance settlement is pending on-chain", async () => {
    const app = loadApp()
    resolveByPartyResult = { ok: true, outcome: "completed", settled: true, underReview: false, pending: true }
    const res = await app.request("http://pirate.test/bookings/bkg_route/complete", {
      method: "POST",
      headers: adminHeaders({ "content-type": "application/json" }),
      body: "{}",
    }, env())
    expect(res.status).toBe(202)
    expect(await json(res)).toMatchObject({ settlement_pending: true })
  })

  test("maps session_not_ended to 409 (no premature settlement)", async () => {
    const app = loadApp()
    resolveByPartyResult = { ok: false, reason: "session_not_ended" }
    const res = await app.request("http://pirate.test/bookings/bkg_route/no-show", {
      method: "POST",
      headers: adminHeaders({ "content-type": "application/json" }),
      body: "{}",
    }, env())
    expect(res.status).toBe(409)
    expect(await json(res)).toMatchObject({ error: "session_not_ended" })
  })

  test("attaches and heartbeats booking sessions", async () => {
    const app = loadApp()
    const attached = await app.request("http://pirate.test/bookings/bkg_route/session/attach", {
      method: "POST",
      headers: adminHeaders({ "content-type": "application/json" }),
      body: "{}",
    }, env())
    expect(attached.status).toBe(200)
    expect(await json(attached)).toMatchObject({ session_id: "bas_route", party: "booker" })
    expect(calls.attach).toHaveLength(1)

    const invalidHeartbeat = await app.request("http://pirate.test/bookings/bkg_route/session/heartbeat", {
      method: "POST",
      headers: adminHeaders({ "content-type": "application/json" }),
      body: "{}",
    }, env())
    expect(invalidHeartbeat.status).toBe(400)
    expect(await json(invalidHeartbeat)).toMatchObject({ error: "invalid_payload" })

    const heartbeat = await app.request("http://pirate.test/bookings/bkg_route/session/heartbeat", {
      method: "POST",
      headers: adminHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ session_id: "bas_route" }),
    }, env())
    expect(heartbeat.status).toBe(200)
    expect(await json(heartbeat)).toMatchObject({ ok: true })
    expect(calls.heartbeat[0]).toMatchObject({
      executor: dummyExecutor,
      bookingId: "bkg_route",
      actorUserId: "actor_route",
      sessionId: "bas_route",
    })
  })
})
