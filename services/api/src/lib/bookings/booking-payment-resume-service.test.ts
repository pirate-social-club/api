import { describe, expect, test } from "bun:test";

import type {
  ClaimedUnresolvedPaymentIntentRecord,
  PendingPaymentIntentRecord,
} from "./payment-intent-repository";
import {
  resolveBookingPaymentResumeState,
  unresolvedBookingPaymentIntentView,
} from "./booking-payment-resume-service";

const NOW = "2026-07-24T12:00:00.000Z";

function record(
  status: PendingPaymentIntentRecord["intent"]["status"],
  overrides: Partial<PendingPaymentIntentRecord> = {},
): PendingPaymentIntentRecord {
  return {
    intent: {
      paymentIntentId: "bpi_hold_1",
      holdId: "hold_1",
      version: 1,
      chainId: 84532,
      tokenAddress: "0xtoken",
      tokenDecimals: 6,
      tokenSymbol: "USDC",
      recipientAddress: "0xrecipient",
      amountAtomic: "50000000",
      grossCents: 5000,
      quoteExpiresAt: "2026-07-24T12:10:00.000Z",
      holdExpiresAt: "2026-07-24T12:10:00.000Z",
      walletAttachmentRequired: true,
      platformFeeBps: 1000,
      platformFeeCents: 500,
      hostPayoutCents: 4500,
      status,
      verificationClaimToken: null,
      verificationClaimExpiresAt: null,
      claimedTxRef: null,
      verifiedSenderAddress: null,
      verifiedAt: null,
      consumedWalletAttachmentId: null,
      consumedAt: null,
      createdAt: "2026-07-24T11:55:00.000Z",
      updatedAt: "2026-07-24T11:55:00.000Z",
    },
    hostUserId: "host_1",
    bookerUserId: "booker_1",
    slotStartUtc: "2026-07-24T13:00:00.000Z",
    slotEndUtc: "2026-07-24T13:30:00.000Z",
    holdStatus: "active",
    bookingId: null,
    ...overrides,
  };
}

describe("resolveBookingPaymentResumeState", () => {
  test("derives every public resume state from authoritative intent and hold timestamps", () => {
    expect(resolveBookingPaymentResumeState(record("active"), NOW)).toBe("payable");

    for (const status of ["verifying", "verification_failed"] as const) {
      const value = record(status);
      value.intent.claimedTxRef = "0xtx";
      value.intent.consumedWalletAttachmentId = "wallet_1";
      expect(resolveBookingPaymentResumeState(value, NOW)).toBe("confirmable");
    }

    expect(resolveBookingPaymentResumeState(record("verified"), NOW)).toBe("finalizable");

    const expiredVerified = record("verified", { holdStatus: "expired" });
    expect(resolveBookingPaymentResumeState(expiredVerified, NOW)).toBe("refund_pending");

    const consumed = record("consumed", { holdStatus: "consumed", bookingId: "booking_1" });
    expect(resolveBookingPaymentResumeState(consumed, NOW)).toBe("booked");
  });

  test("excludes unpaid expired holds and malformed claimed states", () => {
    const expiredActive = record("active", { holdStatus: "expired" });
    expect(resolveBookingPaymentResumeState(expiredActive, NOW)).toBeNull();
    expect(resolveBookingPaymentResumeState(record("verification_failed"), NOW)).toBeNull();
  });
});

test("operator unresolved view exposes durable claim identity and age without payment internals", () => {
  const pending = record("verification_failed");
  pending.intent.claimedTxRef = "0xtx";
  pending.intent.consumedWalletAttachmentId = "wallet_1";
  pending.intent.holdExpiresAt = "2026-07-24T11:30:00.000Z";
  const view = unresolvedBookingPaymentIntentView({
    intent: pending.intent,
    hostUserId: pending.hostUserId,
    bookerUserId: pending.bookerUserId,
    holdStatus: pending.holdStatus,
  } satisfies ClaimedUnresolvedPaymentIntentRecord, NOW);
  expect(view).toEqual({
    payment_intent_id: "bpi_hold_1",
    hold_id: "hold_1",
    host_user_id: "host_1",
    booker_user_id: "booker_1",
    intent_status: "verification_failed",
    hold_status: "active",
    claimed_tx_ref: "0xtx",
    hold_expires_at: "2026-07-24T11:30:00.000Z",
    updated_at: "2026-07-24T11:55:00.000Z",
    unresolved_age_seconds: 1800,
  });
  expect(view).not.toHaveProperty("wallet_attachment_id");
  expect(view).not.toHaveProperty("recipient_address");
  expect(view).not.toHaveProperty("amount_atomic");
});
