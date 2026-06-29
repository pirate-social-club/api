import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { createClient } from "@libsql/client"

import { app } from "../../../src/index"
import { setBookingOperatorEffectExecutorForTests, type OperatorEffect } from "../../../src/lib/communities/bookings/booking-lifecycle-service"
import { resolveDueBooking } from "../../../src/lib/communities/bookings/booking-settlement-evaluator"
import { getCommunityRepository } from "../../../src/lib/communities/db-community-repository"
import { buildLocalCommunityDbUrl } from "../../../src/lib/communities/community-local-db"
import { hashOperatorCredentialSecret, BOOKING_SETTLEMENT_RESOLVE_SCOPE } from "../../../src/lib/operator-credential-auth"
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
  setBookingOperatorEffectExecutorForTests(async (_ctx, effect) => {
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
              gross_cents, platform_fee_bps, platform_fee_cents, host_payout_cents, status, funding_tx_ref,
              funding_wallet_address, host_payout_wallet_address, created_at, updated_at)
            VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?6, 5000, 1000, 500, 4500, 'confirmed', '0xfunded',
              '0x0000000000000000000000000000000000000b0c', '0x0000000000000000000000000000000000000a11', ?7, ?7)`,
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

async function bookingReviewState(root: string, communityId: string, bookingId: string): Promise<{
  status: string
  reviewStatus: string | null
  reason: string | null
  resolution: string | null
  refundCents: number | null
  version: number
}> {
  const c = createClient({ url: buildLocalCommunityDbUrl(root, communityId) })
  try {
    const r = await c.execute({
      sql: `SELECT status, settlement_review_status, settlement_review_reason, settlement_review_version
                   , settlement_review_resolution, refund_cents
            FROM bookings WHERE booking_id = ?1`,
      args: [bookingId],
    })
    const row = r.rows[0]!
    return {
      status: String(row.status),
      reviewStatus: row.settlement_review_status ? String(row.settlement_review_status) : null,
      reason: row.settlement_review_reason ? String(row.settlement_review_reason) : null,
      resolution: row.settlement_review_resolution ? String(row.settlement_review_resolution) : null,
      refundCents: row.refund_cents == null ? null : Number(row.refund_cents),
      version: Number(row.settlement_review_version ?? 0),
    }
  } finally { c.close() }
}

async function seedOperatorCredential(ctx: Ctx, secret = "review-secret"): Promise<string> {
  await ctx.client.execute({
    sql: `INSERT INTO operator_credentials (
            operator_credential_id, operator_actor_id, label, secret_hash, secret_hash_algo,
            secret_hash_version, scopes_json, status, created_at, expires_at
          ) VALUES (?1, ?2, 'Settlement reviewer', ?3, 'sha256', 1, ?4, 'active', ?5, ?6)`,
    args: [
      "opc_review",
      "svc_settlement_reviewer",
      hashOperatorCredentialSecret(secret),
      JSON.stringify([BOOKING_SETTLEMENT_RESOLVE_SCOPE]),
      "2026-06-20T00:00:00.000Z",
      "2026-07-20T00:00:00.000Z",
    ],
  })
  return `Operator opc_review.${secret}`
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

  test("neither attended with review flag → disputed pending review, no money", async () => {
    const { ctx, communityId, host, booker, root } = await setup()
    await seedBookingWithAttendance(root, communityId, { bookingId: "bkg_review", hostUserId: host.userId, bookerUserId: booker.userId, hostPresent: false, bookerPresent: false })
    const r = await resolveDueBooking({
      env: { ...ctx.env, BOOKING_SETTLEMENT_AMBIGUOUS_REVIEW_ENABLED: "true" },
      communityRepository: getCommunityRepository(ctx.env),
      communityId,
      bookingId: "bkg_review",
      nowUtc: "2026-06-20T11:10:00.000Z",
    })
    expect(r.outcome).toBe("ambiguous")
    expect(r.acted).toBe(false)
    expect(await bookingReviewState(root, communityId, "bkg_review")).toEqual({
      status: "disputed",
      reviewStatus: "pending",
      reason: "attendance_ambiguous",
      resolution: null,
      refundCents: null,
      version: 1,
    })
    expect(opEffects.length).toBe(0)
  })

  test("operator resolves pending review, replay is idempotent, different resolution conflicts", async () => {
    const { ctx, communityId, host, booker, root } = await setup()
    await seedBookingWithAttendance(root, communityId, { bookingId: "bkg_route_review", hostUserId: host.userId, bookerUserId: booker.userId, hostPresent: false, bookerPresent: false })
    await resolveDueBooking({
      env: { ...ctx.env, BOOKING_SETTLEMENT_AMBIGUOUS_REVIEW_ENABLED: "true" },
      communityRepository: getCommunityRepository(ctx.env),
      communityId,
      bookingId: "bkg_route_review",
      nowUtc: "2026-06-20T11:10:00.000Z",
    })
    const authorization = await seedOperatorCredential(ctx)
    const url = `http://pirate.test/communities/${communityId}/bookings/bkg_route_review/settlement-review/resolve`

    const resolved = await app.request(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization },
      body: JSON.stringify({ resolution: "no_show_host", expected_review_version: 1, note: "host absent" }),
    }, ctx.env)
    expect(resolved.status).toBe(200)
    expect(await json(resolved)).toMatchObject({ replayed: false, resolution: "no_show_host" })
    expect(await bookingReviewState(root, communityId, "bkg_route_review")).toMatchObject({
      status: "refunded",
      reviewStatus: "resolved",
      resolution: "no_show_host",
      refundCents: 5000,
      version: 2,
    })
    expect(opEffects.map((e) => `${e.kind}:${e.amountCents}:${e.idempotencyKey}`)).toEqual(["refund:5000:booking_refund:bkg_route_review"])

    const replay = await app.request(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization },
      body: JSON.stringify({ resolution: "no_show_host", expected_review_version: 1 }),
    }, ctx.env)
    expect(replay.status).toBe(200)
    expect(await json(replay)).toMatchObject({ replayed: true, resolution: "no_show_host" })
    expect(opEffects.length).toBe(1)

    const conflict = await app.request(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization },
      body: JSON.stringify({ resolution: "completed", expected_review_version: 1 }),
    }, ctx.env)
    expect(conflict.status).toBe(409)
    expect(await json(conflict)).toEqual({ error: "resolution_conflict" })
  })

  test("admin token cannot resolve a pending settlement review", async () => {
    const { ctx, communityId, host, booker, root } = await setup()
    await seedBookingWithAttendance(root, communityId, { bookingId: "bkg_admin_blocked", hostUserId: host.userId, bookerUserId: booker.userId, hostPresent: false, bookerPresent: false })
    await resolveDueBooking({
      env: { ...ctx.env, BOOKING_SETTLEMENT_AMBIGUOUS_REVIEW_ENABLED: "true" },
      communityRepository: getCommunityRepository(ctx.env),
      communityId,
      bookingId: "bkg_admin_blocked",
      nowUtc: "2026-06-20T11:10:00.000Z",
    })
    const response = await app.request(
      `http://pirate.test/communities/${communityId}/bookings/bkg_admin_blocked/settlement-review/resolve`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-admin-token": "admin-secret",
          "x-admin-as-user-id": host.userId,
        },
        body: JSON.stringify({ resolution: "completed", expected_review_version: 1 }),
      },
      { ...ctx.env, PIRATE_ADMIN_TOKEN: "admin-secret" },
    )
    expect(response.status).toBe(401)
    expect(await bookingReviewState(root, communityId, "bkg_admin_blocked")).toMatchObject({
      status: "disputed",
      reviewStatus: "pending",
      resolution: null,
    })
    expect(opEffects.length).toBe(0)
  })
})
