import { describe, expect, test } from "bun:test";

import type { Env } from "../../env";
import { resolveGlobalBookingByParty } from "./booking-settlement-evaluator";

// Minimal executor stub: resolveGlobalBookingByParty first loads the booking (one SELECT). The gate
// checks below all return BEFORE the attendance-settlement path runs, so a single-row stub is enough.
function executorReturning(row: Record<string, unknown> | null) {
  return {
    execute: async () => ({ rows: row ? [row] : [], rowsAffected: 0, lastInsertRowid: null, columnNames: [] }),
  } as never;
}

const HOST = "host_1";
const BOOKER = "booker_1";

function bookingRow(overrides: Record<string, unknown> = {}) {
  return {
    host_user_id: HOST,
    booker_user_id: BOOKER,
    slot_start_utc: "2026-07-02T10:00:00.000Z",
    slot_end_utc: "2026-07-02T11:00:00.000Z",
    status: "confirmed",
    ...overrides,
  };
}

const base = {
  env: {} as Env,
  bookingId: "bkg_1",
  nowUtc: "2026-07-02T12:00:00.000Z", // after slot_end
};

describe("resolveGlobalBookingByParty gates", () => {
  test("hides non-existent bookings", async () => {
    const result = await resolveGlobalBookingByParty({ ...base, executor: executorReturning(null), actorUserId: HOST });
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  test("hides the booking from users who are neither host nor booker", async () => {
    const result = await resolveGlobalBookingByParty({ ...base, executor: executorReturning(bookingRow()), actorUserId: "stranger" });
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  test("refuses to settle a booking that is not in a resolvable state", async () => {
    const result = await resolveGlobalBookingByParty({
      ...base,
      executor: executorReturning(bookingRow({ status: "settled" })),
      actorUserId: BOOKER,
    });
    expect(result).toEqual({ ok: false, reason: "not_settleable" });
  });

  test("refuses to settle before the slot window has closed (no premature, self-attested settlement)", async () => {
    const result = await resolveGlobalBookingByParty({
      ...base,
      nowUtc: "2026-07-02T10:30:00.000Z", // mid-session, before slot_end
      executor: executorReturning(bookingRow()),
      actorUserId: BOOKER,
    });
    expect(result).toEqual({ ok: false, reason: "session_not_ended" });
  });
});
