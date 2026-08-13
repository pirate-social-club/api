import type { Env } from "../../../env"

function enabled(value: string | undefined): boolean {
  return String(value ?? "").trim().toLowerCase() === "true"
}

function boundedSeconds(value: string | undefined, fallback: number, maximum: number): number {
  const parsed = Number(String(value ?? "").trim())
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= maximum ? parsed : fallback
}

export function handleClaimIntentsEnabled(env: Env): boolean {
  return enabled(env.COMMUNITY_HANDLE_CLAIM_INTENTS_ENABLED)
}

export function handleClaimRefundsEnabled(env: Env): boolean {
  // Recovery is deliberately independent from new-intent admission. An
  // incident may stop creating or adopting intents while already-funded
  // intents must continue draining to refund or completion.
  return enabled(env.COMMUNITY_HANDLE_CLAIM_REFUNDS_ENABLED)
}

export function resolveHandleClaimPaymentClockSkewSeconds(env: Env): number {
  return boundedSeconds(env.COMMUNITY_HANDLE_CLAIM_PAYMENT_CLOCK_SKEW_SECONDS, 30, 300)
}

export function resolveFundedHandleReservationSeconds(env: Env): number {
  return boundedSeconds(env.COMMUNITY_HANDLE_CLAIM_FUNDED_RESERVATION_SECONDS, 24 * 60 * 60, 7 * 24 * 60 * 60)
}

export function resolveHandleClaimAuthorizationReleaseGraceSeconds(env: Env): number {
  return boundedSeconds(
    env.COMMUNITY_HANDLE_CLAIM_AUTHORIZATION_RELEASE_GRACE_SECONDS,
    24 * 60 * 60,
    7 * 24 * 60 * 60,
  )
}
