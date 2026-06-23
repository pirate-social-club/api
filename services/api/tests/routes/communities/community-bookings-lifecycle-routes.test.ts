import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { createClient } from "@libsql/client"

// The cancel flow does several sequential writes per test; the local SQLite-file harness contends
// (libsql SQLITE_BUSY backoff) enough to exceed the 5s default. Prod community DBs are D1, not
// contended files — this is a test-harness timing allowance, not a logic delay.
setDefaultTimeout(20_000)

import { app } from "../../../src/index"
import { setBookingOperatorEffectExecutorForTests, type OperatorEffect } from "../../../src/lib/communities/bookings/booking-lifecycle-service"
import { buildLocalCommunityDbUrl } from "../../../src/lib/communities/community-local-db"
import { createRouteTestContext, json, resetRuntimeCaches } from "../../helpers"
import { addCommunityMember, completeUniqueHumanVerification, exchangeJwt, requestJson } from "./community-routes-test-helpers"

type Ctx = Awaited<ReturnType<typeof createRouteTestContext>>
type Client = Ctx["client"]

let cleanup: (() => Promise<void>) | null = null
let opEffects: OperatorEffect[] = [] // UNIQUE executions only
let executedKeys: Map<string, string> // idempotencyKey → txRef (models the durable custody ledger)
beforeEach(() => {
  resetRuntimeCaches()
  opEffects = []
  executedKeys = new Map()
  // An idempotent custody adapter: a repeated idempotencyKey returns the existing tx rather than
  // transferring again — so a retry after a crash never double-spends.
  setBookingOperatorEffectExecutorForTests(async (_ctx, effect) => {
    const existing = executedKeys.get(effect.idempotencyKey)
    if (existing) return { txRef: existing }
    const txRef = `op_${effect.idempotencyKey}`
    executedKeys.set(effect.idempotencyKey, txRef)
    opEffects.push(effect)
    return { txRef }
  })
})
afterEach(async () => {
  setBookingOperatorEffectExecutorForTests(null)
  if (cleanup) { await cleanup(); cleanup = null }
})

function hoursFromNow(h: number): string {
  return new Date(Date.now() + h * 3600_000).toISOString()
}

async function createTestCommunity(env: Ctx["env"], accessToken: string): Promise<string> {
  const response = await requestJson("http://pirate.test/communities", {
    display_name: "Lifecycle Test Community",
    membership_mode: "request",
    handle_policy: { policy_template: "standard" },
  }, env, accessToken)
  expect(response.status).toBe(202)
  return (await json(response) as { community: { id: string } }).community.id.replace(/^com_/, "")
}

async function seedConfirmedBooking(communityDbRoot: string, communityId: string, opts: {
  bookingId: string; hostUserId: string; bookerUserId: string
  slotStartUtc: string; slotEndUtc: string; status?: string; refundCents?: number | null
}): Promise<void> {
  const c = createClient({ url: buildLocalCommunityDbUrl(communityDbRoot, communityId) })
  try {
    const now = new Date().toISOString()
    await c.execute({
      sql: `INSERT INTO bookings (
              booking_id, community_id, hold_id, host_user_id, booker_user_id, slot_start_utc, slot_end_utc,
              gross_cents, platform_fee_bps, platform_fee_cents, host_payout_cents, status, refund_cents,
              funding_tx_ref, funding_wallet_address, host_payout_wallet_address, created_at, updated_at
            ) VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?6, 5000, 1000, 500, 4500, ?7, ?8,
              '0xfunded', '0x0000000000000000000000000000000000000b0c', '0x0000000000000000000000000000000000000a11', ?9, ?9)`,
      args: [opts.bookingId, communityId, opts.hostUserId, opts.bookerUserId, opts.slotStartUtc, opts.slotEndUtc, opts.status ?? "confirmed", opts.refundCents ?? null, now],
    })
  } finally {
    c.close()
  }
}

async function seedHostProfile(client: Client, hostUserId: string): Promise<void> {
  const now = new Date().toISOString()
  await client.execute({
    sql: `INSERT INTO booking_profiles (
            host_user_id, display_headline, bio, topics_json, intro_video_ref,
            host_timezone, base_price_cents, default_slot_duration_seconds,
            platform_fee_bps, is_published, created_at, updated_at
          ) VALUES (?1, NULL, NULL, NULL, NULL, 'UTC', 5000, 1800, 1000, 1, ?2, ?2)`,
    args: [hostUserId, now],
  })
}

async function seedActiveBookingLock(client: Client, opts: {
  lockId: string; hostUserId: string; slotStartUtc: string; slotEndUtc: string; communityId: string; bookingId: string
}): Promise<void> {
  const now = new Date().toISOString()
  await client.execute({
    sql: `INSERT INTO booking_host_slot_locks (
            lock_id, host_user_id, slot_start_utc, slot_end_utc, community_id, hold_id, booking_id,
            status, expires_at_utc, created_at, updated_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, 'active', NULL, ?7, ?7)`,
    args: [opts.lockId, opts.hostUserId, opts.slotStartUtc, opts.slotEndUtc, opts.communityId, opts.bookingId, now],
  })
}

async function communityScalar(communityDbRoot: string, communityId: string, sql: string, args: unknown[]): Promise<unknown> {
  const c = createClient({ url: buildLocalCommunityDbUrl(communityDbRoot, communityId) })
  try {
    const r = await c.execute({ sql, args: args as never })
    return r.rows[0] ? Object.values(r.rows[0])[0] : undefined
  } finally {
    c.close()
  }
}

async function lockStatus(client: Client, bookingId: string): Promise<string | undefined> {
  const r = await client.execute({ sql: `SELECT status FROM booking_host_slot_locks WHERE booking_id = ?1`, args: [bookingId] })
  return r.rows[0] ? String(r.rows[0].status) : undefined
}

async function postAction(action: string, env: Ctx["env"], communityId: string, bookingId: string, token: string) {
  return app.request(
    `http://pirate.test/communities/${communityId}/bookings/${bookingId}/${action}`,
    { method: "POST", headers: { authorization: `Bearer ${token}` } },
    env,
  )
}
const postCancel = (env: Ctx["env"], communityId: string, bookingId: string, token: string) => postAction("cancel", env, communityId, bookingId, token)

async function setup(): Promise<{ ctx: Ctx; communityId: string; host: { accessToken: string; userId: string }; booker: { accessToken: string; userId: string } }> {
  const ctx = await createRouteTestContext()
  cleanup = ctx.cleanup
  const host = await exchangeJwt(ctx.env, "lifecycle-host")
  await completeUniqueHumanVerification(ctx.env, host.accessToken)
  const communityId = await createTestCommunity(ctx.env, host.accessToken)
  await seedHostProfile(ctx.client, host.userId) // booking_host_slot_locks.host_user_id FK → booking_profiles
  const booker = await exchangeJwt(ctx.env, "lifecycle-booker")
  await completeUniqueHumanVerification(ctx.env, booker.accessToken)
  await addCommunityMember(String(ctx.env.LOCAL_COMMUNITY_DB_ROOT), communityId, booker.userId)
  return { ctx, communityId, host, booker }
}

describe("community bookings — cancel lifecycle (Slice D)", () => {
  test("host cancel → full refund to booker, no host payout, status refunded, lock released", async () => {
    const { ctx, communityId, host, booker } = await setup()
    const root = String(ctx.env.LOCAL_COMMUNITY_DB_ROOT)
    await seedConfirmedBooking(root, communityId, { bookingId: "bkg_h", hostUserId: host.userId, bookerUserId: booker.userId, slotStartUtc: hoursFromNow(48), slotEndUtc: hoursFromNow(48.5) })
    await seedActiveBookingLock(ctx.client, { lockId: "blk_h", hostUserId: host.userId, slotStartUtc: hoursFromNow(48), slotEndUtc: hoursFromNow(48.5), communityId, bookingId: "bkg_h" })

    const res = await postCancel(ctx.env, communityId, "bkg_h", host.accessToken)
    expect(res.status).toBe(200)
    const body = await json(res) as { cancelled_by: string; booking: { status: string; refund_cents: number } }
    expect(body.cancelled_by).toBe("host")
    expect(body.booking.status).toBe("refunded")
    expect(body.booking.refund_cents).toBe(5000)
    // one operator effect: a full refund to the booker, no host payout
    expect(opEffects.map((e) => `${e.kind}:${e.amountCents}`)).toEqual(["refund:5000"])
    expect(await lockStatus(ctx.client, "bkg_h")).toBe("released")
  })

  test("booker cancel before the free window → full refund", async () => {
    const { ctx, communityId, host, booker } = await setup()
    const root = String(ctx.env.LOCAL_COMMUNITY_DB_ROOT)
    // slot 48h out, now is >24h before → before the cancellation window → full refund
    await seedConfirmedBooking(root, communityId, { bookingId: "bkg_bb", hostUserId: host.userId, bookerUserId: booker.userId, slotStartUtc: hoursFromNow(48), slotEndUtc: hoursFromNow(48.5) })
    await seedActiveBookingLock(ctx.client, { lockId: "blk_bb", hostUserId: host.userId, slotStartUtc: hoursFromNow(48), slotEndUtc: hoursFromNow(48.5), communityId, bookingId: "bkg_bb" })

    const res = await postCancel(ctx.env, communityId, "bkg_bb", booker.accessToken)
    expect(res.status).toBe(200)
    const body = await json(res) as { cancelled_by: string; booking: { refund_cents: number } }
    expect(body.cancelled_by).toBe("booker")
    expect(body.booking.refund_cents).toBe(5000)
    expect(opEffects.map((e) => `${e.kind}:${e.amountCents}`)).toEqual(["refund:5000"])
  })

  test("booker cancel after the free window → no refund, host keeps payout (retained 90/10)", async () => {
    const { ctx, communityId, host, booker } = await setup()
    const root = String(ctx.env.LOCAL_COMMUNITY_DB_ROOT)
    // slot only 12h out → within the 24h window → policy refund (0%), host keeps the retained payout
    await seedConfirmedBooking(root, communityId, { bookingId: "bkg_ba", hostUserId: host.userId, bookerUserId: booker.userId, slotStartUtc: hoursFromNow(12), slotEndUtc: hoursFromNow(12.5) })
    await seedActiveBookingLock(ctx.client, { lockId: "blk_ba", hostUserId: host.userId, slotStartUtc: hoursFromNow(12), slotEndUtc: hoursFromNow(12.5), communityId, bookingId: "bkg_ba" })

    const res = await postCancel(ctx.env, communityId, "bkg_ba", booker.accessToken)
    expect(res.status).toBe(200)
    const body = await json(res) as { booking: { status: string; refund_cents: number } }
    expect(body.booking.refund_cents).toBe(0)
    expect(body.booking.status).toBe("refunded")
    // no refund; the retained amount pays the host 90% (4500), platform keeps 10%
    expect(opEffects.map((e) => `${e.kind}:${e.amountCents}`)).toEqual(["payout:4500"])
  })

  test("a non-party user cannot cancel (404), booking untouched", async () => {
    const { ctx, communityId, host, booker } = await setup()
    const root = String(ctx.env.LOCAL_COMMUNITY_DB_ROOT)
    await seedConfirmedBooking(root, communityId, { bookingId: "bkg_x", hostUserId: host.userId, bookerUserId: booker.userId, slotStartUtc: hoursFromNow(48), slotEndUtc: hoursFromNow(48.5) })
    const intruder = await exchangeJwt(ctx.env, "lifecycle-intruder")
    await completeUniqueHumanVerification(ctx.env, intruder.accessToken)
    await addCommunityMember(root, communityId, intruder.userId)

    const res = await postCancel(ctx.env, communityId, "bkg_x", intruder.accessToken)
    expect(res.status).toBe(404)
    expect(await communityScalar(root, communityId, "SELECT status FROM bookings WHERE booking_id = ?1", ["bkg_x"])).toBe("confirmed")
    expect(opEffects.length).toBe(0)
  })

  test("cannot cancel a booking in a non-cancellable state (409 illegal_transition)", async () => {
    const { ctx, communityId, host, booker } = await setup()
    const root = String(ctx.env.LOCAL_COMMUNITY_DB_ROOT)
    await seedConfirmedBooking(root, communityId, { bookingId: "bkg_s", hostUserId: host.userId, bookerUserId: booker.userId, slotStartUtc: hoursFromNow(48), slotEndUtc: hoursFromNow(48.5), status: "settled" })

    const res = await postCancel(ctx.env, communityId, "bkg_s", host.accessToken)
    expect(res.status).toBe(409)
    expect((await json(res) as { error: string }).error).toBe("illegal_transition")
  })

  test("repeated cancel is idempotent: one operator effect, returns already_cancelled", async () => {
    const { ctx, communityId, host, booker } = await setup()
    const root = String(ctx.env.LOCAL_COMMUNITY_DB_ROOT)
    await seedConfirmedBooking(root, communityId, { bookingId: "bkg_i", hostUserId: host.userId, bookerUserId: booker.userId, slotStartUtc: hoursFromNow(48), slotEndUtc: hoursFromNow(48.5) })
    await seedActiveBookingLock(ctx.client, { lockId: "blk_i", hostUserId: host.userId, slotStartUtc: hoursFromNow(48), slotEndUtc: hoursFromNow(48.5), communityId, bookingId: "bkg_i" })

    expect((await postCancel(ctx.env, communityId, "bkg_i", host.accessToken)).status).toBe(200)
    const second = await postCancel(ctx.env, communityId, "bkg_i", host.accessToken)
    expect(second.status).toBe(200)
    expect((await json(second) as { already_cancelled: boolean }).already_cancelled).toBe(true)
    expect(opEffects.length).toBe(1) // not re-executed
  })

  test("custody effect already executed (crash before finalize) → retry resumes, no double-execute", async () => {
    const { ctx, communityId, host, booker } = await setup()
    const root = String(ctx.env.LOCAL_COMMUNITY_DB_ROOT)
    // Phase A reserved (cancelled_by_host + refund_cents persisted) and the refund effect already
    // ran in a prior attempt that crashed before finalizing.
    await seedConfirmedBooking(root, communityId, {
      bookingId: "bkg_r", hostUserId: host.userId, bookerUserId: booker.userId,
      slotStartUtc: hoursFromNow(48), slotEndUtc: hoursFromNow(48.5),
      status: "cancelled_by_host", refundCents: 5000,
    })
    await seedActiveBookingLock(ctx.client, { lockId: "blk_r", hostUserId: host.userId, slotStartUtc: hoursFromNow(48), slotEndUtc: hoursFromNow(48.5), communityId, bookingId: "bkg_r" })
    // The durable custody ledger already holds the refund tx from the crashed attempt.
    executedKeys.set("booking_refund:bkg_r", "op_prior_refund")

    const res = await postCancel(ctx.env, communityId, "bkg_r", host.accessToken)
    expect(res.status).toBe(200)
    const body = await json(res) as { booking: { status: string; refund_tx_ref: string } }
    // Resumed B→C: finalized to refunded reusing the existing tx; the refund was NOT re-executed.
    expect(body.booking.status).toBe("refunded")
    expect(body.booking.refund_tx_ref).toBe("op_prior_refund")
    expect(opEffects.length).toBe(0)
    expect(await lockStatus(ctx.client, "bkg_r")).toBe("released")
  })
})

describe("community bookings — start session (Slice D)", () => {
  test("either party starts: confirmed → live, no money", async () => {
    const { ctx, communityId, host, booker } = await setup()
    const root = String(ctx.env.LOCAL_COMMUNITY_DB_ROOT)
    await seedConfirmedBooking(root, communityId, { bookingId: "bkg_s1", hostUserId: host.userId, bookerUserId: booker.userId, slotStartUtc: hoursFromNow(2), slotEndUtc: hoursFromNow(2.5) })
    const res = await postAction("start", ctx.env, communityId, "bkg_s1", booker.accessToken)
    expect(res.status).toBe(200)
    expect((await json(res) as { booking: { status: string } }).booking.status).toBe("live")
    expect(opEffects.length).toBe(0)
  })

  test("non-party cannot start (404); starting a non-confirmed booking is 409", async () => {
    const { ctx, communityId, host, booker } = await setup()
    const root = String(ctx.env.LOCAL_COMMUNITY_DB_ROOT)
    await seedConfirmedBooking(root, communityId, { bookingId: "bkg_s2", hostUserId: host.userId, bookerUserId: booker.userId, slotStartUtc: hoursFromNow(2), slotEndUtc: hoursFromNow(2.5), status: "settled" })
    const intruder = await exchangeJwt(ctx.env, "lifecycle-intruder")
    await completeUniqueHumanVerification(ctx.env, intruder.accessToken)
    await addCommunityMember(root, communityId, intruder.userId)
    expect((await postAction("start", ctx.env, communityId, "bkg_s2", intruder.accessToken)).status).toBe(404)
    expect((await postAction("start", ctx.env, communityId, "bkg_s2", host.accessToken)).status).toBe(409)
  })
})

describe("community bookings — complete + payout (Slice D)", () => {
  test("host completes a live session → settled, host paid retained 4500, no refund, lock released", async () => {
    const { ctx, communityId, host, booker } = await setup()
    const root = String(ctx.env.LOCAL_COMMUNITY_DB_ROOT)
    await seedConfirmedBooking(root, communityId, { bookingId: "bkg_c", hostUserId: host.userId, bookerUserId: booker.userId, slotStartUtc: hoursFromNow(1), slotEndUtc: hoursFromNow(1.5), status: "live" })
    await seedActiveBookingLock(ctx.client, { lockId: "blk_c", hostUserId: host.userId, slotStartUtc: hoursFromNow(1), slotEndUtc: hoursFromNow(1.5), communityId, bookingId: "bkg_c" })
    const res = await postAction("complete", ctx.env, communityId, "bkg_c", host.accessToken)
    expect(res.status).toBe(200)
    const body = await json(res) as { booking: { status: string; refund_cents: number; payout_tx_ref: string } }
    expect(body.booking.status).toBe("settled")
    expect(body.booking.refund_cents).toBe(0)
    expect(opEffects.map((e) => `${e.kind}:${e.amountCents}`)).toEqual(["payout:4500"])
    expect(await lockStatus(ctx.client, "bkg_c")).toBe("released")
  })

  test("booker cannot complete (404); completing a non-live booking is 409", async () => {
    const { ctx, communityId, host, booker } = await setup()
    const root = String(ctx.env.LOCAL_COMMUNITY_DB_ROOT)
    await seedConfirmedBooking(root, communityId, { bookingId: "bkg_c2", hostUserId: host.userId, bookerUserId: booker.userId, slotStartUtc: hoursFromNow(1), slotEndUtc: hoursFromNow(1.5), status: "live" })
    expect((await postAction("complete", ctx.env, communityId, "bkg_c2", booker.accessToken)).status).toBe(404)
    await seedConfirmedBooking(root, communityId, { bookingId: "bkg_c3", hostUserId: host.userId, bookerUserId: booker.userId, slotStartUtc: hoursFromNow(1), slotEndUtc: hoursFromNow(1.5) }) // confirmed, not live
    expect((await postAction("complete", ctx.env, communityId, "bkg_c3", host.accessToken)).status).toBe(409)
    expect(opEffects.length).toBe(0)
  })

  test("repeat complete is idempotent: payout runs once", async () => {
    const { ctx, communityId, host, booker } = await setup()
    const root = String(ctx.env.LOCAL_COMMUNITY_DB_ROOT)
    await seedConfirmedBooking(root, communityId, { bookingId: "bkg_c4", hostUserId: host.userId, bookerUserId: booker.userId, slotStartUtc: hoursFromNow(1), slotEndUtc: hoursFromNow(1.5), status: "live" })
    await seedActiveBookingLock(ctx.client, { lockId: "blk_c4", hostUserId: host.userId, slotStartUtc: hoursFromNow(1), slotEndUtc: hoursFromNow(1.5), communityId, bookingId: "bkg_c4" })
    expect((await postAction("complete", ctx.env, communityId, "bkg_c4", host.accessToken)).status).toBe(200)
    const second = await postAction("complete", ctx.env, communityId, "bkg_c4", host.accessToken)
    expect((await json(second) as { already_settled: boolean }).already_settled).toBe(true)
    expect(opEffects.length).toBe(1)
  })
})

describe("community bookings — no-show (Slice D)", () => {
  test("host reports booker no-show → settled, host paid 4500, no refund", async () => {
    const { ctx, communityId, host, booker } = await setup()
    const root = String(ctx.env.LOCAL_COMMUNITY_DB_ROOT)
    await seedConfirmedBooking(root, communityId, { bookingId: "bkg_n1", hostUserId: host.userId, bookerUserId: booker.userId, slotStartUtc: hoursFromNow(1), slotEndUtc: hoursFromNow(1.5), status: "live" })
    await seedActiveBookingLock(ctx.client, { lockId: "blk_n1", hostUserId: host.userId, slotStartUtc: hoursFromNow(1), slotEndUtc: hoursFromNow(1.5), communityId, bookingId: "bkg_n1" })
    const res = await postAction("no-show", ctx.env, communityId, "bkg_n1", host.accessToken)
    expect(res.status).toBe(200)
    const body = await json(res) as { booking: { status: string; refund_cents: number } }
    expect(body.booking.status).toBe("settled")
    expect(body.booking.refund_cents).toBe(0)
    expect(opEffects.map((e) => `${e.kind}:${e.amountCents}`)).toEqual(["payout:4500"])
    expect(await lockStatus(ctx.client, "bkg_n1")).toBe("released")
  })

  test("booker reports host no-show → refunded, booker gets full refund 5000", async () => {
    const { ctx, communityId, host, booker } = await setup()
    const root = String(ctx.env.LOCAL_COMMUNITY_DB_ROOT)
    await seedConfirmedBooking(root, communityId, { bookingId: "bkg_n2", hostUserId: host.userId, bookerUserId: booker.userId, slotStartUtc: hoursFromNow(1), slotEndUtc: hoursFromNow(1.5), status: "live" })
    await seedActiveBookingLock(ctx.client, { lockId: "blk_n2", hostUserId: host.userId, slotStartUtc: hoursFromNow(1), slotEndUtc: hoursFromNow(1.5), communityId, bookingId: "bkg_n2" })
    const res = await postAction("no-show", ctx.env, communityId, "bkg_n2", booker.accessToken)
    expect(res.status).toBe(200)
    const body = await json(res) as { booking: { status: string; refund_cents: number } }
    expect(body.booking.status).toBe("refunded")
    expect(body.booking.refund_cents).toBe(5000)
    expect(opEffects.map((e) => `${e.kind}:${e.amountCents}`)).toEqual(["refund:5000"])
  })

  test("non-party cannot report no-show (404); no-show on a non-live booking is 409", async () => {
    const { ctx, communityId, host, booker } = await setup()
    const root = String(ctx.env.LOCAL_COMMUNITY_DB_ROOT)
    await seedConfirmedBooking(root, communityId, { bookingId: "bkg_n3", hostUserId: host.userId, bookerUserId: booker.userId, slotStartUtc: hoursFromNow(1), slotEndUtc: hoursFromNow(1.5) }) // confirmed
    const intruder = await exchangeJwt(ctx.env, "lifecycle-intruder")
    await completeUniqueHumanVerification(ctx.env, intruder.accessToken)
    await addCommunityMember(root, communityId, intruder.userId)
    expect((await postAction("no-show", ctx.env, communityId, "bkg_n3", intruder.accessToken)).status).toBe(404)
    expect((await postAction("no-show", ctx.env, communityId, "bkg_n3", host.accessToken)).status).toBe(409)
  })
})
