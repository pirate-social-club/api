// Bounded repository for global bookings PAYMENT INTENTS in the bookings.* Postgres schema.
//
// The repository owns durable row/CAS semantics only. Checkout config derivation, payment verification,
// and booking finalization policy stay outside this module.
import type { InStatement, QueryResult, QueryResultRow } from "../sql-client";
import {
  atomicFromRow, atomicFromRowNullable, atomicToArg, boolFromRow, intFromRow, isoUtcFromRow, isoUtcFromRowNullable, isoUtcToArg,
  textFromRow, textFromRowNullable,
} from "./codecs";
import type { PaymentIntent, PaymentIntentStatus } from "./types";

export interface PaymentIntentSqlExecutor {
  execute(statement: InStatement | string): Promise<QueryResult>;
}

export interface CreatePaymentIntentInput {
  holdId: string;
  paymentIntentId?: string;
  chainId: number;
  tokenAddress: string;
  tokenDecimals: number;
  tokenSymbol: string;
  recipientAddress: string;
  amountAtomic: string;
  grossCents: number;
  quoteExpiresAt: string;
  holdExpiresAt: string;
  walletAttachmentRequired?: boolean;
  platformFeeBps: number;
  platformFeeCents: number;
  hostPayoutCents: number;
  createdAt: string;
  updatedAt?: string;
}

export interface ReservePaymentIntentInput {
  paymentIntentId: string;
  claimToken: string;
  claimExpiresAt: string;
  normalizedTxRef: string;
  walletAttachmentId: string;
  nowUtc: string;
}

interface ClaimPaymentIntentInput {
  paymentIntentId: string;
  claimToken: string;
  nowUtc: string;
}

interface VerifyPaymentIntentInput extends ClaimPaymentIntentInput {
  verifiedSenderAddress: string;
}

export interface MarkCustodyRefundPendingInput extends ClaimPaymentIntentInput {
  observedAmountAtomic: string;
  senderAddress: string;
  reason: "wrong_transfer_amount" | "unexpected_sender";
}

export interface MarkCustodyOperatorIncidentInput extends ClaimPaymentIntentInput {
  transfers: Array<{
    senderAddress: string;
    observedAmountAtomic: string;
    transferCount: number;
  }>;
}

type CreateOrGetPaymentIntentResult =
  | { ok: true; intent: PaymentIntent }
  | { ok: false; reason: "replay-conflict" };

export type ReservePaymentIntentResult =
  | { ok: true; intent: PaymentIntent }
  | { ok: false; reason: "not-reservable" | "reused-tx" };

export interface PendingPaymentIntentRecord {
  intent: PaymentIntent;
  hostUserId: string;
  bookerUserId: string;
  slotStartUtc: string;
  slotEndUtc: string;
  holdStatus: "active" | "consumed" | "expired";
  bookingId: string | null;
}

export interface ClaimedUnresolvedPaymentIntentRecord {
  intent: PaymentIntent;
  hostUserId: string;
  bookerUserId: string;
  holdStatus: "active" | "consumed" | "expired";
}

export function paymentIntentIdForHold(holdId: string): string {
  return `bpi_${holdId}`;
}

export function normalizeTxRef(txRef: string): string {
  return txRef.trim().toLowerCase();
}

function textToArg(label: string, value: string): string {
  if (typeof value !== "string") throw new TypeError(`${label}: expected string`);
  return value;
}

function intToArg(label: string, value: number): number {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${label}: expected a safe integer`);
  return value;
}

function boolToArg(label: string, value: boolean): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${label}: expected boolean`);
  return value;
}

function canonicalIso(value: string): string {
  return isoUtcFromRow(isoUtcToArg(value));
}

function isUniqueConflict(error: unknown): boolean {
  let current: unknown = error;
  while (current && typeof current === "object") {
    const code = "code" in current ? String((current as { code?: unknown }).code) : "";
    if (code === "23505") return true;
    current = "cause" in current ? (current as { cause?: unknown }).cause : null;
  }
  const message = String((error as { message?: unknown })?.message ?? error).toLowerCase();
  return message.includes("unique") || message.includes("duplicate key");
}

function decodeStatus(value: unknown): PaymentIntentStatus {
  const status = textFromRow(value);
  if (
    status !== "active" &&
    status !== "verifying" &&
    status !== "verified" &&
    status !== "verification_failed" &&
    status !== "verification_rejected" &&
    status !== "custody_refund_pending" &&
    status !== "custody_operator_incident" &&
    status !== "consumed" &&
    status !== "expired" &&
    status !== "refunded" &&
    status !== "superseded"
  ) {
    throw new TypeError(`decodeStatus: bad status ${status}`);
  }
  return status;
}

function decodePaymentIntent(row: QueryResultRow): PaymentIntent {
  return {
    paymentIntentId: textFromRow(row.payment_intent_id),
    holdId: textFromRow(row.hold_id),
    version: intFromRow(row.version),
    chainId: intFromRow(row.chain_id),
    tokenAddress: textFromRow(row.token_address),
    tokenDecimals: intFromRow(row.token_decimals),
    tokenSymbol: textFromRow(row.token_symbol),
    recipientAddress: textFromRow(row.recipient_address),
    amountAtomic: atomicFromRow(row.amount_atomic),
    grossCents: intFromRow(row.gross_cents),
    quoteExpiresAt: isoUtcFromRow(row.quote_expires_at),
    holdExpiresAt: isoUtcFromRow(row.hold_expires_at),
    walletAttachmentRequired: boolFromRow(row.wallet_attachment_required),
    platformFeeBps: intFromRow(row.platform_fee_bps),
    platformFeeCents: intFromRow(row.platform_fee_cents),
    hostPayoutCents: intFromRow(row.host_payout_cents),
    status: decodeStatus(row.status),
    verificationClaimToken: textFromRowNullable(row.verification_claim_token),
    verificationClaimExpiresAt: isoUtcFromRowNullable(row.verification_claim_expires_at),
    claimedTxRef: textFromRowNullable(row.claimed_tx_ref),
    verifiedSenderAddress: textFromRowNullable(row.verified_sender_address),
    verifiedAt: isoUtcFromRowNullable(row.verified_at),
    consumedWalletAttachmentId: textFromRowNullable(row.consumed_wallet_attachment_id),
    consumedAt: isoUtcFromRowNullable(row.consumed_at),
    custodyObservedAmountAtomic: atomicFromRowNullable(row.custody_observed_amount_atomic),
    custodySenderAddress: textFromRowNullable(row.custody_sender_address),
    custodyReason: (() => {
      const reason = textFromRowNullable(row.custody_reason);
      if (
        reason !== null
        && reason !== "wrong_transfer_amount"
        && reason !== "unexpected_sender"
        && reason !== "multiple_senders"
      ) {
        throw new TypeError(`decodePaymentIntent: bad custody reason ${reason}`);
      }
      return reason;
    })(),
    custodyEvidence: (() => {
      const value = row.custody_evidence_json;
      if (value == null) return null;
      const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
      if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { transfers?: unknown }).transfers)) {
        throw new TypeError("decodePaymentIntent: bad custody evidence");
      }
      const transfers = (parsed as { transfers: unknown[] }).transfers.map((entry) => {
        if (!entry || typeof entry !== "object") throw new TypeError("decodePaymentIntent: bad custody transfer");
        const transfer = entry as Record<string, unknown>;
        if (
          typeof transfer.sender_address !== "string"
          || typeof transfer.observed_amount_atomic !== "string"
          || !Number.isSafeInteger(transfer.transfer_count)
        ) {
          throw new TypeError("decodePaymentIntent: bad custody transfer");
        }
        return {
          senderAddress: transfer.sender_address,
          observedAmountAtomic: transfer.observed_amount_atomic,
          transferCount: transfer.transfer_count as number,
        };
      });
      return { transfers };
    })(),
    custodyDetectedAt: isoUtcFromRowNullable(row.custody_detected_at),
    refundTxRef: textFromRowNullable(row.refund_tx_ref),
    refundAttemptCount: intFromRow(row.refund_attempt_count),
    refundLastAttemptAt: isoUtcFromRowNullable(row.refund_last_attempt_at),
    refundLastErrorCode: textFromRowNullable(row.refund_last_error_code),
    refundedAt: isoUtcFromRowNullable(row.refunded_at),
    createdAt: isoUtcFromRow(row.created_at),
    updatedAt: isoUtcFromRow(row.updated_at),
  };
}

const COLUMNS =
  "payment_intent_id, hold_id, version, chain_id, token_address, token_decimals, token_symbol, " +
  "recipient_address, amount_atomic, gross_cents, quote_expires_at, hold_expires_at, wallet_attachment_required, " +
  "platform_fee_bps, platform_fee_cents, host_payout_cents, status, verification_claim_token, " +
  "verification_claim_expires_at, claimed_tx_ref, verified_sender_address, verified_at, " +
  "consumed_wallet_attachment_id, consumed_at, custody_observed_amount_atomic, custody_sender_address, " +
  "custody_reason, custody_evidence_json, custody_detected_at, refund_tx_ref, refund_attempt_count, " +
  "refund_last_attempt_at, refund_last_error_code, refunded_at, created_at, updated_at";

function matchesReplay(input: Required<CreatePaymentIntentInput>, row: PaymentIntent): boolean {
  return (
    row.paymentIntentId === input.paymentIntentId &&
    row.holdId === input.holdId &&
    row.chainId === input.chainId &&
    row.tokenAddress === input.tokenAddress &&
    row.tokenDecimals === input.tokenDecimals &&
    row.tokenSymbol === input.tokenSymbol &&
    row.recipientAddress === input.recipientAddress &&
    row.amountAtomic === atomicToArg(input.amountAtomic) &&
    row.grossCents === input.grossCents &&
    row.quoteExpiresAt === canonicalIso(input.quoteExpiresAt) &&
    row.holdExpiresAt === canonicalIso(input.holdExpiresAt) &&
    row.walletAttachmentRequired === input.walletAttachmentRequired
  );
}

function normalizeCreateInput(input: CreatePaymentIntentInput): Required<CreatePaymentIntentInput> {
  const paymentIntentId = input.paymentIntentId ?? paymentIntentIdForHold(input.holdId);
  return {
    ...input,
    paymentIntentId,
    walletAttachmentRequired: input.walletAttachmentRequired ?? true,
    updatedAt: input.updatedAt ?? input.createdAt,
  };
}

async function getPaymentIntent(
  exec: PaymentIntentSqlExecutor,
  paymentIntentId: string,
): Promise<PaymentIntent | null> {
  const res = await exec.execute({
    sql: `SELECT ${COLUMNS} FROM bookings.payment_intents WHERE payment_intent_id = ?1`,
    args: [textToArg("paymentIntentId", paymentIntentId)],
  });
  return res.rows[0] ? decodePaymentIntent(res.rows[0]) : null;
}

async function getPaymentIntentByHold(exec: PaymentIntentSqlExecutor, holdId: string): Promise<PaymentIntent | null> {
  const res = await exec.execute({
    sql: `SELECT ${COLUMNS} FROM bookings.payment_intents WHERE hold_id = ?1`,
    args: [textToArg("holdId", holdId)],
  });
  return res.rows[0] ? decodePaymentIntent(res.rows[0]) : null;
}

// Paid-but-expired orphans: a verified on-chain payment whose hold window has closed and which was never
// consumed into a booking. These hold real custody funds owed back to the payer. `olderThanUtc` should be
// now minus a small grace so freshly-verified intents mid-confirm are not misread as orphans.
async function listOrphanedVerifiedPaymentIntents(
  exec: PaymentIntentSqlExecutor,
  olderThanUtc: string,
  limit: number,
): Promise<PaymentIntent[]> {
  const res = await exec.execute({
    sql: `SELECT ${COLUMNS} FROM bookings.payment_intents
          WHERE status = 'verified' AND hold_expires_at <= ?1::timestamptz
          ORDER BY updated_at ASC, payment_intent_id ASC
          LIMIT ?2`,
    args: [isoUtcToArg(olderThanUtc), intToArg("limit", limit)],
  });
  return res.rows.map(decodePaymentIntent);
}

async function listRecentPaymentIntentsForBooker(
  exec: PaymentIntentSqlExecutor,
  bookerUserId: string,
  createdSinceUtc: string,
  limit: number,
): Promise<PendingPaymentIntentRecord[]> {
  const res = await exec.execute({
    sql: `SELECT ${COLUMNS.split(", ").map((column) => `pi.${column}`).join(", ")},
                 h.host_user_id, h.booker_user_id, h.slot_start_utc, h.slot_end_utc,
                 h.status AS hold_status, b.booking_id
          FROM bookings.payment_intents pi
          JOIN bookings.holds h ON h.hold_id = pi.hold_id
          LEFT JOIN bookings.bookings b ON b.hold_id = h.hold_id
          WHERE h.booker_user_id = ?1
            AND pi.created_at >= ?2::timestamptz
            AND pi.status IN ('active', 'verifying', 'verified', 'verification_failed', 'custody_refund_pending', 'consumed')
          ORDER BY pi.updated_at DESC, pi.payment_intent_id DESC
          LIMIT ?3`,
    args: [
      textToArg("bookerUserId", bookerUserId),
      isoUtcToArg(createdSinceUtc),
      intToArg("limit", limit),
    ],
  });
  return res.rows.map((row) => {
    const holdStatus = textFromRow(row.hold_status);
    if (holdStatus !== "active" && holdStatus !== "consumed" && holdStatus !== "expired") {
      throw new TypeError(`listRecentPaymentIntentsForBooker: bad hold status ${holdStatus}`);
    }
    return {
      intent: decodePaymentIntent(row),
      hostUserId: textFromRow(row.host_user_id),
      bookerUserId: textFromRow(row.booker_user_id),
      slotStartUtc: isoUtcFromRow(row.slot_start_utc),
      slotEndUtc: isoUtcFromRow(row.slot_end_utc),
      holdStatus,
      bookingId: textFromRowNullable(row.booking_id),
    };
  });
}

export function paymentIntentReclaimablePredicate(
  tableAlias: string,
  nowPlaceholder: string,
): string {
  const prefix = tableAlias ? `${tableAlias}.` : "";
  return `(${prefix}status = 'verification_failed' OR (${prefix}status = 'verifying' AND ${prefix}verification_claim_expires_at <= ${nowPlaceholder}::timestamptz))`;
}

async function listClaimedUnresolvedPaymentIntents(
  exec: PaymentIntentSqlExecutor,
  nowUtc: string,
  limit: number,
): Promise<ClaimedUnresolvedPaymentIntentRecord[]> {
  const reclaimable = paymentIntentReclaimablePredicate("pi", "?1");
  const res = await exec.execute({
    sql: `SELECT ${COLUMNS.split(", ").map((column) => `pi.${column}`).join(", ")},
                 h.host_user_id, h.booker_user_id, h.status AS hold_status
          FROM bookings.payment_intents pi
          JOIN bookings.holds h ON h.hold_id = pi.hold_id
          WHERE (${reclaimable} OR (pi.status = 'verified' AND pi.consumed_at IS NULL))
            AND pi.claimed_tx_ref IS NOT NULL
            AND pi.consumed_wallet_attachment_id IS NOT NULL
          ORDER BY pi.updated_at ASC, pi.payment_intent_id ASC
          LIMIT ?2`,
    args: [isoUtcToArg(nowUtc), intToArg("limit", limit)],
  });
  return res.rows.map((row) => {
    const holdStatus = textFromRow(row.hold_status);
    if (holdStatus !== "active" && holdStatus !== "consumed" && holdStatus !== "expired") {
      throw new TypeError(`listClaimedUnresolvedPaymentIntents: bad hold status ${holdStatus}`);
    }
    return {
      intent: decodePaymentIntent(row),
      hostUserId: textFromRow(row.host_user_id),
      bookerUserId: textFromRow(row.booker_user_id),
      holdStatus,
    };
  });
}

async function listOperatorUnresolvedPaymentIntents(
  exec: PaymentIntentSqlExecutor,
  nowUtc: string,
  limit: number,
): Promise<ClaimedUnresolvedPaymentIntentRecord[]> {
  const reclaimable = paymentIntentReclaimablePredicate("pi", "?1");
  const res = await exec.execute({
    sql: `SELECT ${COLUMNS.split(", ").map((column) => `pi.${column}`).join(", ")},
                 h.host_user_id, h.booker_user_id, h.status AS hold_status
          FROM bookings.payment_intents pi
          JOIN bookings.holds h ON h.hold_id = pi.hold_id
          WHERE (${reclaimable}
                 OR (pi.status = 'verified' AND pi.consumed_at IS NULL)
                 OR pi.status IN ('custody_refund_pending', 'custody_operator_incident'))
            AND pi.claimed_tx_ref IS NOT NULL
            AND pi.consumed_wallet_attachment_id IS NOT NULL
          ORDER BY pi.updated_at ASC, pi.payment_intent_id ASC
          LIMIT ?2`,
    args: [isoUtcToArg(nowUtc), intToArg("limit", limit)],
  });
  return res.rows.map((row) => {
    const holdStatus = textFromRow(row.hold_status);
    if (holdStatus !== "active" && holdStatus !== "consumed" && holdStatus !== "expired") {
      throw new TypeError(`listOperatorUnresolvedPaymentIntents: bad hold status ${holdStatus}`);
    }
    return {
      intent: decodePaymentIntent(row),
      hostUserId: textFromRow(row.host_user_id),
      bookerUserId: textFromRow(row.booker_user_id),
      holdStatus,
    };
  });
}

async function listCustodyRefundPendingPaymentIntents(
  exec: PaymentIntentSqlExecutor,
  limit: number,
): Promise<PaymentIntent[]> {
  const res = await exec.execute({
    sql: `SELECT ${COLUMNS} FROM bookings.payment_intents
          WHERE status = 'custody_refund_pending'
          ORDER BY COALESCE(refund_last_attempt_at, custody_detected_at) ASC,
                   custody_detected_at ASC,
                   payment_intent_id ASC
          LIMIT ?1`,
    args: [intToArg("limit", limit)],
  });
  return res.rows.map(decodePaymentIntent);
}

async function markOrphanedVerifiedPaymentIntentRefunded(
  exec: PaymentIntentSqlExecutor,
  paymentIntentId: string,
  refundTxRef: string,
  nowUtc: string,
): Promise<PaymentIntent | null> {
  const res = await exec.execute({
    sql: `UPDATE bookings.payment_intents
          SET status = 'refunded',
              refund_tx_ref = ?2,
              refunded_at = ?3::timestamptz,
              version = version + 1,
              updated_at = ?3::timestamptz
          WHERE payment_intent_id = ?1
            AND status = 'verified'
            AND consumed_at IS NULL
          RETURNING ${COLUMNS}`,
    args: [
      textToArg("paymentIntentId", paymentIntentId),
      textToArg("refundTxRef", normalizeTxRef(refundTxRef)),
      isoUtcToArg(nowUtc),
    ],
  });
  return res.rows[0] ? decodePaymentIntent(res.rows[0]) : null;
}

async function markCustodyRefundPaymentIntentRefunded(
  exec: PaymentIntentSqlExecutor,
  paymentIntentId: string,
  refundTxRef: string,
  nowUtc: string,
): Promise<PaymentIntent | null> {
  const normalizedRefundTxRef = normalizeTxRef(refundTxRef);
  const res = await exec.execute({
    sql: `UPDATE bookings.payment_intents
          SET status = 'refunded',
              refund_tx_ref = ?2,
              refunded_at = ?3::timestamptz,
              refund_last_attempt_at = ?3::timestamptz,
              refund_last_error_code = NULL,
              version = version + 1,
              updated_at = ?3::timestamptz
          WHERE payment_intent_id = ?1
            AND status = 'custody_refund_pending'
            AND (refund_tx_ref IS NULL OR refund_tx_ref = ?2)
          RETURNING ${COLUMNS}`,
    args: [
      textToArg("paymentIntentId", paymentIntentId),
      textToArg("refundTxRef", normalizedRefundTxRef),
      isoUtcToArg(nowUtc),
    ],
  });
  return res.rows[0] ? decodePaymentIntent(res.rows[0]) : null;
}

async function recordCustodyRefundAttemptFailure(
  exec: PaymentIntentSqlExecutor,
  paymentIntentId: string,
  errorCode: string,
  nowUtc: string,
): Promise<PaymentIntent | null> {
  const res = await exec.execute({
    sql: `UPDATE bookings.payment_intents
          SET refund_attempt_count = refund_attempt_count + 1,
              refund_last_attempt_at = ?3::timestamptz,
              refund_last_error_code = ?2,
              version = version + 1,
              updated_at = ?3::timestamptz
          WHERE payment_intent_id = ?1 AND status = 'custody_refund_pending'
          RETURNING ${COLUMNS}`,
    args: [
      textToArg("paymentIntentId", paymentIntentId),
      textToArg("errorCode", errorCode.slice(0, 200)),
      isoUtcToArg(nowUtc),
    ],
  });
  return res.rows[0] ? decodePaymentIntent(res.rows[0]) : null;
}

async function createOrGetPaymentIntent(
  exec: PaymentIntentSqlExecutor,
  rawInput: CreatePaymentIntentInput,
): Promise<CreateOrGetPaymentIntentResult> {
  const input = normalizeCreateInput(rawInput);
  try {
    await exec.execute({
      sql: `INSERT INTO bookings.payment_intents (
              payment_intent_id, hold_id, version, chain_id, token_address, token_decimals, token_symbol,
              recipient_address, amount_atomic, gross_cents, quote_expires_at, hold_expires_at,
              wallet_attachment_required, platform_fee_bps, platform_fee_cents, host_payout_cents,
              status, created_at, updated_at
            ) VALUES (
              ?1, ?2, 1, ?3, ?4, ?5, ?6, ?7, ?8::numeric, ?9, ?10::timestamptz, ?11::timestamptz,
              ?12, ?13, ?14, ?15, 'active', ?16::timestamptz, ?17::timestamptz
            )
            ON CONFLICT (payment_intent_id) DO NOTHING`,
      args: [
        textToArg("paymentIntentId", input.paymentIntentId),
        textToArg("holdId", input.holdId),
        intToArg("chainId", input.chainId),
        textToArg("tokenAddress", input.tokenAddress),
        intToArg("tokenDecimals", input.tokenDecimals),
        textToArg("tokenSymbol", input.tokenSymbol),
        textToArg("recipientAddress", input.recipientAddress),
        atomicToArg(input.amountAtomic),
        intToArg("grossCents", input.grossCents),
        isoUtcToArg(input.quoteExpiresAt),
        isoUtcToArg(input.holdExpiresAt),
        boolToArg("walletAttachmentRequired", input.walletAttachmentRequired),
        intToArg("platformFeeBps", input.platformFeeBps),
        intToArg("platformFeeCents", input.platformFeeCents),
        intToArg("hostPayoutCents", input.hostPayoutCents),
        isoUtcToArg(input.createdAt),
        isoUtcToArg(input.updatedAt),
      ],
    });
  } catch (error) {
    if (isUniqueConflict(error)) return { ok: false, reason: "replay-conflict" };
    throw error;
  }
  const intent = await getPaymentIntent(exec, input.paymentIntentId);
  if (!intent) return { ok: false, reason: "replay-conflict" };
  if (!matchesReplay(input, intent)) return { ok: false, reason: "replay-conflict" };
  return { ok: true, intent };
}

async function reservePaymentIntentForVerification(
  exec: PaymentIntentSqlExecutor,
  input: ReservePaymentIntentInput,
): Promise<ReservePaymentIntentResult> {
  const reclaimable = paymentIntentReclaimablePredicate("", "?6");
  try {
    const res = await exec.execute({
      sql: `UPDATE bookings.payment_intents
            SET status = 'verifying',
                verification_claim_token = ?2,
                verification_claim_expires_at = ?3::timestamptz,
                claimed_tx_ref = ?4,
                consumed_wallet_attachment_id = ?5,
                version = version + 1,
                updated_at = ?6::timestamptz
            WHERE payment_intent_id = ?1
              AND (status = 'active' OR ${reclaimable})
              AND (claimed_tx_ref IS NULL OR claimed_tx_ref = ?4)
              AND (consumed_wallet_attachment_id IS NULL OR consumed_wallet_attachment_id = ?5)
            RETURNING ${COLUMNS}`,
      args: [
        textToArg("paymentIntentId", input.paymentIntentId),
        textToArg("claimToken", input.claimToken),
        isoUtcToArg(input.claimExpiresAt),
        textToArg("normalizedTxRef", input.normalizedTxRef),
        textToArg("walletAttachmentId", input.walletAttachmentId),
        isoUtcToArg(input.nowUtc),
      ],
    });
    return res.rows[0] ? { ok: true, intent: decodePaymentIntent(res.rows[0]) } : { ok: false, reason: "not-reservable" };
  } catch (error) {
    if (isUniqueConflict(error)) return { ok: false, reason: "reused-tx" };
    throw error;
  }
}

async function markPaymentIntentVerified(
  exec: PaymentIntentSqlExecutor,
  input: VerifyPaymentIntentInput,
): Promise<PaymentIntent | null> {
  const res = await exec.execute({
    sql: `UPDATE bookings.payment_intents
          SET status = 'verified',
              verified_sender_address = ?3,
              verified_at = ?4::timestamptz,
              verification_claim_token = NULL,
              verification_claim_expires_at = NULL,
              version = version + 1,
              updated_at = ?4::timestamptz
          WHERE payment_intent_id = ?1 AND status = 'verifying' AND verification_claim_token = ?2
          RETURNING ${COLUMNS}`,
    args: [
      textToArg("paymentIntentId", input.paymentIntentId),
      textToArg("claimToken", input.claimToken),
      textToArg("verifiedSenderAddress", input.verifiedSenderAddress),
      isoUtcToArg(input.nowUtc),
    ],
  });
  return res.rows[0] ? decodePaymentIntent(res.rows[0]) : null;
}

async function markPaymentIntentVerificationFailed(
  exec: PaymentIntentSqlExecutor,
  input: ClaimPaymentIntentInput,
): Promise<PaymentIntent | null> {
  const res = await exec.execute({
    sql: `UPDATE bookings.payment_intents
          SET status = 'verification_failed',
              verification_claim_token = NULL,
              verification_claim_expires_at = NULL,
              version = version + 1,
              updated_at = ?3::timestamptz
          WHERE payment_intent_id = ?1 AND status = 'verifying' AND verification_claim_token = ?2
          RETURNING ${COLUMNS}`,
    args: [
      textToArg("paymentIntentId", input.paymentIntentId),
      textToArg("claimToken", input.claimToken),
      isoUtcToArg(input.nowUtc),
    ],
  });
  return res.rows[0] ? decodePaymentIntent(res.rows[0]) : null;
}

async function markPaymentIntentCustodyRefundPending(
  exec: PaymentIntentSqlExecutor,
  input: MarkCustodyRefundPendingInput,
): Promise<PaymentIntent | null> {
  const res = await exec.execute({
    sql: `WITH transitioned AS (
            UPDATE bookings.payment_intents
            SET status = 'custody_refund_pending',
                verified_sender_address = ?4,
                custody_observed_amount_atomic = ?3::numeric,
                custody_sender_address = ?4,
                custody_reason = ?5,
                custody_detected_at = ?6::timestamptz,
                verification_claim_token = NULL,
                verification_claim_expires_at = NULL,
                version = version + 1,
                updated_at = ?6::timestamptz
            WHERE payment_intent_id = ?1
              AND status = 'verifying'
              AND verification_claim_token = ?2
            RETURNING *
          ), expired_hold AS (
            UPDATE bookings.holds
            SET status = 'expired', updated_at = ?6::timestamptz
            WHERE hold_id = (SELECT hold_id FROM transitioned)
              AND status = 'active'
          ), released_lock AS (
            UPDATE bookings.host_slot_locks
            SET status = 'released', updated_at = ?6::timestamptz
            WHERE hold_id = (SELECT hold_id FROM transitioned)
              AND status = 'active'
          )
          SELECT ${COLUMNS} FROM transitioned`,
    args: [
      textToArg("paymentIntentId", input.paymentIntentId),
      textToArg("claimToken", input.claimToken),
      atomicToArg(input.observedAmountAtomic),
      textToArg("senderAddress", input.senderAddress),
      textToArg("reason", input.reason),
      isoUtcToArg(input.nowUtc),
    ],
  });
  return res.rows[0] ? decodePaymentIntent(res.rows[0]) : null;
}

async function markPaymentIntentCustodyOperatorIncident(
  exec: PaymentIntentSqlExecutor,
  input: MarkCustodyOperatorIncidentInput,
): Promise<PaymentIntent | null> {
  const evidence = {
    transfers: input.transfers.map((transfer) => ({
      sender_address: transfer.senderAddress,
      observed_amount_atomic: transfer.observedAmountAtomic,
      transfer_count: transfer.transferCount,
    })),
  };
  const res = await exec.execute({
    sql: `WITH transitioned AS (
            UPDATE bookings.payment_intents
            SET status = 'custody_operator_incident',
                custody_reason = 'multiple_senders',
                custody_evidence_json = ?3::text::jsonb,
                custody_detected_at = ?4::timestamptz,
                verification_claim_token = NULL,
                verification_claim_expires_at = NULL,
                version = version + 1,
                updated_at = ?4::timestamptz
            WHERE payment_intent_id = ?1
              AND status = 'verifying'
              AND verification_claim_token = ?2
            RETURNING *
          ), expired_hold AS (
            UPDATE bookings.holds
            SET status = 'expired', updated_at = ?4::timestamptz
            WHERE hold_id = (SELECT hold_id FROM transitioned)
              AND status = 'active'
          ), released_lock AS (
            UPDATE bookings.host_slot_locks
            SET status = 'released', updated_at = ?4::timestamptz
            WHERE hold_id = (SELECT hold_id FROM transitioned)
              AND status = 'active'
          )
          SELECT ${COLUMNS} FROM transitioned`,
    args: [
      textToArg("paymentIntentId", input.paymentIntentId),
      textToArg("claimToken", input.claimToken),
      JSON.stringify(evidence),
      isoUtcToArg(input.nowUtc),
    ],
  });
  return res.rows[0] ? decodePaymentIntent(res.rows[0]) : null;
}

async function markPaymentIntentRejected(
  exec: PaymentIntentSqlExecutor,
  input: ClaimPaymentIntentInput,
): Promise<PaymentIntent | null> {
  const res = await exec.execute({
    sql: `UPDATE bookings.payment_intents
          SET status = 'verification_rejected',
              verification_claim_token = NULL,
              verification_claim_expires_at = NULL,
              version = version + 1,
              updated_at = ?3::timestamptz
          WHERE payment_intent_id = ?1 AND status = 'verifying' AND verification_claim_token = ?2
          RETURNING ${COLUMNS}`,
    args: [
      textToArg("paymentIntentId", input.paymentIntentId),
      textToArg("claimToken", input.claimToken),
      isoUtcToArg(input.nowUtc),
    ],
  });
  return res.rows[0] ? decodePaymentIntent(res.rows[0]) : null;
}

async function expirePaymentIntentIfDue(
  exec: PaymentIntentSqlExecutor,
  paymentIntentId: string,
  nowUtc: string,
): Promise<PaymentIntent | null> {
  const res = await exec.execute({
    sql: `UPDATE bookings.payment_intents
          SET status = 'expired', version = version + 1, updated_at = ?2::timestamptz
          WHERE payment_intent_id = ?1
            AND status IN ('active', 'verifying', 'verification_failed')
            AND claimed_tx_ref IS NULL
            AND hold_expires_at <= ?2::timestamptz
          RETURNING ${COLUMNS}`,
    args: [textToArg("paymentIntentId", paymentIntentId), isoUtcToArg(nowUtc)],
  });
  return res.rows[0] ? decodePaymentIntent(res.rows[0]) : null;
}

async function consumePaymentIntent(
  exec: PaymentIntentSqlExecutor,
  paymentIntentId: string,
  holdId: string,
  nowUtc: string,
): Promise<PaymentIntent | null> {
  const res = await exec.execute({
    sql: `UPDATE bookings.payment_intents
          SET status = 'consumed',
              consumed_at = ?3::timestamptz,
              version = version + 1,
              updated_at = ?3::timestamptz
          WHERE payment_intent_id = ?1 AND hold_id = ?2 AND status = 'verified'
          RETURNING ${COLUMNS}`,
    args: [textToArg("paymentIntentId", paymentIntentId), textToArg("holdId", holdId), isoUtcToArg(nowUtc)],
  });
  return res.rows[0] ? decodePaymentIntent(res.rows[0]) : null;
}

export interface PaymentIntentRepository {
  getPaymentIntent(paymentIntentId: string): Promise<PaymentIntent | null>;
  getPaymentIntentByHold(holdId: string): Promise<PaymentIntent | null>;
  listOrphanedVerifiedPaymentIntents(olderThanUtc: string, limit: number): Promise<PaymentIntent[]>;
  listRecentPaymentIntentsForBooker(
    bookerUserId: string,
    createdSinceUtc: string,
    limit: number,
  ): Promise<PendingPaymentIntentRecord[]>;
  listClaimedUnresolvedPaymentIntents(
    nowUtc: string,
    limit: number,
  ): Promise<ClaimedUnresolvedPaymentIntentRecord[]>;
  listOperatorUnresolvedPaymentIntents(nowUtc: string, limit: number): Promise<ClaimedUnresolvedPaymentIntentRecord[]>;
  listCustodyRefundPendingPaymentIntents(limit: number): Promise<PaymentIntent[]>;
}

export interface PaymentIntentWriteRepository extends PaymentIntentRepository {
  createOrGetPaymentIntent(input: CreatePaymentIntentInput): Promise<CreateOrGetPaymentIntentResult>;
  reservePaymentIntentForVerification(input: ReservePaymentIntentInput): Promise<ReservePaymentIntentResult>;
  markPaymentIntentVerified(input: VerifyPaymentIntentInput): Promise<PaymentIntent | null>;
  markPaymentIntentVerificationFailed(input: ClaimPaymentIntentInput): Promise<PaymentIntent | null>;
  markPaymentIntentCustodyRefundPending(input: MarkCustodyRefundPendingInput): Promise<PaymentIntent | null>;
  markPaymentIntentCustodyOperatorIncident(input: MarkCustodyOperatorIncidentInput): Promise<PaymentIntent | null>;
  markPaymentIntentRejected(input: ClaimPaymentIntentInput): Promise<PaymentIntent | null>;
  expirePaymentIntentIfDue(paymentIntentId: string, nowUtc: string): Promise<PaymentIntent | null>;
  consumePaymentIntent(paymentIntentId: string, holdId: string, nowUtc: string): Promise<PaymentIntent | null>;
  markOrphanedVerifiedPaymentIntentRefunded(paymentIntentId: string, refundTxRef: string, nowUtc: string): Promise<PaymentIntent | null>;
  markCustodyRefundPaymentIntentRefunded(paymentIntentId: string, refundTxRef: string, nowUtc: string): Promise<PaymentIntent | null>;
  recordCustodyRefundAttemptFailure(paymentIntentId: string, errorCode: string, nowUtc: string): Promise<PaymentIntent | null>;
}

function buildRepository(executor: PaymentIntentSqlExecutor): PaymentIntentRepository {
  return {
    getPaymentIntent: (paymentIntentId) => getPaymentIntent(executor, paymentIntentId),
    getPaymentIntentByHold: (holdId) => getPaymentIntentByHold(executor, holdId),
    listOrphanedVerifiedPaymentIntents: (olderThanUtc, limit) => listOrphanedVerifiedPaymentIntents(executor, olderThanUtc, limit),
    listRecentPaymentIntentsForBooker: (bookerUserId, createdSinceUtc, limit) =>
      listRecentPaymentIntentsForBooker(executor, bookerUserId, createdSinceUtc, limit),
    listClaimedUnresolvedPaymentIntents: (nowUtc, limit) =>
      listClaimedUnresolvedPaymentIntents(executor, nowUtc, limit),
    listOperatorUnresolvedPaymentIntents: (nowUtc, limit) =>
      listOperatorUnresolvedPaymentIntents(executor, nowUtc, limit),
    listCustodyRefundPendingPaymentIntents: (limit) =>
      listCustodyRefundPendingPaymentIntents(executor, limit),
  };
}

function buildWriteRepository(executor: PaymentIntentSqlExecutor): PaymentIntentWriteRepository {
  return {
    ...buildRepository(executor),
    createOrGetPaymentIntent: (input) => createOrGetPaymentIntent(executor, input),
    reservePaymentIntentForVerification: (input) => reservePaymentIntentForVerification(executor, input),
    markPaymentIntentVerified: (input) => markPaymentIntentVerified(executor, input),
    markPaymentIntentVerificationFailed: (input) => markPaymentIntentVerificationFailed(executor, input),
    markPaymentIntentCustodyRefundPending: (input) => markPaymentIntentCustodyRefundPending(executor, input),
    markPaymentIntentCustodyOperatorIncident: (input) => markPaymentIntentCustodyOperatorIncident(executor, input),
    markPaymentIntentRejected: (input) => markPaymentIntentRejected(executor, input),
    expirePaymentIntentIfDue: (paymentIntentId, nowUtc) => expirePaymentIntentIfDue(executor, paymentIntentId, nowUtc),
    consumePaymentIntent: (paymentIntentId, holdId, nowUtc) => consumePaymentIntent(executor, paymentIntentId, holdId, nowUtc),
    markOrphanedVerifiedPaymentIntentRefunded: (paymentIntentId, refundTxRef, nowUtc) =>
      markOrphanedVerifiedPaymentIntentRefunded(executor, paymentIntentId, refundTxRef, nowUtc),
    markCustodyRefundPaymentIntentRefunded: (paymentIntentId, refundTxRef, nowUtc) =>
      markCustodyRefundPaymentIntentRefunded(executor, paymentIntentId, refundTxRef, nowUtc),
    recordCustodyRefundAttemptFailure: (paymentIntentId, errorCode, nowUtc) =>
      recordCustodyRefundAttemptFailure(executor, paymentIntentId, errorCode, nowUtc),
  };
}

export function createPaymentIntentRepository(executor: PaymentIntentSqlExecutor): PaymentIntentRepository {
  return buildRepository(executor);
}

export function createPaymentIntentWriteRepository(executor: PaymentIntentSqlExecutor): PaymentIntentWriteRepository {
  return buildWriteRepository(executor);
}

export function createPaymentIntentTxWriteRepository(tx: PaymentIntentSqlExecutor): PaymentIntentWriteRepository {
  return buildWriteRepository(tx);
}
