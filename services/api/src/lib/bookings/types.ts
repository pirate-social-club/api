// Public decoded domain types for the global bookings repository. These are the repository's OUTPUT
// shapes (camelCase, already codec-decoded); the raw snake_case Postgres row shapes stay private to the
// repository module. Conventions: money is integer cents; bps is integer; timestamps are canonical
// ISO-8601 UTC strings; local times are "HH:MM[:SS]"; weekday sets are number[] (0=Sun..6=Sat).

export interface BookingProfile {
  hostUserId: string;
  displayHeadline: string | null;
  bio: string | null;
  topics: string[] | null;
  introVideoRef: string | null;
  hostTimezone: string;
  basePriceCents: number;
  defaultSlotDurationSeconds: number;
  platformFeeBps: number;
  payoutWalletAddress: string | null;
  isPublished: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AvailabilityRule {
  ruleId: string;
  hostUserId: string;
  byWeekday: number[];
  startLocal: string;
  endLocal: string;
  slotDurationSeconds: number;
  effectiveFromUtc: string | null;
  effectiveUntilUtc: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AvailabilityException {
  exceptionId: string;
  hostUserId: string;
  kind: "block" | "open";
  startUtc: string;
  endUtc: string;
  createdAt: string;
}

export interface PriceRule {
  priceRuleId: string;
  hostUserId: string;
  matchWeekday: number[] | null;
  matchLocalStart: string | null;
  matchLocalEnd: string | null;
  matchDurationSeconds: number | null;
  priceCents: number;
  priority: number;
  createdAt: string;
  updatedAt: string;
}

export interface HostSlotLock {
  lockId: string;
  hostUserId: string;
  slotStartUtc: string;
  slotEndUtc: string;
  holdId: string | null;
  bookingId: string | null;
  status: "active" | "released";
  sourceCommunityId: string | null;
  expiresAtUtc: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BookingHold {
  holdId: string;
  hostUserId: string;
  bookerUserId: string;
  slotStartUtc: string;
  slotEndUtc: string;
  priceCents: number;
  status: "active" | "consumed" | "expired";
  sourceCommunityId: string | null;
  expiresAtUtc: string;
  createdAt: string;
  updatedAt: string;
}

export type BookingStatus =
  | "hold"
  | "quoted"
  | "pending_payment"
  | "confirmed"
  | "live"
  | "completed"
  | "settled"
  | "expired_hold"
  | "cancelled_before_payment"
  | "cancelled_by_host"
  | "cancelled_by_booker"
  | "no_show_host"
  | "no_show_booker"
  | "refunded"
  | "disputed";

type BookingOutcome =
  | "completed"
  | "no_show_host"
  | "no_show_booker"
  | "cancelled_by_host"
  | "cancelled_by_booker";

export interface Booking {
  bookingId: string;
  holdId: string | null;
  hostUserId: string;
  bookerUserId: string;
  slotStartUtc: string;
  slotEndUtc: string;
  grossCents: number;
  platformFeeBps: number;
  platformFeeCents: number;
  hostPayoutCents: number;
  refundCents: number | null;
  status: BookingStatus;
  outcome: BookingOutcome | null;
  fundingTxRef: string | null;
  payoutTxRef: string | null;
  refundTxRef: string | null;
  fundingWalletAddress: string | null;
  hostPayoutWalletAddress: string | null;
  liveRoomId: string | null;
  sourceCommunityId: string | null;
  confirmedAt: string | null;
  completedAt: string | null;
  settledAt: string | null;
  cancelledAt: string | null;
  settlementReviewStatus: "pending" | "resolved" | null;
  settlementReviewReason: "attendance_ambiguous" | null;
  settlementReviewResolution: "completed" | "no_show_host" | "no_show_booker" | null;
  settlementReviewOpenedAt: string | null;
  settlementReviewResolvedAt: string | null;
  settlementReviewOperatorCredentialId: string | null;
  settlementReviewOperatorActorId: string | null;
  settlementReviewNote: string | null;
  settlementReviewVersion: number;
  createdAt: string;
  updatedAt: string;
}

export type AttendanceParty = "host" | "booker";

export interface AttendanceSession {
  sessionId: string;
  bookingId: string;
  party: AttendanceParty;
  userId: string;
  agoraUid: number | null;
  attachedAt: string;
  lastSeenAt: string;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AttendanceHeartbeat {
  heartbeatId: string;
  sessionId: string;
  bookingId: string;
  seenAt: string;
}

export type BookingSettlementEffectKind = "booking_payout" | "booking_refund";
export type BookingSettlementEffectStatus = "submitted" | "confirmed" | "failed";

export interface BookingSettlementEffect {
  bookingSettlementEffectId: string;
  bookingId: string;
  effectKind: BookingSettlementEffectKind;
  idempotencyKey: string;
  status: BookingSettlementEffectStatus;
  amountCents: number;
  recipientAddress: string;
  settlementRef: string | null;
  failureReason: string | null;
  attemptCount: number;
  signedTx: string | null;
  broadcastNonce: number | null;
  coordinatorRef: string | null;
  coordinatorState: string | null;
  submittedAt: string | null;
  confirmedAt: string | null;
  failedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type PaymentIntentStatus =
  | "active"
  | "verifying"
  | "verified"
  | "verification_failed"
  | "verification_rejected"
  | "consumed"
  | "expired"
  | "superseded";

export interface PaymentIntent {
  paymentIntentId: string;
  holdId: string;
  version: number;
  chainId: number;
  tokenAddress: string;
  tokenDecimals: number;
  tokenSymbol: string;
  recipientAddress: string;
  amountAtomic: string;
  grossCents: number;
  quoteExpiresAt: string;
  holdExpiresAt: string;
  walletAttachmentRequired: boolean;
  platformFeeBps: number;
  platformFeeCents: number;
  hostPayoutCents: number;
  status: PaymentIntentStatus;
  verificationClaimToken: string | null;
  verificationClaimExpiresAt: string | null;
  claimedTxRef: string | null;
  verifiedSenderAddress: string | null;
  verifiedAt: string | null;
  consumedWalletAttachmentId: string | null;
  consumedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// Aggregate host configuration. `null` when the host has no profile row (the caller decides what an
// unpublished/absent profile means — the repository stays policy-free).
export interface HostConfiguration {
  profile: BookingProfile;
  availabilityRules: AvailabilityRule[];
  availabilityExceptions: AvailabilityException[];
  priceRules: PriceRule[];
}
