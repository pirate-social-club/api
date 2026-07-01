import { getAddress } from "ethers";

import type { Env } from "../../env";
import { badRequestError, conflictError } from "../errors";
import { parseExpectedEvmAddress } from "../evm-signer";
import {
  operatorSigningCoordinatorName,
  type OperatorSettleRequest,
  type OperatorSettleResult,
  type OperatorSigningCoordinatorDO,
} from "../communities/bookings/operator-signing-coordinator-do";
import {
  resolveBookingSettlementChainId,
  resolveBookingSettlementOperatorAddress,
} from "./booking-settlement-config";
import {
  createSettlementEffectWriteRepository,
  type SettlementEffectSqlExecutor,
} from "./settlement-effect-repository";

export interface GlobalBookingOperatorEffect {
  kind: "payout" | "refund";
  toUserId: string;
  recipientAddress: string;
  amountCents: number;
  bookingId: string;
  sourceCommunityId: string;
  idempotencyKey: string;
}

interface GlobalBookingOperatorEffectContext {
  env: Env;
  executor: SettlementEffectSqlExecutor;
  nowUtc: string;
  confirmPollMs?: number[];
}

export interface GlobalBookingSettlementCoordinator {
  settle(req: OperatorSettleRequest): Promise<OperatorSettleResult>;
  confirm(req: OperatorSettleRequest, txHash: string): Promise<OperatorSettleResult>;
  reconcile(req: OperatorSettleRequest): Promise<OperatorSettleResult>;
}

let coordinatorForTests: GlobalBookingSettlementCoordinator | null = null;
let confirmPollPlanForTests: number[] | null = null;

export function setGlobalBookingSettlementCoordinatorForTests(coordinator: GlobalBookingSettlementCoordinator | null): void {
  coordinatorForTests = coordinator;
}

export function setGlobalBookingSettlementConfirmPollPlanForTests(delaysMs: number[] | null): void {
  confirmPollPlanForTests = delaysMs;
}

function realCoordinator(env: Env): GlobalBookingSettlementCoordinator {
  const ns = env.OPERATOR_SIGNING_COORDINATOR as DurableObjectNamespace<OperatorSigningCoordinatorDO> | undefined;
  if (!ns) throw badRequestError("OPERATOR_SIGNING_COORDINATOR binding is not configured");
  const stub = ns.getByName(operatorSigningCoordinatorName(resolveBookingSettlementOperatorAddress(env), resolveBookingSettlementChainId(env)));
  return {
    settle: (req) => stub.settle(req),
    confirm: (req, txHash) => stub.confirm(req, txHash),
    reconcile: (req) => stub.reconcile(req),
  };
}

function coordinator(env: Env): GlobalBookingSettlementCoordinator {
  return coordinatorForTests ?? realCoordinator(env);
}

const DEFAULT_CONFIRM_POLL_MS = [500, 1000, 2000, 2000, 2000, 3000];
const MAX_RECONCILE_ATTEMPTS = 3;

function normalizeRecipientAddress(raw: string): string {
  const parsed = parseExpectedEvmAddress(raw);
  if (!parsed) throw badRequestError("Booking settlement recipient address is invalid");
  return getAddress(parsed);
}

function effectKind(effect: GlobalBookingOperatorEffect): "booking_payout" | "booking_refund" {
  return effect.kind === "refund" ? "booking_refund" : "booking_payout";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const BOOKING_SETTLEMENT_ERROR_KIND = Symbol.for("pirate.globalBookingSettlementErrorKind");
type BookingSettlementErrorKind = "pending" | "terminal";

function settlementError(message: string, kind: BookingSettlementErrorKind): Error {
  const error = conflictError(message) as Error & { [BOOKING_SETTLEMENT_ERROR_KIND]?: BookingSettlementErrorKind };
  error[BOOKING_SETTLEMENT_ERROR_KIND] = kind;
  return error;
}

export function globalBookingSettlementErrorKind(error: unknown): BookingSettlementErrorKind | null {
  if (error && typeof error === "object" && BOOKING_SETTLEMENT_ERROR_KIND in error) {
    return (error as { [BOOKING_SETTLEMENT_ERROR_KIND]?: BookingSettlementErrorKind })[BOOKING_SETTLEMENT_ERROR_KIND] ?? null;
  }
  return null;
}

export async function executeGlobalBookingOperatorEffect(
  ctx: GlobalBookingOperatorEffectContext,
  effect: GlobalBookingOperatorEffect,
): Promise<{ txRef: string }> {
  if (effect.amountCents <= 0) throw badRequestError("Booking settlement amount must be positive");
  const recipient = normalizeRecipientAddress(effect.recipientAddress);
  const kind = effectKind(effect);
  const repo = createSettlementEffectWriteRepository(ctx.executor);
  const req: OperatorSettleRequest = {
    communityId: effect.sourceCommunityId || "global",
    bookingId: effect.bookingId,
    effectKind: kind,
    amountCents: effect.amountCents,
    recipientAddress: recipient,
  };

  const begun = await repo.beginSettlementEffectAttempt({
    bookingId: effect.bookingId,
    effectKind: kind,
    idempotencyKey: effect.idempotencyKey,
    amountCents: effect.amountCents,
    recipientAddress: recipient,
    nowUtc: ctx.nowUtc,
  });
  if (!begun.ok) throw conflictError(`Booking settlement effect could not be reserved: ${begun.reason}`);
  if (begun.effect.status === "confirmed") {
    if (!begun.effect.settlementRef) throw new Error("confirmed_booking_settlement_effect_missing_settlement_ref");
    return { txRef: begun.effect.settlementRef };
  }

  let settled = await coordinator(ctx.env).settle(req);
  for (let i = 0; (settled.state === "prepared" || settled.state === "reconciliation_required") && i < MAX_RECONCILE_ATTEMPTS; i++) {
    settled = await coordinator(ctx.env).reconcile(req);
  }

  await mirrorCoordinator(ctx, effect, settled);
  if (settled.state === "confirmed") {
    await ledgerConfirm(ctx, effect, settled.txHash!);
    return { txRef: settled.txHash! };
  }
  if (settled.state === "replaced" || settled.state === "failed_onchain") {
    throw settlementError(`Booking settlement terminal at coordinator (${settled.state}); reconciliation required`, "terminal");
  }
  if (settled.state === "reserving" || settled.state === "failed_preparation") {
    throw settlementError("Booking settlement is not yet broadcast (retryable)", "pending");
  }
  if (!settled.txHash) throw conflictError("Booking settlement broadcast missing transaction hash");

  const confirmed = await pollConfirm(ctx, req, settled.txHash);
  await mirrorCoordinator(ctx, effect, confirmed);
  if (confirmed.state === "confirmed") {
    await ledgerConfirm(ctx, effect, confirmed.txHash ?? settled.txHash);
    return { txRef: confirmed.txHash ?? settled.txHash };
  }
  if (confirmed.state === "failed_onchain" || confirmed.state === "replaced") {
    throw settlementError(`Booking settlement terminal at coordinator (${confirmed.state}); reconciliation required`, "terminal");
  }
  throw settlementError("Booking settlement confirmation pending (retryable)", "pending");
}

export async function executeGlobalBookingOrphanPaymentRefund(
  ctx: {
    env: Env;
    paymentIntentId: string;
    recipientAddress: string;
    amountCents: number;
    confirmPollMs?: number[];
  },
): Promise<{ txRef: string }> {
  if (ctx.amountCents <= 0) throw badRequestError("Booking settlement amount must be positive");
  const recipient = normalizeRecipientAddress(ctx.recipientAddress);
  const req: OperatorSettleRequest = {
    communityId: "global",
    bookingId: `payment_intent:${ctx.paymentIntentId}`,
    effectKind: "booking_refund",
    amountCents: ctx.amountCents,
    recipientAddress: recipient,
  };

  let settled = await coordinator(ctx.env).settle(req);
  for (let i = 0; (settled.state === "prepared" || settled.state === "reconciliation_required") && i < MAX_RECONCILE_ATTEMPTS; i++) {
    settled = await coordinator(ctx.env).reconcile(req);
  }
  if (settled.state === "confirmed") return { txRef: settled.txHash! };
  if (settled.state === "replaced" || settled.state === "failed_onchain") {
    throw settlementError(`Booking orphan payment refund terminal at coordinator (${settled.state}); reconciliation required`, "terminal");
  }
  if (settled.state === "reserving" || settled.state === "failed_preparation") {
    throw settlementError("Booking orphan payment refund is not yet broadcast (retryable)", "pending");
  }
  if (!settled.txHash) throw conflictError("Booking orphan payment refund broadcast missing transaction hash");

  const confirmed = await pollConfirm(ctx, req, settled.txHash);
  if (confirmed.state === "confirmed") return { txRef: confirmed.txHash ?? settled.txHash };
  if (confirmed.state === "failed_onchain" || confirmed.state === "replaced") {
    throw settlementError(`Booking orphan payment refund terminal at coordinator (${confirmed.state}); reconciliation required`, "terminal");
  }
  throw settlementError("Booking orphan payment refund confirmation pending (retryable)", "pending");
}

async function mirrorCoordinator(ctx: GlobalBookingOperatorEffectContext, effect: GlobalBookingOperatorEffect, result: OperatorSettleResult): Promise<void> {
  const mirrored = await createSettlementEffectWriteRepository(ctx.executor).mirrorSettlementCoordinatorEffect({
    idempotencyKey: effect.idempotencyKey,
    coordinatorRef: result.idempotencyKey,
    coordinatorState: result.state,
    settlementRef: result.txHash,
    broadcastNonce: result.nonce,
    nowUtc: ctx.nowUtc,
  });
  if (!mirrored.ok) throw conflictError(`Booking settlement coordinator mirror failed: ${mirrored.reason}`);
}

async function ledgerConfirm(ctx: GlobalBookingOperatorEffectContext, effect: GlobalBookingOperatorEffect, txHash: string): Promise<void> {
  const confirmed = await createSettlementEffectWriteRepository(ctx.executor).confirmSettlementEffect(effect.idempotencyKey, txHash, ctx.nowUtc);
  if (!confirmed) throw conflictError("Booking settlement confirmation transaction reference mismatch");
}

async function pollConfirm(ctx: { env: Env; confirmPollMs?: number[] }, req: OperatorSettleRequest, txHash: string): Promise<OperatorSettleResult> {
  const plan = ctx.confirmPollMs ?? confirmPollPlanForTests ?? DEFAULT_CONFIRM_POLL_MS;
  let result = await coordinator(ctx.env).confirm(req, txHash);
  for (let i = 0; result.state === "broadcast" && i < plan.length; i++) {
    await sleep(plan[i]);
    result = await coordinator(ctx.env).confirm(req, txHash);
  }
  return result;
}
