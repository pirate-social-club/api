import { trimEnv } from "./env-strings"

const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"

/**
 * Fallback model for every OpenRouter-backed provider that has no explicit env override.
 *
 * ONE constant on purpose. When each provider carried its own literal they drifted:
 * content translation was moved to this stable id while labelling, study generation,
 * link summaries, and link translation were left on the dated preview alias
 * `google/gemini-2.5-flash-lite-preview-09-2025`. OpenRouter retired that alias, which
 * returns `http_404 No endpoints found` — a non-transient error that still burns all
 * eight retry attempts before the job dies. Prod shard community-d1-pool-0073 holds 15
 * translation jobs killed exactly that way.
 *
 * Prefer an unversioned model id here: dated preview aliases are removed upstream without
 * notice, and this value is the one used when nobody configured anything.
 */
export const DEFAULT_OPENROUTER_MODEL = "google/gemini-2.5-flash-lite"

export type OpenRouterChatCompletionResponse = Record<string, unknown> & {
  choices?: Array<{
    finish_reason?: unknown
    message?: {
      content?: unknown
      tool_calls?: unknown
    }
  }>
}

export type OpenRouterModel = {
  architecture?: {
    input_modalities?: unknown
    modality?: unknown
    output_modalities?: unknown
  } | null
  context_length?: unknown
  created?: unknown
  description?: unknown
  id?: unknown
  name?: unknown
  pricing?: {
    completion?: unknown
    prompt?: unknown
  } | null
  top_provider?: {
    context_length?: unknown
    max_completion_tokens?: unknown
  } | null
}

type OpenRouterModelsResponse = {
  data?: OpenRouterModel[]
}

export function firstTrimmedEnv(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    const trimmed = trimEnv(value)
    if (trimmed) return trimmed
  }
  return ""
}

export function parsePositiveIntegerEnv(value: string | null | undefined): number | null {
  const parsed = Number.parseInt(trimEnv(value), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function resolveOpenRouterBaseUrl(value: string | null | undefined): string {
  return trimEnv(value) || DEFAULT_OPENROUTER_BASE_URL
}

function normalizeOpenRouterMessageContent(content: unknown): string {
  if (typeof content === "string") {
    return content
  }
  if (!Array.isArray(content)) {
    return ""
  }
  return content
    .filter((part) => part && typeof part === "object" && (part as { type?: string }).type === "text")
    .map((part) => String((part as { text?: string }).text ?? ""))
    .join("")
}

function responseBodyPreview(value: string): string {
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, 500) : "<empty>"
}

export type OpenRouterHttpFailure = {
  category: "client_error" | "rate_limited" | "server_error"
  status: number
}

function openRouterHttpDetails(status: number): OpenRouterHttpFailure {
  return {
    category: status === 429 ? "rate_limited" : status >= 500 ? "server_error" : "client_error",
    status,
  }
}

export function isOpenRouterHttpFailure(error: unknown): error is { openRouterHttp: OpenRouterHttpFailure } {
  if (!error || typeof error !== "object" || !("openRouterHttp" in error)) return false
  const detail = (error as { openRouterHttp: unknown }).openRouterHttp
  return Boolean(detail) && typeof detail === "object" && typeof (detail as { status?: unknown }).status === "number"
}

export type OpenRouterDiagnostics = {
  completionTokens: number | null
  finishReason: string | null
  nativeFinishReason: string | null
  promptTokens: number | null
  reasoningTokens: number | null
  totalTokens: number | null
}

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

/**
 * Allowlisted, provider-agnostic completion metadata. Only known enum-like
 * reason strings and numeric token counts survive; provider-authored prose
 * never reaches logs, so a diagnostic can never leak model output or a
 * learner's question back out.
 */
const OPEN_ROUTER_FINISH_REASONS = new Set([
  "content_filter",
  "error",
  "function_call",
  "length",
  "stop",
  "tool_calls",
])

function finishReasonOrNull(value: unknown): string | null {
  return typeof value === "string" && OPEN_ROUTER_FINISH_REASONS.has(value) ? value : null
}

export function openRouterDiagnosticsFrom(body: OpenRouterChatCompletionResponse): OpenRouterDiagnostics {
  const choice = body.choices?.[0] as Record<string, unknown> | undefined
  const usage = body.usage as Record<string, unknown> | undefined
  const details = usage?.completion_tokens_details as Record<string, unknown> | undefined
  return {
    completionTokens: finiteNumberOrNull(usage?.completion_tokens),
    finishReason: finishReasonOrNull(choice?.finish_reason),
    nativeFinishReason: finishReasonOrNull(choice?.native_finish_reason),
    promptTokens: finiteNumberOrNull(usage?.prompt_tokens),
    reasoningTokens: finiteNumberOrNull(details?.reasoning_tokens),
    totalTokens: finiteNumberOrNull(usage?.total_tokens),
  }
}

function isRetryableOpenRouterResponseError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.message.includes("response was not valid JSON")
    || error.message.includes("response was empty")
    || error.message.includes("response JSON had an unexpected shape")
}

async function requestOpenRouterChatCompletionOnce(input: {
  apiKey: string
  baseUrl?: string | null
  body: Record<string, unknown>
  errorLabel: string
  fetcher?: typeof fetch
  timeoutMs?: number | null
}): Promise<{
  body: OpenRouterChatCompletionResponse
  content: string
}> {
  const controller = new AbortController()
  const timer = input.timeoutMs && input.timeoutMs > 0
    ? setTimeout(() => controller.abort(), input.timeoutMs)
    : null

  try {
    const response = await (input.fetcher ?? fetch)(`${resolveOpenRouterBaseUrl(input.baseUrl).replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(input.body),
      signal: controller.signal,
    })

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "")
      const suffix = errorBody.trim() ? `: ${errorBody.trim().slice(0, 500)}` : ""
      // The message keeps the body for callers that debug against it, but the
      // status and category are attached structurally so privacy-sensitive
      // callers can classify a failure without touching provider-authored text.
      throw Object.assign(
        new Error(`OpenRouter ${input.errorLabel} request failed with http_${response.status}${suffix}`),
        { openRouterHttp: openRouterHttpDetails(response.status) },
      )
    }

    const responseText = await response.text().catch(() => "")
    let body: OpenRouterChatCompletionResponse | null = null
    try {
      body = JSON.parse(responseText) as OpenRouterChatCompletionResponse | null
    } catch {
      const contentType = response.headers.get("content-type") || "unknown"
      throw new Error(
        `OpenRouter ${input.errorLabel} response was not valid JSON `
          + `(http_${response.status}, content-type ${contentType}, body ${responseBodyPreview(responseText)})`,
      )
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error(`OpenRouter ${input.errorLabel} response JSON had an unexpected shape`)
    }

    const content = normalizeOpenRouterMessageContent(body.choices?.[0]?.message?.content)
    const toolCalls = body.choices?.[0]?.message?.tool_calls
    if (!content.trim() && !Array.isArray(toolCalls)) {
      // Carry the provider's own account of why nothing came back. Without it an
      // empty response is indistinguishable from a truncation caused by our own
      // completion-token ceiling, which is a very different fix. Sanitized here
      // so no provider-authored text can escape into logs.
      throw Object.assign(new Error(`OpenRouter ${input.errorLabel} response was empty`), {
        openRouterDiagnostics: openRouterDiagnosticsFrom(body),
      })
    }

    return { body, content }
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

export async function requestOpenRouterChatCompletion(input: {
  apiKey: string
  baseUrl?: string | null
  body: Record<string, unknown>
  errorLabel: string
  fetcher?: typeof fetch
  timeoutMs?: number | null
}): Promise<{
  body: OpenRouterChatCompletionResponse
  content: string
}> {
  const maxAttempts = 2
  let lastError: unknown = null
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await requestOpenRouterChatCompletionOnce(input)
    } catch (error) {
      lastError = error
      if (attempt < maxAttempts && isRetryableOpenRouterResponseError(error)) {
        continue
      }
      throw error
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`OpenRouter ${input.errorLabel} request failed`)
}

export async function requestOpenRouterModels(input: {
  apiKey: string
  baseUrl?: string | null
  fetcher?: typeof fetch
  timeoutMs?: number | null
}): Promise<OpenRouterModel[]> {
  const controller = new AbortController()
  const timer = input.timeoutMs && input.timeoutMs > 0
    ? setTimeout(() => controller.abort(), input.timeoutMs)
    : null

  try {
    const response = await (input.fetcher ?? fetch)(
      `${resolveOpenRouterBaseUrl(input.baseUrl).replace(/\/+$/, "")}/models/user`,
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${input.apiKey}`,
          accept: "application/json",
        },
        signal: controller.signal,
      },
    )

    if (!response.ok) {
      throw new Error(`OpenRouter models request failed with http_${response.status}`)
    }

    const body = await response.json().catch(() => null) as OpenRouterModelsResponse | null
    if (!body || typeof body !== "object" || !Array.isArray(body.data)) {
      throw new Error("OpenRouter models response was not valid JSON")
    }

    return body.data
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}
