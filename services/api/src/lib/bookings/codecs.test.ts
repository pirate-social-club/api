import { describe, expect, test } from "bun:test";
import {
  atomicFromRow, atomicToArg, boolFromRow, intFromRow, intFromRowNullable, isoUtcFromRow,
  isoUtcFromRowNullable, isoUtcToArg, textFromRowNullable, timeFromRow, timeToArg,
  weekdayArrayFromRow, weekdayArrayToArg,
} from "./codecs";

describe("bookings codecs", () => {
  test("NUMERIC(78,0) round-trips a uint256-scale string without JS-number precision loss", () => {
    const huge = "115792089237316195423570985008687907853269984665640564039457584007913129639935";
    expect(atomicFromRow(huge)).toBe(huge);
    expect(atomicToArg(huge)).toBe(huge);
    expect(atomicFromRow(10n)).toBe("10");
    expect(atomicFromRow("1000000")).toBe("1000000");
  });
  test("NUMERIC rejects a JS number (precision already at risk) and non-digit strings", () => {
    expect(() => atomicFromRow(1_000_000)).toThrow();
    expect(() => atomicFromRow("12.5")).toThrow();
    expect(() => atomicToArg("-5")).toThrow();
    expect(() => atomicToArg("0x10")).toThrow();
  });

  test("TIMESTAMPTZ from a Date or string -> canonical ISO UTC (…Z), locale-independent", () => {
    expect(isoUtcFromRow(new Date("2026-07-01T09:00:00Z"))).toBe("2026-07-01T09:00:00.000Z");
    expect(isoUtcFromRow("2026-07-01 09:00:00+00")).toBe("2026-07-01T09:00:00.000Z");
    expect(isoUtcFromRow("2026-07-01T09:00:00Z")).toBe("2026-07-01T09:00:00.000Z");
    // a +02:00 wall time is the same absolute instant as 07:00Z
    expect(isoUtcFromRow("2026-07-01T09:00:00+02:00")).toBe("2026-07-01T07:00:00.000Z");
    expect(isoUtcFromRowNullable(null)).toBeNull();
  });
  test("isoUtcToArg requires canonical UTC", () => {
    expect(isoUtcToArg("2026-07-01T09:00:00.000Z")).toBe("2026-07-01T09:00:00.000Z");
    expect(isoUtcToArg("2026-07-01T09:00:00Z")).toBe("2026-07-01T09:00:00Z");
    expect(() => isoUtcToArg("2026-07-01 09:00:00+00")).toThrow();
    expect(() => isoUtcToArg("2026-07-01T09:00:00+02:00")).toThrow();
  });

  test("TIME passes through unchanged; arg validates HH:MM[:SS]", () => {
    expect(timeFromRow("09:00:00")).toBe("09:00:00");
    expect(timeToArg("09:00")).toBe("09:00");
    expect(timeToArg("18:30:00")).toBe("18:30:00");
    expect(() => timeToArg("9am")).toThrow();
  });

  test("SMALLINT[] parses JS arrays and '{…}' literals; arg emits a literal; rejects out-of-range", () => {
    expect(weekdayArrayFromRow([1, 5])).toEqual([1, 5]);
    expect(weekdayArrayFromRow("{1,5}")).toEqual([1, 5]);
    expect(weekdayArrayFromRow("{}")).toEqual([]);
    expect(weekdayArrayToArg([1, 5])).toBe("{1,5}");
    expect(() => weekdayArrayFromRow("{7}")).toThrow();
    expect(() => weekdayArrayToArg([7])).toThrow();
  });

  test("int/bool/text helpers", () => {
    expect(intFromRow(1000)).toBe(1000);
    expect(intFromRow("1000")).toBe(1000);
    expect(intFromRowNullable(null)).toBeNull();
    expect(() => intFromRow("x")).toThrow();
    expect(boolFromRow(true)).toBe(true);
    expect(boolFromRow("t")).toBe(true);
    expect(boolFromRow(false)).toBe(false);
    expect(textFromRowNullable(null)).toBeNull();
    expect(textFromRowNullable("x")).toBe("x");
  });
});
