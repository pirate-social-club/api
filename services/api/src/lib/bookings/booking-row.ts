// Shared row decoder/projection for bookings.bookings. Repository modules keep raw snake_case rows
// private, but lifecycle/finalization must decode the same financial record identically.
import type { QueryResultRow } from "../sql-client";
import { intFromRow, intFromRowNullable, isoUtcFromRow, isoUtcFromRowNullable, textFromRow, textFromRowNullable } from "./codecs";
import type { Booking, BookingStatus } from "./types";

export const BOOKING_COLUMNS =
  "booking_id, hold_id, host_user_id, booker_user_id, slot_start_utc, slot_end_utc, gross_cents, " +
  "platform_fee_bps, platform_fee_cents, host_payout_cents, refund_cents, status, funding_tx_ref, " +
  "payout_tx_ref, refund_tx_ref, funding_wallet_address, host_payout_wallet_address, live_room_id, " +
  "source_community_id, confirmed_at, completed_at, settled_at, cancelled_at, created_at, updated_at";

export function decodeBookingStatus(value: unknown): BookingStatus {
  const status = textFromRow(value);
  if (
    status !== "hold" &&
    status !== "quoted" &&
    status !== "pending_payment" &&
    status !== "confirmed" &&
    status !== "live" &&
    status !== "completed" &&
    status !== "settled" &&
    status !== "expired_hold" &&
    status !== "cancelled_before_payment" &&
    status !== "cancelled_by_host" &&
    status !== "cancelled_by_booker" &&
    status !== "no_show_host" &&
    status !== "no_show_booker" &&
    status !== "refunded" &&
    status !== "disputed"
  ) {
    throw new TypeError(`decodeBookingStatus: bad status ${status}`);
  }
  return status;
}

export function decodeBooking(row: QueryResultRow): Booking {
  return {
    bookingId: textFromRow(row.booking_id),
    holdId: textFromRowNullable(row.hold_id),
    hostUserId: textFromRow(row.host_user_id),
    bookerUserId: textFromRow(row.booker_user_id),
    slotStartUtc: isoUtcFromRow(row.slot_start_utc),
    slotEndUtc: isoUtcFromRow(row.slot_end_utc),
    grossCents: intFromRow(row.gross_cents),
    platformFeeBps: intFromRow(row.platform_fee_bps),
    platformFeeCents: intFromRow(row.platform_fee_cents),
    hostPayoutCents: intFromRow(row.host_payout_cents),
    refundCents: intFromRowNullable(row.refund_cents),
    status: decodeBookingStatus(row.status),
    fundingTxRef: textFromRowNullable(row.funding_tx_ref),
    payoutTxRef: textFromRowNullable(row.payout_tx_ref),
    refundTxRef: textFromRowNullable(row.refund_tx_ref),
    fundingWalletAddress: textFromRowNullable(row.funding_wallet_address),
    hostPayoutWalletAddress: textFromRowNullable(row.host_payout_wallet_address),
    liveRoomId: textFromRowNullable(row.live_room_id),
    sourceCommunityId: textFromRowNullable(row.source_community_id),
    confirmedAt: isoUtcFromRowNullable(row.confirmed_at),
    completedAt: isoUtcFromRowNullable(row.completed_at),
    settledAt: isoUtcFromRowNullable(row.settled_at),
    cancelledAt: isoUtcFromRowNullable(row.cancelled_at),
    createdAt: isoUtcFromRow(row.created_at),
    updatedAt: isoUtcFromRow(row.updated_at),
  };
}
