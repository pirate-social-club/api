import type { Env } from "../../../env"
import { buildAgoraBlock } from "../live-rooms/runtime"
import { openCommunityReadClient, openCommunityWriteClient } from "../community-read-access"

type CommunityRepository = Parameters<typeof openCommunityReadClient>[1]
type AgoraBlock = ReturnType<typeof buildAgoraBlock>

// The booking 1:1 session is a private Agora channel derived purely from the booking id — no
// live_rooms row, none of the event-shaped (setlist/performer/viewer) machinery.
export function deriveBookingChannel(bookingId: string): string {
  return `pirate-booking-${bookingId}`
}

function randomAgoraUid(): number {
  const v = new Uint32Array(1)
  crypto.getRandomValues(v)
  return v[0]
}

// Only a confirmed or live booking has a joinable session (terminal states are over).
const ATTACHABLE_STATES = new Set<string>(["confirmed", "live"])

type Party = "host" | "booker"
interface BookingPartiesRow {
  host_user_id: string
  booker_user_id: string
  status: string
  live_room_id: string | null
}

async function loadBookingParties(env: Env, repo: CommunityRepository, communityId: string, bookingId: string): Promise<BookingPartiesRow | null> {
  const handle = await openCommunityReadClient(env, repo, communityId)
  try {
    const r = await handle.client.execute({
      sql: `SELECT host_user_id, booker_user_id, status, live_room_id FROM bookings WHERE booking_id = ?1`,
      args: [bookingId],
    })
    const row = r.rows[0]
    if (!row) return null
    return {
      host_user_id: String(row.host_user_id),
      booker_user_id: String(row.booker_user_id),
      status: String(row.status),
      live_room_id: row.live_room_id ? String(row.live_room_id) : null,
    }
  } finally {
    await handle.close()
  }
}

async function writeCommunity(env: Env, repo: CommunityRepository, communityId: string, statement: { sql: string; args: unknown[] }): Promise<void> {
  const write = await openCommunityWriteClient(env, repo, communityId)
  try {
    await write.client.execute(statement as Parameters<typeof write.client.execute>[0])
  } finally {
    await write.close()
  }
}

export interface LifecycleInputBase {
  env: Env
  communityRepository: CommunityRepository
  communityId: string
  bookingId: string
  actorUserId: string
  nowUtc: string
}

export type AttachSessionResult =
  | { ok: false; reason: "not_found" | "not_attachable" }
  | { ok: true; party: Party; sessionId: string; channel: string; agora: AgoraBlock }

/**
 * Attach the authenticated host/booker to the booking's private session: mint an Agora token and
 * open an attendance session row (each attach is a fresh interval; the evaluator derives overlap).
 */
export async function attachBookingSession(input: LifecycleInputBase): Promise<AttachSessionResult> {
  const booking = await loadBookingParties(input.env, input.communityRepository, input.communityId, input.bookingId)
  if (!booking) return { ok: false, reason: "not_found" }

  let party: Party
  if (booking.host_user_id === input.actorUserId) party = "host"
  else if (booking.booker_user_id === input.actorUserId) party = "booker"
  else return { ok: false, reason: "not_found" }

  if (!ATTACHABLE_STATES.has(booking.status)) return { ok: false, reason: "not_attachable" }

  const channel = deriveBookingChannel(input.bookingId)
  const uid = randomAgoraUid()
  const agora = buildAgoraBlock({ env: input.env, channel, uid })
  const sessionId = `bas_${crypto.randomUUID()}`

  await writeCommunity(input.env, input.communityRepository, input.communityId, {
    sql: `INSERT INTO booking_attendance_sessions (
            session_id, community_id, booking_id, party, user_id, agora_uid,
            attached_at, last_seen_at, ended_at, created_at, updated_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, NULL, ?7, ?7)`,
    args: [sessionId, input.communityId, input.bookingId, party, input.actorUserId, uid, input.nowUtc],
  })

  // Record the derived channel on the booking on first attach (reference only; channel is always
  // re-derivable from the booking id).
  if (!booking.live_room_id) {
    await writeCommunity(input.env, input.communityRepository, input.communityId, {
      sql: `UPDATE bookings SET live_room_id = ?2, updated_at = ?3 WHERE booking_id = ?1 AND live_room_id IS NULL`,
      args: [input.bookingId, channel, input.nowUtc],
    })
  }

  return { ok: true, party, sessionId, channel, agora }
}

export type HeartbeatResult = { ok: false; reason: "not_found" } | { ok: true }

/**
 * Liveness heartbeat for an attendance session. Identity-bound: only the session's own user can
 * extend it. Updates last_seen_at and records a sample for gap-aware overlap.
 */
export async function heartbeatBookingSession(input: LifecycleInputBase & { sessionId: string }): Promise<HeartbeatResult> {
  const handle = await openCommunityReadClient(input.env, input.communityRepository, input.communityId)
  let owns = false
  try {
    const r = await handle.client.execute({
      sql: `SELECT user_id, booking_id FROM booking_attendance_sessions WHERE session_id = ?1`,
      args: [input.sessionId],
    })
    const row = r.rows[0]
    owns = Boolean(row) && String(row!.user_id) === input.actorUserId && String(row!.booking_id) === input.bookingId
  } finally {
    await handle.close()
  }
  if (!owns) return { ok: false, reason: "not_found" }

  await writeCommunity(input.env, input.communityRepository, input.communityId, {
    sql: `UPDATE booking_attendance_sessions SET last_seen_at = ?2, updated_at = ?2 WHERE session_id = ?1`,
    args: [input.sessionId, input.nowUtc],
  })
  await writeCommunity(input.env, input.communityRepository, input.communityId, {
    sql: `INSERT INTO booking_attendance_heartbeats (heartbeat_id, session_id, booking_id, seen_at)
          VALUES (?1, ?2, ?3, ?4)`,
    args: [`bah_${crypto.randomUUID()}`, input.sessionId, input.bookingId, input.nowUtc],
  })

  return { ok: true }
}
