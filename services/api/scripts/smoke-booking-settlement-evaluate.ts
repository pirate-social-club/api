#!/usr/bin/env bun

import { SQL } from "bun";
import type { Env } from "../src/env";
import {
  evaluateAttendance,
  type AttendanceOutcome,
} from "../src/lib/communities/bookings/booking-attendance-evaluator";
import { resolveGlobalDueBooking } from "../src/lib/bookings/booking-settlement-evaluator";
import type { Client, InStatement, QueryResult } from "../src/lib/sql-client";

const OUTCOMES = new Set<AttendanceOutcome>(["completed", "no_show_host", "no_show_booker", "ambiguous"]);

export const BOOKING_SETTLEMENT_EVALUATE_SMOKE_USAGE = `Usage:
  bun run smoke:booking-settlement:evaluate -- --booking-id bkg_... [options]

Evaluates one global booking through the production attendance settlement evaluator.
Defaults to expect an ambiguous outcome and refuses money-moving outcomes unless
--allow-money-movement is set.

Options:
  --booking-id ID                 Required booking id.
  --database-url-env NAME         Defaults to CONTROL_PLANE_MIGRATOR_DATABASE_URL.
  --expect-outcome OUTCOME        completed | no_show_host | no_show_booker | ambiguous. Defaults to ambiguous.
  --now-utc ISO                   Evaluation time. Defaults to current time.
  --now-from-slot-end             Evaluate at slot_end_utc + 1s so canaries do not need to wait for wall-clock time.
  --allow-money-movement          Required if expected outcome is not ambiguous.
`;

function arg(name: string): string | null {
  const args = process.argv.slice(2);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? null : null;
}

function flag(name: string): boolean {
  return process.argv.includes(name);
}

function requiredArg(name: string): string {
  const value = arg(name)?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function parseExpectedOutcome(value: string | null): AttendanceOutcome {
  const outcome = (value ?? "ambiguous").trim() as AttendanceOutcome;
  if (!OUTCOMES.has(outcome)) {
    throw new Error("--expect-outcome must be completed, no_show_host, no_show_booker, or ambiguous");
  }
  return outcome;
}

function normalizeDatabaseUrl(raw: string): string {
  const url = new URL(raw);
  url.searchParams.delete("sslrootcert");
  return url.toString();
}

function toPg(sql: string): string {
  return sql.replace(/\?(\d+)/gu, (_match, index: string) => `$${index}`);
}

function makeClient(conn: SQL): Client {
  return {
    async execute(statement: InStatement | string): Promise<QueryResult> {
      const st = typeof statement === "string" ? { sql: statement, args: [] as unknown[] } : statement;
      const rows = await conn.unsafe(toPg(st.sql), st.args ?? []) as Record<string, unknown>[];
      return { rows };
    },
    async batch(statements) {
      const results: QueryResult[] = [];
      for (const statement of statements) results.push(await this.execute(statement));
      return results;
    },
    async transaction() {
      throw new Error("transaction_not_supported_by_smoke");
    },
  };
}

function text(value: unknown): string {
  if (value == null) throw new Error("expected non-null text");
  return value instanceof Date ? value.toISOString() : String(value);
}

async function loadBooking(client: Client, bookingId: string): Promise<{
  status: string;
  slotEndUtc: string;
  slotStartUtc: string;
}> {
  const result = await client.execute({
    sql: `SELECT status, slot_start_utc, slot_end_utc
          FROM bookings.bookings
          WHERE booking_id = ?1`,
    args: [bookingId],
  });
  const row = result.rows[0];
  if (!row) throw new Error(`booking_not_found:${bookingId}`);
  return {
    status: text(row.status),
    slotStartUtc: text(row.slot_start_utc),
    slotEndUtc: text(row.slot_end_utc),
  };
}

async function loadAttendanceSamples(client: Client, bookingId: string): Promise<{ host: string[]; booker: string[] }> {
  const sessions = await client.execute({
    sql: `SELECT party, attached_at, last_seen_at
          FROM bookings.attendance_sessions
          WHERE booking_id = ?1`,
    args: [bookingId],
  });
  const heartbeats = await client.execute({
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
    samples.push(text(row.attached_at), text(row.last_seen_at));
  }
  for (const row of heartbeats.rows) {
    (text(row.party) === "host" ? host : booker).push(text(row.seen_at));
  }
  return { host, booker };
}

async function loadReviewState(client: Client, bookingId: string): Promise<Record<string, unknown> | null> {
  const result = await client.execute({
    sql: `SELECT booking_id, status, settlement_review_status, settlement_review_reason,
                 settlement_review_resolution, settlement_review_version,
                 refund_tx_ref, payout_tx_ref
          FROM bookings.bookings
          WHERE booking_id = ?1`,
    args: [bookingId],
  });
  return result.rows[0] ?? null;
}

async function main(): Promise<void> {
  if (flag("--help") || flag("-h")) {
    console.log(BOOKING_SETTLEMENT_EVALUATE_SMOKE_USAGE);
    return;
  }

  const bookingId = requiredArg("--booking-id");
  const databaseUrlEnv = arg("--database-url-env") ?? "CONTROL_PLANE_MIGRATOR_DATABASE_URL";
  const databaseUrl = process.env[databaseUrlEnv]?.trim();
  if (!databaseUrl) throw new Error(`${databaseUrlEnv} is required`);

  const expectedOutcome = parseExpectedOutcome(arg("--expect-outcome"));
  if (expectedOutcome !== "ambiguous" && !flag("--allow-money-movement")) {
    throw new Error("--allow-money-movement is required when --expect-outcome is not ambiguous");
  }

  const conn = new SQL({ url: normalizeDatabaseUrl(databaseUrl), max: 1 });
  const client = makeClient(conn);
  try {
    const booking = await loadBooking(client, bookingId);
    const nowUtc = flag("--now-from-slot-end")
      ? new Date(Date.parse(booking.slotEndUtc) + 1000).toISOString()
      : arg("--now-utc") ?? new Date().toISOString();
    const samples = await loadAttendanceSamples(client, bookingId);
    const evaluation = evaluateAttendance({
      hostSamplesUtc: samples.host,
      bookerSamplesUtc: samples.booker,
      slotStartUtc: booking.slotStartUtc,
      slotEndUtc: booking.slotEndUtc,
    });
    if (evaluation.outcome !== expectedOutcome) {
      throw new Error(`expected ${expectedOutcome} attendance outcome, got ${evaluation.outcome}`);
    }

    const resolved = await resolveGlobalDueBooking({
      env: process.env as unknown as Env,
      executor: client,
      bookingId,
      nowUtc,
      confirmPollMs: [],
    });
    const review = await loadReviewState(client, bookingId);
    console.log(JSON.stringify({
      step: "booking_settlement_evaluated",
      booking_id: bookingId,
      expected_outcome: expectedOutcome,
      evaluation,
      now_utc: nowUtc,
      resolved,
      review,
    }, null, 2));
  } finally {
    await conn.end();
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
