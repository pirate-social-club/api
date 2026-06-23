import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { createClient } from "@libsql/client"

import { setBookingOperatorEffectExecutorForTests, type OperatorEffect } from "../../../src/lib/communities/bookings/booking-lifecycle-service"
import { resolveDueBooking } from "../../../src/lib/communities/bookings/booking-settlement-evaluator"
import { getCommunityRepository } from "../../../src/lib/communities/db-community-repository"
import { buildLocalCommunityDbUrl } from "../../../src/lib/communities/community-local-db"
import { createRouteTestContext, json, resetRuntimeCaches } from "../../helpers"
import { addCommunityMember, completeUniqueHumanVerification, exchangeJwt, requestJson } from "./community-routes-test-helpers"

setDefaultTimeout(20_000)

type Ctx = Awaited<ReturnType<typeof createRouteTestContext>>

const SLOT_START = "2026-06-20T10:00:00.000Z"
const SLOT_END = "2026-06-20T11:00:00.000Z"

let cleanup: (() => Promise<void>) | null = null
let opEffects: OperatorEffect[] = []
beforeEach(() => {
  resetRuntimeCaches()
  opEffects = []
  const ledger = new Map<string, string>()
  setBookingOperatorEffectExecutorForTests(async (_env, effect) => {
    const existing = ledger.get(effect.idempotencyKey)
    if (existing) return { txRef: existing }
    const txRef = `op_${effect.idempotencyKey}`
    ledger.set(effect.idempotencyKey, txRef)
    opEffects.push(effect)
    return { txRef }
  })
})
afterEach(async () => {
  setBookingOperatorEffectExecutorForTests(null)
  if (cleanup) { await cleanup(); cleanup = null }
})

async function createTestCommunity(env: Ctx["env"], accessToken: string): Promise<string> {
  const response = await requestJson("http://pirate.test/communities", {
    display_name: "Evaluator Test Community", membership_mode: "request", handle_policy: { policy_template: "standard" },
  }, env, accessToken)
  expect(response.status).toBe(202)
  return (await json(response) as { community: { id: string } }).community.id.replace(/^com_/, "")
}

function minuteSamples(startUtc: string, count: number): string[] {
  const lo = Date.parse(startUtc)
  return Array.from({ length: count }, (_, i) => new Date(lo + i * 60_000).toISOString())
}

async function seedBookingWithAttendance(root: string, communityId: string, opts: {
  bookingId: string; hostUserId: string; bookerUserId: string
  hostPresent: boolean; bookerPresent: boolean
}): Promise<void> {
  const c = createClient({ url: buildLocalCommunityDbUrl(root, communityId) })
  try {
    const now = new Date().toISOString()
    await c.execute({
      sql: `INSERT INTO bookings (booking_id, community_id, hold_id, host_user_id, booker_user_id, slot_start_utc, slot_end_utc,
              gross_cents, platform_fee_bps, platform_fee_cents, host_payout_cents, status, funding_tx_ref, created_at, updated_at)
            VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?6, 5000, 1000, 500, 4500, 'confirmed', '0xfunded', ?7, ?7)`,
      args: [opts.bookingId, communityId, opts.hostUserId, opts.bookerUserId, SLOT_START, SLOT_END, now],
    })
    // 16 minute-spaced samples 10:00..10:15 → continuous presence (<=90s apart), overlap 15min.
    const stamps = minuteSamples(SLOT_START, 16)
    for (const [party, userId, present] of [["host", opts.hostUserId, opts.hostPresent], ["booker", opts.bookerUserId, opts.bookerPresent]] as const) {
      if (!present) continue
      const sessionId = `bas_${party}_${opts.bookingId}`
      await c.execute({
        sql: `INSERT INTO booking_attendance_sessions (session_id, community_id, booking_id, party, user_id, agora_uid, attached_at, last_seen_at, ended_at, created_at, updated_at)
              VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?7, NULL, ?6, ?7)`,
        args: [sessionId, communityId, opts.bookingId, party, userId, stamps[0], stamps[stamps.length - 1]],
      })
      for (const seen of stamps) {
        await c.execute({
          sql: `INSERT INTO booking_attendance_heartbeats (heartbeat_id, session_id, booking_id, seen_at) VALUES (?1, ?2, ?3, ?4)`,
          args: [`bah_${party}_${opts.bookingId}_${seen}`, sessionId, opts.bookingId, seen],
        })
      }
    }
  } finally {
    c.close()
  }
}

async function bookingStatus(root: string, communityId: string, bookingId: string): Promise<string> {
  const c = createClient({ url: buildLocalCommunityDbUrl(root, communityId) })
  try {
    const r = await c.execute({ sql: `SELECT status FROM bookings WHERE booking_id = ?1`, args: [bookingId] })
    return String(r.rows[0]?.status)
  } finally { c.close() }
}

async function setup() {
  const ctx = await createRouteTestContext()
  cleanup = ctx.cleanup
  const host = await exchangeJwt(ctx.env, "eval-host")
  await completeUniqueHumanVerification(ctx.env, host.accessToken)
  const communityId = await createTestCommunity(ctx.env, host.accessToken)
  const booker = await exchangeJwt(ctx.env, "eval-booker")
  await completeUniqueHumanVerification(ctx.env, booker.accessToken)
  await addCommunityMember(String(ctx.env.LOCAL_COMMUNITY_DB_ROOT), communityId, booker.userId)
  return { ctx, communityId, host, booker, root: String(ctx.env.LOCAL_COMMUNITY_DB_ROOT) }
}

describe("booking settlement evaluator (Slice D4)", () => {
  test("both attended with overlap → auto-start, complete, host paid", async () => {
    const { ctx, communityId, host, booker, root } = await setup()
    await seedBookingWithAttendance(root, communityId, { bookingId: "bkg_ok", hostUserId: host.userId, bookerUserId: booker.userId, hostPresent: true, bookerPresent: true })
    const r = await resolveDueBooking({ env: ctx.env, communityRepository: getCommunityRepository(ctx.env), communityId, bookingId: "bkg_ok", nowUtc: new Date().toISOString() })
    expect(r.outcome).toBe("completed")
    expect(await bookingStatus(root, communityId, "bkg_ok")).toBe("settled")
    expect(opEffects.map((e) => `${e.kind}:${e.amountCents}`)).toEqual(["payout:4500"])
  })

  test("host present, booker absent → no_show_booker, host paid", async () => {
    const { ctx, communityId, host, booker, root } = await setup()
    await seedBookingWithAttendance(root, communityId, { bookingId: "bkg_nb", hostUserId: host.userId, bookerUserId: booker.userId, hostPresent: true, bookerPresent: false })
    const r = await resolveDueBooking({ env: ctx.env, communityRepository: getCommunityRepository(ctx.env), communityId, bookingId: "bkg_nb", nowUtc: new Date().toISOString() })
    expect(r.outcome).toBe("no_show_booker")
    expect(await bookingStatus(root, communityId, "bkg_nb")).toBe("settled")
    expect(opEffects.map((e) => `${e.kind}:${e.amountCents}`)).toEqual(["payout:4500"])
  })

  test("booker present, host absent → no_show_host, full refund", async () => {
    const { ctx, communityId, host, booker, root } = await setup()
    await seedBookingWithAttendance(root, communityId, { bookingId: "bkg_nh", hostUserId: host.userId, bookerUserId: booker.userId, hostPresent: false, bookerPresent: true })
    const r = await resolveDueBooking({ env: ctx.env, communityRepository: getCommunityRepository(ctx.env), communityId, bookingId: "bkg_nh", nowUtc: new Date().toISOString() })
    expect(r.outcome).toBe("no_show_host")
    expect(await bookingStatus(root, communityId, "bkg_nh")).toBe("refunded")
    expect(opEffects.map((e) => `${e.kind}:${e.amountCents}`)).toEqual(["refund:5000"])
  })

  test("neither attended → ambiguous, no money, booking untouched", async () => {
    const { ctx, communityId, host, booker, root } = await setup()
    await seedBookingWithAttendance(root, communityId, { bookingId: "bkg_amb", hostUserId: host.userId, bookerUserId: booker.userId, hostPresent: false, bookerPresent: false })
    const r = await resolveDueBooking({ env: ctx.env, communityRepository: getCommunityRepository(ctx.env), communityId, bookingId: "bkg_amb", nowUtc: new Date().toISOString() })
    expect(r.outcome).toBe("ambiguous")
    expect(r.acted).toBe(false)
    expect(await bookingStatus(root, communityId, "bkg_amb")).toBe("confirmed")
    expect(opEffects.length).toBe(0)
  })
})
