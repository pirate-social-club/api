import type { Env } from "../../env";
import type { Client } from "../sql-client";
import {
  reconcileGlobalBookingSettlement,
  type ReconcileGlobalBookingSettlementResult,
} from "./booking-lifecycle-service";
import { bookingIdFromRow, resolveGlobalDueBooking, type ResolveGlobalDueBookingResult } from "./booking-settlement-evaluator";

export function isGlobalBookingSettlementCronEnabled(env: Env): boolean {
  return String(env.BOOKINGS_SETTLEMENT_CRON_ENABLED ?? "").trim().toLowerCase() === "true";
}

const CRON_CONFIRM_POLL_MS: ReadonlyArray<number> = [];
const RESUME_STATES = "'completed','no_show_booker','no_show_host','cancelled_by_host','cancelled_by_booker'";

export interface GlobalBookingSettlementSweepSummary {
  enabled: boolean;
  checkedDue: number;
  checkedResume: number;
  initiated: number;
  resumed: number;
  settled: number;
  pending: number;
  ambiguous: number;
  terminal: number;
  skipped: number;
  errors: number;
  deadlineReached: boolean;
  fatal: boolean;
}

export function emptyGlobalBookingSettlementSummary(enabled: boolean): GlobalBookingSettlementSweepSummary {
  return {
    enabled,
    checkedDue: 0,
    checkedResume: 0,
    initiated: 0,
    resumed: 0,
    settled: 0,
    pending: 0,
    ambiguous: 0,
    terminal: 0,
    skipped: 0,
    errors: 0,
    deadlineReached: false,
    fatal: false,
  };
}

const KNOWN_SETTLEMENT_ERROR_CODES = new Set<string>([
  "booking_refund_destination_missing",
  "booking_payout_destination_missing",
  "booking_settlement_intent_missing_refund_decision",
  "booking_settlement_intent_refund_out_of_range",
]);

const GLOBAL_BOOKING_SETTLEMENT_ERROR_KIND = Symbol.for("pirate.globalBookingSettlementErrorKind");

function globalSettlementErrorKind(error: unknown): "pending" | "terminal" | null {
  if (error && typeof error === "object" && GLOBAL_BOOKING_SETTLEMENT_ERROR_KIND in error) {
    return (error as { [GLOBAL_BOOKING_SETTLEMENT_ERROR_KIND]?: "pending" | "terminal" })[GLOBAL_BOOKING_SETTLEMENT_ERROR_KIND] ?? null;
  }
  return null;
}

function sanitizeSettlementError(error: unknown): { code: string; incidentId: string | null } {
  const kind = globalSettlementErrorKind(error);
  if (kind) return { code: `coordinator_${kind}`, incidentId: null };
  const message = (error as { message?: unknown })?.message;
  if (typeof message === "string" && KNOWN_SETTLEMENT_ERROR_CODES.has(message)) return { code: message, incidentId: null };
  const name = (error as { constructor?: { name?: string } })?.constructor?.name ?? "Error";
  return { code: `unknown:${name}`, incidentId: crypto.randomUUID() };
}

function logSettlementFailure(scope: string, bookingId: string | null, error: unknown): void {
  const { code, incidentId } = sanitizeSettlementError(error);
  console.error("[global-booking-settlements] failure", JSON.stringify({ scope, bookingId, code, incidentId }));
}

export interface SweepGlobalBookingSettlementsInput {
  env: Env;
  client: Client;
  maxBookings?: number;
  deadlineMs?: number;
  now?: () => number;
  process?: ProcessGlobalBookingSettlementsFn;
}

export interface ProcessGlobalBookingSettlementsInput {
  env: Env;
  client: Client;
  nowUtc: string;
  maxBookings: number;
  confirmPollMs: ReadonlyArray<number>;
  summary: GlobalBookingSettlementSweepSummary;
  shouldStop: () => boolean;
}

export type ProcessGlobalBookingSettlementsFn = (input: ProcessGlobalBookingSettlementsInput) => Promise<void>;

export async function sweepGlobalBookingSettlements(input: SweepGlobalBookingSettlementsInput): Promise<GlobalBookingSettlementSweepSummary> {
  const now = input.now ?? (() => Date.now());
  const enabled = isGlobalBookingSettlementCronEnabled(input.env);
  const summary = emptyGlobalBookingSettlementSummary(enabled);
  if (!enabled) return summary;

  const maxBookings = Math.max(1, Math.trunc(input.maxBookings ?? 100));
  const deadlineMs = Math.max(1, Math.trunc(input.deadlineMs ?? 20_000));
  const start = now();
  const shouldStop = (): boolean => now() - start >= deadlineMs;
  const process = input.process ?? processGlobalBookingSettlements;

  try {
    await process({
      env: input.env,
      client: input.client,
      nowUtc: new Date(now()).toISOString(),
      maxBookings,
      confirmPollMs: CRON_CONFIRM_POLL_MS,
      summary,
      shouldStop,
    });
  } catch (error) {
    summary.errors += 1;
    summary.fatal = true;
    logSettlementFailure("fatal", null, error);
  }
  return summary;
}

export async function processGlobalBookingSettlements(input: ProcessGlobalBookingSettlementsInput): Promise<void> {
  const due = await input.client.execute({
    sql: `SELECT booking_id
          FROM bookings.bookings
          WHERE status IN ('confirmed','live') AND slot_end_utc <= ?1::timestamptz
          ORDER BY slot_end_utc ASC, booking_id ASC
          LIMIT ?2`,
    args: [input.nowUtc, input.maxBookings],
  });
  const resume = await input.client.execute({
    sql: `SELECT booking_id
          FROM bookings.bookings
          WHERE status IN (${RESUME_STATES})
          ORDER BY updated_at ASC, booking_id ASC
          LIMIT ?1`,
    args: [input.maxBookings],
  });

  const dueIds = due.rows.map(bookingIdFromRow);
  const seen = new Set(dueIds);
  const resumeIds = resume.rows.map(bookingIdFromRow).filter((bookingId) => !seen.has(bookingId));

  for (const bookingId of dueIds) {
    if (input.shouldStop()) {
      input.summary.deadlineReached = true;
      return;
    }
    input.summary.checkedDue += 1;
    await settleOne(input.summary, "initiate", bookingId, () => resolveGlobalDueBooking({
      env: input.env,
      executor: input.client,
      bookingId,
      nowUtc: input.nowUtc,
      confirmPollMs: [...input.confirmPollMs],
    }));
  }

  for (const bookingId of resumeIds) {
    if (input.shouldStop()) {
      input.summary.deadlineReached = true;
      return;
    }
    input.summary.checkedResume += 1;
    await settleOne(input.summary, "resume", bookingId, () => reconcileGlobalBookingSettlement({
      env: input.env,
      executor: input.client,
      bookingId,
      nowUtc: input.nowUtc,
      confirmPollMs: [...input.confirmPollMs],
    }));
  }
}

async function settleOne(
  summary: GlobalBookingSettlementSweepSummary,
  pass: "initiate" | "resume",
  bookingId: string,
  run: () => Promise<ResolveGlobalDueBookingResult | ReconcileGlobalBookingSettlementResult>,
): Promise<void> {
  try {
    const result = await run();
    if (pass === "initiate") {
      const due = result as ResolveGlobalDueBookingResult;
      if (due.acted) {
        summary.initiated += 1;
        summary.settled += 1;
      } else if (due.outcome === "ambiguous") {
        summary.ambiguous += 1;
      } else {
        summary.skipped += 1;
      }
    } else {
      const resume = result as ReconcileGlobalBookingSettlementResult;
      if (resume.outcome === "resumed") {
        summary.resumed += 1;
        summary.settled += 1;
      } else {
        summary.skipped += 1;
      }
    }
  } catch (error) {
    const kind = globalSettlementErrorKind(error);
    if (kind === "pending") {
      if (pass === "initiate") summary.initiated += 1;
      else summary.resumed += 1;
      summary.pending += 1;
    } else if (kind === "terminal") {
      if (pass === "initiate") summary.initiated += 1;
      else summary.resumed += 1;
      summary.terminal += 1;
      logSettlementFailure(`${pass}:terminal`, bookingId, error);
    } else {
      summary.errors += 1;
      logSettlementFailure(pass, bookingId, error);
    }
  }
}
