import { HttpError } from "../errors"

export type PermanentPreviewFailure = {
  code: string
  message: string
  status: number
  details: Record<string, unknown> | null
}

// A deterministic fault (bytes that disagree with their declared hash, a bundle with no
// preview window) fails identically on every attempt. The preview container and the job
// handler both need to tell these apart from transient outages: the container so it does
// not report them as a retryable 502, the handler so it does not spend every remaining
// attempt re-downloading bytes that can never hash differently.
export function permanentPreviewFailure(error: unknown): PermanentPreviewFailure | null {
  if (!(error instanceof HttpError)) return null
  if (error.retryable || error.status < 400 || error.status >= 500) return null
  return {
    code: error.code,
    message: error.message,
    status: error.status,
    details: error.details,
  }
}

export function permanentPreviewFailureCode(error: unknown): string | null {
  return permanentPreviewFailure(error)?.code ?? null
}
