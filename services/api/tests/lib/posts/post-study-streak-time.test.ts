import { describe, expect, test } from "bun:test"
import {
  addUtcDays,
  endOfGraceUtcInstant,
  isValidIanaTimezone,
  resolveStreakPin,
  studyActivityDate,
  STREAK_TIMEZONE_CHANGE_MIN_INTERVAL_MS,
} from "../../../src/lib/posts/post-study-streak-time"

describe("isValidIanaTimezone", () => {
  test("accepts real IANA zones", () => {
    expect(isValidIanaTimezone("UTC")).toBe(true)
    expect(isValidIanaTimezone("America/New_York")).toBe(true)
    expect(isValidIanaTimezone("Pacific/Kiritimati")).toBe(true)
    expect(isValidIanaTimezone("America/Argentina/Buenos_Aires")).toBe(true)
  })

  test("rejects garbage and empty values", () => {
    expect(isValidIanaTimezone("Not/AZone")).toBe(false)
    expect(isValidIanaTimezone("America/New York")).toBe(false)
    expect(isValidIanaTimezone("UTC+14")).toBe(false)
    expect(isValidIanaTimezone("")).toBe(false)
    expect(isValidIanaTimezone(null)).toBe(false)
    expect(isValidIanaTimezone(undefined)).toBe(false)
  })
})

describe("studyActivityDate", () => {
  test("keys the day in the requested timezone", () => {
    expect(studyActivityDate("2026-07-02T06:30:00.000Z", "UTC")).toBe("2026-07-02")
    // 23:30 on July 1 in Los Angeles (UTC-7 in July).
    expect(studyActivityDate("2026-07-02T06:30:00.000Z", "America/Los_Angeles")).toBe("2026-07-01")
    // 00:30 on July 2 in Kiritimati (UTC+14).
    expect(studyActivityDate("2026-07-01T10:30:00.000Z", "Pacific/Kiritimati")).toBe("2026-07-02")
  })
})

describe("addUtcDays", () => {
  test("shifts calendar dates across month boundaries", () => {
    expect(addUtcDays("2026-07-01", 2)).toBe("2026-07-03")
    expect(addUtcDays("2026-07-01", -1)).toBe("2026-06-30")
    expect(addUtcDays("2026-01-31", 1)).toBe("2026-02-01")
  })
})

describe("endOfGraceUtcInstant", () => {
  test("UTC zone: midnight starting lastQualifiedDate + 2 days", () => {
    expect(endOfGraceUtcInstant("2026-07-10", "UTC")).toBe("2026-07-12T00:00:00.000Z")
  })

  test("Pacific/Kiritimati (UTC+14): the UTC instant lands the day before", () => {
    // Local midnight starting 2026-07-12 at +14:00.
    expect(endOfGraceUtcInstant("2026-07-10", "Pacific/Kiritimati")).toBe("2026-07-11T10:00:00.000Z")
  })

  test("Pacific/Honolulu (UTC-10): the UTC instant lands later the same day", () => {
    // Local midnight starting 2026-07-12 at -10:00.
    expect(endOfGraceUtcInstant("2026-07-10", "Pacific/Honolulu")).toBe("2026-07-12T10:00:00.000Z")
  })

  test("America/New_York across the 2026-03-08 spring-forward", () => {
    // Target midnight 2026-03-08 is still EST (UTC-5); the 02:00 switch comes later.
    expect(endOfGraceUtcInstant("2026-03-06", "America/New_York")).toBe("2026-03-08T05:00:00.000Z")
    // Target midnights 2026-03-09 and 2026-03-10 are EDT (UTC-4).
    expect(endOfGraceUtcInstant("2026-03-07", "America/New_York")).toBe("2026-03-09T04:00:00.000Z")
    expect(endOfGraceUtcInstant("2026-03-08", "America/New_York")).toBe("2026-03-10T04:00:00.000Z")
  })

  test("America/New_York across the 2026-11-01 fall-back", () => {
    // Target midnight 2026-11-01 is still EDT (UTC-4); the 02:00 switch comes later.
    expect(endOfGraceUtcInstant("2026-10-30", "America/New_York")).toBe("2026-11-01T04:00:00.000Z")
    // Target midnights 2026-11-02 and 2026-11-03 are EST (UTC-5).
    expect(endOfGraceUtcInstant("2026-10-31", "America/New_York")).toBe("2026-11-02T05:00:00.000Z")
    expect(endOfGraceUtcInstant("2026-11-01", "America/New_York")).toBe("2026-11-03T05:00:00.000Z")
  })
})

describe("resolveStreakPin", () => {
  const pinnedAt = "2026-07-01T00:00:00.000Z"

  test("first pin adopts a valid candidate", () => {
    expect(resolveStreakPin({
      candidateTimezone: "America/New_York",
      now: pinnedAt,
      pinnedTimezone: null,
      pinnedTimezoneUpdatedAt: null,
    })).toEqual({ adoptPin: true, timezone: "America/New_York" })
  })

  test("first pin falls back to UTC when the candidate is invalid", () => {
    expect(resolveStreakPin({
      candidateTimezone: "Not/AZone",
      now: pinnedAt,
      pinnedTimezone: null,
      pinnedTimezoneUpdatedAt: null,
    })).toEqual({ adoptPin: true, timezone: "UTC" })
    expect(resolveStreakPin({
      candidateTimezone: null,
      now: pinnedAt,
      pinnedTimezone: undefined,
      pinnedTimezoneUpdatedAt: undefined,
    })).toEqual({ adoptPin: true, timezone: "UTC" })
  })

  test("matching candidate keeps the existing pin without re-adopting", () => {
    expect(resolveStreakPin({
      candidateTimezone: "America/New_York",
      now: "2026-07-02T00:00:00.000Z",
      pinnedTimezone: "America/New_York",
      pinnedTimezoneUpdatedAt: pinnedAt,
    })).toEqual({ adoptPin: false, timezone: "America/New_York" })
  })

  test("differing candidate inside the 7-day window is rejected", () => {
    expect(resolveStreakPin({
      candidateTimezone: "Pacific/Kiritimati",
      now: "2026-07-05T00:00:00.000Z",
      pinnedTimezone: "America/New_York",
      pinnedTimezoneUpdatedAt: pinnedAt,
    })).toEqual({ adoptPin: false, timezone: "America/New_York" })
  })

  test("differing candidate is adopted at and after the 7-day boundary", () => {
    const exactlySevenDays = new Date(Date.parse(pinnedAt) + STREAK_TIMEZONE_CHANGE_MIN_INTERVAL_MS).toISOString()
    expect(resolveStreakPin({
      candidateTimezone: "Pacific/Kiritimati",
      now: exactlySevenDays,
      pinnedTimezone: "America/New_York",
      pinnedTimezoneUpdatedAt: pinnedAt,
    })).toEqual({ adoptPin: true, timezone: "Pacific/Kiritimati" })
    expect(resolveStreakPin({
      candidateTimezone: "Pacific/Kiritimati",
      now: "2026-07-09T00:00:00.000Z",
      pinnedTimezone: "America/New_York",
      pinnedTimezoneUpdatedAt: pinnedAt,
    })).toEqual({ adoptPin: true, timezone: "Pacific/Kiritimati" })
  })

  test("invalid candidate never displaces a valid pin", () => {
    expect(resolveStreakPin({
      candidateTimezone: "Not/AZone",
      now: "2026-07-09T00:00:00.000Z",
      pinnedTimezone: "America/New_York",
      pinnedTimezoneUpdatedAt: pinnedAt,
    })).toEqual({ adoptPin: false, timezone: "America/New_York" })
  })

  test("garbage pinned value is treated as a first pin", () => {
    expect(resolveStreakPin({
      candidateTimezone: "America/Chicago",
      now: pinnedAt,
      pinnedTimezone: "Garbage/Zone",
      pinnedTimezoneUpdatedAt: pinnedAt,
    })).toEqual({ adoptPin: true, timezone: "America/Chicago" })
    expect(resolveStreakPin({
      candidateTimezone: "Also/Garbage",
      now: pinnedAt,
      pinnedTimezone: "Garbage/Zone",
      pinnedTimezoneUpdatedAt: pinnedAt,
    })).toEqual({ adoptPin: true, timezone: "UTC" })
  })

  test("missing pinned timestamp blocks adoption even after the window", () => {
    expect(resolveStreakPin({
      candidateTimezone: "Pacific/Kiritimati",
      now: "2027-01-01T00:00:00.000Z",
      pinnedTimezone: "America/New_York",
      pinnedTimezoneUpdatedAt: null,
    })).toEqual({ adoptPin: false, timezone: "America/New_York" })
  })
})
