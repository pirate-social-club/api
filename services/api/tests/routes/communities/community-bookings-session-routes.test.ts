import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { createClient } from "@libsql/client"

import { app } from "../../../src/index"
import { buildLocalCommunityDbUrl } from "../../../src/lib/communities/community-local-db"
import { createRouteTestContext, json, resetRuntimeCaches } from "../../helpers"
import { addCommunityMember, completeUniqueHumanVerification, exchangeJwt, requestJson } from "./community-routes-test-helpers"

// Multi-write attach/heartbeat on the local SQLite-file harness contends past the 5s default
// (prod community DBs are D1, not a logic delay).
setDefaultTimeout(20_000)

type Ctx = Awaited<ReturnType<typeof createRouteTestContext>>

let cleanup: (() => Promise<void>) | null = null
beforeEach(() => { resetRuntimeCaches() })
afterEach(async () => { if (cleanup) { await cleanup(); cleanup = null } })

async function createTestCommunity(env: Ctx["env"], accessToken: string): Promise<string> {
  const response = await requestJson("http://pirate.test/communities", {
    display_name: "Session Test Community",
    membership_mode: "request",
    handle_policy: { policy_template: "standard" },
  }, env, accessToken)
  expect(response.status).toBe(202)
  return (await json(response) as { community: { id: string } }).community.id.replace(/^com_/, "")
}

async function seedBooking(root: string, communityId: string, opts: {
  bookingId: string; hostUserId: string; bookerUserId: string; status?: string
}): Promise<void> {
  const c = createClient({ url: buildLocalCommunityDbUrl(root, communityId) })
  try {
    const now = new Date().toISOString()
    const slotStart = new Date(Date.now() + 3600_000).toISOString()
    const slotEnd = new Date(Date.now() + 5400_000).toISOString()
    await c.execute({
      sql: `INSERT INTO bookings (
              booking_id, community_id, hold_id, host_user_id, booker_user_id, slot_start_utc, slot_end_utc,
              gross_cents, platform_fee_bps, platform_fee_cents, host_payout_cents, status,
              funding_tx_ref, created_at, updated_at
            ) VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?6, 5000, 1000, 500, 4500, ?7, '0xfunded', ?8, ?8)`,
      args: [opts.bookingId, communityId, opts.hostUserId, opts.bookerUserId, slotStart, slotEnd, opts.status ?? "confirmed", now],
    })
  } finally {
    c.close()
  }
}

async function communityRows(root: string, communityId: string, sql: string, args: unknown[] = []): Promise<Record<string, unknown>[]> {
  const c = createClient({ url: buildLocalCommunityDbUrl(root, communityId) })
  try {
    const r = await c.execute({ sql, args: args as never })
    return r.rows as Record<string, unknown>[]
  } finally {
    c.close()
  }
}

function post(env: Ctx["env"], communityId: string, bookingId: string, action: string, token: string, body?: unknown) {
  return app.request(
    `http://pirate.test/communities/${communityId}/bookings/${bookingId}/session/${action}`,
    { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined },
    env,
  )
}

async function setup() {
  const ctx = await createRouteTestContext()
  cleanup = ctx.cleanup
  const host = await exchangeJwt(ctx.env, "session-host")
  await completeUniqueHumanVerification(ctx.env, host.accessToken)
  const communityId = await createTestCommunity(ctx.env, host.accessToken)
  const booker = await exchangeJwt(ctx.env, "session-booker")
  await completeUniqueHumanVerification(ctx.env, booker.accessToken)
  await addCommunityMember(String(ctx.env.LOCAL_COMMUNITY_DB_ROOT), communityId, booker.userId)
  return { ctx, communityId, host, booker, root: String(ctx.env.LOCAL_COMMUNITY_DB_ROOT) }
}

describe("community bookings — session attach + attendance (Slice D2/D3)", () => {
  test("host attaches: token block + attendance session + derived channel recorded on booking", async () => {
    const { ctx, communityId, host, booker, root } = await setup()
    await seedBooking(root, communityId, { bookingId: "bkg_a", hostUserId: host.userId, bookerUserId: booker.userId, status: "confirmed" })
    const res = await post(ctx.env, communityId, "bkg_a", "attach", host.accessToken)
    expect(res.status).toBe(200)
    const body = await json(res) as { session_id: string; party: string; channel: string; agora: { channel: string } }
    expect(body.party).toBe("host")
    expect(body.channel).toBe("pirate-booking-bkg_a")
    expect(body.agora.channel).toBe("pirate-booking-bkg_a")
    const sessions = await communityRows(root, communityId, "SELECT party, user_id FROM booking_attendance_sessions WHERE booking_id = ?1", ["bkg_a"])
    expect(sessions.length).toBe(1)
    expect(sessions[0].party).toBe("host")
    const booking = await communityRows(root, communityId, "SELECT live_room_id FROM bookings WHERE booking_id = ?1", ["bkg_a"])
    expect(booking[0].live_room_id).toBe("pirate-booking-bkg_a")
  })

  test("booker attaches as the booker party", async () => {
    const { ctx, communityId, host, booker, root } = await setup()
    await seedBooking(root, communityId, { bookingId: "bkg_b", hostUserId: host.userId, bookerUserId: booker.userId, status: "live" })
    const res = await post(ctx.env, communityId, "bkg_b", "attach", booker.accessToken)
    expect(res.status).toBe(200)
    expect((await json(res) as { party: string }).party).toBe("booker")
  })

  test("a non-party cannot attach (404)", async () => {
    const { ctx, communityId, host, booker, root } = await setup()
    await seedBooking(root, communityId, { bookingId: "bkg_c", hostUserId: host.userId, bookerUserId: booker.userId })
    const intruder = await exchangeJwt(ctx.env, "session-intruder")
    await completeUniqueHumanVerification(ctx.env, intruder.accessToken)
    await addCommunityMember(root, communityId, intruder.userId)
    expect((await post(ctx.env, communityId, "bkg_c", "attach", intruder.accessToken)).status).toBe(404)
  })

  test("cannot attach to a terminal booking (409 not_attachable)", async () => {
    const { ctx, communityId, host, booker, root } = await setup()
    await seedBooking(root, communityId, { bookingId: "bkg_d", hostUserId: host.userId, bookerUserId: booker.userId, status: "settled" })
    const res = await post(ctx.env, communityId, "bkg_d", "attach", host.accessToken)
    expect(res.status).toBe(409)
    expect((await json(res) as { error: string }).error).toBe("not_attachable")
  })

  test("heartbeat extends the session and records a sample (identity-bound)", async () => {
    const { ctx, communityId, host, booker, root } = await setup()
    await seedBooking(root, communityId, { bookingId: "bkg_h", hostUserId: host.userId, bookerUserId: booker.userId })
    const attach = await json(await post(ctx.env, communityId, "bkg_h", "attach", host.accessToken)) as { session_id: string }
    const hb = await post(ctx.env, communityId, "bkg_h", "heartbeat", host.accessToken, { session_id: attach.session_id })
    expect(hb.status).toBe(200)
    const samples = await communityRows(root, communityId, "SELECT seen_at FROM booking_attendance_heartbeats WHERE session_id = ?1", [attach.session_id])
    expect(samples.length).toBe(1)
    // another party cannot heartbeat someone else's session
    const stolen = await post(ctx.env, communityId, "bkg_h", "heartbeat", booker.accessToken, { session_id: attach.session_id })
    expect(stolen.status).toBe(404)
  })

  test("heartbeat for an unknown session is 404", async () => {
    const { ctx, communityId, host, booker, root } = await setup()
    await seedBooking(root, communityId, { bookingId: "bkg_x", hostUserId: host.userId, bookerUserId: booker.userId })
    const res = await post(ctx.env, communityId, "bkg_x", "heartbeat", host.accessToken, { session_id: "bas_nope" })
    expect(res.status).toBe(404)
  })
})
