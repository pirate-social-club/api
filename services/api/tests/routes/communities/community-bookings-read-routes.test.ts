import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { createClient } from "@libsql/client"

setDefaultTimeout(20_000)

import { app } from "../../../src/index"
import { buildLocalCommunityDbUrl } from "../../../src/lib/communities/community-local-db"
import { createRouteTestContext, json, resetRuntimeCaches } from "../../helpers"
import { completeUniqueHumanVerification, exchangeJwt, requestJson } from "./community-routes-test-helpers"

type Ctx = Awaited<ReturnType<typeof createRouteTestContext>>

let cleanup: (() => Promise<void>) | null = null
beforeEach(() => { resetRuntimeCaches() })
afterEach(async () => { if (cleanup) { await cleanup(); cleanup = null } })

function getAuthed(url: string, env: Ctx["env"], token: string): Promise<Response> {
  return Promise.resolve(app.request(url, { method: "GET", headers: { authorization: `Bearer ${token}` } }, env))
}

async function seedBooking(root: string, communityId: string, o: { bookingId: string; hostUserId: string; bookerUserId: string; status?: string }): Promise<void> {
  const c = createClient({ url: buildLocalCommunityDbUrl(root, communityId) })
  try {
    const now = new Date().toISOString()
    await c.execute({
      sql: `INSERT INTO bookings (booking_id, community_id, hold_id, host_user_id, booker_user_id, slot_start_utc, slot_end_utc,
              gross_cents, platform_fee_bps, platform_fee_cents, host_payout_cents, status, refund_cents,
              funding_tx_ref, funding_wallet_address, host_payout_wallet_address, created_at, updated_at)
            VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?6, 5000, 1000, 500, 4500, ?7, NULL,
              '0xabc', '0x0000000000000000000000000000000000000b0c', '0x0000000000000000000000000000000000000a11', ?8, ?8)`,
      args: [o.bookingId, communityId, o.hostUserId, o.bookerUserId, new Date(Date.now() - 3600_000).toISOString(), new Date(Date.now() - 1800_000).toISOString(), o.status ?? "confirmed", now],
    })
  } finally { c.close() }
}

async function setup() {
  const ctx = await createRouteTestContext()
  cleanup = ctx.cleanup
  const host = await exchangeJwt(ctx.env, "read-host")
  await completeUniqueHumanVerification(ctx.env, host.accessToken)
  const r = await requestJson("http://pirate.test/communities", { display_name: "Read Routes", membership_mode: "request", handle_policy: { policy_template: "standard" } }, ctx.env, host.accessToken)
  const communityId = (await json(r) as { community: { id: string } }).community.id.replace(/^com_/, "")
  const booker = await exchangeJwt(ctx.env, "read-booker")
  await completeUniqueHumanVerification(ctx.env, booker.accessToken)
  const intruder = await exchangeJwt(ctx.env, "read-intruder")
  await completeUniqueHumanVerification(ctx.env, intruder.accessToken)
  return { ctx, communityId, root: String(ctx.env.LOCAL_COMMUNITY_DB_ROOT), host, booker, intruder }
}

const SENSITIVE = ["funding_wallet_address", "host_payout_wallet_address", "quote_id", "purchase_id"]

describe("GET booking — party authorization + no sensitive fields", () => {
  test("a party (host and booker) can retrieve it; a non-party gets 404", async () => {
    const { ctx, communityId, root, host, booker, intruder } = await setup()
    await seedBooking(root, communityId, { bookingId: "bkg1", hostUserId: host.userId, bookerUserId: booker.userId })
    const base = `http://pirate.test/communities/${communityId}/bookings/bkg1`

    const asHost = await getAuthed(base, ctx.env, host.accessToken)
    expect(asHost.status).toBe(200)
    const hostBody = (await json(asHost) as { booking: Record<string, unknown> }).booking
    expect(hostBody.viewer_role).toBe("host")
    expect(hostBody.funding_tx_ref).toBe("0xabc")
    for (const key of SENSITIVE) expect(hostBody).not.toHaveProperty(key)

    const asBooker = await getAuthed(base, ctx.env, booker.accessToken)
    expect(asBooker.status).toBe(200)
    expect((await json(asBooker) as { booking: { viewer_role: string } }).booking.viewer_role).toBe("booker")

    const asIntruder = await getAuthed(base, ctx.env, intruder.accessToken)
    expect(asIntruder.status).toBe(404)
  })

  test("a missing booking is 404", async () => {
    const { ctx, communityId, host } = await setup()
    const res = await getAuthed(`http://pirate.test/communities/${communityId}/bookings/nope`, ctx.env, host.accessToken)
    expect(res.status).toBe(404)
  })
})

describe("GET bookings list — role + status filter, own rows only", () => {
  test("lists only the caller's rows for the requested role, with status filter", async () => {
    const { ctx, communityId, root, host, booker } = await setup()
    await seedBooking(root, communityId, { bookingId: "b_conf", hostUserId: host.userId, bookerUserId: booker.userId, status: "confirmed" })
    await seedBooking(root, communityId, { bookingId: "b_settled", hostUserId: host.userId, bookerUserId: booker.userId, status: "settled" })
    const url = (q: string) => `http://pirate.test/communities/${communityId}/bookings${q}`

    const hostAll = await getAuthed(url("?role=host"), ctx.env, host.accessToken)
    expect(hostAll.status).toBe(200)
    const hostIds = (await json(hostAll) as { data: { booking_id: string }[] }).data.map((b) => b.booking_id).sort()
    expect(hostIds).toEqual(["b_conf", "b_settled"])

    const bookerView = await getAuthed(url("?role=booker"), ctx.env, booker.accessToken)
    expect((await json(bookerView) as { data: unknown[] }).data.length).toBe(2)

    // The host querying as 'booker' sees none (they are not the booker).
    const hostAsBooker = await getAuthed(url("?role=booker"), ctx.env, host.accessToken)
    expect((await json(hostAsBooker) as { data: unknown[] }).data.length).toBe(0)

    // Status filter.
    const onlyConfirmed = await getAuthed(url("?role=host&status=confirmed"), ctx.env, host.accessToken)
    const confirmedData = (await json(onlyConfirmed) as { data: { booking_id: string }[] }).data
    expect(confirmedData.map((b) => b.booking_id)).toEqual(["b_conf"])

    // No sensitive fields leak in the list either.
    for (const row of (await json(await getAuthed(url("?role=host"), ctx.env, host.accessToken)) as { data: Record<string, unknown>[] }).data) {
      for (const key of SENSITIVE) expect(row).not.toHaveProperty(key)
    }
  })
})
