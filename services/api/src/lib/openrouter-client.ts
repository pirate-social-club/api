const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"

export type OpenRouterChatCompletionResponse = Record<string, unknown> & {
  choices?: Array<{
    message?: {
      content?: unknown
    }
  }>
}

export function trimEnv(value: string | null | undefined): string {
  return String(value || "").trim()
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

export function resolveOpenRouterBaseUrl(value: string | null | undefined): string {
  return trimEnv(value) || DEFAULT_OPENROUTER_BASE_URL
}

export function normalizeOpenRouterMessageContent(content: unknown): string {
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
      throw new Error(`OpenRouter ${input.errorLabel} request failed with http_${response.status}`)
    }

    const body = await response.json().catch(() => null) as OpenRouterChatCompletionResponse | null
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error(`OpenRouter ${input.errorLabel} response was not valid JSON`)
    }

    const content = normalizeOpenRouterMessageContent(body.choices?.[0]?.message?.content)
    if (!content.trim()) {
      throw new Error(`OpenRouter ${input.errorLabel} response was empty`)
    }

    return { body, content }
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}
