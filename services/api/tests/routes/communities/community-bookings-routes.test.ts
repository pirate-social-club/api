import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createClient } from "@libsql/client"

import { app } from "../../../src/index"
import { buildLocalCommunityDbUrl } from "../../../src/lib/communities/community-local-db"
import { bookingLockUsesAdvisory } from "../../../src/lib/communities/bookings/booking-hold-service"
import { setBookingPaymentVerifierForTests, setCommunityCommerceBuyerFundingVerifierForTests } from "../../../src/lib/communities/commerce/funding-proof-service"
import { createRouteTestContext, json, resetRuntimeCaches } from "../../helpers"
import { addCommunityMember, completeUniqueHumanVerification, exchangeJwt, requestJson } from "./community-routes-test-helpers"

type Ctx = Awaited<ReturnType<typeof createRouteTestContext>>
type Client = Ctx["client"]

let cleanup: (() => Promise<void>) | null = null
let verifierCalls = 0
beforeEach(() => {
  resetRuntimeCaches()
  verifierCalls = 0
  // Default: booking payment verification succeeds, echoing the expected sender from the intent.
  setBookingPaymentVerifierForTests(async (input) => {
    verifierCalls += 1
    return { kind: "verified", senderAddress: input.expected.senderAddress, txRef: input.fundingTxRef }
  })
})
afterEach(async () => {
  setBookingPaymentVerifierForTests(null)
  setCommunityCommerceBuyerFundingVerifierForTests(null)
  if (cleanup) { await cleanup(); cleanup = null }
})

// A bookable date ~7 days out: comfortably inside the read policy's 1h lead-time and 60d
// max-advance, so lead/advance filtering never interferes with these assertions.
function bookableDay() {
  const base = new Date(Date.now() + 7 * 86400_000)
  const dateStr = base.toISOString().slice(0, 10)
  return { dateStr, weekday: base.getUTCDay() }
}

async function createTestCommunity(env: Ctx["env"], accessToken: string): Promise<string> {
  const response = await requestJson("http://pirate.test/communities", {
    display_name: "Bookings Test Community",
    membership_mode: "request",
    handle_policy: { policy_template: "standard" },
  }, env, accessToken)
  expect(response.status).toBe(202)
  const body = await json(response) as { community: { id: string } }
  return body.community.id.replace(/^com_/, "")
}

async function seedProfile(client: Client, opts: {
  hostUserId: string
  hostTimezone?: string
  basePriceCents?: number
  isPublished?: boolean
  platformFeeBps?: number
}): Promise<void> {
  const now = new Date().toISOString()
  await client.execute({
    sql: `INSERT INTO booking_profiles (
            host_user_id, display_headline, bio, topics_json, intro_video_ref,
            host_timezone, base_price_cents, default_slot_duration_seconds,
            platform_fee_bps, payout_wallet_address, is_published, created_at, updated_at
          ) VALUES (?1, NULL, NULL, NULL, NULL, ?2, ?3, 1800, ?4, ?7, ?5, ?6, ?6)`,
    args: [
      opts.hostUserId,
      opts.hostTimezone ?? "UTC",
      opts.basePriceCents ?? 5000,
      opts.platformFeeBps ?? 1000,
      (opts.isPublished ?? true) ? 1 : 0,
      now,
      "0x1111111111111111111111111111111111111111",
    ],
  })
}

async function seedRule(client: Client, opts: {
  hostUserId: string
  weekday: number
  startLocal?: string
  endLocal?: string
}): Promise<void> {
  const now = new Date().toISOString()
  await client.execute({
    sql: `INSERT INTO booking_availability_rules (
            rule_id, host_user_id, by_weekday_json, start_local, end_local,
            slot_duration_seconds, effective_from_utc, effective_until_utc, created_at, updated_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, 1800, NULL, NULL, ?6, ?6)`,
    args: [
      `rule_${opts.hostUserId}_${opts.weekday}_${opts.startLocal ?? "09"}`,
      opts.hostUserId,
      JSON.stringify([opts.weekday]),
      opts.startLocal ?? "09:00",
      opts.endLocal ?? "11:00",
      now,
    ],
  })
}

async function seedPriceRule(client: Client, opts: {
  hostUserId: string
  matchLocalStart: string
  matchLocalEnd: string
  priceCents: number
}): Promise<void> {
  const now = new Date().toISOString()
  await client.execute({
    sql: `INSERT INTO booking_price_rules (
            price_rule_id, host_user_id, match_weekday_json, match_local_start, match_local_end,
            match_duration_seconds, price_cents, priority, created_at, updated_at
          ) VALUES (?1, ?2, NULL, ?3, ?4, NULL, ?5, 10, ?6, ?6)`,
    args: [`pr_${opts.hostUserId}_${opts.priceCents}`, opts.hostUserId, opts.matchLocalStart, opts.matchLocalEnd, opts.priceCents, now],
  })
}

async function seedHold(communityDbRoot: string, communityId: string, opts: {
  holdId: string
  hostUserId: string
  bookerUserId?: string
  slotStartUtc: string
  slotEndUtc: string
  status?: "active" | "consumed" | "expired"
  expiresAtUtc: string
}): Promise<void> {
  const client = createClient({ url: buildLocalCommunityDbUrl(communityDbRoot, communityId) })
  try {
    const now = new Date(Date.now() - 3600_000).toISOString() // created before expiry to satisfy CHECK
    await client.execute({
      sql: `INSERT INTO booking_holds (
              hold_id, community_id, host_user_id, booker_user_id, slot_start_utc, slot_end_utc,
              price_cents, status, expires_at_utc, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?9, ?4, ?5, 5000, ?6, ?7, ?8, ?8)`,
      args: [opts.holdId, communityId, opts.hostUserId, opts.slotStartUtc, opts.slotEndUtc, opts.status ?? "active", opts.expiresAtUtc, now, opts.bookerUserId ?? "booker_test"],
    })
  } finally {
    client.close()
  }
}

async function seedBooking(communityDbRoot: string, communityId: string, opts: {
  bookingId: string
  hostUserId: string
  slotStartUtc: string
  slotEndUtc: string
  status: string
}): Promise<void> {
  const client = createClient({ url: buildLocalCommunityDbUrl(communityDbRoot, communityId) })
  try {
    const now = new Date().toISOString()
    await client.execute({
      sql: `INSERT INTO bookings (
              booking_id, community_id, hold_id, host_user_id, booker_user_id, slot_start_utc, slot_end_utc,
              gross_cents, platform_fee_bps, platform_fee_cents, host_payout_cents, status, created_at, updated_at
            ) VALUES (?1, ?2, NULL, ?3, 'booker_test', ?4, ?5, 5000, 1000, 500, 4500, ?6, ?7, ?7)`,
      args: [opts.bookingId, communityId, opts.hostUserId, opts.slotStartUtc, opts.slotEndUtc, opts.status, now],
    })
  } finally {
    client.close()
  }
}

interface Slot { startUtc: string; endUtc: string; priceCents: number; available: boolean }

async function getSlots(env: Ctx["env"], communityId: string, hostUserId: string, accessToken: string, params: Record<string, string>) {
  const qs = new URLSearchParams(params).toString()
  return app.request(
    `http://pirate.test/communities/${communityId}/booking-hosts/${hostUserId}/slots?${qs}`,
    { headers: { authorization: `Bearer ${accessToken}` } },
    env,
  )
}

async function setupHost(): Promise<{ ctx: Ctx; communityId: string; host: { accessToken: string; userId: string } }> {
  const ctx = await createRouteTestContext()
  cleanup = ctx.cleanup
  const host = await exchangeJwt(ctx.env, "booking-host")
  await completeUniqueHumanVerification(ctx.env, host.accessToken)
  const communityId = await createTestCommunity(ctx.env, host.accessToken)
  return { ctx, communityId, host }
}

describe("community bookings — availability read path (Slice A)", () => {
  test("published host profile returns priced, available slots", async () => {
    const { ctx, communityId, host } = await setupHost()
    const { dateStr, weekday } = bookableDay()
    await seedProfile(ctx.client, { hostUserId: host.userId, basePriceCents: 5000 })
    await seedRule(ctx.client, { hostUserId: host.userId, weekday })

    const res = await getSlots(ctx.env, communityId, host.userId, host.accessToken, {
      from: `${dateStr}T00:00:00Z`, to: `${dateStr}T23:59:59Z`, tz: "UTC",
    })
    expect(res.status).toBe(200)
    const body = await json(res) as { host_timezone: string; slots: Slot[] }
    expect(body.host_timezone).toBe("UTC")
    // 09:00-11:00 UTC, 30-min slots → 09:00, 09:30, 10:00, 10:30
    expect(body.slots.length).toBe(4)
    expect(body.slots.every((s) => s.available)).toBe(true)
    expect(body.slots.every((s) => s.priceCents === 5000)).toBe(true)
    expect(body.slots.find((s) => s.startUtc === `${dateStr}T09:00:00Z`)).toBeDefined()
  })

  test("unpublished profile is not bookable (404)", async () => {
    const { ctx, communityId, host } = await setupHost()
    const { dateStr, weekday } = bookableDay()
    await seedProfile(ctx.client, { hostUserId: host.userId, isPublished: false })
    await seedRule(ctx.client, { hostUserId: host.userId, weekday })
    const res = await getSlots(ctx.env, communityId, host.userId, host.accessToken, {
      from: `${dateStr}T00:00:00Z`, to: `${dateStr}T23:59:59Z`,
    })
    expect(res.status).toBe(404)
  })

  test("missing profile is not bookable (404)", async () => {
    const { ctx, communityId, host } = await setupHost()
    const { dateStr } = bookableDay()
    const res = await getSlots(ctx.env, communityId, host.userId, host.accessToken, {
      from: `${dateStr}T00:00:00Z`, to: `${dateStr}T23:59:59Z`,
    })
    expect(res.status).toBe(404)
  })

  test("variable pricing resolves time-of-day in the profile host_timezone", async () => {
    const { ctx, communityId, host } = await setupHost()
    const { dateStr, weekday } = bookableDay()
    // Vienna (CEST = UTC+2 in summer). Rule 17:00-19:00 local → slots 15:00/15:30/16:00/16:30 UTC.
    await seedProfile(ctx.client, { hostUserId: host.userId, hostTimezone: "Europe/Vienna", basePriceCents: 5000 })
    await seedRule(ctx.client, { hostUserId: host.userId, weekday, startLocal: "17:00", endLocal: "19:00" })
    // Premium for local 18:00-19:00 → applies to 18:00 Vienna (16:00 UTC), not 17:00 (15:00 UTC).
    await seedPriceRule(ctx.client, { hostUserId: host.userId, matchLocalStart: "18:00", matchLocalEnd: "19:00", priceCents: 9000 })

    const res = await getSlots(ctx.env, communityId, host.userId, host.accessToken, {
      from: `${dateStr}T00:00:00Z`, to: `${dateStr}T23:59:59Z`, tz: "Europe/Vienna",
    })
    expect(res.status).toBe(200)
    const body = await json(res) as { slots: Slot[] }
    expect(body.slots.find((s) => s.startUtc === `${dateStr}T16:00:00Z`)?.priceCents).toBe(9000) // 18:00 Vienna
    expect(body.slots.find((s) => s.startUtc === `${dateStr}T15:00:00Z`)?.priceCents).toBe(5000) // 17:00 Vienna
  })

  test("active hold makes the overlapping slot unavailable", async () => {
    const { ctx, communityId, host } = await setupHost()
    const { dateStr, weekday } = bookableDay()
    await seedProfile(ctx.client, { hostUserId: host.userId })
    await seedRule(ctx.client, { hostUserId: host.userId, weekday })
    await seedHold(String(ctx.env.LOCAL_COMMUNITY_DB_ROOT), communityId, {
      holdId: "hold_active", hostUserId: host.userId,
      slotStartUtc: `${dateStr}T09:30:00Z`, slotEndUtc: `${dateStr}T10:00:00Z`,
      status: "active", expiresAtUtc: new Date(Date.now() + 3600_000).toISOString(),
    })
    const res = await getSlots(ctx.env, communityId, host.userId, host.accessToken, {
      from: `${dateStr}T00:00:00Z`, to: `${dateStr}T23:59:59Z`,
    })
    const body = await json(res) as { slots: Slot[] }
    expect(body.slots.find((s) => s.startUtc === `${dateStr}T09:30:00Z`)?.available).toBe(false)
    expect(body.slots.find((s) => s.startUtc === `${dateStr}T09:00:00Z`)?.available).toBe(true)
  })

  test("confirmed and live bookings make their slots unavailable", async () => {
    const { ctx, communityId, host } = await setupHost()
    const { dateStr, weekday } = bookableDay()
    await seedProfile(ctx.client, { hostUserId: host.userId })
    await seedRule(ctx.client, { hostUserId: host.userId, weekday })
    await seedBooking(String(ctx.env.LOCAL_COMMUNITY_DB_ROOT), communityId, {
      bookingId: "bk_confirmed", hostUserId: host.userId,
      slotStartUtc: `${dateStr}T09:00:00Z`, slotEndUtc: `${dateStr}T09:30:00Z`, status: "confirmed",
    })
    await seedBooking(String(ctx.env.LOCAL_COMMUNITY_DB_ROOT), communityId, {
      bookingId: "bk_live", hostUserId: host.userId,
      slotStartUtc: `${dateStr}T09:30:00Z`, slotEndUtc: `${dateStr}T10:00:00Z`, status: "live",
    })
    const res = await getSlots(ctx.env, communityId, host.userId, host.accessToken, {
      from: `${dateStr}T00:00:00Z`, to: `${dateStr}T23:59:59Z`,
    })
    const body = await json(res) as { slots: Slot[] }
    expect(body.slots.find((s) => s.startUtc === `${dateStr}T09:00:00Z`)?.available).toBe(false)
    expect(body.slots.find((s) => s.startUtc === `${dateStr}T09:30:00Z`)?.available).toBe(false)
    expect(body.slots.find((s) => s.startUtc === `${dateStr}T10:00:00Z`)?.available).toBe(true)
  })

  test("expired and consumed holds do not block", async () => {
    const { ctx, communityId, host } = await setupHost()
    const { dateStr, weekday } = bookableDay()
    await seedProfile(ctx.client, { hostUserId: host.userId })
    await seedRule(ctx.client, { hostUserId: host.userId, weekday })
    await seedHold(String(ctx.env.LOCAL_COMMUNITY_DB_ROOT), communityId, {
      holdId: "hold_expired", hostUserId: host.userId,
      slotStartUtc: `${dateStr}T09:00:00Z`, slotEndUtc: `${dateStr}T09:30:00Z`,
      status: "expired", expiresAtUtc: new Date(Date.now() + 3600_000).toISOString(),
    })
    await seedHold(String(ctx.env.LOCAL_COMMUNITY_DB_ROOT), communityId, {
      holdId: "hold_consumed", hostUserId: host.userId,
      slotStartUtc: `${dateStr}T09:30:00Z`, slotEndUtc: `${dateStr}T10:00:00Z`,
      status: "consumed", expiresAtUtc: new Date(Date.now() + 3600_000).toISOString(),
    })
    const res = await getSlots(ctx.env, communityId, host.userId, host.accessToken, {
      from: `${dateStr}T00:00:00Z`, to: `${dateStr}T23:59:59Z`,
    })
    const body = await json(res) as { slots: Slot[] }
    expect(body.slots.find((s) => s.startUtc === `${dateStr}T09:00:00Z`)?.available).toBe(true)
    expect(body.slots.find((s) => s.startUtc === `${dateStr}T09:30:00Z`)?.available).toBe(true)
  })

  test("cancelled and refunded bookings do not block", async () => {
    const { ctx, communityId, host } = await setupHost()
    const { dateStr, weekday } = bookableDay()
    await seedProfile(ctx.client, { hostUserId: host.userId })
    await seedRule(ctx.client, { hostUserId: host.userId, weekday })
    await seedBooking(String(ctx.env.LOCAL_COMMUNITY_DB_ROOT), communityId, {
      bookingId: "bk_cancelled", hostUserId: host.userId,
      slotStartUtc: `${dateStr}T09:00:00Z`, slotEndUtc: `${dateStr}T09:30:00Z`, status: "cancelled_by_booker",
    })
    await seedBooking(String(ctx.env.LOCAL_COMMUNITY_DB_ROOT), communityId, {
      bookingId: "bk_refunded", hostUserId: host.userId,
      slotStartUtc: `${dateStr}T09:30:00Z`, slotEndUtc: `${dateStr}T10:00:00Z`, status: "refunded",
    })
    const res = await getSlots(ctx.env, communityId, host.userId, host.accessToken, {
      from: `${dateStr}T00:00:00Z`, to: `${dateStr}T23:59:59Z`,
    })
    const body = await json(res) as { slots: Slot[] }
    expect(body.slots.find((s) => s.startUtc === `${dateStr}T09:00:00Z`)?.available).toBe(true)
    expect(body.slots.find((s) => s.startUtc === `${dateStr}T09:30:00Z`)?.available).toBe(true)
  })

  test("window end is exclusive", async () => {
    const { ctx, communityId, host } = await setupHost()
    const { dateStr, weekday } = bookableDay()
    await seedProfile(ctx.client, { hostUserId: host.userId })
    await seedRule(ctx.client, { hostUserId: host.userId, weekday })
    // Window [09:00, 09:30): start inclusive keeps 09:00, end exclusive drops 09:30.
    const res = await getSlots(ctx.env, communityId, host.userId, host.accessToken, {
      from: `${dateStr}T09:00:00Z`, to: `${dateStr}T09:30:00Z`,
    })
    const body = await json(res) as { slots: Slot[] }
    expect(body.slots.find((s) => s.startUtc === `${dateStr}T09:00:00Z`)).toBeDefined()
    expect(body.slots.find((s) => s.startUtc === `${dateStr}T09:30:00Z`)).toBeUndefined()
  })

  test("host-local timezone determines the booking day across the UTC date boundary", async () => {
    const { ctx, communityId, host } = await setupHost()
    // Next UTC Saturday, 7+ days out. At UTC Sat 22:00, Tokyo (UTC+9, no DST) is Sunday 07:00.
    let d = new Date(Date.now() + 7 * 86400_000)
    while (d.getUTCDay() !== 6) d = new Date(d.getTime() + 86400_000)
    const satStr = d.toISOString().slice(0, 10)
    // Host in Tokyo, rule for SUNDAY (host-local) 07:00-08:00 → Tokyo Sun 07:00/07:30 = UTC Sat 22:00/22:30.
    // A UTC-based weekday interpretation would find NO Sunday slot in this UTC-Saturday window.
    await seedProfile(ctx.client, { hostUserId: host.userId, hostTimezone: "Asia/Tokyo", basePriceCents: 5000 })
    await seedRule(ctx.client, { hostUserId: host.userId, weekday: 0, startLocal: "07:00", endLocal: "08:00" })

    const res = await getSlots(ctx.env, communityId, host.userId, host.accessToken, {
      from: `${satStr}T20:00:00Z`, to: `${satStr}T23:59:59Z`, tz: "Asia/Tokyo",
    })
    expect(res.status).toBe(200)
    const body = await json(res) as { host_timezone: string; slots: Slot[] }
    expect(body.host_timezone).toBe("Asia/Tokyo")
    expect(body.slots.find((s) => s.startUtc === `${satStr}T22:00:00Z`)?.available).toBe(true) // Tokyo Sun 07:00
    expect(body.slots.find((s) => s.startUtc === `${satStr}T22:30:00Z`)?.available).toBe(true) // Tokyo Sun 07:30
    expect(body.slots.find((s) => s.startUtc === `${satStr}T22:00:00Z`)?.priceCents).toBe(5000)
  })
})

async function seedHostSlotLock(client: Client, opts: {
  lockId: string; hostUserId: string; slotStartUtc: string; slotEndUtc: string
  communityId: string; status?: "active" | "released"; expiresAtUtc: string
}): Promise<void> {
  const now = new Date().toISOString()
  await client.execute({
    sql: `INSERT INTO booking_host_slot_locks (
            lock_id, host_user_id, slot_start_utc, slot_end_utc, community_id, hold_id, booking_id,
            status, expires_at_utc, created_at, updated_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, NULL, NULL, ?6, ?7, ?8, ?8)`,
    args: [opts.lockId, opts.hostUserId, opts.slotStartUtc, opts.slotEndUtc, opts.communityId, opts.status ?? "active", opts.expiresAtUtc, now],
  })
}

async function lockStatuses(client: Client, hostUserId: string, slotStartUtc: string): Promise<string[]> {
  const r = await client.execute({
    sql: `SELECT status FROM booking_host_slot_locks WHERE host_user_id = ?1 AND slot_start_utc = ?2`,
    args: [hostUserId, slotStartUtc],
  })
  return r.rows.map((row) => String(row.status))
}

async function activeHoldCount(communityDbRoot: string, communityId: string, hostUserId: string): Promise<number> {
  const client = createClient({ url: buildLocalCommunityDbUrl(communityDbRoot, communityId) })
  try {
    const r = await client.execute({
      sql: `SELECT COUNT(*) AS n FROM booking_holds WHERE host_user_id = ?1 AND status = 'active'`,
      args: [hostUserId],
    })
    return Number(r.rows[0]?.n ?? 0)
  } finally {
    client.close()
  }
}

async function postHold(env: Ctx["env"], communityId: string, hostUserId: string, token: string, slotStartUtc: string, slotEndUtc: string) {
  return app.request(
    `http://pirate.test/communities/${communityId}/booking-hosts/${hostUserId}/holds`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ slot_start_utc: slotStartUtc, slot_end_utc: slotEndUtc }),
    },
    env,
  )
}

describe("community bookings — hold creation (Slice B)", () => {
  test("creates a hold: 201, per-community hold row + active cross-community lock", async () => {
    const { ctx, communityId, host } = await setupHost()
    const { dateStr, weekday } = bookableDay()
    await seedProfile(ctx.client, { hostUserId: host.userId })
    await seedRule(ctx.client, { hostUserId: host.userId, weekday })

    const res = await postHold(ctx.env, communityId, host.userId, host.accessToken, `${dateStr}T09:00:00Z`, `${dateStr}T09:30:00Z`)
    expect(res.status).toBe(201)
    const body = await json(res) as { hold: { status: string; price_cents: number } }
    expect(body.hold.status).toBe("active")
    expect(body.hold.price_cents).toBe(5000)
    expect(await activeHoldCount(String(ctx.env.LOCAL_COMMUNITY_DB_ROOT), communityId, host.userId)).toBe(1)
    expect(await lockStatuses(ctx.client, host.userId, `${dateStr}T09:00:00Z`)).toEqual(["active"])
  })

  test("same-community: a second hold on the same slot is rejected (409)", async () => {
    const { ctx, communityId, host } = await setupHost()
    const { dateStr, weekday } = bookableDay()
    await seedProfile(ctx.client, { hostUserId: host.userId })
    await seedRule(ctx.client, { hostUserId: host.userId, weekday })

    const first = await postHold(ctx.env, communityId, host.userId, host.accessToken, `${dateStr}T09:00:00Z`, `${dateStr}T09:30:00Z`)
    expect(first.status).toBe(201)
    const second = await postHold(ctx.env, communityId, host.userId, host.accessToken, `${dateStr}T09:00:00Z`, `${dateStr}T09:30:00Z`)
    expect(second.status).toBe(409)
  })

  test("cross-community: a hold overlapping the host's lock in ANOTHER community is rejected", async () => {
    const { ctx, communityId, host } = await setupHost()
    const { dateStr, weekday } = bookableDay()
    await seedProfile(ctx.client, { hostUserId: host.userId })
    await seedRule(ctx.client, { hostUserId: host.userId, weekday })
    // The host is already committed 09:00-10:00 in some OTHER community (60-min lock).
    await seedHostSlotLock(ctx.client, {
      lockId: "blk_other_community", hostUserId: host.userId,
      slotStartUtc: `${dateStr}T09:00:00Z`, slotEndUtc: `${dateStr}T10:00:00Z`,
      communityId: "other-community", expiresAtUtc: new Date(Date.now() + 3600_000).toISOString(),
    })
    // 09:30-10:00 here overlaps the 09:00-10:00 lock with a DIFFERENT start → interval overlap.
    const overlapping = await postHold(ctx.env, communityId, host.userId, host.accessToken, `${dateStr}T09:30:00Z`, `${dateStr}T10:00:00Z`)
    expect(overlapping.status).toBe(409)
    const overlapBody = await json(overlapping) as { error: string }
    expect(overlapBody.error).toBe("slot_locked")
    // No per-community hold was written for the rejected request.
    expect(await activeHoldCount(String(ctx.env.LOCAL_COMMUNITY_DB_ROOT), communityId, host.userId)).toBe(0)
  })

  test("cross-community: a touching (non-overlapping) slot is allowed", async () => {
    const { ctx, communityId, host } = await setupHost()
    const { dateStr, weekday } = bookableDay()
    await seedProfile(ctx.client, { hostUserId: host.userId })
    await seedRule(ctx.client, { hostUserId: host.userId, weekday })
    await seedHostSlotLock(ctx.client, {
      lockId: "blk_touching", hostUserId: host.userId,
      slotStartUtc: `${dateStr}T09:00:00Z`, slotEndUtc: `${dateStr}T09:30:00Z`,
      communityId: "other-community", expiresAtUtc: new Date(Date.now() + 3600_000).toISOString(),
    })
    // 09:30-10:00 touches the 09:00-09:30 lock end but does not overlap → allowed.
    const touching = await postHold(ctx.env, communityId, host.userId, host.accessToken, `${dateStr}T09:30:00Z`, `${dateStr}T10:00:00Z`)
    expect(touching.status).toBe(201)
  })

  test("D1 hold insert failure releases the cross-community lock (compensation)", async () => {
    const { ctx, communityId, host } = await setupHost()
    const { dateStr, weekday } = bookableDay()
    await seedProfile(ctx.client, { hostUserId: host.userId })
    await seedRule(ctx.client, { hostUserId: host.userId, weekday })
    // Make every booking_holds INSERT abort (SELECTs in the read path still work).
    const cdb = createClient({ url: buildLocalCommunityDbUrl(String(ctx.env.LOCAL_COMMUNITY_DB_ROOT), communityId) })
    try {
      await cdb.execute("CREATE TRIGGER booking_holds_block_insert BEFORE INSERT ON booking_holds BEGIN SELECT RAISE(ABORT, 'blocked for test'); END")
    } finally {
      cdb.close()
    }

    const res = await postHold(ctx.env, communityId, host.userId, host.accessToken, `${dateStr}T09:00:00Z`, `${dateStr}T09:30:00Z`)
    expect(res.status).toBe(500)
    const body = await json(res) as { error: string }
    expect(body.error).toBe("hold_insert_failed")
    // The cross-community lock acquired for this attempt must be released (not left 'active').
    expect(await lockStatuses(ctx.client, host.userId, `${dateStr}T09:00:00Z`)).toEqual(["released"])
  })

  test("an expired control-plane lock is reclaimed and does not block a new hold", async () => {
    const { ctx, communityId, host } = await setupHost()
    const { dateStr, weekday } = bookableDay()
    await seedProfile(ctx.client, { hostUserId: host.userId })
    await seedRule(ctx.client, { hostUserId: host.userId, weekday })
    // A stale lock: still 'active' but already expired (the release/sweep job lagged).
    await seedHostSlotLock(ctx.client, {
      lockId: "blk_stale", hostUserId: host.userId,
      slotStartUtc: `${dateStr}T09:00:00Z`, slotEndUtc: `${dateStr}T09:30:00Z`,
      communityId: "other-community", status: "active",
      expiresAtUtc: new Date(Date.now() - 60_000).toISOString(),
    })

    const res = await postHold(ctx.env, communityId, host.userId, host.accessToken, `${dateStr}T09:00:00Z`, `${dateStr}T09:30:00Z`)
    expect(res.status).toBe(201)
    // The stale lock is reclaimed (released) and a fresh active lock is created for the slot.
    expect((await lockStatuses(ctx.client, host.userId, `${dateStr}T09:00:00Z`)).sort()).toEqual(["active", "released"])
  })

  test("advisory lock is used on Postgres and skipped on SQLite (dialect seam)", () => {
    expect(bookingLockUsesAdvisory({ CONTROL_PLANE_DATABASE_URL: "file:/tmp/cp.db" } as unknown as Ctx["env"])).toBe(false)
    expect(bookingLockUsesAdvisory({ CONTROL_PLANE_DATABASE_URL: "postgresql://u:p@h:5432/db" } as unknown as Ctx["env"])).toBe(true)
  })
})

async function insertWalletAttachment(client: Client, userId: string, walletAttachmentId: string, address = "0x7000000000000000000000000000000000000007"): Promise<void> {
  const now = new Date().toISOString()
  await client.execute({
    sql: `INSERT INTO wallet_attachments (
            wallet_attachment_id, user_id, chain_namespace, wallet_address_normalized, wallet_address_display,
            source_provider, source_subject, attachment_kind, is_primary, status, attached_at, detached_at, created_at, updated_at
          ) VALUES (?1, ?2, 'eip155', ?3, ?4, 'test', ?5, 'external', 0, 'active', ?6, NULL, ?6, ?6)`,
    args: [walletAttachmentId, userId, address.toLowerCase(), address, `test|${userId}|${walletAttachmentId}`, now],
  })
}

async function createActiveHold(ctx: Ctx, communityId: string, host: { accessToken: string; userId: string }, slotStart: string, slotEnd: string): Promise<string> {
  const res = await postHold(ctx.env, communityId, host.userId, host.accessToken, slotStart, slotEnd)
  expect(res.status).toBe(201)
  return (await json(res) as { hold: { hold_id: string } }).hold.hold_id
}

async function postQuote(env: Ctx["env"], communityId: string, holdId: string, token: string) {
  return app.request(
    `http://pirate.test/communities/${communityId}/booking-holds/${holdId}/quote`,
    { method: "POST", headers: { authorization: `Bearer ${token}` } },
    env,
  )
}

async function postConfirm(env: Ctx["env"], communityId: string, holdId: string, token: string, fundingTxRef: string, walletAttachmentId: string) {
  return app.request(
    `http://pirate.test/communities/${communityId}/booking-holds/${holdId}/confirm`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ funding_tx_ref: fundingTxRef, wallet_attachment_id: walletAttachmentId }),
    },
    env,
  )
}

async function lockForHold(client: Client, holdId: string): Promise<{ status: string; expires_at_utc: unknown; booking_id: unknown } | undefined> {
  const r = await client.execute({
    sql: `SELECT status, expires_at_utc, booking_id FROM booking_host_slot_locks WHERE hold_id = ?1`,
    args: [holdId],
  })
  const row = r.rows[0]
  return row ? { status: String(row.status), expires_at_utc: row.expires_at_utc, booking_id: row.booking_id } : undefined
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

describe("community bookings — quote + confirm (Slice C)", () => {
  test("quote derives gross/fee/host payout from the hold price snapshot", async () => {
    const { ctx, communityId, host } = await setupHost()
    const { dateStr, weekday } = bookableDay()
    await seedProfile(ctx.client, { hostUserId: host.userId, basePriceCents: 5000, platformFeeBps: 1000 })
    await seedRule(ctx.client, { hostUserId: host.userId, weekday })
    const holdId = await createActiveHold(ctx, communityId, host, `${dateStr}T09:00:00Z`, `${dateStr}T09:30:00Z`)

    const res = await postQuote(ctx.env, communityId, holdId, host.accessToken)
    expect(res.status).toBe(200)
    const body = await json(res) as { quote: { gross_cents: number; platform_fee_cents: number; host_payout_cents: number } }
    expect(body.quote.gross_cents).toBe(5000)
    expect(body.quote.platform_fee_cents).toBe(500)
    expect(body.quote.host_payout_cents).toBe(4500)
  })

  test("verified funding confirms the booking, consumes the hold, makes the lock permanent", async () => {
    const { ctx, communityId, host } = await setupHost()
    const { dateStr, weekday } = bookableDay()
    await seedProfile(ctx.client, { hostUserId: host.userId, basePriceCents: 5000 })
    await seedRule(ctx.client, { hostUserId: host.userId, weekday })
    await insertWalletAttachment(ctx.client, host.userId, "wal_booker")
    const holdId = await createActiveHold(ctx, communityId, host, `${dateStr}T09:00:00Z`, `${dateStr}T09:30:00Z`)

    const res = await postConfirm(ctx.env, communityId, holdId, host.accessToken, "0xfunding-ok", "wal_booker")
    expect(res.status).toBe(201)
    const body = await json(res) as { booking: { status: string; gross_cents: number; platform_fee_cents: number; host_payout_cents: number; funding_tx_ref: string } }
    expect(body.booking.status).toBe("confirmed")
    expect(body.booking.gross_cents).toBe(5000)
    expect(body.booking.platform_fee_cents).toBe(500)
    expect(body.booking.host_payout_cents).toBe(4500)
    expect(body.booking.funding_tx_ref).toBe("0xfunding-ok")
    // hold consumed
    expect(await communityScalar(String(ctx.env.LOCAL_COMMUNITY_DB_ROOT), communityId, "SELECT status FROM booking_holds WHERE hold_id = ?1", [holdId])).toBe("consumed")
    // lock made permanent: expiry NULL + booking_id attached (so Slice B reclaim can't free it)
    const lock = await lockForHold(ctx.client, holdId)
    expect(lock?.status).toBe("active")
    expect(lock?.expires_at_utc).toBeNull()
    expect(lock?.booking_id).toBeTruthy()
  })

  test("fake funding is rejected: no booking, hold and hold-lock left intact", async () => {
    const { ctx, communityId, host } = await setupHost()
    const { dateStr, weekday } = bookableDay()
    await seedProfile(ctx.client, { hostUserId: host.userId })
    await seedRule(ctx.client, { hostUserId: host.userId, weekday })
    await insertWalletAttachment(ctx.client, host.userId, "wal_booker")
    const holdId = await createActiveHold(ctx, communityId, host, `${dateStr}T09:00:00Z`, `${dateStr}T09:30:00Z`)

    // A definitive mismatch (no matching transfer) is a terminal rejection — no booking, hold intact.
    setBookingPaymentVerifierForTests(async () => ({ kind: "rejected", reason: "no_matching_transfer" }))
    const res = await postConfirm(ctx.env, communityId, holdId, host.accessToken, "0xfake", "wal_booker")
    expect(res.status).toBe(409)
    expect((await json(res) as { error: string }).error).toBe("payment_rejected")
    // No booking written.
    expect(await communityScalar(String(ctx.env.LOCAL_COMMUNITY_DB_ROOT), communityId, "SELECT COUNT(*) FROM bookings WHERE hold_id = ?1", [holdId])).toBe(0)
    // Hold still active and its lock still a (non-permanent) hold-lock.
    expect(await communityScalar(String(ctx.env.LOCAL_COMMUNITY_DB_ROOT), communityId, "SELECT status FROM booking_holds WHERE hold_id = ?1", [holdId])).toBe("active")
    const lock = await lockForHold(ctx.client, holdId)
    expect(lock?.status).toBe("active")
    expect(lock?.expires_at_utc).not.toBeNull()
  })

  test("an expired hold cannot be confirmed (409)", async () => {
    const { ctx, communityId, host } = await setupHost()
    const { dateStr } = bookableDay()
    // Directly seed an expired (but active-status, CHECK-valid) hold.
    await seedHold(String(ctx.env.LOCAL_COMMUNITY_DB_ROOT), communityId, {
      holdId: "hld_expired", hostUserId: host.userId, bookerUserId: host.userId,
      slotStartUtc: `${dateStr}T09:00:00Z`, slotEndUtc: `${dateStr}T09:30:00Z`,
      status: "active", expiresAtUtc: new Date(Date.now() - 60_000).toISOString(),
    })
    await insertWalletAttachment(ctx.client, host.userId, "wal_booker")
    const res = await postConfirm(ctx.env, communityId, "hld_expired", host.accessToken, "0xfunding-ok", "wal_booker")
    expect(res.status).toBe(409)
    expect((await json(res) as { error: string }).error).toBe("hold_expired")
  })

  test("repeated confirm is idempotent: one booking, funding verified exactly once", async () => {
    const { ctx, communityId, host } = await setupHost()
    const { dateStr, weekday } = bookableDay()
    await seedProfile(ctx.client, { hostUserId: host.userId })
    await seedRule(ctx.client, { hostUserId: host.userId, weekday })
    await insertWalletAttachment(ctx.client, host.userId, "wal_booker")
    const holdId = await createActiveHold(ctx, communityId, host, `${dateStr}T09:00:00Z`, `${dateStr}T09:30:00Z`)

    const first = await postConfirm(ctx.env, communityId, holdId, host.accessToken, "0xfunding-ok", "wal_booker")
    expect(first.status).toBe(201)
    const firstBooking = (await json(first) as { booking: { booking_id: string } }).booking.booking_id

    const second = await postConfirm(ctx.env, communityId, holdId, host.accessToken, "0xfunding-ok", "wal_booker")
    expect(second.status).toBe(200)
    const secondBody = await json(second) as { booking: { booking_id: string }; already_confirmed: boolean }
    expect(secondBody.already_confirmed).toBe(true)
    expect(secondBody.booking.booking_id).toBe(firstBooking)
    // Exactly one booking and exactly one funding verification (no re-charge).
    expect(await communityScalar(String(ctx.env.LOCAL_COMMUNITY_DB_ROOT), communityId, "SELECT COUNT(*) FROM bookings WHERE hold_id = ?1", [holdId])).toBe(1)
    expect(verifierCalls).toBe(1)
  })

  test("a different user cannot confirm someone else's hold (404), hold untouched", async () => {
    const { ctx, communityId, host } = await setupHost()
    const { dateStr, weekday } = bookableDay()
    await seedProfile(ctx.client, { hostUserId: host.userId })
    await seedRule(ctx.client, { hostUserId: host.userId, weekday })
    await insertWalletAttachment(ctx.client, host.userId, "wal_booker")
    const holdId = await createActiveHold(ctx, communityId, host, `${dateStr}T09:00:00Z`, `${dateStr}T09:30:00Z`)

    // A different authenticated, community-member user attempts to confirm the host's hold.
    const intruder = await exchangeJwt(ctx.env, "booking-intruder")
    await completeUniqueHumanVerification(ctx.env, intruder.accessToken)
    await addCommunityMember(String(ctx.env.LOCAL_COMMUNITY_DB_ROOT), communityId, intruder.userId)
    await insertWalletAttachment(ctx.client, intruder.userId, "wal_intruder", "0x8000000000000000000000000000000000000008")

    const res = await postConfirm(ctx.env, communityId, holdId, intruder.accessToken, "0xfunding-ok", "wal_intruder")
    expect(res.status).toBe(404)
    // Hold stays active, no booking, verifier never invoked.
    expect(await communityScalar(String(ctx.env.LOCAL_COMMUNITY_DB_ROOT), communityId, "SELECT status FROM booking_holds WHERE hold_id = ?1", [holdId])).toBe("active")
    expect(await communityScalar(String(ctx.env.LOCAL_COMMUNITY_DB_ROOT), communityId, "SELECT COUNT(*) FROM bookings WHERE hold_id = ?1", [holdId])).toBe(0)
    expect(verifierCalls).toBe(0)
  })

  test("repeated confirm repairs a lock left non-permanent by a prior partial confirm", async () => {
    const { ctx, communityId, host } = await setupHost()
    const { dateStr, weekday } = bookableDay()
    await seedProfile(ctx.client, { hostUserId: host.userId })
    await seedRule(ctx.client, { hostUserId: host.userId, weekday })
    await insertWalletAttachment(ctx.client, host.userId, "wal_booker")
    const holdId = await createActiveHold(ctx, communityId, host, `${dateStr}T09:00:00Z`, `${dateStr}T09:30:00Z`)

    expect((await postConfirm(ctx.env, communityId, holdId, host.accessToken, "0xfunding-ok", "wal_booker")).status).toBe(201)
    // Simulate a prior confirm that committed the booking but failed to clear the lock expiry.
    await ctx.client.execute({
      sql: `UPDATE booking_host_slot_locks SET expires_at_utc = ?2 WHERE hold_id = ?1`,
      args: [holdId, new Date(Date.now() + 3600_000).toISOString()],
    })
    expect((await lockForHold(ctx.client, holdId))?.expires_at_utc).not.toBeNull()

    // Repeated confirm (idempotent path) self-repairs the lock back to permanent.
    const repair = await postConfirm(ctx.env, communityId, holdId, host.accessToken, "0xfunding-ok", "wal_booker")
    expect(repair.status).toBe(200)
    expect((await lockForHold(ctx.client, holdId))?.expires_at_utc).toBeNull()
  })
})

describe("community bookings — payment intent (Slice C hardening)", () => {
  async function readIntent(root: string, communityId: string, holdId: string): Promise<Record<string, unknown> | null> {
    const c = createClient({ url: buildLocalCommunityDbUrl(root, communityId) })
    try {
      const r = await c.execute({ sql: `SELECT * FROM booking_payment_intents WHERE payment_intent_id = ?1`, args: [`bpi_${holdId}`] })
      return r.rows[0] ? (r.rows[0] as Record<string, unknown>) : null
    } finally { c.close() }
  }
  async function setIntent(root: string, communityId: string, holdId: string, fields: { status?: string; claimed_tx_ref?: string; verified_sender_address?: string }): Promise<void> {
    const c = createClient({ url: buildLocalCommunityDbUrl(root, communityId) })
    try {
      await c.execute({
        sql: `UPDATE booking_payment_intents SET status = COALESCE(?2, status), claimed_tx_ref = COALESCE(?3, claimed_tx_ref),
                verified_sender_address = COALESCE(?4, verified_sender_address), updated_at = ?5 WHERE payment_intent_id = ?1`,
        args: [`bpi_${holdId}`, fields.status ?? null, fields.claimed_tx_ref ?? null, fields.verified_sender_address ?? null, new Date().toISOString()],
      })
    } finally { c.close() }
  }
  async function prep() {
    const { ctx, communityId, host } = await setupHost()
    const { dateStr, weekday } = bookableDay()
    await seedProfile(ctx.client, { hostUserId: host.userId, basePriceCents: 5000 })
    await seedRule(ctx.client, { hostUserId: host.userId, weekday })
    await insertWalletAttachment(ctx.client, host.userId, "wal_booker")
    return { ctx, communityId, host, dateStr }
  }

  test("quote returns persisted payment instructions (deposit address only, no payout snapshot)", async () => {
    const { ctx, communityId, host, dateStr } = await prep()
    const holdId = await createActiveHold(ctx, communityId, host, `${dateStr}T09:00:00Z`, `${dateStr}T09:30:00Z`)
    const body = await json(await postQuote(ctx.env, communityId, holdId, host.accessToken)) as { quote: { payment: Record<string, unknown> } }
    const p = body.quote.payment
    expect(p.amount_atomic).toBe("50000000") // 5000 cents → 50 USDC at 6 decimals
    expect(p.token_decimals).toBe(6)
    expect(typeof p.recipient_address).toBe("string")
    expect(p.payment_intent_id).toBe(`bpi_${holdId}`)
    expect(JSON.stringify(p)).not.toContain("payout") // never expose payout snapshots/coordinator internals
    expect(JSON.stringify(p)).not.toContain("private")
  })

  test("re-quoting an active hold returns the same immutable intent", async () => {
    const { ctx, communityId, host, dateStr } = await prep()
    const holdId = await createActiveHold(ctx, communityId, host, `${dateStr}T09:00:00Z`, `${dateStr}T09:30:00Z`)
    const a = await json(await postQuote(ctx.env, communityId, holdId, host.accessToken)) as { quote: { payment: { payment_intent_id: string; amount_atomic: string } } }
    const b = await json(await postQuote(ctx.env, communityId, holdId, host.accessToken)) as { quote: { payment: { payment_intent_id: string; amount_atomic: string } } }
    expect(b.quote.payment.payment_intent_id).toBe(a.quote.payment.payment_intent_id)
    expect(b.quote.payment.amount_atomic).toBe(a.quote.payment.amount_atomic)
  })

  test("pending verification is resumable and settles on a later retry", async () => {
    const { ctx, communityId, host, dateStr } = await prep()
    const root = String(ctx.env.LOCAL_COMMUNITY_DB_ROOT)
    const holdId = await createActiveHold(ctx, communityId, host, `${dateStr}T09:00:00Z`, `${dateStr}T09:30:00Z`)
    setBookingPaymentVerifierForTests(async () => ({ kind: "pending" }))
    const first = await postConfirm(ctx.env, communityId, holdId, host.accessToken, "0xpend", "wal_booker")
    expect(first.status).toBe(409)
    expect((await json(first) as { error: string }).error).toBe("payment_pending")
    expect(String((await readIntent(root, communityId, holdId))?.status)).toBe("verification_failed")
    expect(String((await readIntent(root, communityId, holdId))?.claimed_tx_ref)).toBe("0xpend") // hash retained

    setBookingPaymentVerifierForTests(async (i) => ({ kind: "verified", senderAddress: i.expected.senderAddress, txRef: i.fundingTxRef }))
    const retry = await postConfirm(ctx.env, communityId, holdId, host.accessToken, "0xpend", "wal_booker")
    expect(retry.status).toBe(201)
    expect(String((await readIntent(root, communityId, holdId))?.status)).toBe("consumed")
  })

  test("definitive rejection is terminal and is never re-verified", async () => {
    const { ctx, communityId, host, dateStr } = await prep()
    const root = String(ctx.env.LOCAL_COMMUNITY_DB_ROOT)
    const holdId = await createActiveHold(ctx, communityId, host, `${dateStr}T09:00:00Z`, `${dateStr}T09:30:00Z`)
    setBookingPaymentVerifierForTests(async () => ({ kind: "rejected", reason: "no_matching_transfer" }))
    expect((await postConfirm(ctx.env, communityId, holdId, host.accessToken, "0xbad", "wal_booker")).status).toBe(409)
    expect(String((await readIntent(root, communityId, holdId))?.status)).toBe("verification_rejected")
    verifierCalls = 0
    setBookingPaymentVerifierForTests(async (i) => ({ kind: "verified", senderAddress: i.expected.senderAddress, txRef: i.fundingTxRef }))
    const retry = await postConfirm(ctx.env, communityId, holdId, host.accessToken, "0xbad", "wal_booker")
    expect((await json(retry) as { error: string }).error).toBe("payment_rejected")
    expect(verifierCalls).toBe(0) // terminal: no re-verification, no new booking
    expect(await communityScalar(root, communityId, "SELECT COUNT(*) FROM bookings WHERE hold_id = ?1", [holdId])).toBe(0)
  })

  test("a reused transaction hash across holds is rejected", async () => {
    const { ctx, communityId, host, dateStr } = await prep()
    const holdA = await createActiveHold(ctx, communityId, host, `${dateStr}T09:00:00Z`, `${dateStr}T09:30:00Z`)
    const holdB = await createActiveHold(ctx, communityId, host, `${dateStr}T10:00:00Z`, `${dateStr}T10:30:00Z`)
    expect((await postConfirm(ctx.env, communityId, holdA, host.accessToken, "0xshared", "wal_booker")).status).toBe(201)
    const reuse = await postConfirm(ctx.env, communityId, holdB, host.accessToken, "0xshared", "wal_booker")
    expect((await json(reuse) as { error: string }).error).toBe("transaction_already_used")
  })

  test("crash after verification resumes into finalization without another chain call", async () => {
    const { ctx, communityId, host, dateStr } = await prep()
    const root = String(ctx.env.LOCAL_COMMUNITY_DB_ROOT)
    const holdId = await createActiveHold(ctx, communityId, host, `${dateStr}T09:00:00Z`, `${dateStr}T09:30:00Z`)
    await postQuote(ctx.env, communityId, holdId, host.accessToken) // creates the active intent
    // Simulate a crash AFTER verified but BEFORE finalization: durable verified, no booking yet.
    await setIntent(root, communityId, holdId, { status: "verified", claimed_tx_ref: "0xcrash", verified_sender_address: "0x7000000000000000000000000000000000000007" })
    verifierCalls = 0
    const res = await postConfirm(ctx.env, communityId, holdId, host.accessToken, "0xcrash", "wal_booker")
    expect(res.status).toBe(201)
    expect(verifierCalls).toBe(0) // resumed from verified — no RPC, no re-pay
    expect(await communityScalar(root, communityId, "SELECT status FROM bookings WHERE hold_id = ?1", [holdId])).toBe("confirmed")
    expect(String((await readIntent(root, communityId, holdId))?.status)).toBe("consumed")
  })

  test("concurrent confirmations create exactly one booking, verified once", async () => {
    const { ctx, communityId, host, dateStr } = await prep()
    const root = String(ctx.env.LOCAL_COMMUNITY_DB_ROOT)
    const holdId = await createActiveHold(ctx, communityId, host, `${dateStr}T09:00:00Z`, `${dateStr}T09:30:00Z`)
    const [a, b] = await Promise.all([
      postConfirm(ctx.env, communityId, holdId, host.accessToken, "0xrace", "wal_booker"),
      postConfirm(ctx.env, communityId, holdId, host.accessToken, "0xrace", "wal_booker"),
    ])
    expect([a.status, b.status].filter((s) => s === 201 || s === 200).length).toBeGreaterThanOrEqual(1)
    expect(await communityScalar(root, communityId, "SELECT COUNT(*) FROM bookings WHERE hold_id = ?1", [holdId])).toBe(1)
    expect(verifierCalls).toBeLessThanOrEqual(1) // only the reservation winner verifies
  })

  test("replaying a confirmed booking with a different tx hash is rejected", async () => {
    const { ctx, communityId, host, dateStr } = await prep()
    const holdId = await createActiveHold(ctx, communityId, host, `${dateStr}T09:00:00Z`, `${dateStr}T09:30:00Z`)
    expect((await postConfirm(ctx.env, communityId, holdId, host.accessToken, "0xorig", "wal_booker")).status).toBe(201)
    expect((await postConfirm(ctx.env, communityId, holdId, host.accessToken, "0xorig", "wal_booker")).status).toBe(200) // same tx → idempotent
    const mismatch = await postConfirm(ctx.env, communityId, holdId, host.accessToken, "0xdifferent", "wal_booker")
    expect((await json(mismatch) as { error: string }).error).toBe("replay_mismatch")
  })
})
