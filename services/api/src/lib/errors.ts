import type { GateFailureDetails } from "../types"

export class HttpError extends Error {
  readonly status: number
  readonly code: string
  readonly retryable: boolean
  readonly details: Record<string, unknown> | null

  constructor(status: number, code: string, message: string, retryable = false, details: Record<string, unknown> | null = null) {
    super(message)
    this.status = status
    this.code = code
    this.retryable = retryable
    this.details = details
  }
}

export function authError(message: string): HttpError {
  return new HttpError(401, "auth_error", message)
}

export function badRequestError(message: string): HttpError {
  return new HttpError(400, "bad_request", message)
}

export function paymentRequired(message: string, details: Record<string, unknown> | null = null): HttpError {
  return new HttpError(402, "payment_required", message, true, details)
}

export function verificationRequired(message: string): HttpError {
  return new HttpError(403, "verification_required", message)
}

export function eligibilityFailed(message: string, details: Record<string, unknown> | null = null): HttpError {
  return new HttpError(403, "eligibility_failed", message, false, details)
}

export function membershipRequired(message: string, details: Record<string, unknown> | null = null): HttpError {
  return new HttpError(403, "membership_required", message, false, details)
}

export function banned(message: string, details: Record<string, unknown> | null = null): HttpError {
  return new HttpError(403, "banned", message, false, details)
}

export function commentsLocked(message: string, details: Record<string, unknown> | null = null): HttpError {
  return new HttpError(403, "comments_locked", message, false, details)
}

export function gateUnsatisfied(message: string, details: Record<string, unknown> | null = null): HttpError {
  return new HttpError(403, "gate_unsatisfied", message, false, details)
}

export function rateLimited(message: string, details: Record<string, unknown> | null = null): HttpError {
  return new HttpError(429, "rate_limited", message, true, details)
}

export function gateFailedWithDetails(message: string, details: GateFailureDetails): HttpError {
  return new HttpError(403, "gate_failed", message, false, details as Record<string, unknown>)
}

export const SONG_CONTENT_HASH_MISMATCH_CODE = "song_content_hash_mismatch"

// Stored bytes disagree with the hash the uploader declared. Retrying re-downloads
// the same bytes and fails identically, so this must never be treated as transient.
export function songContentHashMismatchError(
  message: string,
  details: Record<string, unknown> | null = null,
): HttpError {
  return new HttpError(422, SONG_CONTENT_HASH_MISMATCH_CODE, message, false, details)
}

export function conflictError(message: string, details: Record<string, unknown> | null = null): HttpError {
  return new HttpError(409, "conflict", message, false, details)
}

/**
 * A 409 that a client can act on programmatically. A money-moving flow must be able to
 * tell "this quote expired, start over" apart from "this transaction was already
 * consumed — stop, and never resubmit"; a generic `conflict` code cannot express that.
 */
export function codedConflictError(
  code: string,
  message: string,
  details: Record<string, unknown> | null = null,
): HttpError {
  return new HttpError(409, code, message, false, details)
}

export function analysisBlocked(message: string): HttpError {
  return new HttpError(422, "analysis_blocked", message)
}

export function commentMediaRejected(message: string, details: Record<string, unknown> | null = null): HttpError {
  return new HttpError(400, "comment_media_rejected", message, false, details)
}

export function notFoundError(message: string): HttpError {
  return new HttpError(404, "not_found", message)
}

export function structuredSurfaceDisabled(message: string, details: Record<string, unknown> | null = null): HttpError {
  return new HttpError(403, "structured_surface_disabled", message, false, details)
}

export function providerUnavailable(
  message: string,
  details: Record<string, unknown> | null = null,
  retryable = true,
): HttpError {
  return new HttpError(502, "provider_unavailable", message, retryable, details)
}

export function fundingConfirmationTimeout(message: string, details: Record<string, unknown> | null = null): HttpError {
  return new HttpError(504, "funding_confirmation_timeout", message, true, details)
}

export function internalError(message: string, details: Record<string, unknown> | null = null): HttpError {
  return new HttpError(500, "internal_error", message, false, details)
}

export function notImplementedError(message: string): HttpError {
  return new HttpError(501, "not_implemented", message)
}

export type ErrorResponseBody = {
  code: string
  message: string
  retryable?: boolean
  details?: Record<string, unknown> | null
  request_id?: string
}

export function errorResponse(error: unknown, requestId: string | null = null): { status: number; body: ErrorResponseBody } {
  const requestIdField = requestId ? { request_id: requestId } : {}
  if (error instanceof HttpError) {
    return {
      status: error.status,
      body: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        ...(error.details ? { details: error.details } : {}),
        ...requestIdField,
      },
    }
  }

  return {
    status: 500,
    body: {
      code: "internal_error",
      // Never echo the raw exception message: unknown failures can carry
      // database URLs, shard routing details, or driver internals. The full
      // error is logged server-side keyed by request_id.
      message: "Internal server error",
      // Unknown failures may be transient (deploy rollover, database/network
      // blip, overloaded runtime). Deliberate terminal failures must use a
      // typed HttpError whose explicit retryability is preserved above.
      retryable: true,
      ...requestIdField,
    },
  }
}
