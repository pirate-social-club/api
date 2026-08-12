// Shared song-streak time semantics. One module owns every clock decision for
// study streaks: activity dates, grace-window expiry, timezone validation, and
// the pinned-owner-timezone rule. Study writes, karaoke writes, and all streak
// reads must go through these helpers so the surfaces can never drift.

export const STUDY_FALLBACK_TIMEZONE = "UTC"

// A pinned timezone may be changed at most once per 7 days. Changes requested
// inside the window are ignored (the pinned zone wins), which blocks timezone
// hopping as a streak-extension vector while still allowing genuine moves.
export const STREAK_TIMEZONE_CHANGE_MIN_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000

export function isValidIanaTimezone(value: string | null | undefined): value is string {
  if (!value) return false
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value })
    return true
  } catch {
    return false
  }
}

export function studyActivityDate(nowIsoValue: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: timezone,
    year: "numeric",
  }).format(new Date(nowIsoValue))
}

export function addUtcDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00.000Z`)
  parsed.setUTCDate(parsed.getUTCDate() + days)
  return parsed.toISOString().slice(0, 10)
}

function timezoneOffsetMs(utcMs: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    timeZone: timezone,
    year: "numeric",
  }).formatToParts(new Date(utcMs))
  const values = new Map(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]))
  const localAsUtcMs = Date.UTC(
    Number(values.get("year")),
    Number(values.get("month")) - 1,
    Number(values.get("day")),
    Number(values.get("hour")),
    Number(values.get("minute")),
    Number(values.get("second")),
  )
  return localAsUtcMs - Math.floor(utcMs / 1000) * 1000
}

// UTC ms of local midnight at the start of `date` in `timezone`. Iterated
// because the offset at the target is itself offset-dependent across DST
// transitions; two passes converge for every real IANA zone.
function zonedMidnightUtcMs(date: string, timezone: string): number {
  const naiveUtcMs = Date.parse(`${date}T00:00:00.000Z`)
  let guess = naiveUtcMs
  for (let pass = 0; pass < 3; pass += 1) {
    const candidate = naiveUtcMs - timezoneOffsetMs(guess, timezone)
    if (candidate === guess) return candidate
    guess = candidate
  }
  return guess
}

// The UTC instant when a streak qualified on `lastQualifiedDate` stops being
// active without a new qualification: local midnight starting two days later
// in the owner's timezone (the qualified day plus the grace day both end then).
export function endOfGraceUtcInstant(lastQualifiedDate: string, timezone: string): string {
  return new Date(zonedMidnightUtcMs(addUtcDays(lastQualifiedDate, 2), timezone)).toISOString()
}

// Pin resolution for a (user, post) streak row, read inside the write
// transaction that records the qualification. First qualification pins the
// candidate; a differing candidate is adopted only after the 7-day window.
export function resolveStreakPin(input: {
  candidateTimezone?: string | null
  now: string
  pinnedTimezone?: string | null
  pinnedTimezoneUpdatedAt?: string | null
}): { adoptPin: boolean; timezone: string } {
  const candidate = isValidIanaTimezone(input.candidateTimezone) ? input.candidateTimezone : null
  const pinned = isValidIanaTimezone(input.pinnedTimezone) ? input.pinnedTimezone : null
  if (!pinned) {
    return { adoptPin: true, timezone: candidate ?? STUDY_FALLBACK_TIMEZONE }
  }
  if (candidate && candidate !== pinned) {
    const pinnedAtMs = Date.parse(input.pinnedTimezoneUpdatedAt ?? "")
    const nowMs = Date.parse(input.now)
    const windowElapsed = Number.isFinite(pinnedAtMs) && Number.isFinite(nowMs)
      ? nowMs - pinnedAtMs >= STREAK_TIMEZONE_CHANGE_MIN_INTERVAL_MS
      : false
    if (windowElapsed) {
      return { adoptPin: true, timezone: candidate }
    }
  }
  return { adoptPin: false, timezone: pinned }
}
