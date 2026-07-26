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
      custodyObservedAmountAtomic: null,
      custodySenderAddress: null,
      custodyReason: null,
      custodyDetectedAt: null,
      refundTxRef: null,
      refundAttemptCount: 0,
      refundLastAttemptAt: null,
      refundLastErrorCode: null,
      refundedAt: null,
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

    const custodyRefund = record("custody_refund_pending", { holdStatus: "expired" });
    custodyRefund.intent.claimedTxRef = "0xtx";
    custodyRefund.intent.consumedWalletAttachmentId = "wallet_1";
    custodyRefund.intent.custodyObservedAmountAtomic = "51000000";
    custodyRefund.intent.custodySenderAddress = "0xsender";
    custodyRefund.intent.custodyReason = "wrong_transfer_amount";
    custodyRefund.intent.custodyDetectedAt = NOW;
    expect(resolveBookingPaymentResumeState(custodyRefund, NOW)).toBe("refund_pending");

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
    custody_refund: null,
    custody_incident: null,
  });
  expect(view).not.toHaveProperty("wallet_attachment_id");
  expect(view).not.toHaveProperty("recipient_address");
  expect(view).not.toHaveProperty("amount_atomic");
});

test("operator unresolved view exposes multi-sender custody evidence without assigning a money executor", () => {
  const pending = record("custody_operator_incident");
  pending.intent.claimedTxRef = "0xtx";
  pending.intent.consumedWalletAttachmentId = "wallet_1";
  pending.intent.custodyReason = "multiple_senders";
  pending.intent.custodyDetectedAt = NOW;
  pending.intent.custodyEvidence = {
    transfers: [
      { senderAddress: "0x1111111111111111111111111111111111111111", observedAmountAtomic: "5000000", transferCount: 1 },
      { senderAddress: "0x2222222222222222222222222222222222222222", observedAmountAtomic: "1", transferCount: 1 },
    ],
  };
  const view = unresolvedBookingPaymentIntentView({
    intent: pending.intent,
    hostUserId: pending.hostUserId,
    bookerUserId: pending.bookerUserId,
    holdStatus: "expired",
  }, NOW);
  expect(view.intent_status).toBe("custody_operator_incident");
  expect(view.custody_refund).toBeNull();
  expect(view.custody_incident).toEqual({
    reason: "multiple_senders",
    detected_at: NOW,
    transfers: [
      { sender_address: "0x1111111111111111111111111111111111111111", observed_amount_atomic: "5000000", transfer_count: 1 },
      { sender_address: "0x2222222222222222222222222222222222222222", observed_amount_atomic: "1", transfer_count: 1 },
    ],
  });
});

test("operator unresolved view preserves each recoverable intent status", () => {
  for (const status of ["verifying", "verified", "verification_failed"] as const) {
    const pending = record(status);
    pending.intent.claimedTxRef = "0xtx";
    pending.intent.consumedWalletAttachmentId = "wallet_1";
    const view = unresolvedBookingPaymentIntentView({
      intent: pending.intent,
      hostUserId: pending.hostUserId,
      bookerUserId: pending.bookerUserId,
      holdStatus: pending.holdStatus,
    }, NOW);
    expect(view.intent_status).toBe(status);
  }
});
