import { describe, expect, test } from "bun:test"

import { evaluateAttendance } from "../../src/lib/communities/bookings/booking-attendance-evaluator"

const SLOT_START = "2026-06-23T10:00:00.000Z"
const SLOT_END = "2026-06-23T11:00:00.000Z" // 60-min slot → required overlap = min(10min, 30min) = 10min

// Heartbeat samples every 30s across [startUtc, endUtc] inclusive.
function samples(startUtc: string, endUtc: string, stepMs = 30_000): string[] {
  const lo = Date.parse(startUtc)
  const hi = Date.parse(endUtc)
  const out: string[] = []
  for (let t = lo; t <= hi; t += stepMs) out.push(new Date(t).toISOString())
  return out
}

describe("evaluateAttendance — outcome table", () => {
  test("both present with sustained overlap → completed", () => {
    const r = evaluateAttendance({
      hostSamplesUtc: samples("2026-06-23T10:00:00Z", "2026-06-23T10:15:00Z"),
      bookerSamplesUtc: samples("2026-06-23T10:00:00Z", "2026-06-23T10:15:00Z"),
      slotStartUtc: SLOT_START, slotEndUtc: SLOT_END,
    })
    expect(r.outcome).toBe("completed")
    expect(r.overlapMs).toBeGreaterThanOrEqual(r.requiredOverlapMs)
    expect(r.requiredOverlapMs).toBe(10 * 60_000)
  })

  test("host present, booker absent → no_show_booker", () => {
    const r = evaluateAttendance({
      hostSamplesUtc: samples("2026-06-23T10:00:00Z", "2026-06-23T10:20:00Z"),
      bookerSamplesUtc: [],
      slotStartUtc: SLOT_START, slotEndUtc: SLOT_END,
    })
    expect(r.outcome).toBe("no_show_booker")
    expect(r.hostAttended).toBe(true)
    expect(r.bookerAttended).toBe(false)
  })

  test("booker present, host absent → no_show_host", () => {
    const r = evaluateAttendance({
      hostSamplesUtc: [],
      bookerSamplesUtc: samples("2026-06-23T10:00:00Z", "2026-06-23T10:20:00Z"),
      slotStartUtc: SLOT_START, slotEndUtc: SLOT_END,
    })
    expect(r.outcome).toBe("no_show_host")
  })

  test("neither present → ambiguous (no auto money)", () => {
    const r = evaluateAttendance({ hostSamplesUtc: [], bookerSamplesUtc: [], slotStartUtc: SLOT_START, slotEndUtc: SLOT_END })
    expect(r.outcome).toBe("ambiguous")
  })

  test("both present but thin overlap → ambiguous", () => {
    // host only first 3 min, booker only last 3 min → ~no overlap, both attended
    const r = evaluateAttendance({
      hostSamplesUtc: samples("2026-06-23T10:00:00Z", "2026-06-23T10:03:00Z"),
      bookerSamplesUtc: samples("2026-06-23T10:50:00Z", "2026-06-23T10:53:00Z"),
      slotStartUtc: SLOT_START, slotEndUtc: SLOT_END,
    })
    expect(r.hostAttended).toBe(true)
    expect(r.bookerAttended).toBe(true)
    expect(r.outcome).toBe("ambiguous")
  })
})

describe("evaluateAttendance — rule 1: clip to slot window", () => {
  test("early attaches before the slot do not count toward completion", () => {
    // both 'attended' 15 min BEFORE the slot (allowed while confirmed) and nothing in-window
    const r = evaluateAttendance({
      hostSamplesUtc: samples("2026-06-23T09:00:00Z", "2026-06-23T09:15:00Z"),
      bookerSamplesUtc: samples("2026-06-23T09:00:00Z", "2026-06-23T09:15:00Z"),
      slotStartUtc: SLOT_START, slotEndUtc: SLOT_END,
    })
    expect(r.hostAttended).toBe(false)
    expect(r.bookerAttended).toBe(false)
    expect(r.overlapMs).toBe(0)
    expect(r.outcome).toBe("ambiguous")
  })
})

describe("evaluateAttendance — solo no-show requires sustained presence", () => {
  test("a single attach sample does not prove the counterparty no-showed", () => {
    const r = evaluateAttendance({
      hostSamplesUtc: ["2026-06-23T10:00:00.000Z"], // one attach, no heartbeats → no real presence
      bookerSamplesUtc: [],
      slotStartUtc: SLOT_START, slotEndUtc: SLOT_END,
    })
    expect(r.hostAttended).toBe(false)
    expect(r.outcome).toBe("ambiguous") // NOT no_show_booker → no host payout
  })

  test("a sample exactly at slot_end does not count (half-open window)", () => {
    const r = evaluateAttendance({
      hostSamplesUtc: ["2026-06-23T11:00:00.000Z"], // exactly slotEnd
      bookerSamplesUtc: [],
      slotStartUtc: SLOT_START, slotEndUtc: SLOT_END,
    })
    expect(r.hostAttended).toBe(false)
    expect(r.outcome).toBe("ambiguous")
  })

  test("sub-minute presence is not attendance", () => {
    const r = evaluateAttendance({
      hostSamplesUtc: ["2026-06-23T10:00:00.000Z", "2026-06-23T10:00:30.000Z"], // 30s < minSolo 60s
      bookerSamplesUtc: [],
      slotStartUtc: SLOT_START, slotEndUtc: SLOT_END,
    })
    expect(r.hostAttended).toBe(false)
    expect(r.outcome).toBe("ambiguous")
  })

  test("sustained presence (>= 1 min) with an absent counterparty IS a no-show", () => {
    const r = evaluateAttendance({
      hostSamplesUtc: ["2026-06-23T10:00:00.000Z", "2026-06-23T10:00:30.000Z", "2026-06-23T10:01:00.000Z", "2026-06-23T10:01:30.000Z"],
      bookerSamplesUtc: [],
      slotStartUtc: SLOT_START, slotEndUtc: SLOT_END,
    })
    expect(r.hostAttended).toBe(true)
    expect(r.outcome).toBe("no_show_booker")
  })
})

describe("evaluateAttendance — rule 2: stale-gap splits presence (no fake overlap)", () => {
  test("a long silent gap does not bridge into continuous overlap", () => {
    // Booker present the whole hour; host present only 0-3min then 57-60min with a 54-min silent gap.
    // Naive attached_at→last_seen would read host as present the whole hour (full overlap = completed).
    // Stale-split: host overlap = 3min + 3min = 6min < 10min → NOT completed.
    const r = evaluateAttendance({
      hostSamplesUtc: [...samples("2026-06-23T10:00:00Z", "2026-06-23T10:03:00Z"), ...samples("2026-06-23T10:57:00Z", "2026-06-23T11:00:00Z")],
      bookerSamplesUtc: samples("2026-06-23T10:00:00Z", "2026-06-23T11:00:00Z"),
      slotStartUtc: SLOT_START, slotEndUtc: SLOT_END,
    })
    expect(r.outcome).toBe("ambiguous")
    expect(r.overlapMs).toBeLessThan(r.requiredOverlapMs)
    expect(r.overlapMs).toBeLessThanOrEqual(7 * 60_000) // ~6 min, nowhere near the naive 60 min
  })
})
