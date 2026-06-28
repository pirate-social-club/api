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

describe("bookings codecs — silent-coercion regressions", () => {
  test("intFromRow rejects null, empty, boolean, non-canonical, and unsafe integers", () => {
    expect(() => intFromRow(null)).toThrow();
    expect(() => intFromRow("")).toThrow();
    expect(() => intFromRow(true)).toThrow();
    expect(() => intFromRow("1.5")).toThrow();
    expect(() => intFromRow(2 ** 53)).toThrow();
    expect(intFromRow(0)).toBe(0);
    expect(intFromRow(-5)).toBe(-5);
  });

  test("boolFromRow throws on non-boolean values", () => {
    expect(() => boolFromRow("garbage")).toThrow();
    expect(() => boolFromRow(null)).toThrow();
    expect(() => boolFromRow(2)).toThrow();
  });

  test("atomic amounts reject zero, negative, and uint256 overflow; canonicalize", () => {
    expect(() => atomicFromRow(-1n)).toThrow();
    expect(() => atomicFromRow(0n)).toThrow();
    expect(() => atomicToArg("0")).toThrow();
    expect(() => atomicToArg("-1")).toThrow();
    const overMax = (115792089237316195423570985008687907853269984665640564039457584007913129639935n + 1n).toString();
    expect(() => atomicToArg(overMax)).toThrow();
    expect(atomicFromRow("007")).toBe("7");
  });

  test("time codecs reject out-of-range components", () => {
    expect(() => timeToArg("99:99:99")).toThrow();
    expect(() => timeToArg("24:00")).toThrow();
    expect(() => timeToArg("12:60")).toThrow();
    expect(() => timeFromRow("10:00:60")).toThrow();
    expect(timeToArg("23:59:59")).toBe("23:59:59");
  });

  test("isoUtcFromRow rejects timezone-less and semantically invalid dates", () => {
    expect(() => isoUtcFromRow("2026-07-01 09:00:00")).toThrow();
    expect(() => isoUtcFromRow("2026-07-01T09:00:00")).toThrow();
    expect(() => isoUtcFromRow("2026-13-01T00:00:00Z")).toThrow();
    expect(() => isoUtcFromRow("2026-02-30T00:00:00Z")).toThrow();
  });

  test("weekdayArrayFromRow rejects null/empty/whitespace elements (no coercion to weekday 0)", () => {
    expect(() => weekdayArrayFromRow([null])).toThrow();
    expect(() => weekdayArrayFromRow([""])).toThrow();
    expect(() => weekdayArrayFromRow([" "])).toThrow();
    expect(() => weekdayArrayFromRow([false])).toThrow();
    expect(weekdayArrayFromRow([0])).toEqual([0]);
  });

  test("timestamp codec is locale-independent under a non-UTC TZ (subprocess)", async () => {
    const probe = `${import.meta.dir}/codecs.tz-probe.ts`;
    const proc = Bun.spawn(["bun", "run", probe], { env: { ...process.env, TZ: "America/New_York" }, stdout: "pipe", stderr: "pipe" });
    const err = await new Response(proc.stderr).text();
    await proc.exited;
    expect(proc.exitCode, err).toBe(0);
  });
});
