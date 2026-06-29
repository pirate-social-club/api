// Bounded repository for global bookings HOLDS + HOST SLOT LOCKS in the bookings.* Postgres schema.
//
// Boundary rules match the host-config repository:
//   - The caller supplies the executor/transaction; this module never opens clients or transactions.
//   - Every query is schema-qualified with explicit columns.
//   - Slot overlap correctness is enforced by Postgres. SQLSTATE 23P01 is mapped to slot-conflict.
import type { InStatement, QueryResult, QueryResultRow } from "../sql-client";
import {
  intFromRow, isoUtcFromRow, isoUtcFromRowNullable, isoUtcToArg, textFromRow, textFromRowNullable,
} from "./codecs";
import type { BookingHold, HostSlotLock } from "./types";

export interface BookingHoldSqlExecutor {
  execute(statement: InStatement | string): Promise<QueryResult>;
}

export interface CreateHostSlotLockInput {
  lockId: string;
  hostUserId: string;
  slotStartUtc: string;
  slotEndUtc: string;
  holdId?: string | null;
  bookingId?: string | null;
  status?: "active" | "released";
  sourceCommunityId?: string | null;
  expiresAtUtc?: string | null;
  createdAt: string;
  updatedAt?: string;
}

export interface CreateBookingHoldInput {
  holdId: string;
  hostUserId: string;
  bookerUserId: string;
  slotStartUtc: string;
  slotEndUtc: string;
  priceCents: number;
  status?: "active" | "consumed" | "expired";
  sourceCommunityId?: string | null;
  expiresAtUtc: string;
  createdAt: string;
  updatedAt?: string;
}

export interface CreateHoldWithSlotLockInput {
  nowUtc: string;
  lock: CreateHostSlotLockInput;
  hold: CreateBookingHoldInput;
}

export type SlotLockResult =
  | { ok: true; lock: HostSlotLock }
  | { ok: false; reason: "slot-conflict" };

export type CreateHoldWithSlotLockResult =
  | { ok: true; hold: BookingHold; lock: HostSlotLock }
  | { ok: false; reason: "slot-conflict" };

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

function lockStatusToArg(value: "active" | "released" | undefined): "active" | "released" {
  return value ?? "active";
}

function holdStatusToArg(value: "active" | "consumed" | "expired" | undefined): "active" | "consumed" | "expired" {
  return value ?? "active";
}

function isSlotConflict(error: unknown): boolean {
  let current: unknown = error;
  while (current && typeof current === "object") {
    const code = "code" in current ? String((current as { code?: unknown }).code) : "";
    if (code === "23P01") return true;
    current = "cause" in current ? (current as { cause?: unknown }).cause : null;
  }
  return false;
}

function decodeLockStatus(value: unknown): HostSlotLock["status"] {
  const status = textFromRow(value);
  if (status !== "active" && status !== "released") throw new TypeError(`decodeLockStatus: bad status ${status}`);
  return status;
}

function decodeHoldStatus(value: unknown): BookingHold["status"] {
  const status = textFromRow(value);
  if (status !== "active" && status !== "consumed" && status !== "expired") {
    throw new TypeError(`decodeHoldStatus: bad status ${status}`);
  }
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

function decodeBookingHold(row: QueryResultRow): BookingHold {
  return {
    holdId: textFromRow(row.hold_id),
    hostUserId: textFromRow(row.host_user_id),
    bookerUserId: textFromRow(row.booker_user_id),
    slotStartUtc: isoUtcFromRow(row.slot_start_utc),
    slotEndUtc: isoUtcFromRow(row.slot_end_utc),
    priceCents: intFromRow(row.price_cents),
    status: decodeHoldStatus(row.status),
    sourceCommunityId: textFromRowNullable(row.source_community_id),
    expiresAtUtc: isoUtcFromRow(row.expires_at_utc),
    createdAt: isoUtcFromRow(row.created_at),
    updatedAt: isoUtcFromRow(row.updated_at),
  };
}

const LOCK_COLUMNS =
  "lock_id, host_user_id, slot_start_utc, slot_end_utc, hold_id, booking_id, status, " +
  "source_community_id, expires_at_utc, created_at, updated_at";
const HOLD_COLUMNS =
  "hold_id, host_user_id, booker_user_id, slot_start_utc, slot_end_utc, price_cents, status, " +
  "source_community_id, expires_at_utc, created_at, updated_at";

async function advisoryLockHost(exec: BookingHoldSqlExecutor, hostUserId: string): Promise<void> {
  await exec.execute({
    sql: "SELECT pg_advisory_xact_lock(hashtextextended(?1, 0)) AS locked",
    args: [textToArg("hostUserId", hostUserId)],
  });
}

async function releaseExpiredSlotLocks(
  exec: BookingHoldSqlExecutor,
  hostUserId: string,
  nowUtc: string,
): Promise<HostSlotLock[]> {
  const res = await exec.execute({
    sql: `UPDATE bookings.host_slot_locks
          SET status = 'released', updated_at = ?2::timestamptz
          WHERE host_user_id = ?1 AND status = 'active'
            AND expires_at_utc IS NOT NULL AND expires_at_utc <= ?2::timestamptz
          RETURNING ${LOCK_COLUMNS}`,
    args: [textToArg("hostUserId", hostUserId), isoUtcToArg(nowUtc)],
  });
  return res.rows.map(decodeHostSlotLock);
}

async function createSlotLock(
  exec: BookingHoldSqlExecutor,
  input: CreateHostSlotLockInput,
): Promise<SlotLockResult> {
  const createdAt = isoUtcToArg(input.createdAt);
  const updatedAt = isoUtcToArg(input.updatedAt ?? input.createdAt);
  try {
    const res = await exec.execute({
      sql: `INSERT INTO bookings.host_slot_locks (
              lock_id, host_user_id, slot_start_utc, slot_end_utc, hold_id, booking_id, status,
              source_community_id, expires_at_utc, created_at, updated_at
            ) VALUES (?1, ?2, ?3::timestamptz, ?4::timestamptz, ?5, ?6, ?7, ?8, ?9::timestamptz, ?10::timestamptz, ?11::timestamptz)
            ON CONFLICT ON CONSTRAINT bookings_host_slot_locks_no_overlap DO NOTHING
            RETURNING ${LOCK_COLUMNS}`,
      args: [
        textToArg("lockId", input.lockId),
        textToArg("hostUserId", input.hostUserId),
        isoUtcToArg(input.slotStartUtc),
        isoUtcToArg(input.slotEndUtc),
        nullableTextToArg("holdId", input.holdId),
        nullableTextToArg("bookingId", input.bookingId),
        lockStatusToArg(input.status),
        nullableTextToArg("sourceCommunityId", input.sourceCommunityId),
        input.expiresAtUtc === null || input.expiresAtUtc === undefined ? null : isoUtcToArg(input.expiresAtUtc),
        createdAt,
        updatedAt,
      ],
    });
    const row = res.rows[0];
    return row ? { ok: true, lock: decodeHostSlotLock(row) } : { ok: false, reason: "slot-conflict" };
  } catch (error) {
    if (isSlotConflict(error)) return { ok: false, reason: "slot-conflict" };
    throw error;
  }
}

async function getSlotLock(exec: BookingHoldSqlExecutor, lockId: string): Promise<HostSlotLock | null> {
  const res = await exec.execute({
    sql: `SELECT ${LOCK_COLUMNS} FROM bookings.host_slot_locks WHERE lock_id = ?1`,
    args: [textToArg("lockId", lockId)],
  });
  return res.rows[0] ? decodeHostSlotLock(res.rows[0]) : null;
}

async function getActiveSlotLockByHold(exec: BookingHoldSqlExecutor, holdId: string): Promise<HostSlotLock | null> {
  const res = await exec.execute({
    sql: `SELECT ${LOCK_COLUMNS} FROM bookings.host_slot_locks WHERE hold_id = ?1 AND status = 'active' ORDER BY created_at ASC, lock_id ASC LIMIT 1`,
    args: [textToArg("holdId", holdId)],
  });
  return res.rows[0] ? decodeHostSlotLock(res.rows[0]) : null;
}

async function releaseSlotLock(exec: BookingHoldSqlExecutor, lockId: string, updatedAt: string): Promise<HostSlotLock | null> {
  const res = await exec.execute({
    sql: `UPDATE bookings.host_slot_locks SET status = 'released', updated_at = ?2::timestamptz
          WHERE lock_id = ?1
          RETURNING ${LOCK_COLUMNS}`,
    args: [textToArg("lockId", lockId), isoUtcToArg(updatedAt)],
  });
  return res.rows[0] ? decodeHostSlotLock(res.rows[0]) : null;
}

async function releaseSlotLockByHold(
  exec: BookingHoldSqlExecutor,
  holdId: string,
  updatedAt: string,
): Promise<HostSlotLock | null> {
  const res = await exec.execute({
    sql: `UPDATE bookings.host_slot_locks SET status = 'released', updated_at = ?2::timestamptz
          WHERE hold_id = ?1 AND status = 'active'
          RETURNING ${LOCK_COLUMNS}`,
    args: [textToArg("holdId", holdId), isoUtcToArg(updatedAt)],
  });
  return res.rows[0] ? decodeHostSlotLock(res.rows[0]) : null;
}

async function makeSlotLockPermanent(
  exec: BookingHoldSqlExecutor,
  holdId: string,
  bookingId: string,
  updatedAt: string,
): Promise<HostSlotLock | null> {
  const res = await exec.execute({
    sql: `UPDATE bookings.host_slot_locks
          SET booking_id = ?2, expires_at_utc = NULL, updated_at = ?3::timestamptz
          WHERE hold_id = ?1 AND status = 'active'
          RETURNING ${LOCK_COLUMNS}`,
    args: [textToArg("holdId", holdId), textToArg("bookingId", bookingId), isoUtcToArg(updatedAt)],
  });
  return res.rows[0] ? decodeHostSlotLock(res.rows[0]) : null;
}

async function createHold(exec: BookingHoldSqlExecutor, input: CreateBookingHoldInput): Promise<BookingHold> {
  const createdAt = isoUtcToArg(input.createdAt);
  const updatedAt = isoUtcToArg(input.updatedAt ?? input.createdAt);
  const res = await exec.execute({
    sql: `INSERT INTO bookings.holds (
            hold_id, host_user_id, booker_user_id, slot_start_utc, slot_end_utc, price_cents, status,
            source_community_id, expires_at_utc, created_at, updated_at
          ) VALUES (?1, ?2, ?3, ?4::timestamptz, ?5::timestamptz, ?6, ?7, ?8, ?9::timestamptz, ?10::timestamptz, ?11::timestamptz)
          RETURNING ${HOLD_COLUMNS}`,
    args: [
      textToArg("holdId", input.holdId),
      textToArg("hostUserId", input.hostUserId),
      textToArg("bookerUserId", input.bookerUserId),
      isoUtcToArg(input.slotStartUtc),
      isoUtcToArg(input.slotEndUtc),
      intToArg("priceCents", input.priceCents),
      holdStatusToArg(input.status),
      nullableTextToArg("sourceCommunityId", input.sourceCommunityId),
      isoUtcToArg(input.expiresAtUtc),
      createdAt,
      updatedAt,
    ],
  });
  return decodeBookingHold(res.rows[0]);
}

async function getHold(exec: BookingHoldSqlExecutor, holdId: string): Promise<BookingHold | null> {
  const res = await exec.execute({
    sql: `SELECT ${HOLD_COLUMNS} FROM bookings.holds WHERE hold_id = ?1`,
    args: [textToArg("holdId", holdId)],
  });
  return res.rows[0] ? decodeBookingHold(res.rows[0]) : null;
}

async function updateHoldStatus(
  exec: BookingHoldSqlExecutor,
  holdId: string,
  fromStatus: BookingHold["status"],
  toStatus: BookingHold["status"],
  updatedAt: string,
): Promise<BookingHold | null> {
  const res = await exec.execute({
    sql: `UPDATE bookings.holds SET status = ?3, updated_at = ?4::timestamptz
          WHERE hold_id = ?1 AND status = ?2
          RETURNING ${HOLD_COLUMNS}`,
    args: [
      textToArg("holdId", holdId),
      holdStatusToArg(fromStatus),
      holdStatusToArg(toStatus),
      isoUtcToArg(updatedAt),
    ],
  });
  return res.rows[0] ? decodeBookingHold(res.rows[0]) : null;
}

async function expireDueHolds(exec: BookingHoldSqlExecutor, nowUtc: string): Promise<BookingHold[]> {
  const res = await exec.execute({
    sql: `UPDATE bookings.holds SET status = 'expired', updated_at = ?1::timestamptz
          WHERE status = 'active' AND expires_at_utc <= ?1::timestamptz
          RETURNING ${HOLD_COLUMNS}`,
    args: [isoUtcToArg(nowUtc)],
  });
  return res.rows.map(decodeBookingHold);
}

async function createHoldWithSlotLock(
  exec: BookingHoldSqlExecutor,
  input: CreateHoldWithSlotLockInput,
): Promise<CreateHoldWithSlotLockResult> {
  await advisoryLockHost(exec, input.lock.hostUserId);
  await releaseExpiredSlotLocks(exec, input.lock.hostUserId, input.nowUtc);
  const lock = await createSlotLock(exec, input.lock);
  if (!lock.ok) return lock;
  const hold = await createHold(exec, input.hold);
  return { ok: true, lock: lock.lock, hold };
}

export interface BookingHoldRepository {
  getHold(holdId: string): Promise<BookingHold | null>;
  getSlotLock(lockId: string): Promise<HostSlotLock | null>;
  getActiveSlotLockByHold(holdId: string): Promise<HostSlotLock | null>;
}

export interface BookingHoldWriteRepository extends BookingHoldRepository {
  advisoryLockHost(hostUserId: string): Promise<void>;
  releaseExpiredSlotLocks(hostUserId: string, nowUtc: string): Promise<HostSlotLock[]>;
  createSlotLock(input: CreateHostSlotLockInput): Promise<SlotLockResult>;
  releaseSlotLock(lockId: string, updatedAt: string): Promise<HostSlotLock | null>;
  releaseSlotLockByHold(holdId: string, updatedAt: string): Promise<HostSlotLock | null>;
  makeSlotLockPermanent(holdId: string, bookingId: string, updatedAt: string): Promise<HostSlotLock | null>;
  createHold(input: CreateBookingHoldInput): Promise<BookingHold>;
  consumeHold(holdId: string, updatedAt: string): Promise<BookingHold | null>;
  expireHold(holdId: string, updatedAt: string): Promise<BookingHold | null>;
  expireDueHolds(nowUtc: string): Promise<BookingHold[]>;
  createHoldWithSlotLock(input: CreateHoldWithSlotLockInput): Promise<CreateHoldWithSlotLockResult>;
}

function buildRepository(executor: BookingHoldSqlExecutor): BookingHoldRepository {
  return {
    getHold: (holdId) => getHold(executor, holdId),
    getSlotLock: (lockId) => getSlotLock(executor, lockId),
    getActiveSlotLockByHold: (holdId) => getActiveSlotLockByHold(executor, holdId),
  };
}

function buildWriteRepository(executor: BookingHoldSqlExecutor): BookingHoldWriteRepository {
  return {
    ...buildRepository(executor),
    advisoryLockHost: (hostUserId) => advisoryLockHost(executor, hostUserId),
    releaseExpiredSlotLocks: (hostUserId, nowUtc) => releaseExpiredSlotLocks(executor, hostUserId, nowUtc),
    createSlotLock: (input) => createSlotLock(executor, input),
    releaseSlotLock: (lockId, updatedAt) => releaseSlotLock(executor, lockId, updatedAt),
    releaseSlotLockByHold: (holdId, updatedAt) => releaseSlotLockByHold(executor, holdId, updatedAt),
    makeSlotLockPermanent: (holdId, bookingId, updatedAt) => makeSlotLockPermanent(executor, holdId, bookingId, updatedAt),
    createHold: (input) => createHold(executor, input),
    consumeHold: (holdId, updatedAt) => updateHoldStatus(executor, holdId, "active", "consumed", updatedAt),
    expireHold: (holdId, updatedAt) => updateHoldStatus(executor, holdId, "active", "expired", updatedAt),
    expireDueHolds: (nowUtc) => expireDueHolds(executor, nowUtc),
    createHoldWithSlotLock: (input) => createHoldWithSlotLock(executor, input),
  };
}

export function createBookingHoldRepository(executor: BookingHoldSqlExecutor): BookingHoldRepository {
  return buildRepository(executor);
}

export function createBookingHoldWriteRepository(executor: BookingHoldSqlExecutor): BookingHoldWriteRepository {
  return buildWriteRepository(executor);
}

export function createBookingHoldTxWriteRepository(tx: BookingHoldSqlExecutor): BookingHoldWriteRepository {
  return buildWriteRepository(tx);
}
