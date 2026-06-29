import type { Env } from "../../../env"
import { openCommunityReadClient } from "../community-read-access"

type CommunityRepository = Parameters<typeof openCommunityReadClient>[1]

export type BookingViewerRole = "host" | "booker"
export type BookingSettlementReviewResolution = "completed" | "no_show_host" | "no_show_booker"

// Party-facing booking view. Deliberately OMITS destination wallet snapshots
// (funding_wallet_address / host_payout_wallet_address) and internal commerce refs
// (quote_id / purchase_id). On-chain tx hashes are public and are included.
export interface BookingView {
  object: "booking"
  booking_id: string
  community_id: string
  host_user_id: string
  booker_user_id: string
  slot_start_utc: string
  slot_end_utc: string
  gross_cents: number
  platform_fee_cents: number
  host_payout_cents: number
  refund_cents: number | null
  status: string
  funding_tx_ref: string | null
  payout_tx_ref: string | null
  refund_tx_ref: string | null
  live_room_id: string | null
  confirmed_at: string | null
  completed_at: string | null
  settled_at: string | null
  cancelled_at: string | null
  created_at: string
  updated_at: string
  viewer_role: BookingViewerRole
}

export interface BookingSettlementReviewView {
  object: "booking_settlement_review"
  booking_id: string
  community_id: string
  host_user_id: string
  booker_user_id: string
  slot_start_utc: string
  slot_end_utc: string
  gross_cents: number
  refund_cents: number | null
  booking_status: string
  review_status: "pending" | "resolved"
  review_reason: "attendance_ambiguous" | null
  review_resolution: BookingSettlementReviewResolution | null
  review_opened_at: string | null
  review_resolved_at: string | null
  review_operator_credential_id: string | null
  review_operator_actor_id: string | null
  review_note: string | null
  review_version: number
  updated_at: string
}

export interface BookingSettlementReviewPage {
  object: "list"
  data: BookingSettlementReviewView[]
  has_more: boolean
  next_cursor: string | null
}

export class InvalidBookingSettlementReviewCursorError extends Error {
  constructor() {
    super("Invalid booking settlement review cursor")
    this.name = "InvalidBookingSettlementReviewCursorError"
  }
}

const SELECT_COLUMNS = `booking_id, community_id, host_user_id, booker_user_id, slot_start_utc, slot_end_utc,
        gross_cents, platform_fee_cents, host_payout_cents, refund_cents, status,
        funding_tx_ref, payout_tx_ref, refund_tx_ref, live_room_id,
        confirmed_at, completed_at, settled_at, cancelled_at, created_at, updated_at`
const REVIEW_SELECT_COLUMNS = `booking_id, community_id, host_user_id, booker_user_id, slot_start_utc, slot_end_utc,
        gross_cents, refund_cents, status, settlement_review_status, settlement_review_reason,
        settlement_review_resolution, settlement_review_opened_at, settlement_review_resolved_at,
        settlement_review_operator_credential_id, settlement_review_operator_actor_id,
        settlement_review_note, settlement_review_version, updated_at`

function str(value: unknown): string { return String(value) }
function strOrNull(value: unknown): string | null { return value == null ? null : String(value) }
function num(value: unknown): number { return typeof value === "number" ? value : Number(value) }
function encodeCursor(row: BookingSettlementReviewView): string {
  return btoa(JSON.stringify({ updated_at: row.updated_at, booking_id: row.booking_id }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "")
}

function decodeCursor(cursor: string | null | undefined): { updatedAt: string; bookingId: string } | null {
  if (!cursor) return null
  try {
    const normalized = cursor.replace(/-/g, "+").replace(/_/g, "/")
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")
    const parsed = JSON.parse(atob(padded)) as unknown
    if (!parsed || typeof parsed !== "object") throw new InvalidBookingSettlementReviewCursorError()
    const row = parsed as { updated_at?: unknown; booking_id?: unknown }
    if (typeof row.updated_at !== "string" || typeof row.booking_id !== "string") {
      throw new InvalidBookingSettlementReviewCursorError()
    }
    return { updatedAt: row.updated_at, bookingId: row.booking_id }
  } catch (error) {
    if (error instanceof InvalidBookingSettlementReviewCursorError) throw error
    throw new InvalidBookingSettlementReviewCursorError()
  }
}

function toView(row: Record<string, unknown>, actorUserId: string): BookingView {
  const host = str(row.host_user_id)
  return {
    object: "booking",
    booking_id: str(row.booking_id),
    community_id: str(row.community_id),
    host_user_id: host,
    booker_user_id: str(row.booker_user_id),
    slot_start_utc: str(row.slot_start_utc),
    slot_end_utc: str(row.slot_end_utc),
    gross_cents: num(row.gross_cents),
    platform_fee_cents: num(row.platform_fee_cents),
    host_payout_cents: num(row.host_payout_cents),
    refund_cents: row.refund_cents == null ? null : num(row.refund_cents),
    status: str(row.status),
    funding_tx_ref: strOrNull(row.funding_tx_ref),
    payout_tx_ref: strOrNull(row.payout_tx_ref),
    refund_tx_ref: strOrNull(row.refund_tx_ref),
    live_room_id: strOrNull(row.live_room_id),
    confirmed_at: strOrNull(row.confirmed_at),
    completed_at: strOrNull(row.completed_at),
    settled_at: strOrNull(row.settled_at),
    cancelled_at: strOrNull(row.cancelled_at),
    created_at: str(row.created_at),
    updated_at: str(row.updated_at),
    viewer_role: actorUserId === host ? "host" : "booker",
  }
}

function toReviewView(row: Record<string, unknown>): BookingSettlementReviewView {
  return {
    object: "booking_settlement_review",
    booking_id: str(row.booking_id),
    community_id: str(row.community_id),
    host_user_id: str(row.host_user_id),
    booker_user_id: str(row.booker_user_id),
    slot_start_utc: str(row.slot_start_utc),
    slot_end_utc: str(row.slot_end_utc),
    gross_cents: num(row.gross_cents),
    refund_cents: row.refund_cents == null ? null : num(row.refund_cents),
    booking_status: str(row.status),
    review_status: str(row.settlement_review_status) as "pending" | "resolved",
    review_reason: strOrNull(row.settlement_review_reason) as "attendance_ambiguous" | null,
    review_resolution: strOrNull(row.settlement_review_resolution) as BookingSettlementReviewResolution | null,
    review_opened_at: strOrNull(row.settlement_review_opened_at),
    review_resolved_at: strOrNull(row.settlement_review_resolved_at),
    review_operator_credential_id: strOrNull(row.settlement_review_operator_credential_id),
    review_operator_actor_id: strOrNull(row.settlement_review_operator_actor_id),
    review_note: strOrNull(row.settlement_review_note),
    review_version: num(row.settlement_review_version ?? 0),
    updated_at: str(row.updated_at),
  }
}

// Retrieve a single booking ONLY if the actor is a party (host or booker); otherwise null (→ 404).
export async function getBookingForParty(input: {
  env: Env
  communityRepository: CommunityRepository
  communityId: string
  bookingId: string
  actorUserId: string
}): Promise<BookingView | null> {
  const handle = await openCommunityReadClient(input.env, input.communityRepository, input.communityId)
  try {
    const r = await handle.client.execute({
      sql: `SELECT ${SELECT_COLUMNS} FROM bookings WHERE booking_id = ?1`,
      args: [input.bookingId],
    })
    const row = r.rows[0]
    if (!row) return null
    const host = str(row.host_user_id)
    const booker = str(row.booker_user_id)
    if (host !== input.actorUserId && booker !== input.actorUserId) return null // not a party
    return toView(row as Record<string, unknown>, input.actorUserId)
  } finally {
    await handle.close()
  }
}

// List the actor's own bookings within a community, as host or booker, optionally status-filtered.
// Authorization is inherent: only rows where the actor is the requested party are returned.
export async function listBookingsForUser(input: {
  env: Env
  communityRepository: CommunityRepository
  communityId: string
  actorUserId: string
  role: BookingViewerRole
  statuses?: string[]
  limit?: number
}): Promise<BookingView[]> {
  const limit = Math.min(Math.max(1, Math.trunc(input.limit ?? 50)), 100)
  const column = input.role === "host" ? "host_user_id" : "booker_user_id"
  const statuses = (input.statuses ?? []).filter((s) => s.length > 0)
  // Placeholders: ?1 = actor, ?2 = limit, ?3.. = statuses.
  const statusClause = statuses.length ? ` AND status IN (${statuses.map((_s, i) => `?${i + 3}`).join(", ")})` : ""
  const handle = await openCommunityReadClient(input.env, input.communityRepository, input.communityId)
  try {
    const r = await handle.client.execute({
      sql: `SELECT ${SELECT_COLUMNS} FROM bookings WHERE ${column} = ?1${statusClause}
            ORDER BY slot_start_utc DESC, booking_id ASC LIMIT ?2`,
      args: [input.actorUserId, limit, ...statuses],
    })
    return r.rows.map((row) => toView(row as Record<string, unknown>, input.actorUserId))
  } finally {
    await handle.close()
  }
}

export async function getBookingSettlementReview(input: {
  env: Env
  communityRepository: CommunityRepository
  communityId: string
  bookingId: string
}): Promise<BookingSettlementReviewView | null> {
  const handle = await openCommunityReadClient(input.env, input.communityRepository, input.communityId)
  try {
    const r = await handle.client.execute({
      sql: `SELECT ${REVIEW_SELECT_COLUMNS}
            FROM bookings
            WHERE booking_id = ?1
              AND settlement_review_status IS NOT NULL`,
      args: [input.bookingId],
    })
    const row = r.rows[0]
    return row ? toReviewView(row as Record<string, unknown>) : null
  } finally {
    await handle.close()
  }
}

export async function listPendingBookingSettlementReviews(input: {
  env: Env
  communityRepository: CommunityRepository
  communityId: string
  limit?: number
  cursor?: string | null
}): Promise<BookingSettlementReviewPage> {
  const limit = Math.min(Math.max(1, Math.trunc(input.limit ?? 50)), 100)
  const cursor = decodeCursor(input.cursor)
  const cursorClause = cursor
    ? " AND (updated_at > ?2 OR (updated_at = ?2 AND booking_id > ?3))"
    : ""
  const args = cursor
    ? [input.communityId, cursor.updatedAt, cursor.bookingId, limit + 1]
    : [input.communityId, limit + 1]
  const limitPlaceholder = cursor ? "?4" : "?2"
  const handle = await openCommunityReadClient(input.env, input.communityRepository, input.communityId)
  try {
    const r = await handle.client.execute({
      sql: `SELECT ${REVIEW_SELECT_COLUMNS}
            FROM bookings
            WHERE community_id = ?1
              AND settlement_review_status = 'pending'
              ${cursorClause}
            ORDER BY updated_at ASC, booking_id ASC
            LIMIT ${limitPlaceholder}`,
      args,
    })
    const rows = r.rows.map((row) => toReviewView(row as Record<string, unknown>))
    const data = rows.slice(0, limit)
    return {
      object: "list",
      data,
      has_more: rows.length > limit,
      next_cursor: rows.length > limit && data.length > 0 ? encodeCursor(data[data.length - 1]!) : null,
    }
  } finally {
    await handle.close()
  }
}
