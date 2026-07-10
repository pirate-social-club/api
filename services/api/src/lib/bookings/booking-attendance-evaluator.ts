// Pure attendance → outcome decision for the global post-slot settlement evaluator.
// No I/O: given each party's liveness sample timestamps (attach + heartbeats + last_seen) and the
// booked slot window, decide the settlement outcome. Two rules baked in:
//   1. Attendance is CLIPPED to [slotStart, slotEnd] — early attaches (allowed while confirmed)
//      never count toward completion.
//   2. Presence is built from sample intervals with a STALE threshold — a gap larger than `staleMs`
//      splits presence, so reconnects/silent gaps cannot fabricate continuous overlap.

export type AttendanceOutcome = "completed" | "no_show_host" | "no_show_booker" | "ambiguous"

export interface AttendanceConfig {
  staleMs: number // a gap longer than this ends a presence interval
  minOverlapMs: number // absolute floor for "completed" overlap
  overlapSlotFraction: number // fraction-of-slot floor for "completed" overlap
  minSoloAttendanceMs: number // sustained in-window presence required to count as "attended"
}

const DEFAULT_ATTENDANCE_CONFIG: AttendanceConfig = {
  staleMs: 90_000, // heartbeats every 30s; 3 missed = stale
  minOverlapMs: 10 * 60_000, // 10 minutes
  overlapSlotFraction: 0.5, // or 50% of the slot, whichever is smaller
  minSoloAttendanceMs: 60_000, // a single attach is not attendance — require ~1 min of real presence
}

export interface AttendanceEvaluation {
  outcome: AttendanceOutcome
  hostAttended: boolean
  bookerAttended: boolean
  overlapMs: number
  requiredOverlapMs: number
}

type Interval = [number, number]

// Build presence intervals from sorted sample timestamps, then clip to [lo, hi]. Consecutive
// samples within staleMs are one continuous interval; a larger gap starts a new one.
function presenceIntervals(samplesUtc: string[], staleMs: number, lo: number, hi: number): Interval[] {
  const ts = samplesUtc
    .map((s) => Date.parse(s))
    .filter((t) => !Number.isNaN(t))
    .sort((a, b) => a - b)
  if (ts.length === 0) return []
  const raw: Interval[] = []
  let start = ts[0]
  let prev = ts[0]
  for (let i = 1; i < ts.length; i++) {
    if (ts[i] - prev <= staleMs) {
      prev = ts[i]
    } else {
      raw.push([start, prev])
      start = ts[i]
      prev = ts[i]
    }
  }
  raw.push([start, prev])
  return raw
    .map(([a, b]): Interval => [Math.max(a, lo), Math.min(b, hi)])
    .filter(([a, b]) => b > a)
}

function longestIntervalMs(intervals: Interval[]): number {
  let max = 0
  for (const [a, b] of intervals) max = Math.max(max, b - a)
  return max
}

function overlapDurationMs(a: Interval[], b: Interval[]): number {
  let total = 0
  for (const [as, ae] of a) {
    for (const [bs, be] of b) {
      const lo = Math.max(as, bs)
      const hi = Math.min(ae, be)
      if (hi > lo) total += hi - lo
    }
  }
  return total
}

export function evaluateAttendance(input: {
  hostSamplesUtc: string[]
  bookerSamplesUtc: string[]
  slotStartUtc: string
  slotEndUtc: string
  config?: AttendanceConfig
}): AttendanceEvaluation {
  const config = input.config ?? DEFAULT_ATTENDANCE_CONFIG
  const lo = Date.parse(input.slotStartUtc)
  const hi = Date.parse(input.slotEndUtc)
  const slotMs = Math.max(0, hi - lo)
  const requiredOverlapMs = Math.min(config.minOverlapMs, Math.floor(slotMs * config.overlapSlotFraction))

  // "Attended" requires SUSTAINED in-window presence, not a single sample — a lone attach (or a
  // sample exactly at slotEnd) must not be enough to charge an absent counterparty. Presence is
  // already clipped to the slot window, so early attaches and the slotEnd instant carry no duration.
  const hostIntervals = presenceIntervals(input.hostSamplesUtc, config.staleMs, lo, hi)
  const bookerIntervals = presenceIntervals(input.bookerSamplesUtc, config.staleMs, lo, hi)
  const hostAttended = longestIntervalMs(hostIntervals) >= config.minSoloAttendanceMs
  const bookerAttended = longestIntervalMs(bookerIntervals) >= config.minSoloAttendanceMs
  const overlapMs = overlapDurationMs(hostIntervals, bookerIntervals)

  let outcome: AttendanceOutcome
  if (overlapMs >= requiredOverlapMs && requiredOverlapMs > 0) {
    outcome = "completed"
  } else if (hostAttended && !bookerAttended) {
    outcome = "no_show_booker"
  } else if (bookerAttended && !hostAttended) {
    outcome = "no_show_host"
  } else {
    // both present but insufficient shared time, or neither present → human review, no auto money.
    outcome = "ambiguous"
  }

  return { outcome, hostAttended, bookerAttended, overlapMs, requiredOverlapMs }
}
