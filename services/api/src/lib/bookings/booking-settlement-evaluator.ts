import type { Env } from "../../env";
import {
  type AttendanceConfig,
  type AttendanceOutcome,
  evaluateAttendance,
} from "../communities/bookings/booking-attendance-evaluator";
import type { InStatement, QueryResult, QueryResultRow } from "../sql-client";
import { completeGlobalBooking, noShowGlobalBooking, startGlobalBookingSession } from "./booking-lifecycle-service";
import type { SettlementEffectSqlExecutor } from "./settlement-effect-repository";

export interface GlobalBookingSettlementSqlExecutor {
  execute(statement: InStatement | string): Promise<QueryResult>;
}

type GlobalSettlementExecutor = GlobalBookingSettlementSqlExecutor & SettlementEffectSqlExecutor;

const RESOLVABLE_STATES = new Set<string>(["confirmed", "live"]);

interface DueBookingRow {
  hostUserId: string;
  bookerUserId: string;
  slotStartUtc: string;
  slotEndUtc: string;
  status: string;
}

function text(value: unknown): string {
  if (value == null) throw new TypeError("expected non-null text");
  return String(value);
}

function timestampText(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return text(value);
}

async function loadDueBooking(exec: GlobalBookingSettlementSqlExecutor, bookingId: string): Promise<DueBookingRow | null> {
  const res = await exec.execute({
    sql: `SELECT host_user_id, booker_user_id, slot_start_utc, slot_end_utc, status
          FROM bookings.bookings
          WHERE booking_id = ?1`,
    args: [bookingId],
  });
  const row = res.rows[0];
  if (!row) return null;
  return {
    hostUserId: text(row.host_user_id),
    bookerUserId: text(row.booker_user_id),
    slotStartUtc: timestampText(row.slot_start_utc),
    slotEndUtc: timestampText(row.slot_end_utc),
    status: text(row.status),
  };
}

async function loadAttendanceSamples(exec: GlobalBookingSettlementSqlExecutor, bookingId: string): Promise<{ host: string[]; booker: string[] }> {
  const sessions = await exec.execute({
    sql: `SELECT party, attached_at, last_seen_at
          FROM bookings.attendance_sessions
          WHERE booking_id = ?1`,
    args: [bookingId],
  });
  const heartbeats = await exec.execute({
    sql: `SELECT s.party AS party, hb.seen_at AS seen_at
          FROM bookings.attendance_heartbeats hb
          JOIN bookings.attendance_sessions s ON s.session_id = hb.session_id
          WHERE hb.booking_id = ?1`,
    args: [bookingId],
  });
  const host: string[] = [];
  const booker: string[] = [];
  for (const row of sessions.rows) {
    const samples = text(row.party) === "host" ? host : booker;
    samples.push(timestampText(row.attached_at), timestampText(row.last_seen_at));
  }
  for (const row of heartbeats.rows) {
    (text(row.party) === "host" ? host : booker).push(timestampText(row.seen_at));
  }
  return { host, booker };
}

export interface ResolveGlobalDueBookingResult {
  outcome: AttendanceOutcome | "skipped";
  acted: boolean;
}

export async function resolveGlobalDueBooking(input: {
  env: Env;
  executor: GlobalSettlementExecutor;
  bookingId: string;
  nowUtc: string;
  config?: AttendanceConfig;
  confirmPollMs?: number[];
}): Promise<ResolveGlobalDueBookingResult> {
  const booking = await loadDueBooking(input.executor, input.bookingId);
  if (!booking || !RESOLVABLE_STATES.has(booking.status)) return { outcome: "skipped", acted: false };

  const samples = await loadAttendanceSamples(input.executor, input.bookingId);
  const evaluation = evaluateAttendance({
    hostSamplesUtc: samples.host,
    bookerSamplesUtc: samples.booker,
    slotStartUtc: booking.slotStartUtc,
    slotEndUtc: booking.slotEndUtc,
    config: input.config,
  });

  const base = {
    env: input.env,
    executor: input.executor,
    bookingId: input.bookingId,
    nowUtc: input.nowUtc,
    confirmPollMs: input.confirmPollMs,
    system: true,
  };

  switch (evaluation.outcome) {
    case "completed":
      await startGlobalBookingSession({ ...base, actorUserId: booking.hostUserId });
      await completeGlobalBooking({ ...base, actorUserId: booking.hostUserId });
      return { outcome: "completed", acted: true };
    case "no_show_booker":
      await startGlobalBookingSession({ ...base, actorUserId: booking.hostUserId });
      await noShowGlobalBooking({ ...base, actorUserId: booking.hostUserId });
      return { outcome: "no_show_booker", acted: true };
    case "no_show_host":
      await startGlobalBookingSession({ ...base, actorUserId: booking.bookerUserId });
      await noShowGlobalBooking({ ...base, actorUserId: booking.bookerUserId });
      return { outcome: "no_show_host", acted: true };
    default:
      return { outcome: "ambiguous", acted: false };
  }
}

export function bookingIdFromRow(row: QueryResultRow): string {
  return text(row.booking_id);
}
