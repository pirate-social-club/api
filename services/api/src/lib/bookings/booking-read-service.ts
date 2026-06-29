import type { InStatement, QueryResult } from "../sql-client";
import { BOOKING_COLUMNS, decodeBooking } from "./booking-row";
import type { Booking } from "./types";

export type BookingViewerRole = "host" | "booker";

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
}

function textToArg(label: string, value: string): string {
  if (typeof value !== "string") throw new TypeError(`${label}: expected string`);
  return value;
}

function intToArg(label: string, value: number): number {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${label}: expected a safe integer`);
  return value;
}

function toView(booking: Booking, actorUserId: string): BookingView {
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
    viewer_role: actorUserId === booking.hostUserId ? "host" : "booker",
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
