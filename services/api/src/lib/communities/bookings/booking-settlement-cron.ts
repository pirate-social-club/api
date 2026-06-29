import type { Env } from "../../../env"
import { openCommunityReadClient } from "../community-read-access"
import { selectScheduledCommunityJobPollIds } from "../jobs/runner"
import { bookingSettlementErrorKind } from "./booking-custody-adapter"
import { reconcileBookingSettlement, type ReconcileBookingSettlementResult } from "./booking-lifecycle-service"
import { resolveDueBooking, type ResolveDueResult } from "./booking-settlement-evaluator"

type CommunityRepository = Parameters<typeof openCommunityReadClient>[1] & {
  // Settlement-capable routes ONLY: ready D1 bindings that are not decommissioned. The cron
  // must enumerate from authoritative routing/backend state — never the generic active-community
  // list — so Turso, decommissioned, unsupported-backend, and not-yet-ready routes are skipped
  // before any open attempt (no spurious settlement errors for never-eligible routes).
  listSettlementEligibleCommunities: (input?: { limit?: number }) => Promise<Array<{ community_id: string; created_at?: string | null }>>
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
  fatal: boolean
}

export function emptyBookingSettlementSummary(enabled: boolean): BookingSettlementSweepSummary {
  return { enabled, communitiesScanned: 0, checkedDue: 0, checkedResume: 0, initiated: 0, resumed: 0, settled: 0, pending: 0, ambiguous: 0, terminal: 0, skipped: 0, errors: 0, deadlineReached: false, fatal: false }
}

// Approved stable codes for KNOWN booking settlement failures (these are deterministic guards, not
// coordinator/RPC payloads). Anything else is treated as unknown and never has its message logged.
const KNOWN_SETTLEMENT_ERROR_CODES = new Set<string>([
  "booking_refund_destination_missing",
  "booking_payout_destination_missing",
  "booking_settlement_intent_missing_refund_decision",
  "booking_settlement_intent_refund_out_of_range",
])

// Reduce an error to a SAFE, stable code. Never returns raw messages/objects — RPC/provider/
// coordinator errors can embed transaction payloads, URLs, or addresses. Unknown errors yield the
// error class name + a generated incident id (a correlation token, not the detail).
function sanitizeSettlementError(error: unknown): { code: string; incidentId: string | null } {
  const kind = bookingSettlementErrorKind(error)
  if (kind) return { code: `coordinator_${kind}`, incidentId: null } // pending / terminal
  const message = (error as { message?: unknown })?.message
  if (typeof message === "string") {
    if (KNOWN_SETTLEMENT_ERROR_CODES.has(message)) return { code: message, incidentId: null }
    if (message.startsWith("booking_settlement_unknown_intent_state")) return { code: "booking_settlement_unknown_intent_state", incidentId: null }
  }
  const name = (error as { constructor?: { name?: string } })?.constructor?.name ?? "Error"
  return { code: `unknown:${name}`, incidentId: crypto.randomUUID() }
}

// Log a failure with stable identifiers + a sanitized code ONLY — never raw messages/objects.
function logSettlementFailure(scope: string, communityId: string, bookingId: string | null, error: unknown): void {
  const { code, incidentId } = sanitizeSettlementError(error)
  console.error("[booking-settlements] failure", JSON.stringify({ scope, communityId, bookingId, code, incidentId }))
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
  const summary = emptyBookingSettlementSummary(enabled)
  if (!enabled) return summary // disabled: no enumeration, no side effects

  const maxCommunities = Math.max(1, Math.trunc(input.maxCommunities ?? 50))
  const maxBookings = Math.max(1, Math.trunc(input.maxBookingsPerCommunity ?? 25))
  const deadlineMs = Math.max(1, Math.trunc(input.deadlineMs ?? 20_000))
  const start = now()
  const shouldStop = (): boolean => now() - start >= deadlineMs
  const process = input.processCommunity ?? processCommunityBookingSettlements

  try {
    // Fair rotation across ticks using the existing scheduler utility (newest kept + remainder rotated).
    // Enumerate ONLY settlement-capable routes (ready, non-decommissioned D1) from authoritative
    // routing state — Turso / decommissioned / unsupported / not-yet-ready routes are excluded here,
    // so the sweep never attempts (and never error-logs) a community that could not settle anyway.
    const communities = await input.communityRepository.listSettlementEligibleCommunities()
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
  } catch (error) {
    // Fatal: enumeration (or another top-level step) failed. Still return a structured summary so the
    // caller always emits one; classify it fatal and count the error.
    summary.errors += 1
    summary.fatal = true
    logSettlementFailure("fatal", "-", null, error)
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
