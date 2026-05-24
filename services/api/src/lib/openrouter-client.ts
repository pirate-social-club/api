const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"

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

export type OpenRouterModelsResponse = {
  data?: OpenRouterModel[]
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

function responseBodyPreview(value: string): string {
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, 500) : "<empty>"
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
      const errorBody = await response.text().catch(() => "")
      const suffix = errorBody.trim() ? `: ${errorBody.trim().slice(0, 500)}` : ""
      throw new Error(`OpenRouter ${input.errorLabel} request failed with http_${response.status}${suffix}`)
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
      throw new Error(`OpenRouter ${input.errorLabel} response was empty`)
    }

    return { body, content }
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
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
