import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { createClient } from "@libsql/client"

import {
  beginBookingSettlementEffectAttempt,
  confirmBookingSettlementEffect,
  failBookingSettlementEffect,
  getBookingSettlementEffectByIdempotencyKey,
  mirrorBookingSettlementCoordinatorEffect,
} from "../../../src/lib/communities/bookings/booking-settlement-effects"
import { buildLocalCommunityDbUrl } from "../../../src/lib/communities/community-local-db"
import { createRouteTestContext, json, resetRuntimeCaches } from "../../helpers"
import { completeUniqueHumanVerification, exchangeJwt, requestJson } from "./community-routes-test-helpers"

setDefaultTimeout(20_000)

type Ctx = Awaited<ReturnType<typeof createRouteTestContext>>

const BOOKER_ADDRESS = "0x0000000000000000000000000000000000000222"
const HOST_ADDRESS = "0x0000000000000000000000000000000000000111"

let cleanup: (() => Promise<void>) | null = null
beforeEach(() => { resetRuntimeCaches() })
afterEach(async () => { if (cleanup) { await cleanup(); cleanup = null } })

async function createTestCommunity(env: Ctx["env"], accessToken: string): Promise<string> {
  const response = await requestJson("http://pirate.test/communities", {
    display_name: "Custody Ledger Test Community", membership_mode: "request", handle_policy: { policy_template: "standard" },
  }, env, accessToken)
  expect(response.status).toBe(202)
  return (await json(response) as { community: { id: string } }).community.id.replace(/^com_/, "")
}

async function setup() {
  const ctx = await createRouteTestContext()
  cleanup = ctx.cleanup
  const host = await exchangeJwt(ctx.env, "custody-host")
  await completeUniqueHumanVerification(ctx.env, host.accessToken)
  const communityId = await createTestCommunity(ctx.env, host.accessToken)
  const booker = await exchangeJwt(ctx.env, "custody-booker")
  await completeUniqueHumanVerification(ctx.env, booker.accessToken)
  return { ctx, communityId, host, booker, root: String(ctx.env.LOCAL_COMMUNITY_DB_ROOT) }
}

async function seedBooking(root: string, communityId: string, opts: { bookingId: string; hostUserId: string; bookerUserId: string }): Promise<void> {
  const client = createClient({ url: buildLocalCommunityDbUrl(root, communityId) })
  try {
    const now = new Date().toISOString()
    await client.execute({
      sql: `INSERT INTO bookings (booking_id, community_id, hold_id, host_user_id, booker_user_id, slot_start_utc, slot_end_utc,
              gross_cents, platform_fee_bps, platform_fee_cents, host_payout_cents, status, refund_cents,
              funding_tx_ref, funding_wallet_address, host_payout_wallet_address, created_at, updated_at)
            VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?6, 5000, 1000, 500, 4500, 'confirmed', NULL, '0xfunded', ?7, ?8, ?9, ?9)`,
      args: [opts.bookingId, communityId, opts.hostUserId, opts.bookerUserId, new Date(Date.now() - 3600_000).toISOString(), new Date(Date.now() - 1800_000).toISOString(), BOOKER_ADDRESS, HOST_ADDRESS, now],
    })
  } finally {
    client.close()
  }
}

function dbClient(root: string, communityId: string) { return createClient({ url: buildLocalCommunityDbUrl(root, communityId) }) }

async function beginEffect(client: ReturnType<typeof dbClient>, communityId: string, bookingId: string, key: string) {
  return beginBookingSettlementEffectAttempt({ client, communityId, bookingId, effectKind: "booking_refund", idempotencyKey: key, amountCents: 5000, recipientAddress: BOOKER_ADDRESS, now: new Date().toISOString() })
}
async function mirror(client: ReturnType<typeof dbClient>, key: string, state: string, hash: string | null, nonce: number | null) {
  return mirrorBookingSettlementCoordinatorEffect({ client, idempotencyKey: key, coordinatorRef: `ref:${key}`, coordinatorState: state, settlementRef: hash, nonce, now: new Date().toISOString() })
}

describe("booking settlement ledger — monotonic mirror (D5 F2/DO)", () => {
  test("a stale broadcast mirror cannot regress a confirmed ledger row", async () => {
    const { communityId, host, booker, root } = await setup()
    await seedBooking(root, communityId, { bookingId: "bkg_reg", hostUserId: host.userId, bookerUserId: booker.userId })
    const c = dbClient(root, communityId)
    try {
      const k = "c:bkg_reg:booking_refund"
      await beginEffect(c, communityId, "bkg_reg", k)
      await mirror(c, k, "broadcast", "0xA", 5)
      await confirmBookingSettlementEffect({ client: c, idempotencyKey: k, settlementRef: "0xA", now: new Date().toISOString() })
      // stale broadcast mirror arrives AFTER confirmation
      await mirror(c, k, "broadcast", "0xA", 5)
      const row = await getBookingSettlementEffectByIdempotencyKey({ client: c, idempotencyKey: k })
      expect(row?.status).toBe("confirmed")
      expect(row?.settlement_ref).toBe("0xA")
    } finally { c.close() }
  })

  test("a stale mirror cannot null-out a recorded hash/nonce, nor regress coordinator state", async () => {
    const { communityId, host, booker, root } = await setup()
    await seedBooking(root, communityId, { bookingId: "bkg_null", hostUserId: host.userId, bookerUserId: booker.userId })
    const c = dbClient(root, communityId)
    try {
      const k = "c:bkg_null:booking_refund"
      await beginEffect(c, communityId, "bkg_null", k)
      await mirror(c, k, "broadcast", "0xA", 7)
      // stale 'reserving' mirror with null hash/nonce must not erase or regress
      await mirror(c, k, "reserving", null, null)
      const row = await getBookingSettlementEffectByIdempotencyKey({ client: c, idempotencyKey: k })
      expect(row?.settlement_ref).toBe("0xA")
      expect(row?.broadcast_nonce).toBe(7)
      expect(row?.coordinator_state).toBe("broadcast")
    } finally { c.close() }
  })

  test("a conflicting hash or nonce is rejected", async () => {
    const { communityId, host, booker, root } = await setup()
    await seedBooking(root, communityId, { bookingId: "bkg_cf", hostUserId: host.userId, bookerUserId: booker.userId })
    const c = dbClient(root, communityId)
    try {
      const k = "c:bkg_cf:booking_refund"
      await beginEffect(c, communityId, "bkg_cf", k)
      await mirror(c, k, "broadcast", "0xA", 9)
      await expect(mirror(c, k, "broadcast", "0xB", 9)).rejects.toThrow() // different hash
      await expect(mirror(c, k, "broadcast", "0xA", 10)).rejects.toThrow() // different nonce
      const row = await getBookingSettlementEffectByIdempotencyKey({ client: c, idempotencyKey: k })
      expect(row?.settlement_ref).toBe("0xA")
      expect(row?.broadcast_nonce).toBe(9)
    } finally { c.close() }
  })
})

describe("booking settlement ledger — reservation CAS + validation (D5)", () => {
  test("concurrent retries on a failed effect: exactly one claims", async () => {
    const { communityId, host, booker, root } = await setup()
    await seedBooking(root, communityId, { bookingId: "bkg_race", hostUserId: host.userId, bookerUserId: booker.userId })
    const url = buildLocalCommunityDbUrl(root, communityId)
    const k = "c:bkg_race:booking_refund"
    const seed = dbClient(root, communityId)
    await beginEffect(seed, communityId, "bkg_race", k)
    await failBookingSettlementEffect({ client: seed, idempotencyKey: k, failureReason: "boom", now: new Date().toISOString() })
    seed.close()
    const cA = createClient({ url })
    const cB = createClient({ url })
    try {
      const [a, b] = await Promise.all([beginEffect(cA, communityId, "bkg_race", k).then((r) => r.action), beginEffect(cB, communityId, "bkg_race", k).then((r) => r.action)])
      expect([a, b].sort()).toEqual(["existing_submitted", "retry"])
    } finally { cA.close(); cB.close() }
  })

  test("idempotency key reuse with different effect data is rejected", async () => {
    const { communityId, host, booker, root } = await setup()
    await seedBooking(root, communityId, { bookingId: "bkg_imm", hostUserId: host.userId, bookerUserId: booker.userId })
    const c = dbClient(root, communityId)
    try {
      const k = "c:bkg_imm:booking_refund"
      const base = { client: c, communityId, bookingId: "bkg_imm", effectKind: "booking_refund" as const, idempotencyKey: k, amountCents: 5000, recipientAddress: BOOKER_ADDRESS, now: new Date().toISOString() }
      await beginBookingSettlementEffectAttempt(base)
      await expect(beginBookingSettlementEffectAttempt({ ...base, amountCents: 9999 })).rejects.toThrow()
      await expect(beginBookingSettlementEffectAttempt({ ...base, recipientAddress: HOST_ADDRESS })).rejects.toThrow()
    } finally { c.close() }
  })

  test("confirm rejects a mismatched transaction reference", async () => {
    const { communityId, host, booker, root } = await setup()
    await seedBooking(root, communityId, { bookingId: "bkg_ref", hostUserId: host.userId, bookerUserId: booker.userId })
    const c = dbClient(root, communityId)
    try {
      const k = "c:bkg_ref:booking_refund"
      await beginEffect(c, communityId, "bkg_ref", k)
      await mirror(c, k, "broadcast", "0xA", 1)
      await expect(confirmBookingSettlementEffect({ client: c, idempotencyKey: k, settlementRef: "0xB", now: new Date().toISOString() })).rejects.toThrow()
      const afterReject = await getBookingSettlementEffectByIdempotencyKey({ client: c, idempotencyKey: k })
      expect(afterReject?.status).toBe("submitted")
      expect(afterReject?.settlement_ref).toBe("0xA")
      const ok = await confirmBookingSettlementEffect({ client: c, idempotencyKey: k, settlementRef: "0xA", now: new Date().toISOString() })
      expect(ok.status).toBe("confirmed")
    } finally { c.close() }
  })
})
