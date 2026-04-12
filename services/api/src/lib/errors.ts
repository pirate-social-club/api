export class HttpError extends Error {
  readonly status: number
  readonly code: string
  readonly retryable: boolean

  constructor(status: number, code: string, message: string, retryable = false) {
    super(message)
    this.status = status
    this.code = code
    this.retryable = retryable
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

export function conflictError(message: string): HttpError {
  return new HttpError(409, "conflict", message)
}

export function notFoundError(message: string): HttpError {
  return new HttpError(404, "not_found", message)
}

export function internalError(message: string): HttpError {
  return new HttpError(500, "internal_error", message)
}

export function notImplementedError(message: string): HttpError {
  return new HttpError(501, "not_implemented", message)
}

export function errorResponse(error: unknown): { status: number; body: { code: string; message: string; retryable?: boolean } } {
  if (error instanceof HttpError) {
    return {
      status: error.status,
      body: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
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
