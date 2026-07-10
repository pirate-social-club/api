import type { InStatement, QueryResult } from "../sql-client";
import { BOOKING_COLUMNS, decodeBooking } from "./booking-row";
import type { Booking } from "./types";
import type { ProfileRepository } from "../auth/repositories";

export type BookingViewerRole = "host" | "booker";
export type BookingSettlementReviewResolution = "completed" | "no_show_host" | "no_show_booker";
export type BookingSettlementStatus = "pending" | "live" | "settling" | "settled" | "refunded" | "disputed";

export interface BookingReadSqlExecutor {
  execute(statement: InStatement | string): Promise<QueryResult>;
}

export interface BookingView {
  object: "booking";
  booking_id: string;
  community_id: string;
  host_user_id: string;
  booker_user_id: string;
  slot_start_utc: string;
  slot_end_utc: string;
  gross_cents: number;
  platform_fee_cents: number;
  host_payout_cents: number;
  refund_cents: number | null;
  status: string;
  outcome: Booking["outcome"];
  settlement_status: BookingSettlementStatus;
  funding_tx_ref: string | null;
  payout_tx_ref: string | null;
  refund_tx_ref: string | null;
  live_room_id: string | null;
  confirmed_at: string | null;
  completed_at: string | null;
  settled_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
  viewer_role: BookingViewerRole;
  counterparty: {
    user_id: string;
    display_name: string | null;
    avatar_ref: string | null;
  };
}

export interface BookingSettlementReviewView {
  object: "booking_settlement_review";
  booking_id: string;
  community_id: string;
  host_user_id: string;
  booker_user_id: string;
  slot_start_utc: string;
  slot_end_utc: string;
  gross_cents: number;
  refund_cents: number | null;
  booking_status: string;
  review_status: "pending" | "resolved";
  review_reason: "attendance_ambiguous" | null;
  review_resolution: BookingSettlementReviewResolution | null;
  review_opened_at: string | null;
  review_resolved_at: string | null;
  review_operator_credential_id: string | null;
  review_operator_actor_id: string | null;
  review_note: string | null;
  review_version: number;
  updated_at: string;
}

export interface BookingSettlementReviewPage {
  object: "list";
  data: BookingSettlementReviewView[];
  has_more: boolean;
  next_cursor: string | null;
}

export class InvalidBookingSettlementReviewCursorError extends Error {
  constructor() {
    super("Invalid booking settlement review cursor");
    this.name = "InvalidBookingSettlementReviewCursorError";
  }
}

function textToArg(label: string, value: string): string {
  if (typeof value !== "string") throw new TypeError(`${label}: expected string`);
  return value;
}

function intToArg(label: string, value: number): number {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${label}: expected a safe integer`);
  return value;
}

function encodeCursor(row: BookingSettlementReviewView): string {
  return btoa(JSON.stringify({ updated_at: row.updated_at, booking_id: row.booking_id }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
}

function decodeCursor(cursor: string | null | undefined): { updatedAt: string; bookingId: string } | null {
  if (!cursor) return null;
  try {
    const normalized = cursor.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const parsed = JSON.parse(atob(padded)) as unknown;
    if (!parsed || typeof parsed !== "object") throw new InvalidBookingSettlementReviewCursorError();
    const row = parsed as { updated_at?: unknown; booking_id?: unknown };
    if (typeof row.updated_at !== "string" || typeof row.booking_id !== "string") {
      throw new InvalidBookingSettlementReviewCursorError();
    }
    return { updatedAt: row.updated_at, bookingId: row.booking_id };
  } catch (error) {
    if (error instanceof InvalidBookingSettlementReviewCursorError) throw error;
    throw new InvalidBookingSettlementReviewCursorError();
  }
}

function toView(booking: Booking, actorUserId: string): BookingView {
  const viewerRole = actorUserId === booking.hostUserId ? "host" : "booker";
  const counterpartyUserId = viewerRole === "host" ? booking.bookerUserId : booking.hostUserId;
  return {
    object: "booking",
    booking_id: booking.bookingId,
    community_id: booking.sourceCommunityId ?? "",
    host_user_id: booking.hostUserId,
    booker_user_id: booking.bookerUserId,
    slot_start_utc: booking.slotStartUtc,
    slot_end_utc: booking.slotEndUtc,
    gross_cents: booking.grossCents,
    platform_fee_cents: booking.platformFeeCents,
    host_payout_cents: booking.hostPayoutCents,
    refund_cents: booking.refundCents,
    status: booking.status,
    outcome: booking.outcome,
    settlement_status: settlementStatus(booking),
    funding_tx_ref: booking.fundingTxRef,
    payout_tx_ref: booking.payoutTxRef,
    refund_tx_ref: booking.refundTxRef,
    live_room_id: booking.liveRoomId,
    confirmed_at: booking.confirmedAt,
    completed_at: booking.completedAt,
    settled_at: booking.settledAt,
    cancelled_at: booking.cancelledAt,
    created_at: booking.createdAt,
    updated_at: booking.updatedAt,
    viewer_role: viewerRole,
    counterparty: { user_id: counterpartyUserId, display_name: null, avatar_ref: null },
  };
}

export async function enrichGlobalBookingCounterparties(input: {
  bookings: BookingView[];
  profileRepository: ProfileRepository;
}): Promise<BookingView[]> {
  const userIds = Array.from(new Set(input.bookings.map((booking) => booking.counterparty.user_id)));
  const profiles = input.profileRepository.listProfilesByUserIds
    ? await input.profileRepository.listProfilesByUserIds(userIds)
    : new Map(await Promise.all(userIds.map(async (userId) => [userId, await input.profileRepository.getProfileByUserId(userId)] as const)));
  return input.bookings.map((booking) => {
    const profile = profiles.get(booking.counterparty.user_id);
    return {
      ...booking,
      counterparty: {
        user_id: booking.counterparty.user_id,
        display_name: profile?.display_name ?? null,
        avatar_ref: profile?.avatar_ref ?? null,
      },
    };
  });
}

function settlementStatus(booking: Booking): BookingSettlementStatus {
  if (booking.status === "live") return "live";
  if (booking.status === "settled") return "settled";
  if (booking.status === "refunded") return "refunded";
  if (booking.status === "disputed") return "disputed";
  if (
    booking.status === "completed" ||
    booking.status === "no_show_host" ||
    booking.status === "no_show_booker" ||
    booking.status === "cancelled_by_host" ||
    booking.status === "cancelled_by_booker"
  ) return "settling";
  return "pending";
}

function toReviewView(booking: Booking): BookingSettlementReviewView {
  if (booking.settlementReviewStatus !== "pending" && booking.settlementReviewStatus !== "resolved") {
    throw new TypeError("toReviewView: expected settlement review row");
  }
  return {
    object: "booking_settlement_review",
    booking_id: booking.bookingId,
    community_id: booking.sourceCommunityId ?? "",
    host_user_id: booking.hostUserId,
    booker_user_id: booking.bookerUserId,
    slot_start_utc: booking.slotStartUtc,
    slot_end_utc: booking.slotEndUtc,
    gross_cents: booking.grossCents,
    refund_cents: booking.refundCents,
    booking_status: booking.status,
    review_status: booking.settlementReviewStatus,
    review_reason: booking.settlementReviewReason,
    review_resolution: booking.settlementReviewResolution,
    review_opened_at: booking.settlementReviewOpenedAt,
    review_resolved_at: booking.settlementReviewResolvedAt,
    review_operator_credential_id: booking.settlementReviewOperatorCredentialId,
    review_operator_actor_id: booking.settlementReviewOperatorActorId,
    review_note: booking.settlementReviewNote,
    review_version: booking.settlementReviewVersion,
    updated_at: booking.updatedAt,
  };
}

export async function getGlobalBookingForParty(input: {
  executor: BookingReadSqlExecutor;
  bookingId: string;
  actorUserId: string;
}): Promise<BookingView | null> {
  const res = await input.executor.execute({
    sql: `SELECT ${BOOKING_COLUMNS} FROM bookings.bookings WHERE booking_id = ?1`,
    args: [textToArg("bookingId", input.bookingId)],
  });
  const row = res.rows[0];
  if (!row) return null;
  const booking = decodeBooking(row);
  if (booking.hostUserId !== input.actorUserId && booking.bookerUserId !== input.actorUserId) return null;
  return toView(booking, input.actorUserId);
}

export async function listGlobalBookingsForUser(input: {
  executor: BookingReadSqlExecutor;
  actorUserId: string;
  role: BookingViewerRole;
  sourceCommunityId?: string | null;
  statuses?: string[];
  limit?: number;
}): Promise<BookingView[]> {
  const limit = Math.min(Math.max(1, Math.trunc(input.limit ?? 50)), 100);
  const column = input.role === "host" ? "host_user_id" : "booker_user_id";
  const args: unknown[] = [textToArg("actorUserId", input.actorUserId), intToArg("limit", limit)];
  let next = 3;
  const clauses = [`${column} = ?1`];
  if (input.sourceCommunityId !== undefined) {
    if (input.sourceCommunityId === null) {
      clauses.push("source_community_id IS NULL");
    } else {
      clauses.push(`source_community_id = ?${next++}`);
      args.push(textToArg("sourceCommunityId", input.sourceCommunityId));
    }
  }
  const statuses = (input.statuses ?? []).filter((status) => status.length > 0).map((status) => textToArg("status", status));
  if (statuses.length > 0) {
    clauses.push(`status IN (${statuses.map((_status, index) => `?${next + index}`).join(", ")})`);
    args.push(...statuses);
  }
  const res = await input.executor.execute({
    sql: `SELECT ${BOOKING_COLUMNS}
          FROM bookings.bookings
          WHERE ${clauses.join(" AND ")}
          ORDER BY slot_start_utc DESC, booking_id ASC
          LIMIT ?2`,
    args,
  });
  return res.rows.map((row) => toView(decodeBooking(row), input.actorUserId));
}

export async function getGlobalBookingSettlementReview(input: {
  executor: BookingReadSqlExecutor;
  bookingId: string;
}): Promise<BookingSettlementReviewView | null> {
  const res = await input.executor.execute({
    sql: `SELECT ${BOOKING_COLUMNS}
          FROM bookings.bookings
          WHERE booking_id = ?1
            AND settlement_review_status IS NOT NULL`,
    args: [textToArg("bookingId", input.bookingId)],
  });
  const row = res.rows[0];
  return row ? toReviewView(decodeBooking(row)) : null;
}

export async function listPendingGlobalBookingSettlementReviews(input: {
  executor: BookingReadSqlExecutor;
  sourceCommunityId?: string | null;
  limit?: number;
  cursor?: string | null;
}): Promise<BookingSettlementReviewPage> {
  const limit = Math.min(Math.max(1, Math.trunc(input.limit ?? 50)), 100);
  const cursor = decodeCursor(input.cursor);
  const args: unknown[] = [intToArg("limit", limit + 1)];
  let next = 2;
  const clauses = ["settlement_review_status = 'pending'"];

  if (input.sourceCommunityId !== undefined) {
    if (input.sourceCommunityId === null) {
      clauses.push("source_community_id IS NULL");
    } else {
      clauses.push(`source_community_id = ?${next++}`);
      args.push(textToArg("sourceCommunityId", input.sourceCommunityId));
    }
  }
  if (cursor) {
    clauses.push(`(updated_at > ?${next}::timestamptz OR (updated_at = ?${next}::timestamptz AND booking_id > ?${next + 1}))`);
    args.push(cursor.updatedAt, cursor.bookingId);
  }

  const res = await input.executor.execute({
    sql: `SELECT ${BOOKING_COLUMNS}
          FROM bookings.bookings
          WHERE ${clauses.join(" AND ")}
          ORDER BY updated_at ASC, booking_id ASC
          LIMIT ?1`,
    args,
  });
  const rows = res.rows.map((row) => toReviewView(decodeBooking(row)));
  const data = rows.slice(0, limit);
  return {
    object: "list",
    data,
    has_more: rows.length > limit,
    next_cursor: rows.length > limit && data.length > 0 ? encodeCursor(data[data.length - 1]!) : null,
  };
}
