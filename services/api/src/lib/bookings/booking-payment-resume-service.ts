import type { UserRepository } from "../auth/repositories";
import type { InStatement, QueryResult } from "../sql-client";
import { createBookingHoldWriteRepository } from "./hold-repository";
import {
  createPaymentIntentWriteRepository,
  normalizeTxRef,
  type PendingPaymentIntentRecord,
} from "./payment-intent-repository";
import type { PaymentIntent } from "./types";

export interface BookingPaymentResumeSqlExecutor {
  execute(statement: InStatement | string): Promise<QueryResult>;
}

export type BookingPaymentResumeState =
  | "payable"
  | "confirmable"
  | "finalizable"
  | "booked"
  | "refund_pending";

export interface PendingBookingPaymentIntentView {
  hold_id: string;
  payment_intent_id: string;
  intent_status: "active" | "verifying" | "verified" | "verification_failed" | "consumed";
  resume_state: BookingPaymentResumeState;
  claimed_tx_ref: string | null;
  wallet_attachment_id: string | null;
  payment: {
    payment_intent_id: string;
    version: number;
    chain_id: number;
    token_address: string;
    token_decimals: number;
    token_symbol: string;
    recipient_address: string;
    amount_atomic: string;
    gross_cents: number;
    quote_expires_at: string;
    hold_expires_at: string;
    wallet_attachment_required: boolean;
  };
  quote_expires_at: string;
  hold_expires_at: string;
  host_user_id: string;
  slot_start_utc: string;
  slot_end_utc: string;
  booking_id: string | null;
}

const PENDING_WINDOW_MS = 48 * 60 * 60 * 1000;
const PENDING_LIMIT = 50;

async function requireWalletAttachment(input: {
  userRepository: UserRepository;
  userId: string;
  walletAttachmentId: string;
}): Promise<boolean> {
  const attachments = await input.userRepository.getWalletAttachmentsByUserId(input.userId);
  return attachments.some((candidate) =>
    candidate.wallet_attachment === input.walletAttachmentId && Boolean(candidate.wallet_address?.trim()));
}

function submissionMatches(intent: PaymentIntent, normalizedTxRef: string, walletAttachmentId: string): boolean {
  return intent.claimedTxRef === normalizedTxRef
    && intent.consumedWalletAttachmentId === walletAttachmentId;
}

export type RecordBookingPaymentSubmittedResult =
  | { ok: true; paymentIntentId: string; normalizedTxRef: string }
  | {
      ok: false;
      reason:
        | "hold_not_found"
        | "payment_intent_not_found"
        | "wallet_attachment_invalid"
        | "invalid_tx_ref"
        | "transaction_already_used"
        | "payment_claim_conflict";
    };

export async function recordBookingPaymentSubmitted(input: {
  executor: BookingPaymentResumeSqlExecutor;
  userRepository: UserRepository;
  holdId: string;
  bookerUserId: string;
  txRef: string;
  walletAttachmentId: string;
  nowUtc: string;
}): Promise<RecordBookingPaymentSubmittedResult> {
  const hold = await createBookingHoldWriteRepository(input.executor).getHold(input.holdId);
  if (!hold || hold.bookerUserId !== input.bookerUserId) return { ok: false, reason: "hold_not_found" };
  if (!await requireWalletAttachment({
    userRepository: input.userRepository,
    userId: input.bookerUserId,
    walletAttachmentId: input.walletAttachmentId,
  })) {
    return { ok: false, reason: "wallet_attachment_invalid" };
  }

  const normalizedTxRef = normalizeTxRef(input.txRef);
  if (!normalizedTxRef) return { ok: false, reason: "invalid_tx_ref" };

  const repo = createPaymentIntentWriteRepository(input.executor);
  const intent = await repo.getPaymentIntentByHold(hold.holdId);
  if (!intent) return { ok: false, reason: "payment_intent_not_found" };
  if (submissionMatches(intent, normalizedTxRef, input.walletAttachmentId)) {
    return { ok: true, paymentIntentId: intent.paymentIntentId, normalizedTxRef };
  }
  if (intent.claimedTxRef || intent.consumedWalletAttachmentId) {
    return { ok: false, reason: "payment_claim_conflict" };
  }
  if (intent.status !== "active" && intent.status !== "verification_failed") {
    return { ok: false, reason: "payment_claim_conflict" };
  }

  const reserved = await repo.reservePaymentIntentForVerification({
    paymentIntentId: intent.paymentIntentId,
    claimToken: crypto.randomUUID(),
    // The durable broadcast marker reuses the verification reservation CAS but deliberately leaves
    // an already-expired lease. Confirm can therefore reclaim immediately and remains the only RPC
    // verification/finalization path.
    claimExpiresAt: input.nowUtc,
    normalizedTxRef,
    walletAttachmentId: input.walletAttachmentId,
    nowUtc: input.nowUtc,
  });
  if (reserved.ok) {
    return { ok: true, paymentIntentId: reserved.intent.paymentIntentId, normalizedTxRef };
  }
  if (reserved.reason === "reused-tx") return { ok: false, reason: "transaction_already_used" };

  const current = await repo.getPaymentIntentByHold(hold.holdId);
  if (current && submissionMatches(current, normalizedTxRef, input.walletAttachmentId)) {
    return { ok: true, paymentIntentId: current.paymentIntentId, normalizedTxRef };
  }
  return { ok: false, reason: "payment_claim_conflict" };
}

export function resolveBookingPaymentResumeState(
  record: PendingPaymentIntentRecord,
  nowUtc: string,
): BookingPaymentResumeState | null {
  const { intent } = record;
  if (intent.status === "consumed" && record.bookingId) return "booked";
  if (intent.status === "verified") {
    return record.holdStatus === "active" && intent.holdExpiresAt > nowUtc
      ? "finalizable"
      : "refund_pending";
  }
  if (
    (intent.status === "verifying" || intent.status === "verification_failed")
    && intent.claimedTxRef
    && intent.consumedWalletAttachmentId
  ) {
    return "confirmable";
  }
  if (
    intent.status === "active"
    && !intent.claimedTxRef
    && record.holdStatus === "active"
    && intent.holdExpiresAt > nowUtc
  ) {
    return "payable";
  }
  return null;
}

function toView(
  record: PendingPaymentIntentRecord,
  resumeState: BookingPaymentResumeState,
): PendingBookingPaymentIntentView {
  const intent = record.intent;
  return {
    hold_id: intent.holdId,
    payment_intent_id: intent.paymentIntentId,
    intent_status: intent.status as PendingBookingPaymentIntentView["intent_status"],
    resume_state: resumeState,
    claimed_tx_ref: intent.claimedTxRef,
    wallet_attachment_id: intent.consumedWalletAttachmentId,
    payment: {
      payment_intent_id: intent.paymentIntentId,
      version: intent.version,
      chain_id: intent.chainId,
      token_address: intent.tokenAddress,
      token_decimals: intent.tokenDecimals,
      token_symbol: intent.tokenSymbol,
      recipient_address: intent.recipientAddress,
      amount_atomic: intent.amountAtomic,
      gross_cents: intent.grossCents,
      quote_expires_at: intent.quoteExpiresAt,
      hold_expires_at: intent.holdExpiresAt,
      wallet_attachment_required: intent.walletAttachmentRequired,
    },
    quote_expires_at: intent.quoteExpiresAt,
    hold_expires_at: intent.holdExpiresAt,
    host_user_id: record.hostUserId,
    slot_start_utc: record.slotStartUtc,
    slot_end_utc: record.slotEndUtc,
    booking_id: record.bookingId,
  };
}

export async function listPendingBookingPaymentIntents(input: {
  executor: BookingPaymentResumeSqlExecutor;
  bookerUserId: string;
  nowUtc: string;
}): Promise<PendingBookingPaymentIntentView[]> {
  const createdSinceUtc = new Date(Date.parse(input.nowUtc) - PENDING_WINDOW_MS).toISOString();
  const records = await createPaymentIntentWriteRepository(input.executor)
    .listRecentPaymentIntentsForBooker(input.bookerUserId, createdSinceUtc, PENDING_LIMIT);
  return records.flatMap((record) => {
    const resumeState = resolveBookingPaymentResumeState(record, input.nowUtc);
    return resumeState ? [toView(record, resumeState)] : [];
  });
}
