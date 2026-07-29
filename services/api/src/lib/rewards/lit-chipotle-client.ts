const DEFAULT_BASE_URL = "https://api.chipotle.litprotocol.com"
const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_RETRY_BASE_MS = 250

export type LitChipotleErrorCode =
  | "billing_required"
  | "invalid_request"
  | "action_failed"
  | "overloaded"
  | "upstream"
  | "timeout"
  | "network"
  | "invalid_response"

export type LitTransportCategory =
  | "certificate"
  | "tls"
  | "dns"
  | "connection_reset"
  | "connection_refused"
  | "connection_lost"
  | "redirect"
  | "timeout"
  | "fetch_failed"
  | "unclassified"

export type LitErrorToken =
  | "unauthorized_action"
  | "action_fetch_failed"
  | "invalid_params"
  | "timeout"
  | "other_json_error"
  | "other_json_message"
  | "other_json_nested_error"
  | "other_json_unknown"
  | "other_plain_text"
  | "other"

export class LitChipotleError extends Error {
  constructor(
    readonly code: LitChipotleErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    readonly transportCategory?: LitTransportCategory,
    readonly litErrorToken?: LitErrorToken,
  ) {
    super(message)
    this.name = "LitChipotleError"
  }
}

export type LitActionSource =
  | { code: string; ipfsId?: never }
  | { code?: never; ipfsId: string }

export type LitActionExecution = LitActionSource & {
  jsParams: Record<string, unknown> | null
}

export type LitChipotleClientOptions = {
  usageApiKey: string
  baseUrl?: string
  timeoutMs?: number
  maxAttempts?: number
  retryBaseMs?: number
  fetchImpl?: typeof fetch
  sleep?: (milliseconds: number) => Promise<void>
}

type LitActionResponse = {
  response: unknown
  logs: string
  has_error: boolean
}

function positiveInteger(value: number | undefined, fallback: number, field: string): number {
  const resolved = value ?? fallback
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new LitChipotleError("invalid_request", `${field} must be a positive integer`, false)
  }
  return resolved
}

function endpoint(baseUrl: string): string {
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    throw new LitChipotleError("invalid_request", "Lit API base URL is invalid", false)
  }
  if (parsed.protocol !== "https:") {
    throw new LitChipotleError("invalid_request", "Lit API base URL must use HTTPS", false)
  }
  parsed.pathname = `${parsed.pathname.replace(/\/+$/, "")}/core/v1/lit_action`
  parsed.search = ""
  parsed.hash = ""
  return parsed.toString()
}

function assertExecution(input: LitActionExecution): void {
  const hasCode = typeof input.code === "string" && input.code.length > 0
  const hasIpfsId = typeof input.ipfsId === "string" && input.ipfsId.length > 0
  if (hasCode === hasIpfsId) {
    throw new LitChipotleError(
      "invalid_request",
      "Lit action execution requires exactly one of code or ipfsId",
      false,
    )
  }
}

function retryableStatus(status: number): boolean {
  return status === 429 || status >= 500
}

function networkFailureCategory(error: unknown): LitTransportCategory {
  // Workerd exceptions may cross a realm boundary and fail `instanceof Error`.
  // Read only the structural message and emit only a fixed category below.
  const message = error && typeof error === "object" && "message" in error
    && typeof error.message === "string"
    ? error.message.toLowerCase()
    : ""
  const categories: Array<[string, LitTransportCategory]> = [
    ["certificate", "certificate"],
    ["tls", "tls"],
    ["dns", "dns"],
    ["connection reset", "connection_reset"],
    ["connection refused", "connection_refused"],
    ["network connection lost", "connection_lost"],
    ["too many redirects", "redirect"],
    ["redirect", "redirect"],
    ["timed out", "timeout"],
    ["fetch failed", "fetch_failed"],
  ]
  return categories.find(([needle]) => message.includes(needle))?.[1] ?? "unclassified"
}

function statusError(status: number, observedToken?: LitErrorToken): LitChipotleError {
  const token: LitErrorToken = observedToken && observedToken !== "other"
    ? observedToken
    : status === 401 || status === 403
    ? "unauthorized_action"
    : status === 404
      ? "action_fetch_failed"
      : status >= 400 && status < 500
        ? "invalid_params"
        : "other"
  if (status === 402) {
    return new LitChipotleError(
      "billing_required",
      "Lit action execution requires account credits",
      false,
      status,
      undefined,
      token,
    )
  }
  if (status === 429) {
    return new LitChipotleError("overloaded", "Lit action service is overloaded", true, status, undefined, token)
  }
  if (status >= 500) {
    return new LitChipotleError("upstream", "Lit action service failed", true, status, undefined, token)
  }
  return new LitChipotleError("invalid_request", "Lit action request was rejected", false, status, undefined, token)
}

function responseShape(value: unknown): value is LitActionResponse {
  if (!value || typeof value !== "object") return false
  const response = value as Record<string, unknown>
  return typeof response.has_error === "boolean" && typeof response.logs === "string" && "response" in response
}

function litErrorTokenFromEnvelope(input: LitActionResponse): LitErrorToken {
  // Classification only: provider text is never returned, logged, or persisted.
  const bounded = `${input.logs.slice(0, 2_000)} ${typeof input.response === "string"
    ? input.response.slice(0, 2_000)
    : ""}`.toLowerCase()
  if (bounded.includes("unauthorized") || bounded.includes("not permitted") || bounded.includes("not allowed")) {
    return "unauthorized_action"
  }
  if (
    bounded.includes("ipfs")
    || bounded.includes("action fetch")
    || bounded.includes("fetch action")
    || bounded.includes("action not found")
  ) {
    return "action_fetch_failed"
  }
  if (
    bounded.includes("invalid")
    || bounded.includes("missing parameter")
    || bounded.includes("invalid params")
    || bounded.includes("pinned policy")
  ) {
    return "invalid_params"
  }
  if (bounded.includes("timeout") || bounded.includes("timed out")) return "timeout"
  return "other"
}

function litErrorTokenFromPlainText(input: string): LitErrorToken {
  // Chipotle currently returns action-thrown exceptions as a plain-text HTTP
  // 500 stack rather than its JSON envelope. Match only the exact, reviewed
  // policy messages frozen into the registered action; never return, log, or
  // persist the provider body.
  const bounded = input.slice(0, 4_000).toLowerCase()
  return bounded.includes("deadline is outside pinned policy")
    || bounded.includes("policyversion does not match pinned policy")
    ? "invalid_params"
    : "other"
}

function litErrorTokenFromHttpErrorEnvelope(input: unknown): LitErrorToken {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "other_json_unknown"
  const record = input as Record<string, unknown>
  const candidates = ["error", "message", "detail", "details"]
    .map((field) => record[field])
    .filter((value): value is string => typeof value === "string")
  const nestedError = record.error
  if (
    nestedError
    && typeof nestedError === "object"
    && !Array.isArray(nestedError)
    && typeof (nestedError as Record<string, unknown>).message === "string"
  ) {
    candidates.push((nestedError as Record<string, string>).message)
  }
  const classified = litErrorTokenFromPlainText(candidates.map((value) => value.slice(0, 2_000)).join(" "))
  if (classified !== "other") return classified
  if (typeof record.error === "string") return "other_json_error"
  if (typeof record.message === "string") return "other_json_message"
  if (nestedError && typeof nestedError === "object" && !Array.isArray(nestedError)) {
    return "other_json_nested_error"
  }
  return "other_json_unknown"
}

async function defaultSleep(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds))
}

export class LitChipotleClient {
  private readonly usageApiKey: string
  private readonly url: string
  private readonly timeoutMs: number
  private readonly maxAttempts: number
  private readonly retryBaseMs: number
  private readonly fetchImpl: typeof fetch
  private readonly sleep: (milliseconds: number) => Promise<void>

  constructor(options: LitChipotleClientOptions) {
    if (!options.usageApiKey) {
      throw new LitChipotleError("invalid_request", "Lit usage API key is required", false)
    }
    this.usageApiKey = options.usageApiKey
    this.url = endpoint(options.baseUrl ?? DEFAULT_BASE_URL)
    this.timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, "Lit timeout")
    this.maxAttempts = positiveInteger(options.maxAttempts, DEFAULT_MAX_ATTEMPTS, "Lit max attempts")
    this.retryBaseMs = positiveInteger(options.retryBaseMs, DEFAULT_RETRY_BASE_MS, "Lit retry base")
    // Keep the platform fetch as a direct global call. Calling a stored native
    // fetch as `this.fetchImpl(...)` supplies the client as its `this` value;
    // workerd rejects native APIs invoked with that incorrect receiver.
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init))
    this.sleep = options.sleep ?? defaultSleep
  }

  async execute(input: LitActionExecution): Promise<unknown> {
    assertExecution(input)
    const body = JSON.stringify({
      ...(input.code ? { code: input.code } : { ipfs_id: input.ipfsId }),
      js_params: input.jsParams,
    })

    let lastError: LitChipotleError | null = null
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const response = await this.request(body)
        if (response.status >= 300 && response.status < 400) {
          // Workerd rejects `redirect: "error"` with Cloudflare 1042 before a
          // catchable fetch response. Manual mode preserves the no-forwarding
          // guarantee for X-Api-Key; reject the 3xx without reading Location.
          throw new LitChipotleError(
            "network",
            "Lit action request was redirected",
            false,
            response.status,
            "redirect",
            "other",
          )
        }
        if (!response.ok && response.status < 500) throw statusError(response.status)

        const responseBody = await response.text()
        let decoded: unknown
        try {
          decoded = JSON.parse(responseBody)
        } catch {
          if (!response.ok) {
            const token = litErrorTokenFromPlainText(responseBody)
            throw statusError(response.status, token === "other" ? "other_plain_text" : token)
          }
          throw new LitChipotleError("invalid_response", "Lit action response was not JSON", false)
        }
        if (!responseShape(decoded)) {
          if (!response.ok) {
            throw statusError(response.status, litErrorTokenFromHttpErrorEnvelope(decoded))
          }
          throw new LitChipotleError("invalid_response", "Lit action response shape was invalid", false)
        }
        if (decoded.has_error) {
          // Deliberately omit response/logs: action output may contain secrets or
          // transaction material and must not be copied into Worker error logs.
          throw new LitChipotleError(
            "action_failed",
            "Lit action reported an error",
            false,
            undefined,
            undefined,
            litErrorTokenFromEnvelope(decoded),
          )
        }
        if (!response.ok) throw statusError(response.status)
        return decoded.response
      } catch (error) {
        const classified = this.classify(error)
        lastError = classified
        if (!classified.retryable || attempt === this.maxAttempts) throw classified
        // Retry safety depends on the caller keeping nonce, gas, and every
        // transaction field byte-identical across attempts. A timed-out action
        // may still have completed server-side; never refresh mutable signing
        // inputs inside this loop.
        await this.sleep(this.retryBaseMs * (2 ** (attempt - 1)))
      }
    }
    throw lastError ?? new LitChipotleError("upstream", "Lit action execution failed", true)
  }

  private async request(body: string): Promise<Response> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      return await this.fetchImpl(this.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Api-Key": this.usageApiKey,
        },
        body,
        signal: controller.signal,
        redirect: "manual",
      })
    } finally {
      clearTimeout(timeout)
    }
  }

  private classify(error: unknown): LitChipotleError {
    if (error instanceof LitChipotleError) return error
    if (error instanceof DOMException && error.name === "AbortError") {
      return new LitChipotleError("timeout", "Lit action request timed out", true, undefined, "timeout", "timeout")
    }
    // Only expose a fixed category. Native fetch errors must never copy request
    // headers, action params, or arbitrary provider text into Worker/DO logs.
    return new LitChipotleError(
      "network",
      `Lit action request failed (${networkFailureCategory(error)})`,
      true,
      undefined,
      networkFailureCategory(error),
      "other",
    )
  }
}

export const litChipotleRetryableStatus = retryableStatus
