export const SUBMIT_TRACE_HEADER = "x-pirate-submit-trace-id"

export type SubmitTraceFields = Record<string, unknown>

function nowMs(): number {
  return Date.now()
}

function elapsedMs(sinceMs: number): number {
  return Date.now() - sinceMs
}

function safeHeaderValue(value: string | undefined | null): string | null {
  const text = value?.trim()
  return text ? text : null
}

function submitTraceId(value: string | undefined | null): string | null {
  const text = safeHeaderValue(value)
  if (!text) return null
  return /^[a-z0-9_:-]{1,80}$/iu.test(text) ? text : null
}

export function submitTraceRequestFields(input: {
  contentLengthHeader?: string | null
  sessionIdHeader?: string | null
  submitTraceHeader?: string | null
}): SubmitTraceFields {
  const fields: SubmitTraceFields = {}
  const traceId = submitTraceId(input.submitTraceHeader)
  if (traceId) {
    fields.submit_trace_id = traceId
  }
  const sessionId = safeHeaderValue(input.sessionIdHeader)
  if (sessionId) {
    fields.session_id_suffix = sessionId.slice(-8)
  }
  const contentLength = Number.parseInt(input.contentLengthHeader ?? "", 10)
  if (Number.isFinite(contentLength) && contentLength >= 0) {
    fields.content_length_bytes = contentLength
  }
  return fields
}

export async function withSubmitTraceTiming<T>(
  message: string,
  fields: SubmitTraceFields,
  run: () => Promise<T>,
): Promise<T> {
  const startedAtMs = nowMs()
  console.info(`${message}:start`, fields)
  try {
    const result = await run()
    console.info(`${message}:done`, {
      ...fields,
      duration_ms: elapsedMs(startedAtMs),
    })
    return result
  } catch (error) {
    console.warn(`${message}:failed`, {
      ...fields,
      duration_ms: elapsedMs(startedAtMs),
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}
