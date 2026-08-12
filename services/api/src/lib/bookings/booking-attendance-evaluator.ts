// Pure attendance-to-outcome decision for the global booking settlement evaluator.
// Samples are clipped to the booked slot and split when the heartbeat gap exceeds the stale limit.

export type AttendanceOutcome = "completed" | "no_show_host" | "no_show_booker" | "ambiguous"

export interface AttendanceConfig {
  staleMs: number
  minOverlapMs: number
  overlapSlotFraction: number
  minSoloAttendanceMs: number
}

const DEFAULT_ATTENDANCE_CONFIG: AttendanceConfig = {
  staleMs: 90_000,
  minOverlapMs: 10 * 60_000,
  overlapSlotFraction: 0.5,
  minSoloAttendanceMs: 60_000,
}

export interface AttendanceEvaluation {
  outcome: AttendanceOutcome
  hostAttended: boolean
  bookerAttended: boolean
  overlapMs: number
  requiredOverlapMs: number
}

type Interval = [number, number]

function presenceIntervals(samplesUtc: string[], staleMs: number, lo: number, hi: number): Interval[] {
  const timestamps = samplesUtc
    .map((sample) => Date.parse(sample))
    .filter((timestamp) => !Number.isNaN(timestamp))
    .sort((a, b) => a - b)
  if (timestamps.length === 0) return []

  const raw: Interval[] = []
  let start = timestamps[0]
  let previous = timestamps[0]
  for (let index = 1; index < timestamps.length; index++) {
    if (timestamps[index] - previous <= staleMs) {
      previous = timestamps[index]
    } else {
      raw.push([start, previous])
      start = timestamps[index]
      previous = timestamps[index]
    }
  }
  raw.push([start, previous])

  return raw
    .map(([intervalStart, intervalEnd]): Interval => [
      Math.max(intervalStart, lo),
      Math.min(intervalEnd, hi),
    ])
    .filter(([intervalStart, intervalEnd]) => intervalEnd > intervalStart)
}

function longestIntervalMs(intervals: Interval[]): number {
  let longest = 0
  for (const [start, end] of intervals) longest = Math.max(longest, end - start)
  return longest
}

function overlapDurationMs(first: Interval[], second: Interval[]): number {
  let total = 0
  for (const [firstStart, firstEnd] of first) {
    for (const [secondStart, secondEnd] of second) {
      const start = Math.max(firstStart, secondStart)
      const end = Math.min(firstEnd, secondEnd)
      if (end > start) total += end - start
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
  const slotStart = Date.parse(input.slotStartUtc)
  const slotEnd = Date.parse(input.slotEndUtc)
  const slotMs = Math.max(0, slotEnd - slotStart)
  const requiredOverlapMs = Math.min(
    config.minOverlapMs,
    Math.floor(slotMs * config.overlapSlotFraction),
  )

  const hostIntervals = presenceIntervals(input.hostSamplesUtc, config.staleMs, slotStart, slotEnd)
  const bookerIntervals = presenceIntervals(input.bookerSamplesUtc, config.staleMs, slotStart, slotEnd)
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
    outcome = "ambiguous"
  }

  return { outcome, hostAttended, bookerAttended, overlapMs, requiredOverlapMs }
}
