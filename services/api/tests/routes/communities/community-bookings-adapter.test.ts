import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { createClient } from "@libsql/client"

import {
  executeBookingOperatorEffect,
  setBookingSettlementConfirmPollPlanForTests,
  setBookingSettlementCoordinatorForTests,
} from "../../../src/lib/communities/bookings/booking-custody-adapter"
import {
  beginBookingSettlementEffectAttempt,
  getBookingSettlementEffectByIdempotencyKey,
  mirrorBookingSettlementCoordinatorEffect,
} from "../../../src/lib/communities/bookings/booking-settlement-effects"
import type { OperatorSettleRequest, OperatorSettleResult, OperatorSettleState } from "../../../src/lib/communities/bookings/operator-signing-coordinator-do"
import { getCommunityRepository } from "../../../src/lib/communities/db-community-repository"
import { buildLocalCommunityDbUrl } from "../../../src/lib/communities/community-local-db"
import { createRouteTestContext, json, resetRuntimeCaches } from "../../helpers"
import { completeUniqueHumanVerification, exchangeJwt, requestJson } from "./community-routes-test-helpers"

setDefaultTimeout(20_000)
type Ctx = Awaited<ReturnType<typeof createRouteTestContext>>
const BOOKER = "0x0000000000000000000000000000000000000222"
const HOST = "0x0000000000000000000000000000000000000111"
const COORD_REF = "do-key:refund"

let cleanup: (() => Promise<void>) | null = null
beforeEach(() => { resetRuntimeCaches(); setBookingSettlementConfirmPollPlanForTests([]) })
afterEach(async () => { setBookingSettlementCoordinatorForTests(null); setBookingSettlementConfirmPollPlanForTests(null); if (cleanup) { await cleanup(); cleanup = null } })

function res(state: OperatorSettleState, txHash: string | null, nonce: number | null): OperatorSettleResult {
  return { idempotencyKey: COORD_REF, txHash, nonce, state }
}
type CoordOverride = {
  settle?: (r: OperatorSettleRequest) => OperatorSettleResult
  confirm?: (r: OperatorSettleRequest, h: string) => OperatorSettleResult
  reconcile?: (r: OperatorSettleRequest) => OperatorSettleResult
}
function mockCoordinator(c: CoordOverride): { settle: number; confirm: number; reconcile: number } {
  const calls = { settle: 0, confirm: 0, reconcile: 0 }
  setBookingSettlementCoordinatorForTests({
    settle: async (r) => { calls.settle++; return (c.settle ? c.settle(r) : res("broadcast", "0xTX", 7)) },
    confirm: async (r, h) => { calls.confirm++; return (c.confirm ? c.confirm(r, h) : res("confirmed", h, 7)) },
    reconcile: async (r) => { calls.reconcile++; return (c.reconcile ? c.reconcile(r) : res("broadcast", "0xTX", 7)) },
  })
  return calls
}

async function setup() {
  const ctx = await createRouteTestContext()
  cleanup = ctx.cleanup
  const host = await exchangeJwt(ctx.env, "adp-host")
  await completeUniqueHumanVerification(ctx.env, host.accessToken)
  const r = await requestJson("http://pirate.test/communities", { display_name: "Adapter Test", membership_mode: "request", handle_policy: { policy_template: "standard" } }, ctx.env, host.accessToken)
  const communityId = (await json(r) as { community: { id: string } }).community.id.replace(/^com_/, "")
  const booker = await exchangeJwt(ctx.env, "adp-booker")
  await completeUniqueHumanVerification(ctx.env, booker.accessToken)
  const root = String(ctx.env.LOCAL_COMMUNITY_DB_ROOT)
  const dbc = createClient({ url: buildLocalCommunityDbUrl(root, communityId) })
  await dbc.execute({
    sql: `INSERT INTO bookings (booking_id, community_id, hold_id, host_user_id, booker_user_id, slot_start_utc, slot_end_utc,
            gross_cents, platform_fee_bps, platform_fee_cents, host_payout_cents, status, funding_wallet_address,
            host_payout_wallet_address, created_at, updated_at)
          VALUES ('bkg1', ?1, NULL, ?2, ?3, ?4, ?5, 5000, 1000, 500, 4500, 'confirmed', ?6, ?7, ?8, ?8)`,
    args: [communityId, host.userId, booker.userId, new Date(Date.now() - 3600_000).toISOString(), new Date(Date.now() - 1800_000).toISOString(), BOOKER, HOST, new Date().toISOString()],
  })
  dbc.close()
  return { ctx, communityId, root }
}
function adapterCtx(ctx: Ctx, communityId: string) {
  return { env: ctx.env, communityRepository: getCommunityRepository(ctx.env), communityId, nowUtc: new Date().toISOString() }
}
const EFFECT = { kind: "refund" as const, toUserId: "u_booker", recipientAddress: BOOKER, amountCents: 5000, bookingId: "bkg1", idempotencyKey: "c:bkg1:booking_refund" }
function ledgerRow(root: string, communityId: string) {
  const c = createClient({ url: buildLocalCommunityDbUrl(root, communityId) })
  return getBookingSettlementEffectByIdempotencyKey({ client: c, idempotencyKey: EFFECT.idempotencyKey }).finally(() => c.close())
}

describe("booking custody adapter → coordinator (D5 F2)", () => {
  test("broadcast → confirmed: ledger confirmed, returns txRef", async () => {
    const { ctx, communityId, root } = await setup()
    const calls = mockCoordinator({})
    const out = await executeBookingOperatorEffect(adapterCtx(ctx, communityId), EFFECT)
    expect(out.txRef).toBe("0xTX")
    expect(calls.settle).toBe(1)
    const row = await ledgerRow(root, communityId)
    expect(row?.status).toBe("confirmed")
    expect(row?.coordinator_ref).toBe(COORD_REF)
    expect(row?.broadcast_nonce).toBe(7)
  })

  test("confirmation timeout leaves the ledger recoverable, never failed", async () => {
    const { ctx, communityId, root } = await setup()
    mockCoordinator({ confirm: () => res("broadcast", "0xTX", 7) }) // never confirms (pending forever)
    await expect(executeBookingOperatorEffect(adapterCtx(ctx, communityId), EFFECT)).rejects.toThrow(/pending|retry/i)
    const row = await ledgerRow(root, communityId)
    expect(row?.status).toBe("submitted") // recoverable, NOT failed
    expect(row?.settlement_ref).toBe("0xTX")
    expect(row?.coordinator_state).toBe("broadcast")
  })

  test("crash after DO broadcast but before D1 mirror: retry discovers the DO record and completes", async () => {
    const { ctx, communityId, root } = await setup()
    // post-crash state: begin ran (submitted) but mirror did not.
    const seed = createClient({ url: buildLocalCommunityDbUrl(root, communityId) })
    await beginBookingSettlementEffectAttempt({ client: seed, communityId, bookingId: "bkg1", effectKind: "booking_refund", idempotencyKey: EFFECT.idempotencyKey, amountCents: 5000, recipientAddress: BOOKER, now: new Date().toISOString() })
    seed.close()
    mockCoordinator({}) // DO settle returns the existing broadcast (idempotent)
    const out = await executeBookingOperatorEffect(adapterCtx(ctx, communityId), EFFECT)
    expect(out.txRef).toBe("0xTX")
    expect((await ledgerRow(root, communityId))?.status).toBe("confirmed")
  })

  test("crash after D1 mirror but before confirmation: retry completes idempotently", async () => {
    const { ctx, communityId, root } = await setup()
    const seed = createClient({ url: buildLocalCommunityDbUrl(root, communityId) })
    await beginBookingSettlementEffectAttempt({ client: seed, communityId, bookingId: "bkg1", effectKind: "booking_refund", idempotencyKey: EFFECT.idempotencyKey, amountCents: 5000, recipientAddress: BOOKER, now: new Date().toISOString() })
    await mirrorBookingSettlementCoordinatorEffect({ client: seed, idempotencyKey: EFFECT.idempotencyKey, coordinatorRef: COORD_REF, coordinatorState: "broadcast", settlementRef: "0xTX", nonce: 7, now: new Date().toISOString() })
    seed.close()
    mockCoordinator({}) // same hash from DO → idempotent mirror, then confirm
    const out = await executeBookingOperatorEffect(adapterCtx(ctx, communityId), EFFECT)
    expect(out.txRef).toBe("0xTX")
    expect((await ledgerRow(root, communityId))?.status).toBe("confirmed")
  })

  test("prepared → bounded reconcile drives to broadcast then confirm", async () => {
    const { ctx, communityId, root } = await setup()
    const calls = mockCoordinator({ settle: () => res("prepared", "0xTX", 7), reconcile: () => res("broadcast", "0xTX", 7) })
    const out = await executeBookingOperatorEffect(adapterCtx(ctx, communityId), EFFECT)
    expect(out.txRef).toBe("0xTX")
    expect(calls.reconcile).toBeGreaterThanOrEqual(1)
    expect((await ledgerRow(root, communityId))?.status).toBe("confirmed")
  })

  test.each(["reserving", "failed_preparation"] as const)("%s is retryable and leaves the ledger submitted", async (state) => {
    const { ctx, communityId, root } = await setup()
    mockCoordinator({ settle: () => res(state, null, 7), reconcile: () => res(state, null, 7) })
    await expect(executeBookingOperatorEffect(adapterCtx(ctx, communityId), EFFECT)).rejects.toThrow(/retry|broadcast/i)
    expect((await ledgerRow(root, communityId))?.status).toBe("submitted")
  })

  test.each(["replaced", "failed_onchain"] as const)("%s is terminal: ledger stays submitted (no failed→retry), records coordinator_state", async (state) => {
    const { ctx, communityId, root } = await setup()
    const calls = mockCoordinator({ settle: () => res(state, "0xTX", 7) })
    await expect(executeBookingOperatorEffect(adapterCtx(ctx, communityId), EFFECT)).rejects.toThrow(/terminal|reconciliation/i)
    const row = await ledgerRow(root, communityId)
    expect(row?.status).toBe("submitted") // NOT 'failed' → never eligible for a new transaction
    expect(row?.coordinator_state).toBe(state)
    expect(calls.settle).toBe(1) // never re-attempted within the call
  })
})
