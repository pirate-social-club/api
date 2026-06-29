// Global booking quote/confirm service backed by bookings.* Postgres repositories.
//
// This is the Phase-2 service boundary for moving paid booking confirmation out of community D1.
// It keeps the existing route response shape (snake_case payment instructions / booking snapshot)
// while delegating durable row semantics to the repository layer.
import type { Env } from "../../env";
import type { UserRepository } from "../auth/repositories";
import type { InStatement, QueryResult } from "../sql-client";
import { bookingIdForHold, createBookingFinalizationWriteRepository } from "./booking-finalization-repository";
import { createBookingHoldWriteRepository } from "./hold-repository";
import { createBookingHostConfigRepository } from "./host-config-repository";
import {
  createPaymentIntentWriteRepository,
  normalizeTxRef,
  paymentIntentIdForHold,
} from "./payment-intent-repository";
import type { Booking, BookingHold, PaymentIntent } from "./types";

export interface BookingConfirmSqlExecutor {
  execute(statement: InStatement | string): Promise<QueryResult>;
}

const USDC_DECIMALS = 6;
const USDC_SYMBOL = "USDC";
const VERIFICATION_CLAIM_TTL_MS = 60_000;
const BASE_SEPOLIA_CHAIN_ID = 84532;
const BASE_SEPOLIA_USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";

function centsToAtomicString(cents: number): string {
  return (BigInt(cents) * 10n ** BigInt(USDC_DECIMALS - 2)).toString();
}

function feeSnapshot(platformFeeBps: number, grossCents: number): {
  platformFeeBps: number;
  platformFeeCents: number;
  hostPayoutCents: number;
} {
  const platformFeeCents = Math.floor((grossCents * platformFeeBps + 5000) / 10000);
  return {
    platformFeeBps,
    platformFeeCents,
    hostPayoutCents: grossCents - platformFeeCents,
  };
}

function normalizeEvmAddress(label: string, value: string | null | undefined): string {
  const trimmed = String(value ?? "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/u.test(trimmed)) throw new Error(`${label}_invalid`);
  return trimmed.toLowerCase();
}

function resolveSourceChainId(env: Env): number {
  const parsed = Number(String(env.PIRATE_CHECKOUT_SOURCE_CHAIN_ID || "").trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : BASE_SEPOLIA_CHAIN_ID;
}

function resolveUsdcTokenAddress(env: Env): string {
  return normalizeEvmAddress("PIRATE_CHECKOUT_USDC_TOKEN_ADDRESS", env.PIRATE_CHECKOUT_USDC_TOKEN_ADDRESS ?? BASE_SEPOLIA_USDC);
}

function resolveOperatorAddress(env: Env): string {
  return normalizeEvmAddress("PIRATE_CHECKOUT_OPERATOR_ADDRESS", env.PIRATE_CHECKOUT_OPERATOR_ADDRESS);
}

function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  try {
    return normalizeEvmAddress("a", a) === normalizeEvmAddress("b", b);
  } catch {
    return false;
  }
}

function bookingSnapshot(booking: Booking): BookingSnapshot {
  return {
    booking_id: booking.bookingId,
    hold_id: booking.holdId ?? "",
    host_user_id: booking.hostUserId,
    booker_user_id: booking.bookerUserId,
    slot_start_utc: booking.slotStartUtc,
    slot_end_utc: booking.slotEndUtc,
    gross_cents: booking.grossCents,
    platform_fee_cents: booking.platformFeeCents,
    host_payout_cents: booking.hostPayoutCents,
    status: booking.status,
    funding_tx_ref: booking.fundingTxRef,
  };
}

function paymentInstructions(intent: PaymentIntent): PaymentInstructions {
  return {
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
  };
}

function replayMatches(input: {
  intent: PaymentIntent | null;
  existing: Booking;
  hold: BookingHold;
  normalizedTxRef: string;
  walletAttachmentId: string;
  buyerAddress: string;
  bookerUserId: string;
}): boolean {
  const intent = input.intent;
  if (!intent || (intent.status !== "verified" && intent.status !== "consumed")) return false;
  if (intent.holdId !== input.hold.holdId) return false;
  if ((intent.claimedTxRef ?? "") !== input.normalizedTxRef) return false;
  if ((intent.consumedWalletAttachmentId ?? "") !== input.walletAttachmentId) return false;
  if (!sameAddress(intent.verifiedSenderAddress, input.buyerAddress)) return false;
  if (input.existing.bookerUserId !== input.bookerUserId || input.existing.holdId !== input.hold.holdId) return false;
  if ((input.existing.fundingTxRef ?? "").toLowerCase() !== input.normalizedTxRef) return false;
  return true;
}

export interface BookingPaymentExpectation {
  chainId: number;
  tokenAddress: string;
  recipientAddress: string;
  amountAtomic: bigint;
  senderAddress: string;
}

export type BookingPaymentVerification =
  | { kind: "verified"; senderAddress: string; txRef: string }
  | { kind: "pending" }
  | { kind: "rejected"; reason: string };

type PaymentVerifier = (input: {
  env: Env;
  fundingTxRef: string;
  expected: BookingPaymentExpectation;
}) => Promise<BookingPaymentVerification>;

let paymentVerifierForTests: PaymentVerifier | null = null;
export function setGlobalBookingPaymentVerifierForTests(verifier: PaymentVerifier | null): void {
  paymentVerifierForTests = verifier;
}

async function verifyPayment(input: Parameters<PaymentVerifier>[0]): Promise<BookingPaymentVerification> {
  if (paymentVerifierForTests) return paymentVerifierForTests(input);
  const mod = await import("../communities/commerce/funding-proof-service");
  return mod.classifyBookingPaymentReceipt(input);
}

async function resolveWalletAttachmentAddress(input: {
  userRepository: UserRepository;
  userId: string;
  walletAttachmentId: string;
}): Promise<string> {
  const attachments = await input.userRepository.getWalletAttachmentsByUserId(input.userId);
  const attachment = attachments.find((candidate) => candidate.wallet_attachment === input.walletAttachmentId);
  if (!attachment?.wallet_address?.trim()) throw new Error("wallet_attachment_invalid");
  return attachment.wallet_address;
}

async function hostSettlement(input: {
  executor: BookingConfirmSqlExecutor;
  hostUserId: string;
}): Promise<{ platformFeeBps: number; payoutWalletAddress: string | null }> {
  const profile = await createBookingHostConfigRepository(input.executor).getProfile(input.hostUserId);
  return {
    platformFeeBps: profile?.platformFeeBps ?? 1000,
    payoutWalletAddress: profile?.payoutWalletAddress ?? null,
  };
}

async function createOrGetIntent(input: {
  env: Env;
  executor: BookingConfirmSqlExecutor;
  hold: BookingHold;
  nowUtc: string;
}): Promise<{ intent: PaymentIntent; platformFeeBps: number; platformFeeCents: number; hostPayoutCents: number }> {
  const settlement = await hostSettlement({ executor: input.executor, hostUserId: input.hold.hostUserId });
  const snapshot = feeSnapshot(settlement.platformFeeBps, input.hold.priceCents);
  const result = await createPaymentIntentWriteRepository(input.executor).createOrGetPaymentIntent({
    holdId: input.hold.holdId,
    chainId: resolveSourceChainId(input.env),
    tokenAddress: resolveUsdcTokenAddress(input.env),
    tokenDecimals: USDC_DECIMALS,
    tokenSymbol: USDC_SYMBOL,
    recipientAddress: resolveOperatorAddress(input.env),
    amountAtomic: centsToAtomicString(input.hold.priceCents),
    grossCents: input.hold.priceCents,
    quoteExpiresAt: input.hold.expiresAtUtc,
    holdExpiresAt: input.hold.expiresAtUtc,
    walletAttachmentRequired: true,
    platformFeeBps: snapshot.platformFeeBps,
    platformFeeCents: snapshot.platformFeeCents,
    hostPayoutCents: snapshot.hostPayoutCents,
    createdAt: input.nowUtc,
  });
  if (!result.ok) throw new Error("booking_payment_intent_replay_conflict");
  return { intent: result.intent, ...snapshot };
}

export interface PaymentInstructions {
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
}

export interface BookingSnapshot {
  booking_id: string;
  hold_id: string;
  host_user_id: string;
  booker_user_id: string;
  slot_start_utc: string;
  slot_end_utc: string;
  gross_cents: number;
  platform_fee_cents: number;
  host_payout_cents: number;
  status: string;
  funding_tx_ref: string | null;
}

export type QuoteGlobalBookingHoldResult =
  | { ok: false; reason: "hold_not_found" | "hold_expired" }
  | {
    ok: true;
    quote: {
      hold_id: string;
      gross_cents: number;
      platform_fee_bps: number;
      platform_fee_cents: number;
      host_payout_cents: number;
      expires_at_utc: string;
      payment: PaymentInstructions;
    };
  };

export async function quoteGlobalBookingHold(input: {
  env: Env;
  executor: BookingConfirmSqlExecutor;
  holdId: string;
  nowUtc: string;
}): Promise<QuoteGlobalBookingHoldResult> {
  const hold = await createBookingHoldWriteRepository(input.executor).getHold(input.holdId);
  if (!hold) return { ok: false, reason: "hold_not_found" };
  if (hold.expiresAtUtc <= input.nowUtc || hold.status !== "active") return { ok: false, reason: "hold_expired" };

  const { intent } = await createOrGetIntent({ env: input.env, executor: input.executor, hold, nowUtc: input.nowUtc });
  return {
    ok: true,
    quote: {
      hold_id: hold.holdId,
      gross_cents: hold.priceCents,
      platform_fee_bps: intent.platformFeeBps,
      platform_fee_cents: intent.platformFeeCents,
      host_payout_cents: intent.hostPayoutCents,
      expires_at_utc: hold.expiresAtUtc,
      payment: paymentInstructions(intent),
    },
  };
}

export type ConfirmGlobalBookingResult =
  | {
    ok: false;
    reason:
      | "hold_not_found"
      | "hold_not_active"
      | "hold_expired"
      | "host_payout_unconfigured"
      | "payment_pending"
      | "payment_rejected"
      | "transaction_already_used"
      | "verification_in_progress"
      | "replay_mismatch"
      | "wallet_attachment_invalid"
      | "finalization_conflict";
  }
  | { ok: true; already: boolean; booking: BookingSnapshot };

export async function confirmGlobalBookingHold(input: {
  env: Env;
  executor: BookingConfirmSqlExecutor;
  userRepository: UserRepository;
  holdId: string;
  bookerUserId: string;
  fundingTxRef: string;
  walletAttachmentId: string;
  nowUtc: string;
}): Promise<ConfirmGlobalBookingResult> {
  const holdRepo = createBookingHoldWriteRepository(input.executor);
  const intentRepo = createPaymentIntentWriteRepository(input.executor);
  const finalizationRepo = createBookingFinalizationWriteRepository(input.executor);
  const hold = await holdRepo.getHold(input.holdId);
  if (!hold) return { ok: false, reason: "hold_not_found" };
  if (hold.bookerUserId !== input.bookerUserId) return { ok: false, reason: "hold_not_found" };

  let buyerAddress: string;
  try {
    buyerAddress = await resolveWalletAttachmentAddress({
      userRepository: input.userRepository,
      userId: input.bookerUserId,
      walletAttachmentId: input.walletAttachmentId,
    });
  } catch {
    return { ok: false, reason: "wallet_attachment_invalid" };
  }

  const intentId = paymentIntentIdForHold(hold.holdId);
  const normalizedTxRef = normalizeTxRef(input.fundingTxRef);
  const existing = await finalizationRepo.getBookingByHold(hold.holdId);
  if (existing) {
    const replayIntent = await intentRepo.getPaymentIntent(intentId);
    if (!replayMatches({
      intent: replayIntent,
      existing,
      hold,
      normalizedTxRef,
      walletAttachmentId: input.walletAttachmentId,
      buyerAddress,
      bookerUserId: input.bookerUserId,
    })) {
      return { ok: false, reason: "replay_mismatch" };
    }
    return { ok: true, already: true, booking: bookingSnapshot(existing) };
  }

  await createOrGetIntent({ env: input.env, executor: input.executor, hold, nowUtc: input.nowUtc });
  await intentRepo.expirePaymentIntentIfDue(intentId, input.nowUtc);
  let intent = await intentRepo.getPaymentIntent(intentId);
  if (!intent) throw new Error("payment_intent_missing");

  if (intent.status === "consumed") return finalizeFromVerifiedIntent(input, hold, intent, buyerAddress, normalizedTxRef);
  if (intent.status === "verification_rejected") return { ok: false, reason: "payment_rejected" };
  if (intent.status === "expired") return { ok: false, reason: "hold_expired" };
  if (intent.status === "verified") return finalizeFromVerifiedIntent(input, hold, intent, buyerAddress, normalizedTxRef);
  if (hold.status !== "active") return { ok: false, reason: "hold_not_active" };
  if (hold.expiresAtUtc <= input.nowUtc) return { ok: false, reason: "hold_expired" };

  const claimToken = crypto.randomUUID();
  const reserved = await intentRepo.reservePaymentIntentForVerification({
    paymentIntentId: intentId,
    claimToken,
    claimExpiresAt: new Date(Date.parse(input.nowUtc) + VERIFICATION_CLAIM_TTL_MS).toISOString(),
    normalizedTxRef,
    walletAttachmentId: input.walletAttachmentId,
    nowUtc: input.nowUtc,
  });
  if (!reserved.ok) {
    if (reserved.reason === "reused-tx") return { ok: false, reason: "transaction_already_used" };
    const current = await intentRepo.getPaymentIntent(intentId);
    if (current?.status === "consumed" || current?.status === "verified") {
      return finalizeFromVerifiedIntent(input, hold, current, buyerAddress, normalizedTxRef);
    }
    if (current?.status === "verification_rejected") return { ok: false, reason: "payment_rejected" };
    return { ok: false, reason: "verification_in_progress" };
  }

  const outcome = await verifyPayment({
    env: input.env,
    fundingTxRef: normalizedTxRef,
    expected: {
      chainId: intent.chainId,
      tokenAddress: intent.tokenAddress,
      recipientAddress: intent.recipientAddress,
      amountAtomic: BigInt(intent.amountAtomic),
      senderAddress: buyerAddress,
    },
  });
  if (outcome.kind === "pending") {
    await intentRepo.markPaymentIntentVerificationFailed({ paymentIntentId: intentId, claimToken, nowUtc: input.nowUtc });
    return { ok: false, reason: "payment_pending" };
  }
  if (outcome.kind === "rejected") {
    await intentRepo.markPaymentIntentRejected({ paymentIntentId: intentId, claimToken, nowUtc: input.nowUtc });
    return { ok: false, reason: "payment_rejected" };
  }

  const transitioned = await intentRepo.markPaymentIntentVerified({
    paymentIntentId: intentId,
    claimToken,
    verifiedSenderAddress: outcome.senderAddress,
    nowUtc: input.nowUtc,
  });
  if (!transitioned) {
    const current = await intentRepo.getPaymentIntent(intentId);
    if (current?.status === "verified" || current?.status === "consumed") {
      return finalizeFromVerifiedIntent(input, hold, current, buyerAddress, normalizedTxRef);
    }
    return { ok: false, reason: "verification_in_progress" };
  }
  intent = await intentRepo.getPaymentIntent(intentId);
  if (!intent) throw new Error("payment_intent_missing_after_verify");
  return finalizeFromVerifiedIntent(input, hold, intent, buyerAddress, normalizedTxRef);
}

async function finalizeFromVerifiedIntent(
  input: {
    env: Env;
    executor: BookingConfirmSqlExecutor;
    holdId: string;
    bookerUserId: string;
    walletAttachmentId: string;
    nowUtc: string;
  },
  hold: BookingHold,
  intent: PaymentIntent,
  buyerAddress: string,
  normalizedTxRef: string,
): Promise<ConfirmGlobalBookingResult> {
  if (intent.holdId !== hold.holdId) return { ok: false, reason: "replay_mismatch" };
  if ((intent.claimedTxRef ?? "") !== normalizedTxRef) return { ok: false, reason: "replay_mismatch" };
  if ((intent.consumedWalletAttachmentId ?? "") !== input.walletAttachmentId) return { ok: false, reason: "replay_mismatch" };
  if (!sameAddress(intent.verifiedSenderAddress, buyerAddress)) return { ok: false, reason: "replay_mismatch" };

  const settlement = await hostSettlement({ executor: input.executor, hostUserId: hold.hostUserId });
  if (!settlement.payoutWalletAddress) return { ok: false, reason: "host_payout_unconfigured" };

  const result = await createBookingFinalizationWriteRepository(input.executor).finalizeBookingFromVerifiedPaymentIntent({
    bookingId: bookingIdForHold(hold.holdId),
    holdId: hold.holdId,
    paymentIntentId: intent.paymentIntentId,
    bookerUserId: input.bookerUserId,
    normalizedTxRef,
    walletAttachmentId: input.walletAttachmentId,
    verifiedSenderAddress: intent.verifiedSenderAddress ?? buyerAddress,
    hostPayoutWalletAddress: settlement.payoutWalletAddress,
    nowUtc: input.nowUtc,
  });
  if (!result.ok) return { ok: false, reason: "finalization_conflict" };
  return { ok: true, already: result.already || intent.status === "consumed", booking: bookingSnapshot(result.booking) };
}
