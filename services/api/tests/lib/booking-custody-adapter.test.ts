import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { createClient } from "@libsql/client"

import { executeBookingOperatorEffect, setBookingOperatorUsdcTransferForTests } from "../../src/lib/communities/bookings/booking-custody-adapter"
import { cancelBooking, completeBooking } from "../../src/lib/communities/bookings/booking-lifecycle-service"
import { getCommunityRepository } from "../../src/lib/communities/db-community-repository"
import { buildLocalCommunityDbUrl } from "../../src/lib/communities/community-local-db"
import { createRouteTestContext, json, resetRuntimeCaches } from "../helpers"
import { completeUniqueHumanVerification, exchangeJwt, requestJson } from "../routes/communities/community-routes-test-helpers"

setDefaultTimeout(20_000)

type Ctx = Awaited<ReturnType<typeof createRouteTestContext>>

const BOOKER_ADDRESS = "0x0000000000000000000000000000000000000222"
const HOST_ADDRESS = "0x0000000000000000000000000000000000000111"

let cleanup: (() => Promise<void>) | null = null
let broadcasts: Array<{ to: string; amountCents: number }> = []
let waits: string[] = []
let broadcastError: Error | null = null

beforeEach(() => {
  resetRuntimeCaches()
  broadcasts = []
  waits = []
  broadcastError = null
  setBookingOperatorUsdcTransferForTests({
    broadcast: async (_env, input) => {
      if (broadcastError) throw broadcastError
      broadcasts.push({ to: input.to, amountCents: input.amountCents })
      return { txRef: `tx_${input.to.slice(-4)}_${input.amountCents}` }
    },
    wait: async (_env, input) => {
      waits.push(input.txRef)
    },
  })
})

afterEach(async () => {
  setBookingOperatorUsdcTransferForTests(null)
  if (cleanup) { await cleanup(); cleanup = null }
})

async function createTestCommunity(env: Ctx["env"], accessToken: string): Promise<string> {
  const response = await requestJson("http://pirate.test/communities", {
    display_name: "Custody Adapter Test Community",
    membership_mode: "request",
    handle_policy: { policy_template: "standard" },
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

async function seedBooking(root: string, communityId: string, opts: {
  bookingId: string
  hostUserId: string
  bookerUserId: string
  status?: string
}): Promise<void> {
  const client = createClient({ url: buildLocalCommunityDbUrl(root, communityId) })
  try {
    const now = new Date().toISOString()
    const slotStart = new Date(Date.now() - 3600_000).toISOString()
    const slotEnd = new Date(Date.now() - 1800_000).toISOString()
    await client.execute({
      sql: `INSERT INTO bookings (
              booking_id, community_id, hold_id, host_user_id, booker_user_id, slot_start_utc, slot_end_utc,
              gross_cents, platform_fee_bps, platform_fee_cents, host_payout_cents, status, refund_cents,
              funding_tx_ref, funding_wallet_address, host_payout_wallet_address, created_at, updated_at
            ) VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?6, 5000, 1000, 500, 4500, ?7, NULL,
              '0xfunded', ?8, ?9, ?10, ?10)`,
      args: [
        opts.bookingId,
        communityId,
        opts.hostUserId,
        opts.bookerUserId,
        slotStart,
        slotEnd,
        opts.status ?? "confirmed",
        BOOKER_ADDRESS,
        HOST_ADDRESS,
        now,
      ],
    })
  } finally {
    client.close()
  }
}

async function rows(root: string, communityId: string, sql: string, args: unknown[] = []): Promise<Record<string, unknown>[]> {
  const client = createClient({ url: buildLocalCommunityDbUrl(root, communityId) })
  try {
    const result = await client.execute({ sql, args: args as never })
    return result.rows as Record<string, unknown>[]
  } finally {
    client.close()
  }
}

describe("booking custody adapter (D5)", () => {
  test("refunds use the snapshotted funding wallet address and confirm the ledger effect", async () => {
    const { ctx, communityId, host, booker, root } = await setup()
    await seedBooking(root, communityId, { bookingId: "bkg_refund", hostUserId: host.userId, bookerUserId: booker.userId })

    const result = await cancelBooking({
      env: ctx.env,
      communityRepository: getCommunityRepository(ctx.env),
      communityId,
      bookingId: "bkg_refund",
      actorUserId: host.userId,
      nowUtc: new Date().toISOString(),
    })

    expect(result.ok).toBe(true)
    expect(broadcasts).toEqual([{ to: BOOKER_ADDRESS, amountCents: 5000 }])
    const effects = await rows(root, communityId, "SELECT effect_kind, status, amount_cents, recipient_address, settlement_ref FROM booking_settlement_effects")
    expect(effects).toEqual([{
      effect_kind: "booking_refund",
      status: "confirmed",
      amount_cents: 5000,
      recipient_address: BOOKER_ADDRESS,
      settlement_ref: "tx_0222_5000",
    }])
  })

  test("payouts use the snapshotted host payout wallet address", async () => {
    const { ctx, communityId, host, booker, root } = await setup()
    await seedBooking(root, communityId, { bookingId: "bkg_payout", hostUserId: host.userId, bookerUserId: booker.userId, status: "live" })

    const result = await completeBooking({
      env: ctx.env,
      communityRepository: getCommunityRepository(ctx.env),
      communityId,
      bookingId: "bkg_payout",
      actorUserId: host.userId,
      nowUtc: new Date().toISOString(),
    })

    expect(result.ok).toBe(true)
    expect(broadcasts).toEqual([{ to: HOST_ADDRESS, amountCents: 4500 }])
    const effects = await rows(root, communityId, "SELECT effect_kind, status, amount_cents, recipient_address FROM booking_settlement_effects")
    expect(effects).toEqual([{
      effect_kind: "booking_payout",
      status: "confirmed",
      amount_cents: 4500,
      recipient_address: HOST_ADDRESS,
    }])
  })

  test("a confirmed ledger effect dedups without broadcasting again", async () => {
    const { ctx, communityId, host, booker, root } = await setup()
    await seedBooking(root, communityId, { bookingId: "bkg_dedup", hostUserId: host.userId, bookerUserId: booker.userId })
    const common = {
      env: ctx.env,
      communityRepository: getCommunityRepository(ctx.env),
      communityId,
      nowUtc: new Date().toISOString(),
    }

    const first = await executeBookingOperatorEffect(common, {
      kind: "refund",
      toUserId: booker.userId,
      recipientAddress: BOOKER_ADDRESS,
      amountCents: 5000,
      bookingId: "bkg_dedup",
      idempotencyKey: "booking_refund:bkg_dedup",
    })
    const second = await executeBookingOperatorEffect(common, {
      kind: "refund",
      toUserId: booker.userId,
      recipientAddress: BOOKER_ADDRESS,
      amountCents: 5000,
      bookingId: "bkg_dedup",
      idempotencyKey: "booking_refund:bkg_dedup",
    })

    expect(first.txRef).toBe("tx_0222_5000")
    expect(second.txRef).toBe("tx_0222_5000")
    expect(broadcasts.length).toBe(1)
    expect((await rows(root, communityId, "SELECT status, attempt_count FROM booking_settlement_effects"))[0]).toEqual({
      status: "confirmed",
      attempt_count: 1,
    })
  })

  test("a failed pre-broadcast transfer leaves the booking in its reserved intent state", async () => {
    const { ctx, communityId, host, booker, root } = await setup()
    await seedBooking(root, communityId, { bookingId: "bkg_fail", hostUserId: host.userId, bookerUserId: booker.userId })
    broadcastError = new Error("operator offline")

    await expect(cancelBooking({
      env: ctx.env,
      communityRepository: getCommunityRepository(ctx.env),
      communityId,
      bookingId: "bkg_fail",
      actorUserId: host.userId,
      nowUtc: new Date().toISOString(),
    })).rejects.toThrow("operator offline")

    expect((await rows(root, communityId, "SELECT status FROM bookings WHERE booking_id = ?1", ["bkg_fail"]))[0].status).toBe("cancelled_by_host")
    expect((await rows(root, communityId, "SELECT status, settlement_ref, failure_reason FROM booking_settlement_effects"))[0]).toEqual({
      status: "failed",
      settlement_ref: null,
      failure_reason: "operator offline",
    })
  })

  test("a stale submitted effect without a tx ref does not auto-retry or broadcast", async () => {
    const { ctx, communityId, host, booker, root } = await setup()
    await seedBooking(root, communityId, { bookingId: "bkg_stale", hostUserId: host.userId, bookerUserId: booker.userId })
    const now = new Date().toISOString()
    await rows(root, communityId, `INSERT INTO booking_settlement_effects (
      booking_settlement_effect_id, community_id, booking_id, effect_kind, idempotency_key,
      status, amount_cents, recipient_address, settlement_ref, failure_reason, attempt_count,
      submitted_at, confirmed_at, failed_at, created_at, updated_at
    ) VALUES ('bse_stale', ?1, 'bkg_stale', 'booking_refund', 'booking_refund:bkg_stale',
      'submitted', 5000, ?2, NULL, NULL, 1, ?3, NULL, NULL, ?3, ?3)`, [communityId, BOOKER_ADDRESS, now])

    await expect(executeBookingOperatorEffect({
      env: ctx.env,
      communityRepository: getCommunityRepository(ctx.env),
      communityId,
      nowUtc: now,
    }, {
      kind: "refund",
      toUserId: booker.userId,
      recipientAddress: BOOKER_ADDRESS,
      amountCents: 5000,
      bookingId: "bkg_stale",
      idempotencyKey: "booking_refund:bkg_stale",
    })).rejects.toThrow("unresolved submitted attempt")
    expect(broadcasts.length).toBe(0)
  })

  test("a submitted effect with a tx ref is confirmed without another broadcast", async () => {
    const { ctx, communityId, host, booker, root } = await setup()
    await seedBooking(root, communityId, { bookingId: "bkg_recover", hostUserId: host.userId, bookerUserId: booker.userId })
    const now = new Date().toISOString()
    await rows(root, communityId, `INSERT INTO booking_settlement_effects (
      booking_settlement_effect_id, community_id, booking_id, effect_kind, idempotency_key,
      status, amount_cents, recipient_address, settlement_ref, failure_reason, attempt_count,
      submitted_at, confirmed_at, failed_at, created_at, updated_at
    ) VALUES ('bse_recover', ?1, 'bkg_recover', 'booking_refund', 'booking_refund:bkg_recover',
      'submitted', 5000, ?2, '0xrecover', NULL, 1, ?3, NULL, NULL, ?3, ?3)`, [communityId, BOOKER_ADDRESS, now])

    const result = await executeBookingOperatorEffect({
      env: ctx.env,
      communityRepository: getCommunityRepository(ctx.env),
      communityId,
      nowUtc: now,
    }, {
      kind: "refund",
      toUserId: booker.userId,
      recipientAddress: BOOKER_ADDRESS,
      amountCents: 5000,
      bookingId: "bkg_recover",
      idempotencyKey: "booking_refund:bkg_recover",
    })

    expect(result.txRef).toBe("0xrecover")
    expect(broadcasts.length).toBe(0)
    expect(waits).toEqual(["0xrecover"])
    expect((await rows(root, communityId, "SELECT status, settlement_ref FROM booking_settlement_effects WHERE idempotency_key = 'booking_refund:bkg_recover'"))[0]).toEqual({
      status: "confirmed",
      settlement_ref: "0xrecover",
    })
  })
})
