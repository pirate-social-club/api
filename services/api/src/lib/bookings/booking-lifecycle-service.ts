import type { Env } from "../../env";
import { createBookingLifecycleWriteRepository, type BookingLifecycleSqlExecutor } from "./booking-lifecycle-repository";
import type { SettlementEffectSqlExecutor } from "./settlement-effect-repository";
import type { AttendanceParty, Booking } from "./types";

const SESSION_START_LEAD_MS = 5 * 60_000;
const NO_SHOW_GRACE_MS = 10 * 60_000;
const ATTACHABLE_STATES = new Set<string>(["confirmed", "live"]);
const CANCELLED_STATES = new Set<string>(["cancelled_by_host", "cancelled_by_booker"]);
const NO_SHOW_STATES = new Set<string>(["no_show_host", "no_show_booker"]);
const UNFINISHED_INTENT_STATES = new Set<string>([
  "completed",
  "no_show_booker",
  "no_show_host",
  "cancelled_by_host",
  "cancelled_by_booker",
]);

interface BookingLifecycleSnapshot {
  booking_id: string;
  status: string;
  outcome: Booking["outcome"];
  refund_cents: number;
  refund_tx_ref: string | null;
  payout_tx_ref: string | null;
}

type AgoraBlock = {
  app_id: string | null;
  channel: string;
  uid: number;
  token: string | null;
  token_expires_at: number | null;
  configured: boolean;
};

type AgoraBuilder = (input: { env: Env; channel: string; uid: number }) => AgoraBlock;
let agoraBuilderForTests: AgoraBuilder | null = null;

type BookingState = Booking["status"];
type CancelBy = "host" | "booker";
type SettlementIntentState = "cancelled_by_host" | "cancelled_by_booker" | "completed" | "no_show_host" | "no_show_booker";
type FinalSettlementState = "settled" | "refunded";
export type GlobalBookingSettlementReviewResolution = "completed" | "no_show_host" | "no_show_booker";

interface GlobalBookingOperatorEffect {
  kind: "payout" | "refund";
  toUserId: string;
  recipientAddress: string;
  amountCents: number;
  bookingId: string;
  sourceCommunityId: string;
  idempotencyKey: string;
}

interface GlobalSettlementContext {
  env: Env;
  executor: BookingLifecycleSqlExecutor & SettlementEffectSqlExecutor;
  nowUtc: string;
  confirmPollMs?: number[];
}

type GlobalOperatorEffectExecutor = (ctx: GlobalSettlementContext, effect: GlobalBookingOperatorEffect) => Promise<{ txRef: string }>;
let operatorEffectExecutorForTests: GlobalOperatorEffectExecutor | null = null;

interface LifecycleDomain {
  canTransition(from: BookingState, event: string): boolean;
  applyTransition(from: BookingState, event: string): BookingState;
  resolveRefund(input: {
    state: BookingState;
    cancelledBy: CancelBy | "system";
    slotStartUtc: string;
    nowUtc: string;
    grossCents: number;
    platformFeeBps: number;
  }): number;
  retainedHostPayout(input: {
    grossCents: number;
    refundCents: number;
    platformFeeBps: number;
  }): number;
}
let lifecycleDomainForTests: LifecycleDomain | null = null;

export function setGlobalBookingAgoraBuilderForTests(builder: AgoraBuilder | null): void {
  agoraBuilderForTests = builder;
}

export function setGlobalBookingOperatorEffectExecutorForTests(executor: GlobalOperatorEffectExecutor | null): void {
  operatorEffectExecutorForTests = executor;
}

export function setGlobalBookingLifecycleDomainForTests(domain: LifecycleDomain | null): void {
  lifecycleDomainForTests = domain;
}

async function buildAgoraBlock(input: { env: Env; channel: string; uid: number }): Promise<AgoraBlock> {
  if (agoraBuilderForTests) return agoraBuilderForTests(input);
  const mod = await import("../communities/live-rooms/runtime");
  return mod.buildAgoraBlock(input);
}

async function executeOperatorEffect(ctx: GlobalSettlementContext, effect: GlobalBookingOperatorEffect): Promise<{ txRef: string }> {
  if (operatorEffectExecutorForTests) return operatorEffectExecutorForTests(ctx, effect);
  const mod = await import("./booking-custody-adapter");
  return mod.executeGlobalBookingOperatorEffect(ctx, effect);
}

async function settlementErrorKind(error: unknown): Promise<"pending" | "terminal" | null> {
  const mod = await import("./booking-custody-adapter");
  return mod.globalBookingSettlementErrorKind(error);
}

function randomAgoraUid(): number {
  const v = new Uint32Array(1);
  crypto.getRandomValues(v);
  return (v[0] & 0x7fffffff) || 1;
}

function deriveBookingChannel(bookingId: string): string {
  return `pirate-booking-${bookingId}`;
}

function epochMs(iso: string): number {
  return Date.parse(iso);
}

function lifecyclePolicy(platformFeeBps: number) {
  return {
    platformFeeBps,
    holdTtlSeconds: 600,
    minLeadTimeSeconds: 3600,
    maxAdvanceSeconds: 60 * 86400,
    cancellationWindowSeconds: 86400,
    noShowGraceSeconds: 600,
    refundPolicy: {
      bookerCancelAfterWindowRefundBps: 0,
      noShowByBookerRefundBps: 0,
      noShowByHostRefundBps: 10000,
    },
    rounding: "half_up" as const,
  };
}

async function computeRetainedHostPayout(grossCents: number, refundCents: number, platformFeeBps: number): Promise<number> {
  if (lifecycleDomainForTests) return lifecycleDomainForTests.retainedHostPayout({ grossCents, refundCents, platformFeeBps });
  const mod = await import("@pirate/bookings-domain");
  const allocation = mod.computeAllocation(Math.max(0, grossCents - refundCents), lifecyclePolicy(platformFeeBps));
  return allocation.legs.find((leg) => leg.recipientType === "host")?.amountCents ?? 0;
}

async function transitionAllowed(from: BookingState, event: string): Promise<boolean> {
  if (lifecycleDomainForTests) return lifecycleDomainForTests.canTransition(from, event);
  const mod = await import("@pirate/bookings-domain");
  return mod.canTransition(from, event as never);
}

async function transition(from: BookingState, event: string): Promise<BookingState> {
  if (lifecycleDomainForTests) return lifecycleDomainForTests.applyTransition(from, event);
  const mod = await import("@pirate/bookings-domain");
  return mod.applyTransition(from, event as never) as BookingState;
}

async function refundFor(input: {
  state: BookingState;
  cancelledBy: CancelBy | "system";
  booking: Booking;
  nowUtc: string;
}): Promise<number> {
  if (lifecycleDomainForTests) {
    return lifecycleDomainForTests.resolveRefund({
      state: input.state,
      cancelledBy: input.cancelledBy,
      slotStartUtc: input.booking.slotStartUtc,
      nowUtc: input.nowUtc,
      grossCents: input.booking.grossCents,
      platformFeeBps: input.booking.platformFeeBps,
    });
  }
  const mod = await import("@pirate/bookings-domain");
  const policy = lifecyclePolicy(input.booking.platformFeeBps);
  return mod.resolveRefund({
    state: input.state as never,
    cancelledBy: input.cancelledBy,
    slotStartUtc: input.booking.slotStartUtc,
    nowUtc: input.nowUtc,
    policy,
    allocation: mod.computeAllocation(input.booking.grossCents, policy),
  }).refundCents;
}

function snapshot(booking: Booking): BookingLifecycleSnapshot {
  return {
    booking_id: booking.bookingId,
    status: booking.status,
    outcome: booking.outcome,
    refund_cents: booking.refundCents ?? 0,
    refund_tx_ref: booking.refundTxRef,
    payout_tx_ref: booking.payoutTxRef,
  };
}

function actorParty(booking: Booking, actorUserId: string): AttendanceParty | null {
  if (booking.hostUserId === actorUserId) return "host";
  if (booking.bookerUserId === actorUserId) return "booker";
  return null;
}

function requireSettlementAddress(address: string | null, code: string): string {
  if (!address) throw new Error(code);
  return address;
}

function finalStateForIntent(intentState: SettlementIntentState): FinalSettlementState {
  return intentState === "completed" || intentState === "no_show_booker" ? "settled" : "refunded";
}

function refundForSettlementReviewResolution(booking: Booking, resolution: GlobalBookingSettlementReviewResolution): number {
  switch (resolution) {
    case "completed":
    case "no_show_booker":
      return 0;
    case "no_show_host":
      return booking.grossCents;
  }
}

function resolvedReviewReplayOutcome(
  booking: Booking,
  resolution: GlobalBookingSettlementReviewResolution,
): "replayed" | "resolved_pending" | null {
  if (booking.settlementReviewResolution !== resolution) return null;
  if (booking.status === "settled" || booking.status === "refunded") return "replayed";
  if (UNFINISHED_INTENT_STATES.has(booking.status)) return "resolved_pending";
  return null;
}

async function executeSettlement(input: {
  ctx: GlobalSettlementContext;
  booking: Booking;
  fromStatus: "confirmed" | "live";
  intentState: SettlementIntentState;
  refundCents: number;
}): Promise<BookingLifecycleSnapshot> {
  const repo = createBookingLifecycleWriteRepository(input.ctx.executor);
  const current = input.booking.status === input.fromStatus
    ? await repo.reserveBookingSettlementIntent({
      bookingId: input.booking.bookingId,
      fromStatus: input.fromStatus,
      toStatus: input.intentState,
      refundCents: input.refundCents,
      nowUtc: input.ctx.nowUtc,
    })
    : input.booking;
  if (!current) throw new Error("booking_settlement_intent_reservation_failed");

  const refundCents = current.refundCents ?? input.refundCents;
  const payoutCents = await computeRetainedHostPayout(current.grossCents, refundCents, current.platformFeeBps);
  const sourceCommunityId = current.sourceCommunityId ?? "";
  let refundTxRef: string | null = null;
  let payoutTxRef: string | null = null;

  if (refundCents > 0) {
    refundTxRef = (await executeOperatorEffect(input.ctx, {
      kind: "refund",
      toUserId: current.bookerUserId,
      amountCents: refundCents,
      recipientAddress: requireSettlementAddress(current.fundingWalletAddress, "booking_refund_destination_missing"),
      bookingId: current.bookingId,
      sourceCommunityId,
      idempotencyKey: `booking_refund:${current.bookingId}`,
    })).txRef;
  }
  if (payoutCents > 0) {
    payoutTxRef = (await executeOperatorEffect(input.ctx, {
      kind: "payout",
      toUserId: current.hostUserId,
      amountCents: payoutCents,
      recipientAddress: requireSettlementAddress(current.hostPayoutWalletAddress, "booking_payout_destination_missing"),
      bookingId: current.bookingId,
      sourceCommunityId,
      idempotencyKey: `booking_payout:${current.bookingId}`,
    })).txRef;
  }

  const finalized = await repo.finalizeBookingSettlement({
    bookingId: current.bookingId,
    fromStatus: input.intentState,
    finalStatus: finalStateForIntent(input.intentState),
    refundTxRef,
    payoutTxRef,
    nowUtc: input.ctx.nowUtc,
  });
  if (!finalized) throw new Error("booking_settlement_finalize_failed");
  await repo.releaseBookingSlotLock(current.bookingId, input.ctx.nowUtc);
  return snapshot(finalized);
}

export type GlobalLifecycleResult =
  | { ok: false; reason: "not_found" | "illegal_transition" | "outside_start_window" | "too_early_to_complete" | "too_early_for_no_show" }
  | { ok: true; already: boolean; booking: BookingLifecycleSnapshot };

export type MarkGlobalBookingSettlementAmbiguousResult =
  | { ok: false; reason: "not_found" | "not_reviewable" }
  | { ok: true; already: boolean; reviewVersion: number };

export async function markGlobalBookingSettlementAmbiguous(input: {
  executor: BookingLifecycleSqlExecutor;
  bookingId: string;
  nowUtc: string;
}): Promise<MarkGlobalBookingSettlementAmbiguousResult> {
  const repo = createBookingLifecycleWriteRepository(input.executor);
  const booking = await repo.getBooking(input.bookingId);
  if (!booking) return { ok: false, reason: "not_found" };
  if (booking.status === "disputed" && booking.settlementReviewStatus === "pending") {
    return { ok: true, already: true, reviewVersion: booking.settlementReviewVersion };
  }
  if (booking.status !== "confirmed" && booking.status !== "live") {
    return { ok: false, reason: "not_reviewable" };
  }
  const marked = await repo.markBookingSettlementAmbiguous({
    bookingId: input.bookingId,
    nowUtc: input.nowUtc,
  });
  if (marked) return { ok: true, already: false, reviewVersion: marked.settlementReviewVersion };
  const latest = await repo.getBooking(input.bookingId);
  if (latest?.status === "disputed" && latest.settlementReviewStatus === "pending") {
    return { ok: true, already: true, reviewVersion: latest.settlementReviewVersion };
  }
  return { ok: false, reason: "not_reviewable" };
}

export type ResolveGlobalBookingSettlementReviewResult =
  | { ok: false; reason: "not_found" | "not_pending_review" | "version_conflict" | "resolution_conflict" | "invalid_resolution" }
  | { ok: true; outcome: "resolved" | "resolved_pending" | "replayed"; booking: BookingLifecycleSnapshot };

export async function resolveGlobalBookingSettlementReview(input: {
  env: Env;
  executor: BookingLifecycleSqlExecutor & SettlementEffectSqlExecutor;
  bookingId: string;
  resolution: GlobalBookingSettlementReviewResolution;
  expectedReviewVersion: number;
  operatorCredentialId: string;
  operatorActorId: string;
  note?: string | null;
  nowUtc: string;
  confirmPollMs?: number[];
}): Promise<ResolveGlobalBookingSettlementReviewResult> {
  if (
    input.resolution !== "completed" &&
    input.resolution !== "no_show_host" &&
    input.resolution !== "no_show_booker"
  ) {
    return { ok: false, reason: "invalid_resolution" };
  }
  if (!Number.isInteger(input.expectedReviewVersion) || input.expectedReviewVersion < 0) {
    return { ok: false, reason: "version_conflict" };
  }

  const repo = createBookingLifecycleWriteRepository(input.executor);
  const review = await repo.getBooking(input.bookingId);
  if (!review) return { ok: false, reason: "not_found" };
  if (review.settlementReviewStatus === "resolved") {
    const replayOutcome = resolvedReviewReplayOutcome(review, input.resolution);
    return replayOutcome
      ? { ok: true, outcome: replayOutcome, booking: snapshot(review) }
      : { ok: false, reason: "resolution_conflict" };
  }
  if (review.status !== "disputed" || review.settlementReviewStatus !== "pending") {
    return { ok: false, reason: "not_pending_review" };
  }
  if (review.settlementReviewVersion !== input.expectedReviewVersion) {
    return { ok: false, reason: "version_conflict" };
  }

  const refundCents = refundForSettlementReviewResolution(review, input.resolution);
  const reserved = await repo.resolveBookingSettlementReview({
    bookingId: input.bookingId,
    resolution: input.resolution,
    refundCents,
    expectedReviewVersion: input.expectedReviewVersion,
    operatorCredentialId: input.operatorCredentialId,
    operatorActorId: input.operatorActorId,
    note: input.note ?? null,
    nowUtc: input.nowUtc,
  });
  if (!reserved) {
    const latest = await repo.getBooking(input.bookingId);
    if (latest?.settlementReviewStatus === "resolved") {
      const replayOutcome = resolvedReviewReplayOutcome(latest, input.resolution);
      return replayOutcome
        ? { ok: true, outcome: replayOutcome, booking: snapshot(latest) }
        : { ok: false, reason: "resolution_conflict" };
    }
    return { ok: false, reason: "version_conflict" };
  }

  try {
    const reconciled = await reconcileGlobalBookingSettlement({
      executor: input.executor,
      bookingId: input.bookingId,
      env: input.env,
      nowUtc: input.nowUtc,
      confirmPollMs: input.confirmPollMs,
    });
    if (reconciled.outcome === "resumed") {
      return { ok: true, outcome: "resolved", booking: reconciled.booking };
    }
    const latest = await repo.getBooking(input.bookingId);
    return { ok: true, outcome: "resolved_pending", booking: snapshot(latest ?? reserved) };
  } catch (error) {
    if (await settlementErrorKind(error) === "pending") {
      const latest = await repo.getBooking(input.bookingId);
      return { ok: true, outcome: "resolved_pending", booking: snapshot(latest ?? reserved) };
    }
    throw error;
  }
}

export async function startGlobalBookingSession(input: {
  executor: BookingLifecycleSqlExecutor;
  bookingId: string;
  actorUserId: string;
  nowUtc: string;
  system?: boolean;
}): Promise<GlobalLifecycleResult> {
  const repo = createBookingLifecycleWriteRepository(input.executor);
  const booking = await repo.getBooking(input.bookingId);
  if (!booking || !actorParty(booking, input.actorUserId)) return { ok: false, reason: "not_found" };
  if (booking.status === "live") return { ok: true, already: true, booking: snapshot(booking) };
  if (!input.system && (epochMs(input.nowUtc) < epochMs(booking.slotStartUtc) - SESSION_START_LEAD_MS || epochMs(input.nowUtc) >= epochMs(booking.slotEndUtc))) {
    return { ok: false, reason: "outside_start_window" };
  }
  if (booking.status !== "confirmed") return { ok: false, reason: "illegal_transition" };
  const started = await repo.startBookingSession(input.bookingId, input.nowUtc);
  if (!started) return { ok: false, reason: "illegal_transition" };
  return { ok: true, already: false, booking: snapshot(started) };
}

export type CancelGlobalBookingResult =
  | { ok: false; reason: "not_found" | "illegal_transition" }
  | { ok: false; reason: "cancellation_terms_changed"; preview: GlobalBookingCancellationPreview }
  | { ok: true; already: boolean; cancelledBy: CancelBy; booking: BookingLifecycleSnapshot };

export interface GlobalBookingCancellationPreview {
  object: "booking_cancellation_preview";
  booking_id: string;
  cancelled_by: CancelBy;
  gross_cents: number;
  refund_cents: number;
  host_payout_cents: number;
  platform_fee_cents: number;
  previewed_at: string;
  policy_cutoff_at: string | null;
}

async function cancellationPreviewFor(
  booking: Booking,
  cancelledBy: CancelBy,
  nowUtc: string,
): Promise<GlobalBookingCancellationPreview> {
  const intentState: SettlementIntentState = cancelledBy === "host" ? "cancelled_by_host" : "cancelled_by_booker";
  const refundCents = await refundFor({ state: intentState, cancelledBy, booking, nowUtc });
  const hostPayoutCents = await computeRetainedHostPayout(booking.grossCents, refundCents, booking.platformFeeBps);
  return {
    object: "booking_cancellation_preview",
    booking_id: booking.bookingId,
    cancelled_by: cancelledBy,
    gross_cents: booking.grossCents,
    refund_cents: refundCents,
    host_payout_cents: hostPayoutCents,
    platform_fee_cents: booking.grossCents - refundCents - hostPayoutCents,
    previewed_at: nowUtc,
    policy_cutoff_at: cancelledBy === "booker"
      ? new Date(epochMs(booking.slotStartUtc) - lifecyclePolicy(booking.platformFeeBps).cancellationWindowSeconds * 1000).toISOString()
      : null,
  };
}

export async function previewGlobalBookingCancellation(input: {
  executor: BookingLifecycleSqlExecutor;
  bookingId: string;
  actorUserId: string;
  nowUtc: string;
}): Promise<{ ok: false; reason: "not_found" | "illegal_transition" } | { ok: true; preview: GlobalBookingCancellationPreview }> {
  const booking = await createBookingLifecycleWriteRepository(input.executor).getBooking(input.bookingId);
  if (!booking) return { ok: false, reason: "not_found" };
  const cancelledBy = booking.hostUserId === input.actorUserId
    ? "host"
    : booking.bookerUserId === input.actorUserId
      ? "booker"
      : null;
  if (!cancelledBy) return { ok: false, reason: "not_found" };
  if (booking.status !== "confirmed") return { ok: false, reason: "illegal_transition" };
  return { ok: true, preview: await cancellationPreviewFor(booking, cancelledBy, input.nowUtc) };
}

export async function cancelGlobalBooking(input: {
  env: Env;
  executor: BookingLifecycleSqlExecutor & SettlementEffectSqlExecutor;
  bookingId: string;
  actorUserId: string;
  nowUtc: string;
  expectedRefundCents?: number;
  confirmPollMs?: number[];
}): Promise<CancelGlobalBookingResult> {
  const repo = createBookingLifecycleWriteRepository(input.executor);
  const booking = await repo.getBooking(input.bookingId);
  if (!booking) return { ok: false, reason: "not_found" };

  let cancelledBy: CancelBy;
  if (booking.hostUserId === input.actorUserId) cancelledBy = "host";
  else if (booking.bookerUserId === input.actorUserId) cancelledBy = "booker";
  else return { ok: false, reason: "not_found" };

  if (booking.status === "refunded") {
    return { ok: true, already: true, cancelledBy, booking: snapshot(booking) };
  }

  let intentState: SettlementIntentState;
  let refundCents: number;
  if (CANCELLED_STATES.has(booking.status)) {
    intentState = booking.status as SettlementIntentState;
    refundCents = booking.refundCents ?? 0;
  } else {
    const event = cancelledBy === "host" ? "HOST_CANCELS" : "BOOKER_CANCELS";
    if (!await transitionAllowed(booking.status, event)) return { ok: false, reason: "illegal_transition" };
    intentState = await transition(booking.status, event) as SettlementIntentState;
    const preview = await cancellationPreviewFor(booking, cancelledBy, input.nowUtc);
    if (input.expectedRefundCents !== undefined && input.expectedRefundCents !== preview.refund_cents) {
      return { ok: false, reason: "cancellation_terms_changed", preview };
    }
    refundCents = preview.refund_cents;
  }

  const settled = await executeSettlement({
    ctx: { env: input.env, executor: input.executor, nowUtc: input.nowUtc, confirmPollMs: input.confirmPollMs },
    booking,
    fromStatus: "confirmed",
    intentState,
    refundCents,
  });
  return { ok: true, already: false, cancelledBy, booking: settled };
}

export async function completeGlobalBooking(input: {
  env: Env;
  executor: BookingLifecycleSqlExecutor & SettlementEffectSqlExecutor;
  bookingId: string;
  actorUserId: string;
  nowUtc: string;
  confirmPollMs?: number[];
  system?: boolean;
}): Promise<GlobalLifecycleResult> {
  const repo = createBookingLifecycleWriteRepository(input.executor);
  const booking = await repo.getBooking(input.bookingId);
  if (!booking || booking.hostUserId !== input.actorUserId) return { ok: false, reason: "not_found" };
  if (booking.status === "settled") return { ok: true, already: true, booking: snapshot(booking) };

  let refundCents = booking.refundCents ?? 0;
  if (booking.status !== "completed") {
    if (!input.system && epochMs(input.nowUtc) < epochMs(booking.slotStartUtc)) return { ok: false, reason: "too_early_to_complete" };
    if (!await transitionAllowed(booking.status, "SESSION_ENDED")) return { ok: false, reason: "illegal_transition" };
    refundCents = await refundFor({ state: "completed", cancelledBy: "system", booking, nowUtc: input.nowUtc });
  }

  const settled = await executeSettlement({
    ctx: { env: input.env, executor: input.executor, nowUtc: input.nowUtc, confirmPollMs: input.confirmPollMs },
    booking,
    fromStatus: "live",
    intentState: "completed",
    refundCents,
  });
  return { ok: true, already: false, booking: settled };
}

export async function noShowGlobalBooking(input: {
  env: Env;
  executor: BookingLifecycleSqlExecutor & SettlementEffectSqlExecutor;
  bookingId: string;
  actorUserId: string;
  nowUtc: string;
  confirmPollMs?: number[];
  system?: boolean;
}): Promise<GlobalLifecycleResult> {
  const repo = createBookingLifecycleWriteRepository(input.executor);
  const booking = await repo.getBooking(input.bookingId);
  if (!booking) return { ok: false, reason: "not_found" };

  let event: "HOST_NO_SHOW" | "BOOKER_NO_SHOW";
  if (booking.hostUserId === input.actorUserId) event = "BOOKER_NO_SHOW";
  else if (booking.bookerUserId === input.actorUserId) event = "HOST_NO_SHOW";
  else return { ok: false, reason: "not_found" };

  if (booking.status === "refunded" || booking.status === "settled") {
    return { ok: true, already: true, booking: snapshot(booking) };
  }

  let intentState: SettlementIntentState;
  let refundCents: number;
  if (NO_SHOW_STATES.has(booking.status)) {
    intentState = booking.status as SettlementIntentState;
    refundCents = booking.refundCents ?? 0;
  } else {
    if (!input.system && epochMs(input.nowUtc) < epochMs(booking.slotStartUtc) + NO_SHOW_GRACE_MS) {
      return { ok: false, reason: "too_early_for_no_show" };
    }
    if (!await transitionAllowed(booking.status, event)) return { ok: false, reason: "illegal_transition" };
    intentState = await transition(booking.status, event) as SettlementIntentState;
    refundCents = await refundFor({ state: intentState, cancelledBy: "system", booking, nowUtc: input.nowUtc });
  }

  const settled = await executeSettlement({
    ctx: { env: input.env, executor: input.executor, nowUtc: input.nowUtc, confirmPollMs: input.confirmPollMs },
    booking,
    fromStatus: "live",
    intentState,
    refundCents,
  });
  return { ok: true, already: false, booking: settled };
}

export type ReconcileGlobalBookingSettlementResult =
  | { outcome: "skipped" }
  | { outcome: "resumed"; booking: BookingLifecycleSnapshot };

export async function reconcileGlobalBookingSettlement(input: {
  env: Env;
  executor: BookingLifecycleSqlExecutor & SettlementEffectSqlExecutor;
  bookingId: string;
  nowUtc: string;
  confirmPollMs?: number[];
}): Promise<ReconcileGlobalBookingSettlementResult> {
  const repo = createBookingLifecycleWriteRepository(input.executor);
  const booking = await repo.getBooking(input.bookingId);
  if (!booking || !UNFINISHED_INTENT_STATES.has(booking.status)) return { outcome: "skipped" };
  if (booking.refundCents == null) throw new Error("booking_settlement_intent_missing_refund_decision");
  if (!Number.isInteger(booking.refundCents) || booking.refundCents < 0 || booking.refundCents > booking.grossCents) {
    throw new Error("booking_settlement_intent_refund_out_of_range");
  }
  const refundCents = booking.refundCents;
  const payoutCents = await computeRetainedHostPayout(booking.grossCents, refundCents, booking.platformFeeBps);
  if (refundCents > 0) requireSettlementAddress(booking.fundingWalletAddress, "booking_refund_destination_missing");
  if (payoutCents > 0) requireSettlementAddress(booking.hostPayoutWalletAddress, "booking_payout_destination_missing");

  const settled = await executeSettlement({
    ctx: { env: input.env, executor: input.executor, nowUtc: input.nowUtc, confirmPollMs: input.confirmPollMs },
    booking,
    fromStatus: CANCELLED_STATES.has(booking.status) ? "confirmed" : "live",
    intentState: booking.status as SettlementIntentState,
    refundCents,
  });
  return { outcome: "resumed", booking: settled };
}

export type AttachGlobalBookingSessionResult =
  | { ok: false; reason: "not_found" | "not_attachable" }
  | { ok: true; party: AttendanceParty; sessionId: string; channel: string; agora: AgoraBlock };

export async function attachGlobalBookingSession(input: {
  env: Env;
  executor: BookingLifecycleSqlExecutor;
  bookingId: string;
  actorUserId: string;
  nowUtc: string;
}): Promise<AttachGlobalBookingSessionResult> {
  const repo = createBookingLifecycleWriteRepository(input.executor);
  const booking = await repo.getBooking(input.bookingId);
  const party = booking ? actorParty(booking, input.actorUserId) : null;
  if (!booking || !party) return { ok: false, reason: "not_found" };
  if (!ATTACHABLE_STATES.has(booking.status)) return { ok: false, reason: "not_attachable" };

  const channel = deriveBookingChannel(input.bookingId);
  const uid = randomAgoraUid();
  const agora = await buildAgoraBlock({ env: input.env, channel, uid });
  const sessionId = `bas_${crypto.randomUUID()}`;
  const session = await repo.attachAttendanceSession({
    sessionId,
    bookingId: input.bookingId,
    party,
    userId: input.actorUserId,
    agoraUid: uid,
    attachedAt: input.nowUtc,
  });
  if (!session) return { ok: false, reason: "not_attachable" };
  await repo.setBookingLiveRoomIfUnset(input.bookingId, channel, input.nowUtc);
  return { ok: true, party, sessionId, channel, agora };
}

export type GlobalHeartbeatResult = { ok: false; reason: "not_found" } | { ok: true };

export async function heartbeatGlobalBookingSession(input: {
  executor: BookingLifecycleSqlExecutor;
  bookingId: string;
  actorUserId: string;
  sessionId: string;
  nowUtc: string;
}): Promise<GlobalHeartbeatResult> {
  const result = await createBookingLifecycleWriteRepository(input.executor).heartbeatAttendanceSession({
    heartbeatId: `bah_${crypto.randomUUID()}`,
    sessionId: input.sessionId,
    bookingId: input.bookingId,
    userId: input.actorUserId,
    seenAt: input.nowUtc,
  });
  return result.ok ? { ok: true } : { ok: false, reason: "not_found" };
}
