import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { createClient } from "@libsql/client"

import { setBookingSettlementCoordinatorForTests } from "../../../src/lib/communities/bookings/booking-custody-adapter"
import { reconcileBookingSettlement } from "../../../src/lib/communities/bookings/booking-lifecycle-service"
import { sweepDueBookingSettlements } from "../../../src/lib/communities/bookings/booking-settlement-cron"
import type { OperatorSettleRequest, OperatorSettleResult, OperatorSettleState } from "../../../src/lib/communities/bookings/operator-signing-coordinator-do"
import { getCommunityRepository } from "../../../src/lib/communities/db-community-repository"
import { buildLocalCommunityDbUrl } from "../../../src/lib/communities/community-local-db"
import { createRouteTestContext, json, resetRuntimeCaches } from "../../helpers"
import { completeUniqueHumanVerification, exchangeJwt, requestJson } from "./community-routes-test-helpers"

setDefaultTimeout(30_000)
type Ctx = Awaited<ReturnType<typeof createRouteTestContext>>
const BOOKER_WALLET = "0x0000000000000000000000000000000000000222"
const HOST_WALLET = "0x0000000000000000000000000000000000000111"

let cleanup: (() => Promise<void>) | null = null
beforeEach(() => { resetRuntimeCaches() })
afterEach(async () => { setBookingSettlementCoordinatorForTests(null); if (cleanup) { await cleanup(); cleanup = null } })

function settleResult(state: OperatorSettleState, txHash: string | null): OperatorSettleResult {
  return { idempotencyKey: "do-key", txHash, nonce: 1, state }
}
// Mock coordinator: records every settle request (effect kind/amount/recipient) and returns a
// configurable state. settle 'confirmed' = finalized in one shot; 'broadcast' + confirm state drives
// the pending/confirm path; 'replaced'/'failed_onchain' = terminal.
function installCoordinator() {
  const settleReqs: Array<{ effectKind: string; amountCents: number; recipientAddress: string }> = []
  const state = { settle: "confirmed" as OperatorSettleState, confirm: "confirmed" as OperatorSettleState }
  setBookingSettlementCoordinatorForTests({
    settle: async (req: OperatorSettleRequest) => { settleReqs.push({ effectKind: req.effectKind, amountCents: req.amountCents, recipientAddress: req.recipientAddress }); return settleResult(state.settle, `0x${req.effectKind}`) },
    confirm: async (_req, h) => settleResult(state.confirm, h),
    reconcile: async () => settleResult(state.settle, "0xrec"),
  })
  return { settleReqs, state }
}

async function setup() {
  const ctx = await createRouteTestContext()
  cleanup = ctx.cleanup
  const host = await exchangeJwt(ctx.env, "set-host")
  await completeUniqueHumanVerification(ctx.env, host.accessToken)
  const r = await requestJson("http://pirate.test/communities", { display_name: "Settlement Cron", membership_mode: "request", handle_policy: { policy_template: "standard" } }, ctx.env, host.accessToken)
  const communityId = (await json(r) as { community: { id: string } }).community.id.replace(/^com_/, "")
  const booker = await exchangeJwt(ctx.env, "set-booker")
  await completeUniqueHumanVerification(ctx.env, booker.accessToken)
  const root = String(ctx.env.LOCAL_COMMUNITY_DB_ROOT)
  // The settlement cron now enumerates from authoritative routing state (ready, non-decommissioned
  // D1) rather than the generic active-community list. Force a ready-D1 routing row so this
  // community is settlement-eligible regardless of what local provisioning seeds.
  const cp = ctx.client
  const nowIso = new Date().toISOString()
  await cp.execute({
    sql: `INSERT INTO community_database_routing
            (community_id, backend, provisioning_state, shard_worker_id, binding_name, region, created_at, updated_at)
          VALUES (?1, 'd1', 'ready', 'community-d1-shard-test', 'DB_CMTY_TEST', 'enam', ?2, ?2)
          ON CONFLICT (community_id) DO UPDATE SET
            backend = 'd1', provisioning_state = 'ready', decommissioned_at = NULL, turso_database_binding_id = NULL,
            shard_worker_id = 'community-d1-shard-test', binding_name = 'DB_CMTY_TEST', region = 'enam', updated_at = ?2`,
    args: [communityId, nowIso],
  })
  return { ctx, communityId, root, hostId: host.userId, bookerId: booker.userId }
}

interface SeedOpts {
  bookingId: string; status: string; refundCents: number | null
  fundingWallet?: string | null; hostPayoutWallet?: string | null
  grossCents?: number; hostId: string; bookerId: string
}
async function seedBooking(root: string, communityId: string, o: SeedOpts): Promise<void> {
  const c = createClient({ url: buildLocalCommunityDbUrl(root, communityId) })
  try {
    const now = new Date().toISOString()
    const gross = o.grossCents ?? 5000
    await c.execute({
      sql: `INSERT INTO bookings (booking_id, community_id, hold_id, host_user_id, booker_user_id, slot_start_utc, slot_end_utc,
              gross_cents, platform_fee_bps, platform_fee_cents, host_payout_cents, status, refund_cents,
              funding_wallet_address, host_payout_wallet_address, created_at, updated_at)
            VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?6, ?7, 1000, 500, 4500, ?8, ?9, ?10, ?11, ?12, ?12)`,
      args: [o.bookingId, communityId, o.hostId, o.bookerId, new Date(Date.now() - 1800_000).toISOString(), new Date(Date.now() - 600_000).toISOString(),
        gross, o.status, o.refundCents, o.fundingWallet === undefined ? BOOKER_WALLET : o.fundingWallet, o.hostPayoutWallet === undefined ? HOST_WALLET : o.hostPayoutWallet, now],
    })
  } finally { c.close() }
}
async function bookingStatus(root: string, communityId: string, bookingId: string): Promise<string | null> {
  const c = createClient({ url: buildLocalCommunityDbUrl(root, communityId) })
  try {
    const r = await c.execute({ sql: `SELECT status FROM bookings WHERE booking_id = ?1`, args: [bookingId] })
    return r.rows[0] ? String(r.rows[0].status) : null
  } finally { c.close() }
}
function resumeInput(ctx: Ctx, communityId: string, bookingId: string) {
  return { env: ctx.env, communityRepository: getCommunityRepository(ctx.env), communityId, bookingId, nowUtc: new Date().toISOString(), confirmPollMs: [] as number[] }
}
function sweepInput(ctx: Ctx, _communityId?: string) {
  const repo = getCommunityRepository(ctx.env) as unknown as Parameters<typeof sweepDueBookingSettlements>[0]["communityRepository"]
  return { env: { ...ctx.env, BOOKINGS_SETTLEMENT_CRON_ENABLED: "true" } as typeof ctx.env, communityRepository: repo }
}

describe("booking settlement resume — reconstructs strictly from persisted intent", () => {
  // [intent state, seeded refund_cents, expected refund effect, expected payout effect, expected final]
  const CASES: Array<[string, number, number | null, number | null, string]> = [
    ["completed", 0, null, 4500, "settled"],
    ["no_show_booker", 0, null, 4500, "settled"],
    ["no_show_host", 5000, 5000, null, "refunded"],
    ["cancelled_by_host", 5000, 5000, null, "refunded"],
    ["cancelled_by_booker", 0, null, 4500, "refunded"],
  ]
  test.each(CASES)("intent %s settles per persisted decision", async (status, refundCents, refundEffect, payoutEffect, finalState) => {
    const { ctx, communityId, root, hostId, bookerId } = await setup()
    await seedBooking(root, communityId, { bookingId: "bkg1", status, refundCents, hostId, bookerId })
    const coord = installCoordinator()
    const result = await reconcileBookingSettlement(resumeInput(ctx, communityId, "bkg1"))
    expect(result.outcome).toBe("resumed")
    expect(await bookingStatus(root, communityId, "bkg1")).toBe(finalState)
    const refund = coord.settleReqs.find((s) => s.effectKind === "booking_refund")
    const payout = coord.settleReqs.find((s) => s.effectKind === "booking_payout")
    expect(refund?.amountCents ?? null).toBe(refundEffect)
    if (refundEffect != null) expect(refund?.recipientAddress.toLowerCase()).toBe(BOOKER_WALLET)
    expect(payout?.amountCents ?? null).toBe(payoutEffect)
    if (payoutEffect != null) expect(payout?.recipientAddress.toLowerCase()).toBe(HOST_WALLET)
  })

  test("uses the PERSISTED refund amount, never a recomputed policy value", async () => {
    const { ctx, communityId, root, hostId, bookerId } = await setup()
    // no_show_host policy would compute a full 5000 refund; persisted is an atypical 1234.
    await seedBooking(root, communityId, { bookingId: "bkg1", status: "no_show_host", refundCents: 1234, hostId, bookerId })
    const coord = installCoordinator()
    await reconcileBookingSettlement(resumeInput(ctx, communityId, "bkg1"))
    expect(coord.settleReqs.find((s) => s.effectKind === "booking_refund")?.amountCents).toBe(1234)
  })

  test("fails closed on a missing destination snapshot (no settlement)", async () => {
    const { ctx, communityId, root, hostId, bookerId } = await setup()
    await seedBooking(root, communityId, { bookingId: "bkg1", status: "no_show_host", refundCents: 5000, fundingWallet: null, hostId, bookerId })
    installCoordinator()
    await expect(reconcileBookingSettlement(resumeInput(ctx, communityId, "bkg1"))).rejects.toThrow()
    expect(await bookingStatus(root, communityId, "bkg1")).toBe("no_show_host") // unchanged
  })

  test("fails closed when the persisted refund decision is missing", async () => {
    const { ctx, communityId, root, hostId, bookerId } = await setup()
    await seedBooking(root, communityId, { bookingId: "bkg1", status: "completed", refundCents: null, hostId, bookerId })
    installCoordinator()
    await expect(reconcileBookingSettlement(resumeInput(ctx, communityId, "bkg1"))).rejects.toThrow()
    expect(await bookingStatus(root, communityId, "bkg1")).toBe("completed")
  })

  test("skips a non-intent (already final) booking", async () => {
    const { ctx, communityId, root, hostId, bookerId } = await setup()
    await seedBooking(root, communityId, { bookingId: "bkg1", status: "settled", refundCents: 0, hostId, bookerId })
    installCoordinator()
    expect((await reconcileBookingSettlement(resumeInput(ctx, communityId, "bkg1"))).outcome).toBe("skipped")
  })
})

describe("booking settlement cron — sweep over real D1", () => {
  test("confirmation timeout becomes pending, then settles on a later resume", async () => {
    const { ctx, communityId, root, hostId, bookerId } = await setup()
    await seedBooking(root, communityId, { bookingId: "bkg1", status: "completed", refundCents: 0, hostId, bookerId })
    const coord = installCoordinator()
    coord.state.settle = "broadcast"; coord.state.confirm = "broadcast" // never confirms this tick
    const first = await sweepDueBookingSettlements(sweepInput(ctx, communityId))
    expect(first.pending).toBe(1)
    expect(first.settled).toBe(0)
    expect(await bookingStatus(root, communityId, "bkg1")).toBe("completed") // still intent, recoverable

    coord.state.confirm = "confirmed" // confirmation lands
    const second = await sweepDueBookingSettlements(sweepInput(ctx, communityId))
    expect(second.resumed).toBe(1)
    expect(second.settled).toBe(1)
    expect(await bookingStatus(root, communityId, "bkg1")).toBe("settled")
  })

  test("repeated runs do not duplicate broadcasts or re-settle", async () => {
    const { ctx, communityId, root, hostId, bookerId } = await setup()
    await seedBooking(root, communityId, { bookingId: "bkg1", status: "no_show_host", refundCents: 5000, hostId, bookerId })
    const coord = installCoordinator()
    await sweepDueBookingSettlements(sweepInput(ctx, communityId))
    expect(await bookingStatus(root, communityId, "bkg1")).toBe("refunded")
    const after = coord.settleReqs.length
    const again = await sweepDueBookingSettlements(sweepInput(ctx, communityId))
    expect(again.resumed).toBe(0) // already final → not a resume candidate
    expect(coord.settleReqs.length).toBe(after) // no new settle calls
  })

  test("replaced/failed_onchain stay terminal across repeated runs (never re-settled)", async () => {
    const { ctx, communityId, root, hostId, bookerId } = await setup()
    await seedBooking(root, communityId, { bookingId: "bkg1", status: "no_show_host", refundCents: 5000, hostId, bookerId })
    const coord = installCoordinator()
    coord.state.settle = "replaced"
    const first = await sweepDueBookingSettlements(sweepInput(ctx, communityId))
    expect(first.terminal).toBe(1)
    expect(await bookingStatus(root, communityId, "bkg1")).toBe("no_show_host") // never finalized
    const second = await sweepDueBookingSettlements(sweepInput(ctx, communityId))
    expect(second.terminal).toBe(1)
    expect(await bookingStatus(root, communityId, "bkg1")).toBe("no_show_host")
  })

  test("a due live booking with no attendance is left ambiguous (unchanged)", async () => {
    const { ctx, communityId, root, hostId, bookerId } = await setup()
    await seedBooking(root, communityId, { bookingId: "bkg1", status: "live", refundCents: null, hostId, bookerId })
    installCoordinator()
    const summary = await sweepDueBookingSettlements(sweepInput(ctx, communityId))
    expect(summary.ambiguous).toBe(1)
    expect(summary.settled).toBe(0)
    expect(await bookingStatus(root, communityId, "bkg1")).toBe("live") // untouched
  })

  test("one failed booking does not stop sibling bookings", async () => {
    const { ctx, communityId, root, hostId, bookerId } = await setup()
    await seedBooking(root, communityId, { bookingId: "bad", status: "no_show_host", refundCents: 5000, fundingWallet: null, hostId, bookerId }) // fail-closed
    await seedBooking(root, communityId, { bookingId: "good", status: "no_show_host", refundCents: 5000, hostId, bookerId })
    installCoordinator()
    const summary = await sweepDueBookingSettlements(sweepInput(ctx, communityId))
    expect(summary.errors).toBeGreaterThanOrEqual(1)
    expect(await bookingStatus(root, communityId, "good")).toBe("refunded") // sibling still settled
  })

  test("enforces the per-community booking limit", async () => {
    const { ctx, communityId, root, hostId, bookerId } = await setup()
    for (let i = 0; i < 5; i++) await seedBooking(root, communityId, { bookingId: `bkg${i}`, status: "no_show_host", refundCents: 5000, hostId, bookerId })
    installCoordinator()
    const summary = await sweepDueBookingSettlements({ ...sweepInput(ctx, communityId), maxBookingsPerCommunity: 2 })
    expect(summary.checkedResume).toBe(2) // hard limit honored
  })
})
