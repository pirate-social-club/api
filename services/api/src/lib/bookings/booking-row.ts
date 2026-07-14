// Shared row decoder/projection for bookings.bookings. Repository modules keep raw snake_case rows
// private, but lifecycle/finalization must decode the same financial record identically.
import type { QueryResultRow } from "../sql-client";
import { intFromRow, intFromRowNullable, isoUtcFromRow, isoUtcFromRowNullable, textFromRow, textFromRowNullable } from "./codecs";
import type { Booking, BookingStatus } from "./types";

export const BOOKING_COLUMNS =
  "booking_id, hold_id, host_user_id, booker_user_id, slot_start_utc, slot_end_utc, gross_cents, " +
  "platform_fee_bps, platform_fee_cents, host_payout_cents, refund_cents, status, funding_tx_ref, " +
  "payout_tx_ref, refund_tx_ref, funding_wallet_address, host_payout_wallet_address, live_room_id, " +
  "source_community_id, confirmed_at, completed_at, settled_at, cancelled_at, settlement_review_status, " +
  "settlement_review_reason, settlement_review_resolution, settlement_review_opened_at, settlement_review_resolved_at, " +
  "settlement_review_operator_credential_id, settlement_review_operator_actor_id, settlement_review_note, " +
  "settlement_review_version, outcome, created_at, updated_at";

function decodeBookingStatus(value: unknown): BookingStatus {
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

function decodeSettlementReviewStatus(value: unknown): Booking["settlementReviewStatus"] {
  const status = textFromRowNullable(value);
  if (status !== null && status !== "pending" && status !== "resolved") {
    throw new TypeError(`decodeSettlementReviewStatus: bad status ${status}`);
  }
  return status;
}

function decodeSettlementReviewReason(value: unknown): Booking["settlementReviewReason"] {
  const reason = textFromRowNullable(value);
  if (reason !== null && reason !== "attendance_ambiguous") {
    throw new TypeError(`decodeSettlementReviewReason: bad reason ${reason}`);
  }
  return reason;
}

function decodeSettlementReviewResolution(value: unknown): Booking["settlementReviewResolution"] {
  const resolution = textFromRowNullable(value);
  if (resolution !== null && resolution !== "completed" && resolution !== "no_show_host" && resolution !== "no_show_booker") {
    throw new TypeError(`decodeSettlementReviewResolution: bad resolution ${resolution}`);
  }
  return resolution;
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
    outcome: decodeBookingOutcome(row.outcome),
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
    settlementReviewStatus: decodeSettlementReviewStatus(row.settlement_review_status),
    settlementReviewReason: decodeSettlementReviewReason(row.settlement_review_reason),
    settlementReviewResolution: decodeSettlementReviewResolution(row.settlement_review_resolution),
    settlementReviewOpenedAt: isoUtcFromRowNullable(row.settlement_review_opened_at),
    settlementReviewResolvedAt: isoUtcFromRowNullable(row.settlement_review_resolved_at),
    settlementReviewOperatorCredentialId: textFromRowNullable(row.settlement_review_operator_credential_id),
    settlementReviewOperatorActorId: textFromRowNullable(row.settlement_review_operator_actor_id),
    settlementReviewNote: textFromRowNullable(row.settlement_review_note),
    settlementReviewVersion: intFromRow(row.settlement_review_version),
    createdAt: isoUtcFromRow(row.created_at),
    updatedAt: isoUtcFromRow(row.updated_at),
  };
}

function decodeBookingOutcome(value: unknown): Booking["outcome"] {
  const outcome = textFromRowNullable(value);
  if (
    outcome !== null &&
    outcome !== "completed" &&
    outcome !== "no_show_host" &&
    outcome !== "no_show_booker" &&
    outcome !== "cancelled_by_host" &&
    outcome !== "cancelled_by_booker"
  ) {
    throw new TypeError(`decodeBookingOutcome: bad outcome ${outcome}`);
  }
  return outcome;
}
