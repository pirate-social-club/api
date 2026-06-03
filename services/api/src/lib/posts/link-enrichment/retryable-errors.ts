const RETRYABLE_LINK_SUMMARY_HTTP_ERROR = /OpenRouter link summary request failed with http_(?:401|403|408|409|425|429|5\d\d)\b/u
const RETRYABLE_LINK_SUMMARY_NETWORK_ERROR = /(?:fetch failed|network|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)/iu

export function isRetryableLinkSummaryErrorMessage(message: string): boolean {
  return RETRYABLE_LINK_SUMMARY_HTTP_ERROR.test(message)
    || message.includes("OpenRouter link summary response was not valid JSON")
    || message.includes("OpenRouter link summary response was empty")
    || message.includes("OpenRouter link summary response JSON had an unexpected shape")
    || RETRYABLE_LINK_SUMMARY_NETWORK_ERROR.test(message)
}

export function isRetryableLinkSummaryError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  return error.name === "AbortError"
    || error.name === "TimeoutError"
    || isRetryableLinkSummaryErrorMessage(error.message)
}
