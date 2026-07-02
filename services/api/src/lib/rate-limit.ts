import { rateLimited } from "./errors"

// Shape of Cloudflare's native rate-limiter binding (configured under `ratelimits`
// in wrangler). Kept as a local interface so callers/tests don't depend on the
// generated worker types.
export interface RateLimiterBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>
}

/**
 * Enforce a per-key rate limit, throwing a 429 `rateLimited` error when exceeded.
 *
 * Fails OPEN when the binding is absent (local dev / tests / a misconfigured env)
 * so a missing limiter never breaks the request path — a warning is logged so the
 * gap is visible rather than silent. This is a best-effort abuse-reduction layer;
 * note that Cloudflare's native limiter counts per-colo, not globally.
 */
export async function enforceRateLimit(
  limiter: RateLimiterBinding | undefined | null,
  key: string,
  message: string,
  details: Record<string, unknown> = {},
): Promise<void> {
  if (!limiter) {
    console.warn("[rate-limit] limiter binding missing; allowing request", { key_prefix: key.split(":")[0] })
    return
  }
  const { success } = await limiter.limit({ key })
  if (!success) {
    throw rateLimited(message, details)
  }
}
