import type { Context } from "hono"
import { HttpError, errorResponse } from "../lib/errors"
import { logPipelineError } from "../lib/observability/pipeline-log"
import { requestIdForContext } from "../lib/request-correlation"

export function apiErrorHandler(error: Error, c: Context): Response {
  const requestId = requestIdForContext(c)
  if (!(error instanceof HttpError) || error.status >= 500) {
    console.error("[api-worker]", `request_id=${requestId}`, error)
    const details = error instanceof HttpError ? error.details : null
    const causeDetails = details?.cause_details && typeof details.cause_details === "object"
      ? details.cause_details as Record<string, unknown>
      : null
    logPipelineError("[api-worker] unhandled request error", {
      request_id: requestId,
      route: c.req.path,
      method: c.req.method,
      status: error instanceof HttpError ? String(error.status) : "500",
      ...(typeof details?.community_id === "string" ? { community_id: details.community_id } : {}),
      ...(typeof details?.job_id === "string" ? { job_id: details.job_id } : {}),
      ...(typeof causeDetails?.operator_error_code === "string" ? { operator_error_code: causeDetails.operator_error_code } : {}),
      ...(typeof causeDetails?.operator_request_id === "string" ? { operator_request_id: causeDetails.operator_request_id } : {}),
      ...(typeof causeDetails?.operator_step === "string" ? { operator_step: causeDetails.operator_step } : {}),
      ...(typeof causeDetails?.operator_message === "string" ? { operator_message: causeDetails.operator_message } : {}),
      error: error.message,
    })
  }
  const response = errorResponse(error, requestId)
  return new Response(JSON.stringify(response.body), {
    status: response.status,
    headers: {
      "content-type": "application/json",
      "x-request-id": requestId,
    },
  })
}
