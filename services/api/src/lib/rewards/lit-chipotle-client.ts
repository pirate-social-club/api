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

export class LitChipotleError extends Error {
  constructor(
    readonly code: LitChipotleErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
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

function statusError(status: number): LitChipotleError {
  if (status === 402) {
    return new LitChipotleError(
      "billing_required",
      "Lit action execution requires account credits",
      false,
      status,
    )
  }
  if (status === 429) {
    return new LitChipotleError("overloaded", "Lit action service is overloaded", true, status)
  }
  if (status >= 500) {
    return new LitChipotleError("upstream", "Lit action service failed", true, status)
  }
  return new LitChipotleError("invalid_request", "Lit action request was rejected", false, status)
}

function responseShape(value: unknown): value is LitActionResponse {
  if (!value || typeof value !== "object") return false
  const response = value as Record<string, unknown>
  return typeof response.has_error === "boolean" && typeof response.logs === "string" && "response" in response
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
    this.fetchImpl = options.fetchImpl ?? fetch
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
        if (!response.ok) throw statusError(response.status)

        let decoded: unknown
        try {
          decoded = await response.json()
        } catch {
          throw new LitChipotleError("invalid_response", "Lit action response was not JSON", false)
        }
        if (!responseShape(decoded)) {
          throw new LitChipotleError("invalid_response", "Lit action response shape was invalid", false)
        }
        if (decoded.has_error) {
          // Deliberately omit response/logs: action output may contain secrets or
          // transaction material and must not be copied into Worker error logs.
          throw new LitChipotleError("action_failed", "Lit action reported an error", false)
        }
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
        redirect: "error",
      })
    } finally {
      clearTimeout(timeout)
    }
  }

  private classify(error: unknown): LitChipotleError {
    if (error instanceof LitChipotleError) return error
    if (error instanceof DOMException && error.name === "AbortError") {
      return new LitChipotleError("timeout", "Lit action request timed out", true)
    }
    return new LitChipotleError("network", "Lit action request failed", true)
  }
}

export const litChipotleRetryableStatus = retryableStatus
