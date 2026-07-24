import type { Env } from "../../env";
import type { UserRepository } from "../auth/repositories";
import {
  confirmGlobalBookingHold,
  type BookingConfirmSqlExecutor,
} from "./booking-confirm-service";
import { createPaymentIntentRepository } from "./payment-intent-repository";

const DEFAULT_LIMIT = 100;
const DEFAULT_DEADLINE_MS = 20_000;
const STALE_AFTER_MS = 30 * 60 * 1000;

export function isBookingPaymentReverificationCronEnabled(env: Env): boolean {
  return String(env.BOOKINGS_PAYMENT_REVERIFICATION_CRON_ENABLED ?? "").trim().toLowerCase() === "true";
}

export interface BookingPaymentReverificationSummary {
  enabled: boolean;
  checked: number;
  booked: number;
  refundPending: number;
  unresolved: number;
  rejected: number;
  stale: number;
  errors: number;
  deadlineReached: boolean;
  fatal: boolean;
}

export function emptyBookingPaymentReverificationSummary(
  enabled: boolean,
): BookingPaymentReverificationSummary {
  return {
    enabled,
    checked: 0,
    booked: 0,
    refundPending: 0,
    unresolved: 0,
    rejected: 0,
    stale: 0,
    errors: 0,
    deadlineReached: false,
    fatal: false,
  };
}

export async function sweepClaimedBookingPaymentIntents(input: {
  env: Env;
  client: BookingConfirmSqlExecutor;
  userRepository: UserRepository;
  maxIntents?: number;
  deadlineMs?: number;
  now?: () => number;
}): Promise<BookingPaymentReverificationSummary> {
  const enabled = isBookingPaymentReverificationCronEnabled(input.env);
  const summary = emptyBookingPaymentReverificationSummary(enabled);
  if (!enabled) return summary;

  const now = input.now ?? (() => Date.now());
  const startedAt = now();
  const maxIntents = Math.max(1, Math.trunc(input.maxIntents ?? DEFAULT_LIMIT));
  const deadlineMs = Math.max(1, Math.trunc(input.deadlineMs ?? DEFAULT_DEADLINE_MS));

  try {
    const records = await createPaymentIntentRepository(input.client)
      .listClaimedUnresolvedPaymentIntents(maxIntents);
    for (const record of records) {
      if (now() - startedAt >= deadlineMs) {
        summary.deadlineReached = true;
        break;
      }
      summary.checked += 1;
      const nowMs = now();
      const nowUtc = new Date(nowMs).toISOString();
      // Verification retries update updated_at on every pass. Age from the immutable hold
      // deadline so a repeatedly-pending transaction still crosses the operator alert threshold.
      if (nowMs - Date.parse(record.intent.holdExpiresAt) >= STALE_AFTER_MS) summary.stale += 1;

      try {
        const result = await confirmGlobalBookingHold({
          env: input.env,
          executor: input.client,
          userRepository: input.userRepository,
          holdId: record.intent.holdId,
          bookerUserId: record.bookerUserId,
          fundingTxRef: record.intent.claimedTxRef as string,
          walletAttachmentId: record.intent.consumedWalletAttachmentId as string,
          nowUtc,
        });
        if (result.ok) {
          summary.booked += 1;
        } else if (result.reason === "hold_expired_refund_pending") {
          summary.refundPending += 1;
        } else if (result.reason === "payment_rejected") {
          summary.rejected += 1;
        } else if (result.reason === "payment_pending" || result.reason === "verification_in_progress") {
          summary.unresolved += 1;
        } else {
          summary.errors += 1;
          console.error("[booking-payment-reverification] item failed", JSON.stringify({
            paymentIntentId: record.intent.paymentIntentId,
            code: result.reason,
            incidentId: crypto.randomUUID(),
          }));
        }
      } catch (error) {
        summary.errors += 1;
        console.error("[booking-payment-reverification] item crashed", JSON.stringify({
          paymentIntentId: record.intent.paymentIntentId,
          code: error instanceof Error ? error.name : "unknown",
          incidentId: crypto.randomUUID(),
        }));
      }
    }
  } catch {
    summary.errors += 1;
    summary.fatal = true;
  }
  return summary;
}
