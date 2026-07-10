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
  bookingSettlementErrorKind,
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

interface BookingSettlementReviewSnapshot {
  booking_id: string
  status: string
  settlement_review_status: string | null
  settlement_review_resolution: string | null
  settlement_review_version: number
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

async function loadSettlementReviewSnapshot(
  env: Env,
  repo: CommunityRepository,
  communityId: string,
  bookingId: string,
): Promise<BookingSettlementReviewSnapshot | null> {
  const handle = await openCommunityReadClient(env, repo, communityId)
  try {
    const r = await handle.client.execute({
      sql: `SELECT booking_id, status, settlement_review_status, settlement_review_resolution,
                   settlement_review_version
            FROM bookings WHERE booking_id = ?1`,
      args: [bookingId],
    })
    const row = r.rows[0]
    if (!row) return null
    return {
      booking_id: String(row.booking_id),
      status: String(row.status),
      settlement_review_status: row.settlement_review_status ? String(row.settlement_review_status) : null,
      settlement_review_resolution: row.settlement_review_resolution ? String(row.settlement_review_resolution) : null,
      settlement_review_version: asNumber(row.settlement_review_version ?? 0),
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

async function writeBookingResult(
  env: Env,
  repo: CommunityRepository,
  communityId: string,
  statement: { sql: string; args: unknown[] },
): Promise<number> {
  const write = await openCommunityWriteClient(env, repo, communityId)
  try {
    const result = await write.client.execute(statement as Parameters<typeof write.client.execute>[0])
    return result.rowsAffected ?? 0
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
  // Explicit confirmation-poll policy threaded to the custody adapter (not a global). Omitted on
  // the interactive path (full default poll); the settlement cron passes [] (one confirm, then resume).
  confirmPollMs?: number[]
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
export type BookingSettlementReviewResolution = "completed" | "no_show_host" | "no_show_booker"

function refundForSettlementReviewResolution(booking: BookingRow, resolution: BookingSettlementReviewResolution): number {
  switch (resolution) {
    case "completed":
    case "no_show_booker":
      return 0
    case "no_show_host":
      return booking.gross_cents
  }
}

export type MarkBookingSettlementAmbiguousResult =
  | { ok: false; reason: "not_found" | "not_reviewable" }
  | { ok: true; already: boolean; reviewVersion: number }

export async function markBookingSettlementAmbiguous(input: {
  env: Env
  communityRepository: CommunityRepository
  communityId: string
  bookingId: string
  nowUtc: string
}): Promise<MarkBookingSettlementAmbiguousResult> {
  const review = await loadSettlementReviewSnapshot(input.env, input.communityRepository, input.communityId, input.bookingId)
  if (!review) return { ok: false, reason: "not_found" }
  if (review.status === "disputed" && review.settlement_review_status === "pending") {
    return { ok: true, already: true, reviewVersion: review.settlement_review_version }
  }
  if (review.status !== "confirmed" && review.status !== "live") {
    return { ok: false, reason: "not_reviewable" }
  }
  const rowsAffected = await writeBookingResult(input.env, input.communityRepository, input.communityId, {
    sql: `UPDATE bookings
          SET status = 'disputed',
              settlement_review_status = 'pending',
              settlement_review_reason = 'attendance_ambiguous',
              settlement_review_resolution = NULL,
              settlement_review_opened_at = COALESCE(settlement_review_opened_at, ?2),
              settlement_review_resolved_at = NULL,
              settlement_review_operator_credential_id = NULL,
              settlement_review_operator_actor_id = NULL,
              settlement_review_note = NULL,
              settlement_review_version = settlement_review_version + 1,
              updated_at = ?2
          WHERE booking_id = ?1
            AND status IN ('confirmed', 'live')
            AND settlement_review_status IS NULL`,
    args: [input.bookingId, input.nowUtc],
  })
  if (rowsAffected !== 1) {
    const latest = await loadSettlementReviewSnapshot(input.env, input.communityRepository, input.communityId, input.bookingId)
    if (latest?.status === "disputed" && latest.settlement_review_status === "pending") {
      return { ok: true, already: true, reviewVersion: latest.settlement_review_version }
    }
    return { ok: false, reason: "not_reviewable" }
  }
  const latest = await loadSettlementReviewSnapshot(input.env, input.communityRepository, input.communityId, input.bookingId)
  return { ok: true, already: false, reviewVersion: latest?.settlement_review_version ?? 1 }
}

export type ResolveBookingSettlementReviewResult =
  | { ok: false; reason: "not_found" | "not_pending_review" | "version_conflict" | "resolution_conflict" | "invalid_resolution" }
  | { ok: true; outcome: "resolved" | "resolved_pending" | "replayed"; booking: BookingLifecycleSnapshot }

// Every unfinished intent state (reserved + maybe broadcast, not yet finalized to settled/refunded).
const UNFINISHED_INTENT_STATES = new Set<string>([
  "completed", "no_show_booker", "no_show_host", "cancelled_by_host", "cancelled_by_booker",
])

function resolvedReviewReplayOutcome(
  review: BookingSettlementReviewSnapshot,
  resolution: BookingSettlementReviewResolution,
): "replayed" | "resolved_pending" | null {
  if (review.settlement_review_resolution !== resolution) return null
  if (review.status === "settled" || review.status === "refunded") return "replayed"
  if (UNFINISHED_INTENT_STATES.has(review.status)) return "resolved_pending"
  return null
}

export async function resolveBookingSettlementReview(input: {
  env: Env
  communityRepository: CommunityRepository
  communityId: string
  bookingId: string
  resolution: BookingSettlementReviewResolution
  expectedReviewVersion: number
  operatorCredentialId: string
  operatorActorId: string
  note?: string | null
  nowUtc: string
  confirmPollMs?: number[]
}): Promise<ResolveBookingSettlementReviewResult> {
  if (!Number.isInteger(input.expectedReviewVersion) || input.expectedReviewVersion < 0) {
    return { ok: false, reason: "version_conflict" }
  }

  const review = await loadSettlementReviewSnapshot(input.env, input.communityRepository, input.communityId, input.bookingId)
  if (!review) return { ok: false, reason: "not_found" }
  if (review.settlement_review_status === "resolved") {
    const replayOutcome = resolvedReviewReplayOutcome(review, input.resolution)
    if (replayOutcome) {
      return {
        ok: true,
        outcome: replayOutcome,
        booking: await loadSnapshot(input.env, input.communityRepository, input.communityId, input.bookingId),
      }
    }
    return { ok: false, reason: "resolution_conflict" }
  }
  if (review.status !== "disputed" || review.settlement_review_status !== "pending") {
    return { ok: false, reason: "not_pending_review" }
  }
  if (review.settlement_review_version !== input.expectedReviewVersion) {
    return { ok: false, reason: "version_conflict" }
  }

  const booking = await loadBooking(input.env, input.communityRepository, input.communityId, input.bookingId)
  if (!booking || booking.status !== "disputed") return { ok: false, reason: "not_pending_review" }
  const refundCents = refundForSettlementReviewResolution(booking, input.resolution)
  const rowsAffected = await writeBookingResult(input.env, input.communityRepository, input.communityId, {
    sql: `UPDATE bookings
          SET status = ?2,
              refund_cents = ?3,
              settlement_review_status = 'resolved',
              settlement_review_resolution = ?2,
              settlement_review_resolved_at = ?4,
              settlement_review_operator_credential_id = ?5,
              settlement_review_operator_actor_id = ?6,
              settlement_review_note = ?7,
              settlement_review_version = settlement_review_version + 1,
              updated_at = ?4
          WHERE booking_id = ?1
            AND status = 'disputed'
            AND settlement_review_status = 'pending'
            AND settlement_review_version = ?8`,
    args: [
      input.bookingId,
      input.resolution,
      refundCents,
      input.nowUtc,
      input.operatorCredentialId,
      input.operatorActorId,
      input.note ?? null,
      input.expectedReviewVersion,
    ],
  })
  if (rowsAffected !== 1) {
    const latest = await loadSettlementReviewSnapshot(input.env, input.communityRepository, input.communityId, input.bookingId)
    if (latest?.settlement_review_status === "resolved") {
      const replayOutcome = resolvedReviewReplayOutcome(latest, input.resolution)
      return replayOutcome
        ? {
            ok: true,
            outcome: replayOutcome,
            booking: await loadSnapshot(input.env, input.communityRepository, input.communityId, input.bookingId),
          }
        : { ok: false, reason: "resolution_conflict" }
    }
    return { ok: false, reason: "version_conflict" }
  }

  try {
    const reconciled = await reconcileBookingSettlement({
      env: input.env,
      communityRepository: input.communityRepository,
      communityId: input.communityId,
      bookingId: input.bookingId,
      nowUtc: input.nowUtc,
      confirmPollMs: input.confirmPollMs,
    })
    if (reconciled.outcome !== "resumed") {
      return {
        ok: true,
        outcome: "resolved_pending",
        booking: await loadSnapshot(input.env, input.communityRepository, input.communityId, input.bookingId),
      }
    }
    return { ok: true, outcome: "resolved", booking: reconciled.booking }
  } catch (error) {
    if (bookingSettlementErrorKind(error) === "pending") {
      return {
        ok: true,
        outcome: "resolved_pending",
        booking: await loadSnapshot(input.env, input.communityRepository, input.communityId, input.bookingId),
      }
    }
    throw error
  }
}

export interface LifecycleInput {
  env: Env
  communityRepository: CommunityRepository
  communityId: string
  bookingId: string
  actorUserId: string
  nowUtc: string
  confirmPollMs?: number[]
  expectedRefundCents?: number
  // The unattended settlement evaluator (D4) drives the same transitions for ALREADY-PAST sessions
  // based on recorded attendance, so it bypasses the user-facing schedule windows. Never set this on
  // a request-initiated call.
  system?: boolean
}
function ctxOf(input: LifecycleInput): SettlementContext {
  return { env: input.env, communityRepository: input.communityRepository, communityId: input.communityId, nowUtc: input.nowUtc, confirmPollMs: input.confirmPollMs }
}

export type LifecycleResult =
  | { ok: false; reason: "not_found" | "illegal_transition" | "outside_start_window" | "too_early_to_complete" | "too_early_for_no_show" }
  | { ok: true; already: boolean; booking: BookingLifecycleSnapshot }

// Server-enforced schedule bounds on the payout-relevant lifecycle transitions (the web gate is not
// authoritative — direct API callers must be bound too). A session may only START from 5 minutes
// before its slot until the slot end; it may only be COMPLETED once its scheduled start has arrived
// (so a host cannot start-and-instantly-settle early); a NO-SHOW may only be reported after a grace
// period past the scheduled start.
const SESSION_START_LEAD_MS = 5 * 60_000
const NO_SHOW_GRACE_MS = 10 * 60_000
function epochMs(iso: string): number { return Date.parse(iso) }

type CancelBy = "host" | "booker"
export type CancelBookingResult =
  | { ok: false; reason: "not_found" | "illegal_transition" }
  | { ok: false; reason: "cancellation_terms_changed"; preview: {
      object: "booking_cancellation_preview"
      booking_id: string
      cancelled_by: CancelBy
      gross_cents: number
      refund_cents: number
      host_payout_cents: number
      platform_fee_cents: number
      previewed_at: string
      policy_cutoff_at: string | null
    } }
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
  // Schedule bound: cannot start before the join window opens or after the slot has ended.
  const startNow = epochMs(input.nowUtc)
  if (!input.system && (startNow < epochMs(booking.slot_start_utc) - SESSION_START_LEAD_MS || startNow >= epochMs(booking.slot_end_utc))) {
    return { ok: false, reason: "outside_start_window" }
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

  const hostPayoutCents = retainedHostPayout(booking.gross_cents, refundCents, booking.platform_fee_bps)
  const preview = {
    object: "booking_cancellation_preview" as const,
    booking_id: booking.booking_id,
    cancelled_by: cancelBy,
    gross_cents: booking.gross_cents,
    refund_cents: refundCents,
    host_payout_cents: hostPayoutCents,
    platform_fee_cents: booking.gross_cents - refundCents - hostPayoutCents,
    previewed_at: input.nowUtc,
    policy_cutoff_at: cancelBy === "booker"
      ? new Date(epochMs(booking.slot_start_utc) - lifecyclePolicy(booking.platform_fee_bps).cancellationWindowSeconds * 1000).toISOString()
      : null,
  }
  if (input.expectedRefundCents !== undefined && input.expectedRefundCents !== refundCents) {
    return { ok: false, reason: "cancellation_terms_changed", preview }
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
    // Schedule bound: cannot complete (and pay the host) before the scheduled start has arrived.
    if (!input.system && epochMs(input.nowUtc) < epochMs(booking.slot_start_utc)) return { ok: false, reason: "too_early_to_complete" }
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
    // Schedule bound: a no-show can only be reported after the grace period past the scheduled start.
    if (!input.system && epochMs(input.nowUtc) < epochMs(booking.slot_start_utc) + NO_SHOW_GRACE_MS) return { ok: false, reason: "too_early_for_no_show" }
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

export type ReconcileBookingSettlementResult =
  | { outcome: "skipped" }
  | { outcome: "resumed"; booking: BookingLifecycleSnapshot }

/**
 * Resume an unfinished settlement (a prior attempt reserved the intent + maybe broadcast but never
 * finalized — e.g. a confirmation timeout or a crash). No actor: the financial decision is
 * RECONSTRUCTED STRICTLY from persisted booking data (intent state + persisted refund_cents +
 * destination snapshots) and never recomputed. Inconsistent/incomplete intent records fail closed.
 * Idempotent: re-runs the same idempotency-keyed effects (coordinator + ledger dedupe) then finalizes.
 */
export async function reconcileBookingSettlement(input: {
  env: Env
  communityRepository: CommunityRepository
  communityId: string
  bookingId: string
  nowUtc: string
  confirmPollMs?: number[]
}): Promise<ReconcileBookingSettlementResult> {
  const booking = await loadBooking(input.env, input.communityRepository, input.communityId, input.bookingId)
  // Resume ONLY exact unfinished intent states; anything else (final, pre-intent, missing) is skipped.
  if (!booking || !UNFINISHED_INTENT_STATES.has(booking.status)) return { outcome: "skipped" }

  // Reject incomplete/inconsistent intent records instead of guessing a financial decision.
  if (!FINALIZE[booking.status]) throw new Error(`booking_settlement_unknown_intent_state:${booking.status}`)
  if (booking.refund_cents == null) throw new Error("booking_settlement_intent_missing_refund_decision")
  if (!Number.isInteger(booking.refund_cents) || booking.refund_cents < 0 || booking.refund_cents > booking.gross_cents) {
    throw new Error("booking_settlement_intent_refund_out_of_range")
  }
  const refundCents = booking.refund_cents
  const payoutCents = retainedHostPayout(booking.gross_cents, refundCents, booking.platform_fee_bps)
  if (refundCents > 0 && !booking.funding_wallet_address) throw new Error("booking_refund_destination_missing")
  if (payoutCents > 0 && !booking.host_payout_wallet_address) throw new Error("booking_payout_destination_missing")

  // The booking is already in its intent state, so executeSettlement skips Phase A (needsReserve =
  // status === fromState is false) and re-runs Phase B/C from persisted data. fromState is only the
  // (now-unmatched) reserve guard.
  const fromState: BookingState = CANCELLED_STATES.has(booking.status) ? "confirmed" : "live"
  const ctx: SettlementContext = {
    env: input.env, communityRepository: input.communityRepository, communityId: input.communityId,
    nowUtc: input.nowUtc, confirmPollMs: input.confirmPollMs,
  }
  const settled = await executeSettlement(ctx, booking, fromState, booking.status as BookingState, refundCents)
  return { outcome: "resumed", booking: settled }
}
