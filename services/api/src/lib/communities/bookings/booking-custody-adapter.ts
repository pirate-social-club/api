import { getAddress } from "ethers"

import type { Env } from "../../../env"
import { conflictError, badRequestError } from "../../errors"
import { parseExpectedEvmAddress } from "../../evm-signer"
import { openCommunityWriteClient } from "../community-read-access"
import {
  beginBookingSettlementEffectAttempt,
  confirmBookingSettlementEffect,
  mirrorBookingSettlementCoordinatorEffect,
  type BookingSettlementEffectKind,
} from "./booking-settlement-effects"
import {
  operatorSigningCoordinatorName,
  type OperatorSettleRequest,
  type OperatorSettleResult,
  type OperatorSigningCoordinatorDO,
} from "./operator-signing-coordinator-do"
import {
  resolvePirateCheckoutOperatorAddress,
  resolvePirateCheckoutSourceChainId,
} from "../commerce/checkout-config"

type CommunityRepository = Parameters<typeof openCommunityWriteClient>[1]

export interface BookingOperatorEffect {
  kind: "payout" | "refund"
  toUserId: string
  recipientAddress: string
  amountCents: number
  bookingId: string
  idempotencyKey: string
}

interface BookingOperatorEffectContext {
  env: Env
  communityRepository: CommunityRepository
  communityId: string
  nowUtc: string
  // Explicit confirmation-polling policy threaded through the call stack (NOT a mutable global):
  // the interactive path omits it (full default poll); the cron passes [] (one confirm attempt,
  // then treat as pending and resume on a later tick) so one tx can't consume the cron budget.
  confirmPollMs?: number[]
}

// Coordinator seam: the wallet-scoped Durable Object is the nonce/signing/broadcast/chain authority.
// A seam keeps the adapter unit-testable without spinning a DO; the DO has its own isolate tests.
export interface BookingSettlementCoordinator {
  settle(req: OperatorSettleRequest): Promise<OperatorSettleResult>
  confirm(req: OperatorSettleRequest, txHash: string): Promise<OperatorSettleResult>
  reconcile(req: OperatorSettleRequest): Promise<OperatorSettleResult>
}

let coordinatorForTests: BookingSettlementCoordinator | null = null
export function setBookingSettlementCoordinatorForTests(c: BookingSettlementCoordinator | null): void { coordinatorForTests = c }

function realCoordinator(env: Env): BookingSettlementCoordinator {
  const ns = env.OPERATOR_SIGNING_COORDINATOR as DurableObjectNamespace<OperatorSigningCoordinatorDO> | undefined
  if (!ns) throw badRequestError("OPERATOR_SIGNING_COORDINATOR binding is not configured")
  const stub = ns.getByName(operatorSigningCoordinatorName(resolvePirateCheckoutOperatorAddress(env), resolvePirateCheckoutSourceChainId(env)))
  return {
    settle: (req) => stub.settle(req),
    confirm: (req, txHash) => stub.confirm(req, txHash),
    reconcile: (req) => stub.reconcile(req),
  }
}
function coordinator(env: Env): BookingSettlementCoordinator { return coordinatorForTests ?? realCoordinator(env) }

// Bounded confirm polling. Tests can shorten/skip the delays.
let confirmPollPlanForTests: number[] | null = null
export function setBookingSettlementConfirmPollPlanForTests(delaysMs: number[] | null): void { confirmPollPlanForTests = delaysMs }
const DEFAULT_CONFIRM_POLL_MS = [500, 1000, 2000, 2000, 2000, 3000] // ~10.5s worst case, well under a request deadline
const MAX_RECONCILE_ATTEMPTS = 3

function normalizeRecipientAddress(raw: string): string {
  const a = parseExpectedEvmAddress(raw)
  if (!a) throw badRequestError("Booking settlement recipient address is invalid")
  return getAddress(a)
}
function effectKind(effect: BookingOperatorEffect): BookingSettlementEffectKind {
  return effect.kind === "refund" ? "booking_refund" : "booking_payout"
}
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)) }

// Tag the two non-success settlement throws with a stable kind so callers (the settlement cron)
// classify them without brittle message matching. "pending" = broadcast but not yet confirmed
// (resumable on a later tick); "terminal" = coordinator replaced/failed_onchain (never re-spend).
const BOOKING_SETTLEMENT_ERROR_KIND = Symbol.for("pirate.bookingSettlementErrorKind")
type BookingSettlementErrorKind = "pending" | "terminal"
function settlementError(message: string, kind: BookingSettlementErrorKind): Error {
  const error = conflictError(message) as Error & { [BOOKING_SETTLEMENT_ERROR_KIND]?: BookingSettlementErrorKind }
  error[BOOKING_SETTLEMENT_ERROR_KIND] = kind
  return error
}
export function bookingSettlementErrorKind(error: unknown): BookingSettlementErrorKind | null {
  if (error && typeof error === "object" && BOOKING_SETTLEMENT_ERROR_KIND in error) {
    return (error as { [BOOKING_SETTLEMENT_ERROR_KIND]?: BookingSettlementErrorKind })[BOOKING_SETTLEMENT_ERROR_KIND] ?? null
  }
  return null
}

async function withCommunityWrite<T>(ctx: BookingOperatorEffectContext, fn: (client: Awaited<ReturnType<typeof openCommunityWriteClient>>["client"]) => Promise<T>): Promise<T> {
  const handle = await openCommunityWriteClient(ctx.env, ctx.communityRepository, ctx.communityId)
  try {
    return await fn(handle.client)
  } finally {
    await handle.close()
  }
}

/**
 * Execute one booking settlement money-out. Two layers: a booking-scoped ledger mirror (idempotent
 * per effect within the community) and the wallet-scoped coordinator DO (serial nonce/sign/broadcast
 * + chain state). Returns only when the coordinator has CONFIRMED the on-chain receipt. A
 * confirmation timeout throws a retryable error and leaves both records recoverable (a later
 * reconcile resumes) — never marked failed. Terminal coordinator failures (replaced / failed_onchain)
 * are surfaced without ever creating another transaction.
 */
export async function executeBookingOperatorEffect(ctx: BookingOperatorEffectContext, effect: BookingOperatorEffect): Promise<{ txRef: string }> {
  if (effect.amountCents <= 0) throw badRequestError("Booking settlement amount must be positive")
  const recipient = normalizeRecipientAddress(effect.recipientAddress)
  const kind = effectKind(effect)
  const req: OperatorSettleRequest = { communityId: ctx.communityId, bookingId: effect.bookingId, effectKind: kind, amountCents: effect.amountCents, recipientAddress: recipient }

  // 1) Booking-scoped ledger reservation (idempotent CAS). Already-confirmed short-circuits.
  const begun = await withCommunityWrite(ctx, (client) => beginBookingSettlementEffectAttempt({
    client, communityId: ctx.communityId, bookingId: effect.bookingId, effectKind: kind,
    idempotencyKey: effect.idempotencyKey, amountCents: effect.amountCents, recipientAddress: recipient, now: ctx.nowUtc,
  }))
  if (begun.row.status === "confirmed") {
    if (!begun.row.settlement_ref) throw new Error("confirmed_booking_settlement_effect_missing_settlement_ref")
    return { txRef: begun.row.settlement_ref }
  }

  // 2) Wallet-scoped coordinator: serial nonce + sign + broadcast.
  let s = await coordinator(ctx.env).settle(req)
  // 3) Resolve transitional states (prepared = broadcast may have transiently failed) via BOUNDED reconcile.
  for (let i = 0; (s.state === "prepared" || s.state === "reconciliation_required") && i < MAX_RECONCILE_ATTEMPTS; i++) {
    s = await coordinator(ctx.env).reconcile(req)
  }

  // 4) Mirror the coordinator outcome (pointer + hash + nonce + state) onto the ledger — no signed tx.
  await mirrorCoordinator(ctx, effect, s)

  // 5) Per-state handling.
  if (s.state === "confirmed") {
    await ledgerConfirm(ctx, effect, s.txHash!)
    return { txRef: s.txHash! }
  }
  if (s.state === "replaced" || s.state === "failed_onchain") {
    // Terminal: leave the ledger submitted (never the failed -> retry path); the coordinator_state
    // mirror records the terminal reason. Never create another transaction.
    throw settlementError(`Booking settlement terminal at coordinator (${s.state}); reconciliation required`, "terminal")
  }
  if (s.state === "reserving" || s.state === "failed_preparation") {
    // Nothing broadcast; retryable. Leave records submitted for a later reconcile.
    throw settlementError("Booking settlement is not yet broadcast (retryable)", "pending")
  }
  // s.state === "broadcast": poll confirm with bounded backoff.
  if (!s.txHash) throw conflictError("Booking settlement broadcast missing transaction hash")
  const confirmed = await pollConfirm(ctx, req, s.txHash)
  await mirrorCoordinator(ctx, effect, confirmed)
  if (confirmed.state === "confirmed") {
    await ledgerConfirm(ctx, effect, confirmed.txHash ?? s.txHash)
    return { txRef: confirmed.txHash ?? s.txHash }
  }
  if (confirmed.state === "failed_onchain" || confirmed.state === "replaced") {
    throw settlementError(`Booking settlement terminal at coordinator (${confirmed.state}); reconciliation required`, "terminal")
  }
  // Confirmation did not complete within the bounded window — retryable, records left recoverable.
  throw settlementError("Booking settlement confirmation pending (retryable)", "pending")
}

async function mirrorCoordinator(ctx: BookingOperatorEffectContext, effect: BookingOperatorEffect, s: OperatorSettleResult): Promise<void> {
  await withCommunityWrite(ctx, (client) => mirrorBookingSettlementCoordinatorEffect({
    client, idempotencyKey: effect.idempotencyKey, coordinatorRef: s.idempotencyKey, coordinatorState: s.state,
    settlementRef: s.txHash, nonce: s.nonce, now: ctx.nowUtc,
  }))
}

async function ledgerConfirm(ctx: BookingOperatorEffectContext, effect: BookingOperatorEffect, txHash: string): Promise<void> {
  await withCommunityWrite(ctx, (client) => confirmBookingSettlementEffect({ client, idempotencyKey: effect.idempotencyKey, settlementRef: txHash, now: ctx.nowUtc }))
}

async function pollConfirm(ctx: BookingOperatorEffectContext, req: OperatorSettleRequest, txHash: string): Promise<OperatorSettleResult> {
  // Explicit per-call policy wins; the test global is only a fallback; otherwise the full default.
  const plan = ctx.confirmPollMs ?? confirmPollPlanForTests ?? DEFAULT_CONFIRM_POLL_MS
  // confirm() returns the chain state (pending → state stays 'broadcast'); only genuine errors
  // (missing record / hash mismatch / immutable mismatch / RPC failure) throw — those are NOT
  // retryable and propagate so the operation fails loudly rather than masquerading as "pending".
  let r = await coordinator(ctx.env).confirm(req, txHash)
  for (let i = 0; r.state === "broadcast" && i < plan.length; i++) {
    await sleep(plan[i])
    r = await coordinator(ctx.env).confirm(req, txHash)
  }
  return r
}
