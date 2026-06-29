// Bounded repository for global bookings FINALIZATION in the bookings.* Postgres schema.
//
// Finalization is a durable CAS: from a verified payment intent and active hold, create the booking,
// consume the hold, consume the intent, and make the slot lock permanent. Callers provide an explicit
// executor/transaction; this module never opens clients or starts transactions.
import type { InStatement, QueryResult } from "../sql-client";
import { BOOKING_COLUMNS, decodeBooking } from "./booking-row";
import { isoUtcToArg } from "./codecs";
import type { Booking } from "./types";

export interface BookingFinalizationSqlExecutor {
  execute(statement: InStatement | string): Promise<QueryResult>;
}

export interface FinalizeBookingInput {
  bookingId?: string;
  holdId: string;
  paymentIntentId: string;
  bookerUserId: string;
  normalizedTxRef: string;
  walletAttachmentId: string;
  verifiedSenderAddress: string;
  hostPayoutWalletAddress: string;
  nowUtc: string;
}

export type FinalizeBookingResult =
  | { ok: true; already: boolean; booking: Booking }
  | { ok: false; reason: "finalization-conflict" | "replay-conflict" };

export function bookingIdForHold(holdId: string): string {
  return `bkg_${holdId}`;
}

function textToArg(label: string, value: string): string {
  if (typeof value !== "string") throw new TypeError(`${label}: expected string`);
  return value;
}

function bookingMatches(input: Required<FinalizeBookingInput>, booking: Booking): boolean {
  return (
    booking.bookingId === input.bookingId &&
    booking.holdId === input.holdId &&
    booking.bookerUserId === input.bookerUserId &&
    booking.fundingTxRef === input.normalizedTxRef &&
    (booking.fundingWalletAddress ?? "").toLowerCase() === input.verifiedSenderAddress.toLowerCase() &&
    booking.hostPayoutWalletAddress === input.hostPayoutWalletAddress
  );
}

function normalizeInput(input: FinalizeBookingInput): Required<FinalizeBookingInput> {
  return {
    ...input,
    bookingId: input.bookingId ?? bookingIdForHold(input.holdId),
  };
}

async function getBooking(exec: BookingFinalizationSqlExecutor, bookingId: string): Promise<Booking | null> {
  const res = await exec.execute({
    sql: `SELECT ${BOOKING_COLUMNS} FROM bookings.bookings WHERE booking_id = ?1`,
    args: [textToArg("bookingId", bookingId)],
  });
  return res.rows[0] ? decodeBooking(res.rows[0]) : null;
}

async function getBookingByHold(exec: BookingFinalizationSqlExecutor, holdId: string): Promise<Booking | null> {
  const res = await exec.execute({
    sql: `SELECT ${BOOKING_COLUMNS} FROM bookings.bookings WHERE hold_id = ?1`,
    args: [textToArg("holdId", holdId)],
  });
  return res.rows[0] ? decodeBooking(res.rows[0]) : null;
}

async function finalizeBookingFromVerifiedPaymentIntent(
  exec: BookingFinalizationSqlExecutor,
  rawInput: FinalizeBookingInput,
): Promise<FinalizeBookingResult> {
  const input = normalizeInput(rawInput);
  const res = await exec.execute({
    sql: `WITH inserted AS (
            INSERT INTO bookings.bookings (
              booking_id, hold_id, host_user_id, booker_user_id, slot_start_utc, slot_end_utc,
              gross_cents, platform_fee_bps, platform_fee_cents, host_payout_cents, status,
              funding_tx_ref, funding_wallet_address, host_payout_wallet_address, live_room_id,
              source_community_id, confirmed_at, created_at, updated_at
            )
            SELECT
              ?1, h.hold_id, h.host_user_id, h.booker_user_id, h.slot_start_utc, h.slot_end_utc,
              pi.gross_cents, pi.platform_fee_bps, pi.platform_fee_cents, pi.host_payout_cents, 'confirmed',
              pi.claimed_tx_ref, pi.verified_sender_address, ?8, NULL,
              h.source_community_id, ?9::timestamptz, ?9::timestamptz, ?9::timestamptz
            FROM bookings.holds h
            JOIN bookings.payment_intents pi ON pi.hold_id = h.hold_id
            WHERE h.hold_id = ?2
              AND h.status = 'active'
              AND h.booker_user_id = ?4
              AND pi.payment_intent_id = ?3
              AND pi.status = 'verified'
              AND pi.claimed_tx_ref = ?5
              AND pi.consumed_wallet_attachment_id = ?6
              AND lower(pi.verified_sender_address) = lower(?7)
              AND EXISTS (
                SELECT 1 FROM bookings.host_slot_locks l
                WHERE l.hold_id = h.hold_id AND l.status = 'active'
              )
            ON CONFLICT (booking_id) DO NOTHING
            RETURNING ${BOOKING_COLUMNS}
          ),
          selected AS (
            SELECT true AS inserted_now, ${BOOKING_COLUMNS} FROM inserted
            UNION ALL
            SELECT false AS inserted_now, ${BOOKING_COLUMNS} FROM bookings.bookings
            WHERE booking_id = ?1
              AND hold_id = ?2
              AND booker_user_id = ?4
              AND funding_tx_ref = ?5
              AND lower(funding_wallet_address) = lower(?7)
              AND host_payout_wallet_address = ?8
              AND NOT EXISTS (SELECT 1 FROM inserted)
          ),
          hold_update AS (
            UPDATE bookings.holds h
            SET status = 'consumed', updated_at = ?9::timestamptz
            WHERE h.hold_id = ?2 AND h.status = 'active' AND EXISTS (SELECT 1 FROM selected)
            RETURNING h.hold_id
          ),
          intent_update AS (
            UPDATE bookings.payment_intents pi
            SET status = 'consumed',
                consumed_at = ?9::timestamptz,
                version = version + 1,
                updated_at = ?9::timestamptz
            WHERE pi.payment_intent_id = ?3
              AND pi.status = 'verified'
              AND pi.hold_id = ?2
              AND pi.claimed_tx_ref = ?5
              AND pi.consumed_wallet_attachment_id = ?6
              AND lower(pi.verified_sender_address) = lower(?7)
              AND EXISTS (SELECT 1 FROM selected)
            RETURNING pi.payment_intent_id
          ),
          lock_update AS (
            UPDATE bookings.host_slot_locks l
            SET booking_id = ?1, expires_at_utc = NULL, updated_at = ?9::timestamptz
            WHERE l.hold_id = ?2 AND l.status = 'active' AND EXISTS (SELECT 1 FROM selected)
            RETURNING l.lock_id
          )
          SELECT selected.inserted_now, selected.${BOOKING_COLUMNS.replaceAll(", ", ", selected.")}
          FROM selected
          LIMIT 1`,
    args: [
      textToArg("bookingId", input.bookingId),
      textToArg("holdId", input.holdId),
      textToArg("paymentIntentId", input.paymentIntentId),
      textToArg("bookerUserId", input.bookerUserId),
      textToArg("normalizedTxRef", input.normalizedTxRef),
      textToArg("walletAttachmentId", input.walletAttachmentId),
      textToArg("verifiedSenderAddress", input.verifiedSenderAddress),
      textToArg("hostPayoutWalletAddress", input.hostPayoutWalletAddress),
      isoUtcToArg(input.nowUtc),
    ],
  });
  const row = res.rows[0];
  if (!row) {
    const existing = await getBookingByHold(exec, input.holdId);
    return existing ? { ok: false, reason: "replay-conflict" } : { ok: false, reason: "finalization-conflict" };
  }
  const booking = decodeBooking(row);
  if (!bookingMatches(input, booking)) return { ok: false, reason: "replay-conflict" };
  return { ok: true, already: row.inserted_now !== true && row.inserted_now !== "t" && row.inserted_now !== "true", booking };
}

export interface BookingFinalizationRepository {
  getBooking(bookingId: string): Promise<Booking | null>;
  getBookingByHold(holdId: string): Promise<Booking | null>;
}

export interface BookingFinalizationWriteRepository extends BookingFinalizationRepository {
  finalizeBookingFromVerifiedPaymentIntent(input: FinalizeBookingInput): Promise<FinalizeBookingResult>;
}

function buildRepository(executor: BookingFinalizationSqlExecutor): BookingFinalizationRepository {
  return {
    getBooking: (bookingId) => getBooking(executor, bookingId),
    getBookingByHold: (holdId) => getBookingByHold(executor, holdId),
  };
}

function buildWriteRepository(executor: BookingFinalizationSqlExecutor): BookingFinalizationWriteRepository {
  return {
    ...buildRepository(executor),
    finalizeBookingFromVerifiedPaymentIntent: (input) => finalizeBookingFromVerifiedPaymentIntent(executor, input),
  };
}

export function createBookingFinalizationRepository(
  executor: BookingFinalizationSqlExecutor,
): BookingFinalizationRepository {
  return buildRepository(executor);
}

export function createBookingFinalizationWriteRepository(
  executor: BookingFinalizationSqlExecutor,
): BookingFinalizationWriteRepository {
  return buildWriteRepository(executor);
}

export function createBookingFinalizationTxWriteRepository(
  tx: BookingFinalizationSqlExecutor,
): BookingFinalizationWriteRepository {
  return buildWriteRepository(tx);
}
