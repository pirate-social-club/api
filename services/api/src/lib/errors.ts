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

export function verificationRequired(message: string): HttpError {
  return new HttpError(403, "verification_required", message)
}

export function eligibilityFailed(message: string): HttpError {
  return new HttpError(403, "eligibility_failed", message)
}

export function gateFailed(message: string): HttpError {
  return new HttpError(403, "gate_failed", message)
}

export function gateFailedWithDetails(message: string, details: GateFailureDetails): HttpError {
  return new HttpError(403, "gate_failed", message, false, details as Record<string, unknown>)
}

export function conflictError(message: string): HttpError {
  return new HttpError(409, "conflict", message)
}

export function analysisBlocked(message: string): HttpError {
  return new HttpError(422, "analysis_blocked", message)
}

export function notFoundError(message: string): HttpError {
  return new HttpError(404, "not_found", message)
}

export function providerUnavailable(message: string, details: Record<string, unknown> | null = null): HttpError {
  return new HttpError(502, "provider_unavailable", message, true, details)
}

export function internalError(message: string, details: Record<string, unknown> | null = null): HttpError {
  return new HttpError(500, "internal_error", message, false, details)
}

export function notImplementedError(message: string): HttpError {
  return new HttpError(501, "not_implemented", message)
}

export function errorResponse(error: unknown): { status: number; body: { code: string; message: string; retryable?: boolean; details?: Record<string, unknown> | null } } {
  if (error instanceof HttpError) {
    return {
      status: error.status,
      body: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        ...(error.details ? { details: error.details } : {}),
      },
    }
  }

  const message = error instanceof Error ? error.message : "Internal server error"
  return {
    status: 500,
    body: {
      code: "internal_error",
      message,
      retryable: false,
    },
  }
}
