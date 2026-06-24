import type { Env } from "../../../env"
import { openCommunityReadClient } from "../community-read-access"
import { selectScheduledCommunityJobPollIds } from "../jobs/runner"
import { bookingSettlementErrorKind } from "./booking-custody-adapter"
import { reconcileBookingSettlement, type ReconcileBookingSettlementResult } from "./booking-lifecycle-service"
import { resolveDueBooking, type ResolveDueResult } from "./booking-settlement-evaluator"

type CommunityRepository = Parameters<typeof openCommunityReadClient>[1] & {
  listActiveCommunities: (input?: { limit?: number }) => Promise<Array<{ community_id: string; created_at?: string | null }>>
}

// Gating: missing / empty / invalid all resolve to DISABLED. Only an explicit normalized "true"
// enables. Keeps unattended settlement off until migrations are applied + the flag is flipped.
export function isBookingSettlementCronEnabled(env: Env): boolean {
  return String(env.BOOKINGS_SETTLEMENT_CRON_ENABLED ?? "").trim().toLowerCase() === "true"
}

// Cron confirmation policy: ZERO extra polling. One confirm attempt inside the settlement; if still
// unconfirmed it is left pending and resumed on a later tick — one tx can't consume the cron budget.
const CRON_CONFIRM_POLL_MS: ReadonlyArray<number> = []
const RESUME_STATES = "'completed','no_show_booker','no_show_host','cancelled_by_host','cancelled_by_booker'"

export interface BookingSettlementSweepSummary {
  enabled: boolean
  communitiesScanned: number
  checkedDue: number
  checkedResume: number
  initiated: number
  resumed: number
  settled: number
  pending: number
  ambiguous: number
  terminal: number
  skipped: number
  errors: number
  deadlineReached: boolean
}

function emptySummary(enabled: boolean): BookingSettlementSweepSummary {
  return { enabled, communitiesScanned: 0, checkedDue: 0, checkedResume: 0, initiated: 0, resumed: 0, settled: 0, pending: 0, ambiguous: 0, terminal: 0, skipped: 0, errors: 0, deadlineReached: false }
}

// Log a failure with stable identifiers ONLY. The thrown messages here are controlled strings
// (e.g. "...confirmation pending (retryable)", "booking_refund_destination_missing"); never log raw
// objects, wallet addresses, signed transactions, or secrets.
function logSettlementFailure(scope: string, communityId: string, bookingId: string | null, error: unknown): void {
  const message = String((error as { message?: unknown })?.message ?? error).slice(0, 200)
  console.error("[booking-settlements] failure", JSON.stringify({ scope, communityId, bookingId, message }))
}

export interface ProcessCommunityInput {
  env: Env
  communityRepository: CommunityRepository
  communityId: string
  nowUtc: string
  maxBookings: number
  confirmPollMs: ReadonlyArray<number>
  summary: BookingSettlementSweepSummary
  shouldStop: () => boolean
}
export type ProcessCommunityFn = (input: ProcessCommunityInput) => Promise<void>

export interface SweepBookingSettlementsInput {
  env: Env
  communityRepository: CommunityRepository
  maxCommunities?: number
  maxBookingsPerCommunity?: number
  deadlineMs?: number
  now?: () => number
  // Test seam: process one community (enumerate + settle). Default = real D1 + lifecycle.
  processCommunity?: ProcessCommunityFn
}

/**
 * One unattended booking-settlement sweep. Gated, rotated, deadline-bounded, per-community isolated.
 * Per community two bounded passes: INITIATE due confirmed/live bookings from objective attendance,
 * and RESUME unfinished intent states (e.g. a prior confirmation timeout). Returns a structured
 * summary. Performs NO settlement and NO enumeration when the flag is disabled.
 */
export async function sweepDueBookingSettlements(input: SweepBookingSettlementsInput): Promise<BookingSettlementSweepSummary> {
  const now = input.now ?? (() => Date.now())
  const enabled = isBookingSettlementCronEnabled(input.env)
  const summary = emptySummary(enabled)
  if (!enabled) return summary // disabled: no enumeration, no side effects

  const maxCommunities = Math.max(1, Math.trunc(input.maxCommunities ?? 50))
  const maxBookings = Math.max(1, Math.trunc(input.maxBookingsPerCommunity ?? 25))
  const deadlineMs = Math.max(1, Math.trunc(input.deadlineMs ?? 20_000))
  const start = now()
  const shouldStop = (): boolean => now() - start >= deadlineMs
  const process = input.processCommunity ?? processCommunityBookingSettlements

  // Fair rotation across ticks using the existing scheduler utility (newest kept + remainder rotated).
  const communities = await input.communityRepository.listActiveCommunities()
  const communityIds = selectScheduledCommunityJobPollIds(communities, maxCommunities, now())

  for (const communityId of communityIds) {
    if (shouldStop()) { summary.deadlineReached = true; break } // stop STARTING new communities
    try {
      await process({
        env: input.env, communityRepository: input.communityRepository, communityId,
        nowUtc: new Date(now()).toISOString(), maxBookings, confirmPollMs: CRON_CONFIRM_POLL_MS, summary, shouldStop,
      })
      summary.communitiesScanned += 1
    } catch (error) {
      // A failed community must not stop later communities.
      summary.errors += 1
      logSettlementFailure("community", communityId, null, error)
    }
  }
  return summary
}

/** Default per-community processor: enumerate due + resume candidates from D1, then settle each. */
export async function processCommunityBookingSettlements(input: ProcessCommunityInput): Promise<void> {
  let dueIds: string[] = []
  let resumeIds: string[] = []
  const handle = await openCommunityReadClient(input.env, input.communityRepository, input.communityId)
  try {
    // Separate queries, deterministic ordering, hard limits.
    const due = await handle.client.execute({
      sql: `SELECT booking_id FROM bookings WHERE status IN ('confirmed','live') AND slot_end_utc <= ?1
            ORDER BY slot_end_utc ASC, booking_id ASC LIMIT ?2`,
      args: [input.nowUtc, input.maxBookings],
    })
    const resume = await handle.client.execute({
      sql: `SELECT booking_id FROM bookings WHERE status IN (${RESUME_STATES})
            ORDER BY updated_at ASC, booking_id ASC LIMIT ?1`,
      args: [input.maxBookings],
    })
    dueIds = due.rows.map((r) => String(r.booking_id))
    const seen = new Set(dueIds)
    resumeIds = resume.rows.map((r) => String(r.booking_id)).filter((id) => !seen.has(id)) // dedupe across passes
  } finally {
    await handle.close() // close enumeration handle before settlement (which opens its own)
  }

  // Sequential per-booking settlement (low, explicit concurrency). Each booking is isolated.
  for (const bookingId of dueIds) {
    if (input.shouldStop()) { input.summary.deadlineReached = true; return }
    input.summary.checkedDue += 1
    await settleOne(input.summary, "initiate", input.communityId, bookingId, () => resolveDueBooking({
      env: input.env, communityRepository: input.communityRepository, communityId: input.communityId,
      bookingId, nowUtc: input.nowUtc, confirmPollMs: [...input.confirmPollMs],
    }))
  }
  for (const bookingId of resumeIds) {
    if (input.shouldStop()) { input.summary.deadlineReached = true; return }
    input.summary.checkedResume += 1
    await settleOne(input.summary, "resume", input.communityId, bookingId, () => reconcileBookingSettlement({
      env: input.env, communityRepository: input.communityRepository, communityId: input.communityId,
      bookingId, nowUtc: input.nowUtc, confirmPollMs: [...input.confirmPollMs],
    }))
  }
}

async function settleOne(
  summary: BookingSettlementSweepSummary,
  pass: "initiate" | "resume",
  communityId: string,
  bookingId: string,
  run: () => Promise<ResolveDueResult | ReconcileBookingSettlementResult>,
): Promise<void> {
  try {
    const result = await run()
    if (pass === "initiate") {
      const r = result as ResolveDueResult
      if (r.acted) { summary.initiated += 1; summary.settled += 1 } // settled within the single confirm attempt
      else if (r.outcome === "ambiguous") summary.ambiguous += 1
      else summary.skipped += 1
    } else {
      const r = result as ReconcileBookingSettlementResult
      if (r.outcome === "resumed") { summary.resumed += 1; summary.settled += 1 }
      else summary.skipped += 1
    }
  } catch (error) {
    const kind = bookingSettlementErrorKind(error)
    if (kind === "pending") {
      if (pass === "initiate") summary.initiated += 1
      else summary.resumed += 1
      summary.pending += 1 // broadcast but unconfirmed; a later tick's resume finalizes it
    } else if (kind === "terminal") {
      if (pass === "initiate") summary.initiated += 1
      else summary.resumed += 1
      summary.terminal += 1 // replaced / failed_onchain — terminal, never re-spent
      logSettlementFailure(`${pass}:terminal`, communityId, bookingId, error)
    } else {
      summary.errors += 1 // unexpected (incl. fail-closed inconsistent-intent rejections)
      logSettlementFailure(pass, communityId, bookingId, error)
    }
  }
}
