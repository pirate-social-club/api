import { describe, expect, test } from "bun:test";

import type { PendingPaymentIntentRecord } from "./payment-intent-repository";
import { resolveBookingPaymentResumeState } from "./booking-payment-resume-service";

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
