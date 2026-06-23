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

// The host payout for a cancellation is whatever the platform retains after the refund, split
// 90/10. Derived deterministically from the PERSISTED refund (not nowUtc), so retries are stable.
function retainedHostPayout(grossCents: number, refundCents: number, platformFeeBps: number): number {
  const allocation = computeAllocation(Math.max(0, grossCents - refundCents), lifecyclePolicy(platformFeeBps))
  return allocation.legs.find((l) => l.recipientType === "host")?.amountCents ?? 0
}

// Operator custody effect (USDC out): refund to booker / payout to host. The real on-chain
// transfer from custody is a separate integration (the money-OUT mirror of PR0's funding-IN); it
// sits behind a seam so the lifecycle/FSM/refund logic is testable now. The idempotencyKey is the
// durable dedup handle: the real adapter MUST return the existing tx for a repeated key rather
// than transferring twice, so a retry after a crash never double-spends.
export interface OperatorEffect {
  kind: "payout" | "refund"
  toUserId: string
  amountCents: number
  bookingId: string
  idempotencyKey: string
}
type OperatorEffectExecutor = (env: Env, effect: OperatorEffect) => Promise<{ txRef: string }>
let operatorEffectExecutor: OperatorEffectExecutor | null = null
export function setBookingOperatorEffectExecutorForTests(fn: OperatorEffectExecutor | null): void {
  operatorEffectExecutor = fn
}
async function executeOperatorEffect(env: Env, effect: OperatorEffect): Promise<{ txRef: string }> {
  if (operatorEffectExecutor) return operatorEffectExecutor(env, effect)
  throw new Error("operator custody effects are not configured")
}

async function loadBooking(env: Env, repo: CommunityRepository, communityId: string, bookingId: string): Promise<BookingRow | null> {
  const handle = await openCommunityReadClient(env, repo, communityId)
  try {
    const r = await handle.client.execute({
      sql: `SELECT booking_id, community_id, host_user_id, booker_user_id, slot_start_utc, slot_end_utc,
                   gross_cents, platform_fee_bps, refund_cents, status
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

type CancelBy = "host" | "booker"
const CANCELLED_STATES = new Set<string>(["cancelled_by_host", "cancelled_by_booker"])

export type CancelBookingResult =
  | { ok: false; reason: "not_found" | "illegal_transition" }
  | { ok: true; already: boolean; cancelledBy: CancelBy; booking: BookingLifecycleSnapshot }

/**
 * Cancel a booking via a reservation/outbox flow so money never moves before durable state
 * records the intent:
 *   A) reserve   — confirmed → cancelled_by_* + persist the (nowUtc-dependent) refund decision
 *   B) execute   — idempotency-keyed operator refund/payout (retry-safe at the seam)
 *   C) finalize  — cancelled_by_* → refunded + record tx refs
 * A crash between B and C leaves the booking in cancelled_by_*; a retry resumes at B with the
 * same keys (no double-spend) and completes C.
 */
export async function cancelBooking(input: {
  env: Env
  communityRepository: CommunityRepository
  communityId: string
  bookingId: string
  actorUserId: string
  nowUtc: string
}): Promise<CancelBookingResult> {
  const booking = await loadBooking(input.env, input.communityRepository, input.communityId, input.bookingId)
  if (!booking) return { ok: false, reason: "not_found" }

  // The actor's role determines the cancel policy. Only a party to the booking may cancel.
  let cancelBy: CancelBy
  if (booking.host_user_id === input.actorUserId) cancelBy = "host"
  else if (booking.booker_user_id === input.actorUserId) cancelBy = "booker"
  else return { ok: false, reason: "not_found" }

  // Idempotent terminal state.
  if (booking.status === "refunded") {
    return { ok: true, already: true, cancelledBy: cancelBy, booking: await loadSnapshot(input.env, input.communityRepository, input.communityId, input.bookingId) }
  }

  // Decide the cancellation: resume from an already-reserved cancelled_by_* state, or compute the
  // (nowUtc-dependent) refund from 'confirmed'. The reserve write happens below before any money.
  let cancelledState: BookingState
  let refundCents: number
  let needsReserve: boolean
  if (CANCELLED_STATES.has(booking.status)) {
    cancelledState = booking.status as BookingState
    refundCents = booking.refund_cents ?? 0
    needsReserve = false
  } else {
    const cancelEvent = cancelBy === "host" ? "HOST_CANCELS" : "BOOKER_CANCELS"
    if (!canTransition(booking.status as BookingState, cancelEvent)) {
      return { ok: false, reason: "illegal_transition" }
    }
    cancelledState = applyTransition(booking.status as BookingState, cancelEvent)
    const policy = lifecyclePolicy(booking.platform_fee_bps)
    const refund = resolveRefund({
      state: cancelledState,
      cancelledBy: cancelBy,
      slotStartUtc: booking.slot_start_utc,
      nowUtc: input.nowUtc,
      policy,
      allocation: computeAllocation(booking.gross_cents, policy),
    })
    refundCents = refund.refundCents
    needsReserve = true
  }

  const payoutCents = retainedHostPayout(booking.gross_cents, refundCents, booking.platform_fee_bps)

  // --- Phase A (reserve): persist the refund decision BEFORE any money moves, in its own
  //     short-lived connection (no DB connection is held across the operator effect). Guarded on
  //     status='confirmed' so a concurrent reserve can't double-apply.
  if (needsReserve) {
    await writeBooking(input.env, input.communityRepository, input.communityId, {
      sql: `UPDATE bookings SET status = ?2, refund_cents = ?3, cancelled_at = ?4, updated_at = ?4
            WHERE booking_id = ?1 AND status = 'confirmed'`,
      args: [booking.booking_id, cancelledState, refundCents, input.nowUtc],
    })
  }

  // --- Phase B (execute): idempotency-keyed custody effects from the persisted refund decision.
  let refundTxRef: string | null = null
  let payoutTxRef: string | null = null
  if (refundCents > 0) {
    refundTxRef = (await executeOperatorEffect(input.env, {
      kind: "refund", toUserId: booking.booker_user_id, amountCents: refundCents,
      bookingId: booking.booking_id, idempotencyKey: `booking_refund:${booking.booking_id}`,
    })).txRef
  }
  if (payoutCents > 0) {
    payoutTxRef = (await executeOperatorEffect(input.env, {
      kind: "payout", toUserId: booking.host_user_id, amountCents: payoutCents,
      bookingId: booking.booking_id, idempotencyKey: `booking_payout:${booking.booking_id}`,
    })).txRef
  }

  // --- Phase C (finalize): cancelled_by_* → refunded + tx refs.
  const finalState = applyTransition(cancelledState, "REFUND_EXECUTED")
  await writeBooking(input.env, input.communityRepository, input.communityId, {
    sql: `UPDATE bookings SET status = ?2, refund_tx_ref = ?3, payout_tx_ref = ?4, updated_at = ?5
          WHERE booking_id = ?1`,
    args: [booking.booking_id, finalState, refundTxRef, payoutTxRef, input.nowUtc],
  })

  await releaseBookingLock(input.env, booking.booking_id, input.nowUtc)

  return {
    ok: true,
    already: false,
    cancelledBy: cancelBy,
    booking: { booking_id: booking.booking_id, status: finalState, refund_cents: refundCents, refund_tx_ref: refundTxRef, payout_tx_ref: payoutTxRef },
  }
}
