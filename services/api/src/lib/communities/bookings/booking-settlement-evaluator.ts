import type { Env } from "../../../env"
import { openCommunityReadClient } from "../community-read-access"
import {
  type AttendanceConfig,
  type AttendanceOutcome,
  evaluateAttendance,
} from "./booking-attendance-evaluator"
import { completeBooking, noShowBooking, startBookingSession } from "./booking-lifecycle-service"

type CommunityRepository = Parameters<typeof openCommunityReadClient>[1]

// Bookings the evaluator can still act on (everything else is already resolved or pre-session).
const RESOLVABLE_STATES = new Set<string>(["confirmed", "live"])

interface DueBookingRow {
  host_user_id: string
  booker_user_id: string
  slot_start_utc: string
  slot_end_utc: string
  status: string
}

async function loadDueBooking(env: Env, repo: CommunityRepository, communityId: string, bookingId: string): Promise<DueBookingRow | null> {
  const handle = await openCommunityReadClient(env, repo, communityId)
  try {
    const r = await handle.client.execute({
      sql: `SELECT host_user_id, booker_user_id, slot_start_utc, slot_end_utc, status FROM bookings WHERE booking_id = ?1`,
      args: [bookingId],
    })
    const row = r.rows[0]
    if (!row) return null
    return {
      host_user_id: String(row.host_user_id),
      booker_user_id: String(row.booker_user_id),
      slot_start_utc: String(row.slot_start_utc),
      slot_end_utc: String(row.slot_end_utc),
      status: String(row.status),
    }
  } finally {
    await handle.close()
  }
}

// Per-party liveness samples = each session's attach + last_seen + every heartbeat sample.
async function loadAttendanceSamples(env: Env, repo: CommunityRepository, communityId: string, bookingId: string): Promise<{ host: string[]; booker: string[] }> {
  const handle = await openCommunityReadClient(env, repo, communityId)
  try {
    const sessions = await handle.client.execute({
      sql: `SELECT party, attached_at, last_seen_at FROM booking_attendance_sessions WHERE booking_id = ?1`,
      args: [bookingId],
    })
    const heartbeats = await handle.client.execute({
      sql: `SELECT s.party AS party, hb.seen_at AS seen_at
            FROM booking_attendance_heartbeats hb
            JOIN booking_attendance_sessions s ON s.session_id = hb.session_id
            WHERE hb.booking_id = ?1`,
      args: [bookingId],
    })
    const host: string[] = []
    const booker: string[] = []
    for (const row of sessions.rows) {
      const arr = String(row.party) === "host" ? host : booker
      arr.push(String(row.attached_at), String(row.last_seen_at))
    }
    for (const row of heartbeats.rows) {
      ;(String(row.party) === "host" ? host : booker).push(String(row.seen_at))
    }
    return { host, booker }
  } finally {
    await handle.close()
  }
}

export interface ResolveDueResult {
  outcome: AttendanceOutcome | "skipped"
  acted: boolean
}

/**
 * Settle one booking past its slot from objective attendance (Slice D4). Auto-starts the session
 * (confirmed → live) before resolving, since complete/no-show require `live`. Ambiguous results are
 * left untouched for dispute — no automatic money movement.
 */
export async function resolveDueBooking(input: {
  env: Env
  communityRepository: CommunityRepository
  communityId: string
  bookingId: string
  nowUtc: string
  config?: AttendanceConfig
  confirmPollMs?: number[]
}): Promise<ResolveDueResult> {
  const booking = await loadDueBooking(input.env, input.communityRepository, input.communityId, input.bookingId)
  if (!booking || !RESOLVABLE_STATES.has(booking.status)) return { outcome: "skipped", acted: false }

  const samples = await loadAttendanceSamples(input.env, input.communityRepository, input.communityId, input.bookingId)
  const evaluation = evaluateAttendance({
    hostSamplesUtc: samples.host,
    bookerSamplesUtc: samples.booker,
    slotStartUtc: booking.slot_start_utc,
    slotEndUtc: booking.slot_end_utc,
    config: input.config,
  })

  const base = {
    env: input.env,
    communityRepository: input.communityRepository,
    communityId: input.communityId,
    bookingId: input.bookingId,
    nowUtc: input.nowUtc,
    confirmPollMs: input.confirmPollMs,
  }

  // Drive the outcome through the existing lifecycle services, supplying the party whose action the
  // attendance objectively justifies. Auto-start first (no-op if already live).
  switch (evaluation.outcome) {
    case "completed":
      await startBookingSession({ ...base, actorUserId: booking.host_user_id })
      await completeBooking({ ...base, actorUserId: booking.host_user_id })
      return { outcome: "completed", acted: true }
    case "no_show_booker":
      await startBookingSession({ ...base, actorUserId: booking.host_user_id })
      await noShowBooking({ ...base, actorUserId: booking.host_user_id })
      return { outcome: "no_show_booker", acted: true }
    case "no_show_host":
      await startBookingSession({ ...base, actorUserId: booking.booker_user_id })
      await noShowBooking({ ...base, actorUserId: booking.booker_user_id })
      return { outcome: "no_show_host", acted: true }
    default:
      return { outcome: "ambiguous", acted: false }
  }
}
