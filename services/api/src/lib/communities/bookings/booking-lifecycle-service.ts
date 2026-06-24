import {
  applyTransition,
  canTransition,
  computeAllocation,
  resolveRefund,
  type BookingPolicy,
  type BookingState,
} from "@pirate/bookings-domain"

import type { Env } from "../../../env"
import { getControlPlaneClient } from "../../runtime-deps"
import { openCommunityReadClient, openCommunityWriteClient } from "../community-read-access"
import {
  executeBookingOperatorEffect,
  type BookingOperatorEffect,
} from "./booking-custody-adapter"

type CommunityRepository = Parameters<typeof openCommunityReadClient>[1]

interface BookingRow {
  booking_id: string
  community_id: string
  host_user_id: string
  booker_user_id: string
  slot_start_utc: string
  slot_end_utc: string
  gross_cents: number
  platform_fee_bps: number
  refund_cents: number | null
  status: string
  funding_wallet_address: string | null
  host_payout_wallet_address: string | null
}

interface BookingLifecycleSnapshot {
  booking_id: string
  status: string
  refund_cents: number
  refund_tx_ref: string | null
  payout_tx_ref: string | null
}

function asNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value)
}

// Service-level policy defaults (not yet profile-configurable). resolveRefund reads
// cancellationWindowSeconds + refundPolicy; computeAllocation reads platformFeeBps.
function lifecyclePolicy(platformFeeBps: number): BookingPolicy {
  return {
    platformFeeBps,
    holdTtlSeconds: 600,
    minLeadTimeSeconds: 3600,
    maxAdvanceSeconds: 60 * 86400,
    cancellationWindowSeconds: 86400,
    noShowGraceSeconds: 600,
    refundPolicy: {
      bookerCancelAfterWindowRefundBps: 0,
      noShowByBookerRefundBps: 0,
      noShowByHostRefundBps: 10000,
    },
    rounding: "half_up",
  }
}

// The host payout for a settlement is whatever the platform retains after the refund, split 90/10.
// Derived deterministically from the PERSISTED refund (not nowUtc), so retries are stable.
function retainedHostPayout(grossCents: number, refundCents: number, platformFeeBps: number): number {
  const allocation = computeAllocation(Math.max(0, grossCents - refundCents), lifecyclePolicy(platformFeeBps))
  return allocation.legs.find((l) => l.recipientType === "host")?.amountCents ?? 0
}

export type OperatorEffect = BookingOperatorEffect
type OperatorEffectExecutor = (ctx: SettlementContext, effect: OperatorEffect) => Promise<{ txRef: string }>
let operatorEffectExecutor: OperatorEffectExecutor | null = null
export function setBookingOperatorEffectExecutorForTests(fn: OperatorEffectExecutor | null): void {
  operatorEffectExecutor = fn
}
async function executeOperatorEffect(ctx: SettlementContext, effect: OperatorEffect): Promise<{ txRef: string }> {
  if (operatorEffectExecutor) return operatorEffectExecutor(ctx, effect)
  return executeBookingOperatorEffect(ctx, effect)
}

async function loadBooking(env: Env, repo: CommunityRepository, communityId: string, bookingId: string): Promise<BookingRow | null> {
  const handle = await openCommunityReadClient(env, repo, communityId)
  try {
    const r = await handle.client.execute({
      sql: `SELECT booking_id, community_id, host_user_id, booker_user_id, slot_start_utc, slot_end_utc,
                   gross_cents, platform_fee_bps, refund_cents, status,
                   funding_wallet_address, host_payout_wallet_address
            FROM bookings WHERE booking_id = ?1`,
      args: [bookingId],
    })
    const row = r.rows[0]
    if (!row) return null
    return {
      booking_id: String(row.booking_id),
      community_id: String(row.community_id),
      host_user_id: String(row.host_user_id),
      booker_user_id: String(row.booker_user_id),
      slot_start_utc: String(row.slot_start_utc),
      slot_end_utc: String(row.slot_end_utc),
      gross_cents: asNumber(row.gross_cents),
      platform_fee_bps: asNumber(row.platform_fee_bps),
      refund_cents: row.refund_cents != null ? asNumber(row.refund_cents) : null,
      status: String(row.status),
      funding_wallet_address: row.funding_wallet_address ? String(row.funding_wallet_address) : null,
      host_payout_wallet_address: row.host_payout_wallet_address ? String(row.host_payout_wallet_address) : null,
    }
  } finally {
    await handle.close()
  }
}

async function loadSnapshot(env: Env, repo: CommunityRepository, communityId: string, bookingId: string): Promise<BookingLifecycleSnapshot> {
  const handle = await openCommunityReadClient(env, repo, communityId)
  try {
    const r = await handle.client.execute({
      sql: `SELECT booking_id, status, refund_cents, refund_tx_ref, payout_tx_ref
            FROM bookings WHERE booking_id = ?1`,
      args: [bookingId],
    })
    const row = r.rows[0]!
    return {
      booking_id: String(row.booking_id),
      status: String(row.status),
      refund_cents: row.refund_cents != null ? asNumber(row.refund_cents) : 0,
      refund_tx_ref: row.refund_tx_ref ? String(row.refund_tx_ref) : null,
      payout_tx_ref: row.payout_tx_ref ? String(row.payout_tx_ref) : null,
    }
  } finally {
    await handle.close()
  }
}

async function releaseBookingLock(env: Env, bookingId: string, nowUtc: string): Promise<void> {
  await getControlPlaneClient(env).execute({
    sql: `UPDATE booking_host_slot_locks SET status = 'released', updated_at = ?2
          WHERE booking_id = ?1 AND status = 'active'`,
    args: [bookingId, nowUtc],
  })
}

// One short-lived community write connection per statement (opened, executed, closed) so no
// connection is held across the operator-effect await.
async function writeBooking(env: Env, repo: CommunityRepository, communityId: string, statement: { sql: string; args: unknown[] }): Promise<void> {
  const write = await openCommunityWriteClient(env, repo, communityId)
  try {
    await write.client.execute(statement as Parameters<typeof write.client.execute>[0])
  } finally {
    await write.close()
  }
}

// --- Terminal settlement: every money-out path (cancel / complete / no-show) reserves a durable
//     intent state, then runs idempotency-keyed custody effects, then finalizes. The maps below
//     pin the per-intent timestamp (Phase A) and the finalize state/timestamp (Phase C). Column
//     names come only from these whitelists — never from input — so the dynamic SET is injection-safe.
const INTENT_AT: Record<string, "cancelled_at" | "completed_at" | null> = {
  cancelled_by_host: "cancelled_at",
  cancelled_by_booker: "cancelled_at",
  completed: "completed_at",
  no_show_host: null,
  no_show_booker: null,
}
const FINALIZE: Record<string, { finalState: BookingState; finalAt: "settled_at" | null }> = {
  cancelled_by_host: { finalState: "refunded", finalAt: null },
  cancelled_by_booker: { finalState: "refunded", finalAt: null },
  no_show_host: { finalState: "refunded", finalAt: null },
  completed: { finalState: "settled", finalAt: "settled_at" },
  no_show_booker: { finalState: "settled", finalAt: "settled_at" },
}

interface SettlementContext {
  env: Env
  communityRepository: CommunityRepository
  communityId: string
  nowUtc: string
}

function requireSettlementAddress(address: string | null, code: string): string {
  if (!address) throw new Error(code)
  return address
}

// Reservation/outbox settlement: A) persist the refund decision + intent state (BEFORE money),
// B) idempotency-keyed operator effects, C) finalize. Resumes when the booking is already in the
// intent state (a prior attempt reserved but didn't finalize) — same keys, no double-spend.
async function executeSettlement(
  ctx: SettlementContext,
  booking: BookingRow,
  fromState: BookingState,
  intentState: BookingState,
  decidedRefundCents: number,
): Promise<BookingLifecycleSnapshot> {
  const needsReserve = booking.status === fromState
  const refundCents = needsReserve ? decidedRefundCents : booking.refund_cents ?? 0

  // --- Phase A (reserve): persist intent + refund decision, guarded on the from-state.
  if (needsReserve) {
    const intentAt = INTENT_AT[intentState]
    const setClause = intentAt
      ? `status = ?2, refund_cents = ?3, ${intentAt} = ?4, updated_at = ?4`
      : `status = ?2, refund_cents = ?3, updated_at = ?4`
    await writeBooking(ctx.env, ctx.communityRepository, ctx.communityId, {
      sql: `UPDATE bookings SET ${setClause} WHERE booking_id = ?1 AND status = ?5`,
      args: [booking.booking_id, intentState, refundCents, ctx.nowUtc, fromState],
    })
  }

  // --- Phase B (execute): idempotency-keyed custody effects from the persisted refund decision.
  const payoutCents = retainedHostPayout(booking.gross_cents, refundCents, booking.platform_fee_bps)
  let refundTxRef: string | null = null
  let payoutTxRef: string | null = null
  if (refundCents > 0) {
    refundTxRef = (await executeOperatorEffect(ctx, {
      kind: "refund", toUserId: booking.booker_user_id, amountCents: refundCents,
      recipientAddress: requireSettlementAddress(booking.funding_wallet_address, "booking_refund_destination_missing"),
      bookingId: booking.booking_id, idempotencyKey: `booking_refund:${booking.booking_id}`,
    })).txRef
  }
  if (payoutCents > 0) {
    payoutTxRef = (await executeOperatorEffect(ctx, {
      kind: "payout", toUserId: booking.host_user_id, amountCents: payoutCents,
      recipientAddress: requireSettlementAddress(booking.host_payout_wallet_address, "booking_payout_destination_missing"),
      bookingId: booking.booking_id, idempotencyKey: `booking_payout:${booking.booking_id}`,
    })).txRef
  }

  // --- Phase C (finalize): intent → refunded/settled + tx refs.
  const fin = FINALIZE[intentState]
  const setClause = fin.finalAt
    ? `status = ?2, refund_tx_ref = ?3, payout_tx_ref = ?4, ${fin.finalAt} = ?5, updated_at = ?5`
    : `status = ?2, refund_tx_ref = ?3, payout_tx_ref = ?4, updated_at = ?5`
  await writeBooking(ctx.env, ctx.communityRepository, ctx.communityId, {
    sql: `UPDATE bookings SET ${setClause} WHERE booking_id = ?1`,
    args: [booking.booking_id, fin.finalState, refundTxRef, payoutTxRef, ctx.nowUtc],
  })

  await releaseBookingLock(ctx.env, booking.booking_id, ctx.nowUtc)

  return { booking_id: booking.booking_id, status: fin.finalState, refund_cents: refundCents, refund_tx_ref: refundTxRef, payout_tx_ref: payoutTxRef }
}

const CANCELLED_STATES = new Set<string>(["cancelled_by_host", "cancelled_by_booker"])
const NO_SHOW_STATES = new Set<string>(["no_show_host", "no_show_booker"])

export interface LifecycleInput {
  env: Env
  communityRepository: CommunityRepository
  communityId: string
  bookingId: string
  actorUserId: string
  nowUtc: string
}
function ctxOf(input: LifecycleInput): SettlementContext {
  return { env: input.env, communityRepository: input.communityRepository, communityId: input.communityId, nowUtc: input.nowUtc }
}

export type LifecycleResult =
  | { ok: false; reason: "not_found" | "illegal_transition" }
  | { ok: true; already: boolean; booking: BookingLifecycleSnapshot }

type CancelBy = "host" | "booker"
export type CancelBookingResult =
  | { ok: false; reason: "not_found" | "illegal_transition" }
  | { ok: true; already: boolean; cancelledBy: CancelBy; booking: BookingLifecycleSnapshot }

/** Start the 1:1 session: confirmed → live. Either party may start; no money moves. */
export async function startBookingSession(input: LifecycleInput): Promise<LifecycleResult> {
  const booking = await loadBooking(input.env, input.communityRepository, input.communityId, input.bookingId)
  if (!booking) return { ok: false, reason: "not_found" }
  if (booking.host_user_id !== input.actorUserId && booking.booker_user_id !== input.actorUserId) {
    return { ok: false, reason: "not_found" }
  }
  if (booking.status === "live") {
    return { ok: true, already: true, booking: await loadSnapshot(input.env, input.communityRepository, input.communityId, input.bookingId) }
  }
  if (!canTransition(booking.status as BookingState, "SESSION_STARTED")) {
    return { ok: false, reason: "illegal_transition" }
  }
  await writeBooking(input.env, input.communityRepository, input.communityId, {
    sql: `UPDATE bookings SET status = 'live', updated_at = ?2 WHERE booking_id = ?1 AND status = 'confirmed'`,
    args: [booking.booking_id, input.nowUtc],
  })
  return { ok: true, already: false, booking: { booking_id: booking.booking_id, status: "live", refund_cents: booking.refund_cents ?? 0, refund_tx_ref: null, payout_tx_ref: null } }
}

/**
 * Cancel a confirmed booking. The actor's role (host vs booker) is inferred and sets the refund
 * policy; settlement runs via the reservation/outbox flow.
 */
export async function cancelBooking(input: LifecycleInput): Promise<CancelBookingResult> {
  const booking = await loadBooking(input.env, input.communityRepository, input.communityId, input.bookingId)
  if (!booking) return { ok: false, reason: "not_found" }

  let cancelBy: CancelBy
  if (booking.host_user_id === input.actorUserId) cancelBy = "host"
  else if (booking.booker_user_id === input.actorUserId) cancelBy = "booker"
  else return { ok: false, reason: "not_found" }

  if (booking.status === "refunded") {
    return { ok: true, already: true, cancelledBy: cancelBy, booking: await loadSnapshot(input.env, input.communityRepository, input.communityId, input.bookingId) }
  }

  let intentState: BookingState
  let refundCents: number
  if (CANCELLED_STATES.has(booking.status)) {
    intentState = booking.status as BookingState
    refundCents = booking.refund_cents ?? 0
  } else {
    const event = cancelBy === "host" ? "HOST_CANCELS" : "BOOKER_CANCELS"
    if (!canTransition(booking.status as BookingState, event)) return { ok: false, reason: "illegal_transition" }
    intentState = applyTransition(booking.status as BookingState, event)
    const policy = lifecyclePolicy(booking.platform_fee_bps)
    refundCents = resolveRefund({
      state: intentState, cancelledBy: cancelBy, slotStartUtc: booking.slot_start_utc,
      nowUtc: input.nowUtc, policy, allocation: computeAllocation(booking.gross_cents, policy),
    }).refundCents
  }

  const settled = await executeSettlement(ctxOf(input), booking, "confirmed", intentState, refundCents)
  return { ok: true, already: false, cancelledBy: cancelBy, booking: settled }
}

/** Complete a live session: live → completed → settled, paying the host their retained share. */
export async function completeBooking(input: LifecycleInput): Promise<LifecycleResult> {
  const booking = await loadBooking(input.env, input.communityRepository, input.communityId, input.bookingId)
  if (!booking) return { ok: false, reason: "not_found" }
  // Only the host attests delivery; a booker dispute is a separate path (DISPUTE_OPENED).
  if (booking.host_user_id !== input.actorUserId) return { ok: false, reason: "not_found" }

  if (booking.status === "settled") {
    return { ok: true, already: true, booking: await loadSnapshot(input.env, input.communityRepository, input.communityId, input.bookingId) }
  }
  let refundCents = booking.refund_cents ?? 0
  if (booking.status !== "completed") {
    if (!canTransition(booking.status as BookingState, "SESSION_ENDED")) return { ok: false, reason: "illegal_transition" }
    const policy = lifecyclePolicy(booking.platform_fee_bps)
    refundCents = resolveRefund({
      state: "completed", cancelledBy: "system", slotStartUtc: booking.slot_start_utc,
      nowUtc: input.nowUtc, policy, allocation: computeAllocation(booking.gross_cents, policy),
    }).refundCents
  }

  const settled = await executeSettlement(ctxOf(input), booking, "live", "completed", refundCents)
  return { ok: true, already: false, booking: settled }
}

/**
 * Report a no-show on a live booking. The actor reports the OTHER party absent: host → booker
 * no-show (host keeps payout); booker → host no-show (full refund to booker).
 */
export async function noShowBooking(input: LifecycleInput): Promise<LifecycleResult> {
  const booking = await loadBooking(input.env, input.communityRepository, input.communityId, input.bookingId)
  if (!booking) return { ok: false, reason: "not_found" }

  let event: "HOST_NO_SHOW" | "BOOKER_NO_SHOW"
  if (booking.host_user_id === input.actorUserId) event = "BOOKER_NO_SHOW"
  else if (booking.booker_user_id === input.actorUserId) event = "HOST_NO_SHOW"
  else return { ok: false, reason: "not_found" }

  // no_show_host → refunded, no_show_booker → settled: either terminal means already done.
  if (booking.status === "refunded" || booking.status === "settled") {
    return { ok: true, already: true, booking: await loadSnapshot(input.env, input.communityRepository, input.communityId, input.bookingId) }
  }

  let intentState: BookingState
  let refundCents: number
  if (NO_SHOW_STATES.has(booking.status)) {
    intentState = booking.status as BookingState
    refundCents = booking.refund_cents ?? 0
  } else {
    if (!canTransition(booking.status as BookingState, event)) return { ok: false, reason: "illegal_transition" }
    intentState = applyTransition(booking.status as BookingState, event)
    const policy = lifecyclePolicy(booking.platform_fee_bps)
    refundCents = resolveRefund({
      state: intentState, cancelledBy: "system", slotStartUtc: booking.slot_start_utc,
      nowUtc: input.nowUtc, policy, allocation: computeAllocation(booking.gross_cents, policy),
    }).refundCents
  }

  const settled = await executeSettlement(ctxOf(input), booking, "live", intentState, refundCents)
  return { ok: true, already: false, booking: settled }
}
