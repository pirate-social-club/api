// Bounded repository for global booking lifecycle + attendance rows in the bookings.* Postgres schema.
//
// This module owns durable row/CAS semantics only. Actor authorization, schedule windows, refund
// calculation, custody effects, Agora token minting, and settlement policy stay in higher layers.
import type { InStatement, QueryResult, QueryResultRow } from "../sql-client";
import { BOOKING_COLUMNS, decodeBooking } from "./booking-row";
import { intFromRowNullable, isoUtcFromRow, isoUtcFromRowNullable, isoUtcToArg, textFromRow, textFromRowNullable } from "./codecs";
import type { AttendanceHeartbeat, AttendanceParty, AttendanceSession, Booking, HostSlotLock } from "./types";

export interface BookingLifecycleSqlExecutor {
  execute(statement: InStatement | string): Promise<QueryResult>;
}

interface ReserveBookingSettlementIntentInput {
  bookingId: string;
  fromStatus: "confirmed" | "live";
  toStatus: "cancelled_by_host" | "cancelled_by_booker" | "completed" | "no_show_host" | "no_show_booker";
  refundCents: number;
  nowUtc: string;
}

interface FlagBookingSettlementDisputedInput {
  bookingId: string;
  fromStatus: "confirmed" | "live";
  nowUtc: string;
}

interface MarkBookingSettlementAmbiguousInput {
  bookingId: string;
  nowUtc: string;
}

interface ResolveBookingSettlementReviewInput {
  bookingId: string;
  resolution: "completed" | "no_show_host" | "no_show_booker";
  refundCents: number;
  expectedReviewVersion: number;
  operatorCredentialId: string;
  operatorActorId: string;
  note?: string | null;
  nowUtc: string;
}

interface FinalizeBookingSettlementInput {
  bookingId: string;
  fromStatus: "cancelled_by_host" | "cancelled_by_booker" | "completed" | "no_show_host" | "no_show_booker";
  finalStatus: "settled" | "refunded";
  refundTxRef?: string | null;
  payoutTxRef?: string | null;
  nowUtc: string;
}

interface AttachAttendanceSessionInput {
  sessionId: string;
  bookingId: string;
  party: AttendanceParty;
  userId: string;
  agoraUid?: number | null;
  attachedAt: string;
}

interface HeartbeatAttendanceSessionInput {
  heartbeatId: string;
  sessionId: string;
  bookingId: string;
  userId: string;
  seenAt: string;
}

type HeartbeatAttendanceSessionResult =
  | { ok: true; session: AttendanceSession; heartbeat: AttendanceHeartbeat }
  | { ok: false; reason: "not-found" };

function textToArg(label: string, value: string): string {
  if (typeof value !== "string") throw new TypeError(`${label}: expected string`);
  return value;
}

function nullableTextToArg(label: string, value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return textToArg(label, value);
}

function intToArg(label: string, value: number): number {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${label}: expected a safe integer`);
  return value;
}

function nullableIntToArg(label: string, value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return intToArg(label, value);
}

function settlementIntentStatusToArg(value: ReserveBookingSettlementIntentInput["toStatus"]): ReserveBookingSettlementIntentInput["toStatus"] {
  if (
    value !== "cancelled_by_host" &&
    value !== "cancelled_by_booker" &&
    value !== "completed" &&
    value !== "no_show_host" &&
    value !== "no_show_booker"
  ) {
    throw new TypeError(`settlementIntentStatusToArg: bad status ${String(value)}`);
  }
  return value;
}

function settlementFinalStatusToArg(value: FinalizeBookingSettlementInput["finalStatus"]): FinalizeBookingSettlementInput["finalStatus"] {
  if (value !== "settled" && value !== "refunded") throw new TypeError(`settlementFinalStatusToArg: bad status ${String(value)}`);
  return value;
}

function fromStatusToArg(value: "confirmed" | "live"): "confirmed" | "live" {
  if (value !== "confirmed" && value !== "live") throw new TypeError(`fromStatusToArg: bad status ${String(value)}`);
  return value;
}

function unfinishedStatusToArg(value: FinalizeBookingSettlementInput["fromStatus"]): FinalizeBookingSettlementInput["fromStatus"] {
  return settlementIntentStatusToArg(value);
}

function reviewResolutionToArg(value: ResolveBookingSettlementReviewInput["resolution"]): ResolveBookingSettlementReviewInput["resolution"] {
  if (value !== "completed" && value !== "no_show_host" && value !== "no_show_booker") {
    throw new TypeError(`reviewResolutionToArg: bad resolution ${String(value)}`);
  }
  return value;
}

function intentStatusForReviewResolution(
  value: ResolveBookingSettlementReviewInput["resolution"],
): ReserveBookingSettlementIntentInput["toStatus"] {
  return settlementIntentStatusToArg(value);
}

function attendancePartyToArg(value: AttendanceParty): AttendanceParty {
  if (value !== "host" && value !== "booker") throw new TypeError(`attendancePartyToArg: bad party ${String(value)}`);
  return value;
}

function decodeLockStatus(value: unknown): HostSlotLock["status"] {
  const status = textFromRow(value);
  if (status !== "active" && status !== "released") throw new TypeError(`decodeLockStatus: bad status ${status}`);
  return status;
}

function decodeHostSlotLock(row: QueryResultRow): HostSlotLock {
  return {
    lockId: textFromRow(row.lock_id),
    hostUserId: textFromRow(row.host_user_id),
    slotStartUtc: isoUtcFromRow(row.slot_start_utc),
    slotEndUtc: isoUtcFromRow(row.slot_end_utc),
    holdId: textFromRowNullable(row.hold_id),
    bookingId: textFromRowNullable(row.booking_id),
    status: decodeLockStatus(row.status),
    sourceCommunityId: textFromRowNullable(row.source_community_id),
    expiresAtUtc: isoUtcFromRowNullable(row.expires_at_utc),
    createdAt: isoUtcFromRow(row.created_at),
    updatedAt: isoUtcFromRow(row.updated_at),
  };
}

function decodeAttendanceParty(value: unknown): AttendanceParty {
  const party = textFromRow(value);
  if (party !== "host" && party !== "booker") throw new TypeError(`decodeAttendanceParty: bad party ${party}`);
  return party;
}

function decodeAttendanceSession(row: QueryResultRow): AttendanceSession {
  return {
    sessionId: textFromRow(row.session_id),
    bookingId: textFromRow(row.booking_id),
    party: decodeAttendanceParty(row.party),
    userId: textFromRow(row.user_id),
    agoraUid: intFromRowNullable(row.agora_uid),
    attachedAt: isoUtcFromRow(row.attached_at),
    lastSeenAt: isoUtcFromRow(row.last_seen_at),
    endedAt: isoUtcFromRowNullable(row.ended_at),
    createdAt: isoUtcFromRow(row.created_at),
    updatedAt: isoUtcFromRow(row.updated_at),
  };
}

function decodeAttendanceHeartbeat(row: QueryResultRow): AttendanceHeartbeat {
  return {
    heartbeatId: textFromRow(row.heartbeat_id),
    sessionId: textFromRow(row.session_id),
    bookingId: textFromRow(row.booking_id),
    seenAt: isoUtcFromRow(row.seen_at),
  };
}

const LOCK_COLUMNS =
  "lock_id, host_user_id, slot_start_utc, slot_end_utc, hold_id, booking_id, status, " +
  "source_community_id, expires_at_utc, created_at, updated_at";
const SESSION_COLUMNS =
  "session_id, booking_id, party, user_id, agora_uid, attached_at, last_seen_at, ended_at, created_at, updated_at";
const HEARTBEAT_COLUMNS = "heartbeat_id, session_id, booking_id, seen_at";

async function getBooking(exec: BookingLifecycleSqlExecutor, bookingId: string): Promise<Booking | null> {
  const res = await exec.execute({
    sql: `SELECT ${BOOKING_COLUMNS} FROM bookings.bookings WHERE booking_id = ?1`,
    args: [textToArg("bookingId", bookingId)],
  });
  return res.rows[0] ? decodeBooking(res.rows[0]) : null;
}

async function startBookingSession(
  exec: BookingLifecycleSqlExecutor,
  bookingId: string,
  updatedAt: string,
): Promise<Booking | null> {
  const res = await exec.execute({
    sql: `UPDATE bookings.bookings
          SET status = 'live', updated_at = ?2::timestamptz
          WHERE booking_id = ?1 AND status = 'confirmed'
          RETURNING ${BOOKING_COLUMNS}`,
    args: [textToArg("bookingId", bookingId), isoUtcToArg(updatedAt)],
  });
  return res.rows[0] ? decodeBooking(res.rows[0]) : null;
}

async function reserveBookingSettlementIntent(
  exec: BookingLifecycleSqlExecutor,
  input: ReserveBookingSettlementIntentInput,
): Promise<Booking | null> {
  const res = await exec.execute({
    sql: `UPDATE bookings.bookings
          SET status = ?3,
              outcome = ?3,
              refund_cents = ?4,
              cancelled_at = CASE WHEN ?3 IN ('cancelled_by_host', 'cancelled_by_booker') THEN ?5::timestamptz ELSE cancelled_at END,
              completed_at = CASE WHEN ?3 = 'completed' THEN ?5::timestamptz ELSE completed_at END,
              updated_at = ?5::timestamptz
          WHERE booking_id = ?1 AND status = ?2
          RETURNING ${BOOKING_COLUMNS}`,
    args: [
      textToArg("bookingId", input.bookingId),
      fromStatusToArg(input.fromStatus),
      settlementIntentStatusToArg(input.toStatus),
      intToArg("refundCents", input.refundCents),
      isoUtcToArg(input.nowUtc),
    ],
  });
  return res.rows[0] ? decodeBooking(res.rows[0]) : null;
}

async function flagBookingSettlementDisputed(
  exec: BookingLifecycleSqlExecutor,
  input: FlagBookingSettlementDisputedInput,
): Promise<Booking | null> {
  const res = await exec.execute({
    sql: `UPDATE bookings.bookings
          SET status = 'disputed',
              settlement_review_status = 'pending',
              settlement_review_reason = 'attendance_ambiguous',
              settlement_review_resolution = NULL,
              settlement_review_opened_at = COALESCE(settlement_review_opened_at, ?3::timestamptz),
              settlement_review_resolved_at = NULL,
              settlement_review_operator_credential_id = NULL,
              settlement_review_operator_actor_id = NULL,
              settlement_review_note = NULL,
              settlement_review_version = settlement_review_version + 1,
              updated_at = ?3::timestamptz
          WHERE booking_id = ?1 AND status = ?2 AND settlement_review_status IS NULL
          RETURNING ${BOOKING_COLUMNS}`,
    args: [
      textToArg("bookingId", input.bookingId),
      fromStatusToArg(input.fromStatus),
      isoUtcToArg(input.nowUtc),
    ],
  });
  return res.rows[0] ? decodeBooking(res.rows[0]) : null;
}

async function markBookingSettlementAmbiguous(
  exec: BookingLifecycleSqlExecutor,
  input: MarkBookingSettlementAmbiguousInput,
): Promise<Booking | null> {
  const res = await exec.execute({
    sql: `UPDATE bookings.bookings
          SET status = 'disputed',
              settlement_review_status = 'pending',
              settlement_review_reason = 'attendance_ambiguous',
              settlement_review_resolution = NULL,
              settlement_review_opened_at = COALESCE(settlement_review_opened_at, ?2::timestamptz),
              settlement_review_resolved_at = NULL,
              settlement_review_operator_credential_id = NULL,
              settlement_review_operator_actor_id = NULL,
              settlement_review_note = NULL,
              settlement_review_version = settlement_review_version + 1,
              updated_at = ?2::timestamptz
          WHERE booking_id = ?1
            AND status IN ('confirmed', 'live')
            AND settlement_review_status IS NULL
          RETURNING ${BOOKING_COLUMNS}`,
    args: [
      textToArg("bookingId", input.bookingId),
      isoUtcToArg(input.nowUtc),
    ],
  });
  return res.rows[0] ? decodeBooking(res.rows[0]) : null;
}

async function resolveBookingSettlementReview(
  exec: BookingLifecycleSqlExecutor,
  input: ResolveBookingSettlementReviewInput,
): Promise<Booking | null> {
  const res = await exec.execute({
    sql: `UPDATE bookings.bookings
          SET status = ?2,
              outcome = ?2,
              refund_cents = ?3,
              settlement_review_status = 'resolved',
              settlement_review_resolution = ?2,
              settlement_review_resolved_at = ?4::timestamptz,
              settlement_review_operator_credential_id = ?5,
              settlement_review_operator_actor_id = ?6,
              settlement_review_note = ?7,
              settlement_review_version = settlement_review_version + 1,
              updated_at = ?4::timestamptz
          WHERE booking_id = ?1
            AND status = 'disputed'
            AND settlement_review_status = 'pending'
            AND settlement_review_version = ?8
          RETURNING ${BOOKING_COLUMNS}`,
    args: [
      textToArg("bookingId", input.bookingId),
      intentStatusForReviewResolution(reviewResolutionToArg(input.resolution)),
      intToArg("refundCents", input.refundCents),
      isoUtcToArg(input.nowUtc),
      textToArg("operatorCredentialId", input.operatorCredentialId),
      textToArg("operatorActorId", input.operatorActorId),
      nullableTextToArg("note", input.note),
      intToArg("expectedReviewVersion", input.expectedReviewVersion),
    ],
  });
  return res.rows[0] ? decodeBooking(res.rows[0]) : null;
}

async function finalizeBookingSettlement(
  exec: BookingLifecycleSqlExecutor,
  input: FinalizeBookingSettlementInput,
): Promise<Booking | null> {
  const res = await exec.execute({
    sql: `UPDATE bookings.bookings
          SET status = ?3,
              refund_tx_ref = ?4,
              payout_tx_ref = ?5,
              settled_at = CASE WHEN ?3 = 'settled' THEN ?6::timestamptz ELSE settled_at END,
              updated_at = ?6::timestamptz
          WHERE booking_id = ?1 AND status = ?2
          RETURNING ${BOOKING_COLUMNS}`,
    args: [
      textToArg("bookingId", input.bookingId),
      unfinishedStatusToArg(input.fromStatus),
      settlementFinalStatusToArg(input.finalStatus),
      nullableTextToArg("refundTxRef", input.refundTxRef),
      nullableTextToArg("payoutTxRef", input.payoutTxRef),
      isoUtcToArg(input.nowUtc),
    ],
  });
  return res.rows[0] ? decodeBooking(res.rows[0]) : null;
}

async function releaseBookingSlotLock(
  exec: BookingLifecycleSqlExecutor,
  bookingId: string,
  updatedAt: string,
): Promise<HostSlotLock | null> {
  const res = await exec.execute({
    sql: `UPDATE bookings.host_slot_locks
          SET status = 'released', updated_at = ?2::timestamptz
          WHERE booking_id = ?1 AND status = 'active'
          RETURNING ${LOCK_COLUMNS}`,
    args: [textToArg("bookingId", bookingId), isoUtcToArg(updatedAt)],
  });
  return res.rows[0] ? decodeHostSlotLock(res.rows[0]) : null;
}

async function getAttendanceSession(
  exec: BookingLifecycleSqlExecutor,
  sessionId: string,
): Promise<AttendanceSession | null> {
  const res = await exec.execute({
    sql: `SELECT ${SESSION_COLUMNS} FROM bookings.attendance_sessions WHERE session_id = ?1`,
    args: [textToArg("sessionId", sessionId)],
  });
  return res.rows[0] ? decodeAttendanceSession(res.rows[0]) : null;
}

async function listAttendanceSessions(
  exec: BookingLifecycleSqlExecutor,
  bookingId: string,
): Promise<AttendanceSession[]> {
  const res = await exec.execute({
    sql: `SELECT ${SESSION_COLUMNS}
          FROM bookings.attendance_sessions
          WHERE booking_id = ?1
          ORDER BY attached_at ASC, session_id ASC`,
    args: [textToArg("bookingId", bookingId)],
  });
  return res.rows.map(decodeAttendanceSession);
}

async function listAttendanceHeartbeats(
  exec: BookingLifecycleSqlExecutor,
  sessionId: string,
): Promise<AttendanceHeartbeat[]> {
  const res = await exec.execute({
    sql: `SELECT ${HEARTBEAT_COLUMNS}
          FROM bookings.attendance_heartbeats
          WHERE session_id = ?1
          ORDER BY seen_at ASC, heartbeat_id ASC`,
    args: [textToArg("sessionId", sessionId)],
  });
  return res.rows.map(decodeAttendanceHeartbeat);
}

async function attachAttendanceSession(
  exec: BookingLifecycleSqlExecutor,
  input: AttachAttendanceSessionInput,
): Promise<AttendanceSession | null> {
  const attachedAt = isoUtcToArg(input.attachedAt);
  const res = await exec.execute({
    sql: `INSERT INTO bookings.attendance_sessions (
            session_id, booking_id, party, user_id, agora_uid, attached_at, last_seen_at, ended_at, created_at, updated_at
          )
          SELECT ?1, b.booking_id, ?3, ?4, ?5, ?6::timestamptz, ?6::timestamptz, NULL, ?6::timestamptz, ?6::timestamptz
          FROM bookings.bookings b
          WHERE b.booking_id = ?2
            AND b.status IN ('confirmed', 'live')
            AND ((?3 = 'host' AND b.host_user_id = ?4) OR (?3 = 'booker' AND b.booker_user_id = ?4))
          RETURNING ${SESSION_COLUMNS}`,
    args: [
      textToArg("sessionId", input.sessionId),
      textToArg("bookingId", input.bookingId),
      attendancePartyToArg(input.party),
      textToArg("userId", input.userId),
      nullableIntToArg("agoraUid", input.agoraUid),
      attachedAt,
    ],
  });
  return res.rows[0] ? decodeAttendanceSession(res.rows[0]) : null;
}

async function setBookingLiveRoomIfUnset(
  exec: BookingLifecycleSqlExecutor,
  bookingId: string,
  liveRoomId: string,
  updatedAt: string,
): Promise<Booking | null> {
  const res = await exec.execute({
    sql: `UPDATE bookings.bookings
          SET live_room_id = ?2, updated_at = ?3::timestamptz
          WHERE booking_id = ?1 AND live_room_id IS NULL
          RETURNING ${BOOKING_COLUMNS}`,
    args: [textToArg("bookingId", bookingId), textToArg("liveRoomId", liveRoomId), isoUtcToArg(updatedAt)],
  });
  return res.rows[0] ? decodeBooking(res.rows[0]) : null;
}

async function heartbeatAttendanceSession(
  exec: BookingLifecycleSqlExecutor,
  input: HeartbeatAttendanceSessionInput,
): Promise<HeartbeatAttendanceSessionResult> {
  const res = await exec.execute({
    sql: `WITH updated AS (
            UPDATE bookings.attendance_sessions
            SET last_seen_at = ?5::timestamptz, updated_at = ?5::timestamptz
            WHERE session_id = ?2 AND booking_id = ?3 AND user_id = ?4
            RETURNING ${SESSION_COLUMNS}
          ),
          inserted AS (
            INSERT INTO bookings.attendance_heartbeats (heartbeat_id, session_id, booking_id, seen_at)
            SELECT ?1, session_id, booking_id, ?5::timestamptz FROM updated
            RETURNING ${HEARTBEAT_COLUMNS}
          )
          SELECT
            updated.session_id, updated.booking_id, updated.party, updated.user_id, updated.agora_uid,
            updated.attached_at, updated.last_seen_at, updated.ended_at, updated.created_at, updated.updated_at,
            inserted.heartbeat_id, inserted.session_id AS heartbeat_session_id,
            inserted.booking_id AS heartbeat_booking_id, inserted.seen_at AS heartbeat_seen_at
          FROM updated
          JOIN inserted ON inserted.session_id = updated.session_id`,
    args: [
      textToArg("heartbeatId", input.heartbeatId),
      textToArg("sessionId", input.sessionId),
      textToArg("bookingId", input.bookingId),
      textToArg("userId", input.userId),
      isoUtcToArg(input.seenAt),
    ],
  });
  const row = res.rows[0];
  if (!row) return { ok: false, reason: "not-found" };
  return {
    ok: true,
    session: decodeAttendanceSession(row),
    heartbeat: decodeAttendanceHeartbeat({
      heartbeat_id: row.heartbeat_id,
      session_id: row.heartbeat_session_id,
      booking_id: row.heartbeat_booking_id,
      seen_at: row.heartbeat_seen_at,
    }),
  };
}

async function endAttendanceSession(
  exec: BookingLifecycleSqlExecutor,
  sessionId: string,
  userId: string,
  endedAt: string,
): Promise<AttendanceSession | null> {
  const res = await exec.execute({
    sql: `UPDATE bookings.attendance_sessions
          SET ended_at = ?3::timestamptz, updated_at = ?3::timestamptz
          WHERE session_id = ?1 AND user_id = ?2
          RETURNING ${SESSION_COLUMNS}`,
    args: [textToArg("sessionId", sessionId), textToArg("userId", userId), isoUtcToArg(endedAt)],
  });
  return res.rows[0] ? decodeAttendanceSession(res.rows[0]) : null;
}

export interface BookingLifecycleRepository {
  getBooking(bookingId: string): Promise<Booking | null>;
  getAttendanceSession(sessionId: string): Promise<AttendanceSession | null>;
  listAttendanceSessions(bookingId: string): Promise<AttendanceSession[]>;
  listAttendanceHeartbeats(sessionId: string): Promise<AttendanceHeartbeat[]>;
}

export interface BookingLifecycleWriteRepository extends BookingLifecycleRepository {
  startBookingSession(bookingId: string, updatedAt: string): Promise<Booking | null>;
  reserveBookingSettlementIntent(input: ReserveBookingSettlementIntentInput): Promise<Booking | null>;
  flagBookingSettlementDisputed(input: FlagBookingSettlementDisputedInput): Promise<Booking | null>;
  markBookingSettlementAmbiguous(input: MarkBookingSettlementAmbiguousInput): Promise<Booking | null>;
  resolveBookingSettlementReview(input: ResolveBookingSettlementReviewInput): Promise<Booking | null>;
  finalizeBookingSettlement(input: FinalizeBookingSettlementInput): Promise<Booking | null>;
  releaseBookingSlotLock(bookingId: string, updatedAt: string): Promise<HostSlotLock | null>;
  attachAttendanceSession(input: AttachAttendanceSessionInput): Promise<AttendanceSession | null>;
  setBookingLiveRoomIfUnset(bookingId: string, liveRoomId: string, updatedAt: string): Promise<Booking | null>;
  heartbeatAttendanceSession(input: HeartbeatAttendanceSessionInput): Promise<HeartbeatAttendanceSessionResult>;
  endAttendanceSession(sessionId: string, userId: string, endedAt: string): Promise<AttendanceSession | null>;
}

function buildRepository(executor: BookingLifecycleSqlExecutor): BookingLifecycleRepository {
  return {
    getBooking: (bookingId) => getBooking(executor, bookingId),
    getAttendanceSession: (sessionId) => getAttendanceSession(executor, sessionId),
    listAttendanceSessions: (bookingId) => listAttendanceSessions(executor, bookingId),
    listAttendanceHeartbeats: (sessionId) => listAttendanceHeartbeats(executor, sessionId),
  };
}

function buildWriteRepository(executor: BookingLifecycleSqlExecutor): BookingLifecycleWriteRepository {
  return {
    ...buildRepository(executor),
    startBookingSession: (bookingId, updatedAt) => startBookingSession(executor, bookingId, updatedAt),
    reserveBookingSettlementIntent: (input) => reserveBookingSettlementIntent(executor, input),
    flagBookingSettlementDisputed: (input) => flagBookingSettlementDisputed(executor, input),
    markBookingSettlementAmbiguous: (input) => markBookingSettlementAmbiguous(executor, input),
    resolveBookingSettlementReview: (input) => resolveBookingSettlementReview(executor, input),
    finalizeBookingSettlement: (input) => finalizeBookingSettlement(executor, input),
    releaseBookingSlotLock: (bookingId, updatedAt) => releaseBookingSlotLock(executor, bookingId, updatedAt),
    attachAttendanceSession: (input) => attachAttendanceSession(executor, input),
    setBookingLiveRoomIfUnset: (bookingId, liveRoomId, updatedAt) => setBookingLiveRoomIfUnset(executor, bookingId, liveRoomId, updatedAt),
    heartbeatAttendanceSession: (input) => heartbeatAttendanceSession(executor, input),
    endAttendanceSession: (sessionId, userId, endedAt) => endAttendanceSession(executor, sessionId, userId, endedAt),
  };
}

export function createBookingLifecycleRepository(
  executor: BookingLifecycleSqlExecutor,
): BookingLifecycleRepository {
  return buildRepository(executor);
}

export function createBookingLifecycleWriteRepository(
  executor: BookingLifecycleSqlExecutor,
): BookingLifecycleWriteRepository {
  return buildWriteRepository(executor);
}

export function createBookingLifecycleTxWriteRepository(
  tx: BookingLifecycleSqlExecutor,
): BookingLifecycleWriteRepository {
  return buildWriteRepository(tx);
}
