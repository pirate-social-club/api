import { internalError, providerUnavailable } from "../errors"
import { makeId } from "../helpers"
import { sha256Hex } from "../crypto"
import type { Env, VerificationIntent, VeryWidgetLaunch } from "../../types"

const VERY_TIMEOUT_MS = 15_000
const VERY_BRIDGE_API_URL = "https://bridge.very.org/api/v1/"
const VERY_VERIFY_API_URL = "https://verify.very.org/api/v1/verify"

export type VeryStartResult = {
  upstreamSessionRef: string
  launch: VeryWidgetLaunch
}

export type VerySessionOutcome =
  | { status: "verified"; attestationData: Record<string, unknown> }
  | { status: "pending"; _diag?: Record<string, unknown> }
  | { status: "failed"; failureReason: string; _diag?: Record<string, unknown> }
  | { status: "expired"; _diag?: Record<string, unknown> }

export interface VeryProvider {
  startSession(input: {
    userId: string
    requestedCapabilities: Array<"unique_human">
    walletAttachmentId: string | null
    verificationIntent: string | null
    policyId: string | null
    publicOrigin?: string | null
  }): Promise<VeryStartResult>

  getSessionOutcome(input: {
    upstreamSessionRef: string
    providerPayloadRef: string | null
  }): Promise<VerySessionOutcome>
}

type VeryVerifyResponse = {
  status?: string
  valid?: boolean
  isValid?: boolean
  is_valid?: boolean
  verified?: boolean
  success?: boolean
  expired?: boolean
  failure_reason?: string | null
  error?: string | null
  data?: Record<string, unknown> | null
  result?: boolean | Record<string, unknown> | null
}

let testOverride: VeryProvider | null = null

function trimEnv(value: string | null | undefined): string {
  return String(value || "").trim()
}

function isDevelopmentEnv(env: Env): boolean {
  return String(env.ENVIRONMENT || "").trim().toLowerCase() === "development"
}

function requireConfiguredVery(env: Env): {
  appId: string
  verifyUrl: string
} {
  const appId = trimEnv(env.VERY_APP_ID)
  if (!appId) {
    throw providerUnavailable("Very provider not configured: VERY_APP_ID must be set")
  }

  const configuredApiUrl = trimEnv(env.VERY_API_URL)
  const verifyUrl = trimEnv(env.VERY_VERIFY_URL)
    || (configuredApiUrl ? deriveVeryVerifyUrl(configuredApiUrl) : VERY_VERIFY_API_URL)
  return { appId, verifyUrl }
}

function deriveVeryVerifyUrl(apiUrl: string): string {
  try {
    const url = new URL(apiUrl)
    const pathname = url.pathname.replace(/\/$/, "")
    if (pathname.endsWith("/api/v1/verify") || pathname.endsWith("/verify")) {
      return url.toString()
    }
    url.pathname = pathname.endsWith("/api/v1")
      ? `${pathname}/verify`
      : pathname
        ? `${pathname}/api/v1/verify`
        : "/api/v1/verify"
    return url.toString()
  } catch {
    throw internalError("VERY_API_URL is not a valid URL")
  }
}

function buildVeryBridgeUrl(env: Env, path: string): string {
  const baseUrl = trimEnv(env.VERY_BRIDGE_API_URL) || VERY_BRIDGE_API_URL
  try {
    return new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString()
  } catch {
    throw internalError("VERY_BRIDGE_API_URL is not a valid URL")
  }
}

export async function proxyVeryBridgeRequest(input: {
  body?: string | null
  env: Env
  method: "GET" | "POST"
  path: string
}): Promise<{ body: Record<string, unknown>; status: number }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), VERY_TIMEOUT_MS)

  try {
    const response = await fetch(buildVeryBridgeUrl(input.env, input.path), {
      method: input.method,
      headers: {
        accept: "application/json",
        ...(input.body != null ? { "content-type": "application/json" } : {}),
      },
      ...(input.body != null ? { body: input.body } : {}),
      signal: controller.signal,
    })
    const rawBody = await response.text().catch(() => "")
    const body = rawBody
      ? JSON.parse(rawBody) as unknown
      : null

    if (body && typeof body === "object" && !Array.isArray(body)) {
      if (response.ok) {
        return { body: body as Record<string, unknown>, status: response.status }
      }
      return {
        body: {
          ...(body as Record<string, unknown>),
          status: "error",
          userMessage: typeof (body as { userMessage?: unknown }).userMessage === "string"
            ? (body as { userMessage: string }).userMessage
            : `Very bridge request failed with status ${response.status}`,
        },
        status: response.status,
      }
    }

    return {
      body: {
        status: "error",
        userMessage: response.ok
          ? "Very bridge response was invalid"
          : `Very bridge request failed with status ${response.status}`,
      },
      status: response.ok ? 502 : response.status,
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return {
        body: { status: "error", userMessage: "Very bridge request timed out" },
        status: 504,
      }
    }
    if (error instanceof SyntaxError) {
      return {
        body: { status: "error", userMessage: "Very bridge response was invalid" },
        status: 502,
      }
    }
    return {
      body: {
        status: "error",
        userMessage: error instanceof Error ? error.message : "Very bridge request failed",
      },
      status: 502,
    }
  } finally {
    clearTimeout(timeout)
  }
}

function normalizeOrigin(value: string | null | undefined): string | null {
  const trimmed = trimEnv(value)
  if (!trimmed) {
    return null
  }
  try {
    return new URL(trimmed).origin
  } catch {
    return null
  }
}

function buildWidgetVerifyUrl(input: {
  env: Env
  publicOrigin?: string | null
  providerVerifyUrl: string
}): string {
  const origin = normalizeOrigin(input.env.PIRATE_API_PUBLIC_ORIGIN)
    ?? normalizeOrigin(input.publicOrigin)
  if (!origin) {
    return input.providerVerifyUrl
  }
  return `${origin}/verification-sessions/very-widget-verify`
}

function buildExternalNullifier(input: {
  verificationIntent: string | null
  policyId: string | null
  upstreamSessionRef: string
  includeSessionId?: boolean
}): string {
  const intent = normalizeVerificationIntent(input.verificationIntent)
  if (input.policyId) {
    return `Pirate - ${intent} - ${input.policyId}`
  }
  if (input.includeSessionId === false) {
    return `Pirate - ${intent}`
  }
  return `Pirate - ${intent} - ${input.upstreamSessionRef}`
}

function normalizeVerificationIntent(intent: string | null): string {
  switch (intent as VerificationIntent | null) {
    case "community_creation":
      return "Community Creation"
    case "community_join":
      return "Community Join"
    case "post_access_18_plus":
      return "18+ Post Access"
    case "commerce_pricing":
      return "Commerce Pricing"
    case "qualifier_disclosure":
      return "Qualifier Disclosure"
    case "profile_verification":
    default:
      return "Profile Verification"
  }
}

function getNestedBoolean(value: unknown, keys: string[]): boolean | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null
  }
  const record = value as Record<string, unknown>
  for (const key of keys) {
    if (typeof record[key] === "boolean") {
      return record[key]
    }
  }
  return null
}

function getVeryVerifySuccess(body: VeryVerifyResponse): boolean {
  const nestedResult = getNestedBoolean(body.result, ["valid", "verified", "success", "isValid", "is_valid"])
  const nestedData = getNestedBoolean(body.data, ["valid", "verified", "success", "isValid", "is_valid"])
  return body.verified === true
    || body.valid === true
    || body.isValid === true
    || body.is_valid === true
    || body.success === true
    || body.result === true
    || nestedResult === true
    || nestedData === true
}

function summarizeVeryVerifyResponse(input: {
  body: VeryVerifyResponse | null
  proofHash: string
  responseStatus: number
  upstreamSessionRef: string
}): Record<string, unknown> {
  const body = input.body
  const bodyRecord = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : null
  return {
    proofHashPrefix: input.proofHash.slice(0, 12),
    responseStatus: input.responseStatus,
    upstreamSessionRef: input.upstreamSessionRef,
    bodyKeys: bodyRecord ? Object.keys(bodyRecord).sort() : [],
    code: typeof bodyRecord?.code === "string" || typeof bodyRecord?.code === "number" ? bodyRecord.code : null,
    message: typeof bodyRecord?.message === "string" ? bodyRecord.message : null,
    status: typeof body?.status === "string" ? body.status : null,
    error: typeof body?.error === "string" ? body.error : null,
    failureReason: typeof body?.failure_reason === "string" ? body.failure_reason : null,
    valid: body?.valid === true,
    isValid: body?.isValid === true,
    is_valid: body?.is_valid === true,
    verified: body?.verified === true,
    success: body?.success === true,
    resultType: body?.result == null ? null : typeof body.result,
    resultBoolean: typeof body?.result === "boolean" ? body.result : null,
    nestedResult: getNestedBoolean(body?.result, ["valid", "verified", "success", "isValid", "is_valid"]),
    nestedData: getNestedBoolean(body?.data, ["valid", "verified", "success", "isValid", "is_valid"]),
  }
}

function buildVeryQuery(input: {
  userId: string
  walletAttachmentId: string | null
  verificationIntent: string | null
  policyId: string | null
  upstreamSessionRef: string
  includeSessionId?: boolean
}): Record<string, unknown> {
  // Keep the ZK timestamp range inside signed 32-bit Unix time. Very's mobile
  // proof generator can fail before returning a proof when handed larger values.
  // Keep the lower bound broad so existing Very identities minted before this
  // Pirate session can still satisfy the widget query.
  const lowerBoundSeconds = 0
  const maxDocumentedUpperBoundSeconds = 2_043_436_800
  const upperBoundSeconds = maxDocumentedUpperBoundSeconds
  const options: Record<string, unknown> = {
    expiredAtLowerBound: String(lowerBoundSeconds),
    externalNullifier: buildExternalNullifier(input),
    equalCheckId: "0",
    pseudonym: input.includeSessionId === false
      ? (input.walletAttachmentId ?? "0")
      : (input.walletAttachmentId ?? input.userId),
  }
  if (input.includeSessionId !== false) {
    options.sessionId = input.upstreamSessionRef
  }
  return {
    conditions: [
      {
        identifier: "val",
        operation: "IN",
        value: {
          from: String(lowerBoundSeconds),
          to: String(upperBoundSeconds),
        },
      },
    ],
    options,
  }
}

async function verifyVeryPayload(input: {
  verifyUrl: string
  providerPayloadRef: string
  upstreamSessionRef: string
}): Promise<VerySessionOutcome> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), VERY_TIMEOUT_MS)

  try {
    const response = await fetch(input.verifyUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        proof: input.providerPayloadRef,
      }),
      signal: controller.signal,
    })

    const body = await response.json().catch(() => null) as VeryVerifyResponse | null
    const proofHash = await sha256Hex(input.providerPayloadRef)
    if (!response.ok) {
      const diag = summarizeVeryVerifyResponse({ body, proofHash, responseStatus: response.status, upstreamSessionRef: input.upstreamSessionRef })
      console.warn("[very-provider] verifier returned non-ok", diag)
      const err = providerUnavailable(body?.error || body?.failure_reason || `Very verification request failed with status ${response.status}`)
      Object.defineProperty(err, "_diag", { value: diag, enumerable: false, writable: false })
      throw err
    }
    if (!body || typeof body !== "object") {
      throw providerUnavailable("Very verification response was invalid")
    }

    const status = String(body.status || "").trim().toLowerCase()
    if (body.expired === true || status === "expired") {
      const diag = summarizeVeryVerifyResponse({
        body,
        proofHash,
        responseStatus: response.status,
        upstreamSessionRef: input.upstreamSessionRef,
      })
      console.warn("[very-provider] verifier returned expired", diag)
      return { status: "expired", _diag: diag }
    }
    if (
      getVeryVerifySuccess(body)
      || status === "valid"
      || status === "verified"
      || status === "success"
      || status === "completed"
    ) {
      return {
        status: "verified",
        attestationData: {
          proof_hash: proofHash,
          provider_session_ref: input.upstreamSessionRef,
          provider_status: status || "verified",
          ...(body.data && typeof body.data === "object" ? body.data : {}),
        },
      }
    }
    if (status === "pending" || status === "processing") {
      const diag = summarizeVeryVerifyResponse({
        body,
        proofHash,
        responseStatus: response.status,
        upstreamSessionRef: input.upstreamSessionRef,
      })
      console.info("[very-provider] verifier returned pending", diag)
      return { status: "pending", _diag: diag }
    }

    const diag = summarizeVeryVerifyResponse({ body, proofHash, responseStatus: response.status, upstreamSessionRef: input.upstreamSessionRef })
    console.warn("[very-provider] verifier returned failed", diag)
    return {
      status: "failed",
      failureReason: body.failure_reason || body.error || status || "verification_failed",
      _diag: diag,
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw providerUnavailable("Very verification request timed out")
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

export function getVeryProvider(env: Env): VeryProvider {
  if (testOverride) {
    return testOverride
  }

  const { appId, verifyUrl } = requireConfiguredVery(env)

  return {
    async startSession(input) {
      const upstreamSessionRef = makeId("vs")
      return {
        upstreamSessionRef,
        launch: {
          app_id: appId,
          context: "Veros - Palm Verification Timestamp",
          type_id: "3",
          query: buildVeryQuery({
            userId: input.userId,
            walletAttachmentId: input.walletAttachmentId,
            verificationIntent: input.verificationIntent,
            policyId: input.policyId,
            upstreamSessionRef,
            includeSessionId: false,
          }),
          verify_url: buildWidgetVerifyUrl({
            env,
            publicOrigin: input.publicOrigin ?? null,
            providerVerifyUrl: verifyUrl,
          }),
        },
      }
    },

    async getSessionOutcome(input) {
      const { verifyUrl } = requireConfiguredVery(env)
      if (!input.providerPayloadRef?.trim()) {
        return { status: "pending" }
      }
      if (isDevelopmentEnv(env)) {
        console.warn("[very-provider] trusting local widget completion in development")
        return {
          status: "verified",
          attestationData: {
            proof_hash: await sha256Hex(input.providerPayloadRef.trim()),
            provider_session_ref: input.upstreamSessionRef,
            provider_status: "local_widget_verified",
          },
        }
      }
      return await verifyVeryPayload({
        verifyUrl,
        providerPayloadRef: input.providerPayloadRef.trim(),
        upstreamSessionRef: input.upstreamSessionRef,
      })
    },
  }
}

type VeryWidgetVerifyResult = {
  status: "valid" | "pending" | "expired" | "invalid"
  error?: string
  _diag?: Record<string, unknown>
}

export async function verifyVeryWidgetProof(env: Env, proof: string): Promise<VeryWidgetVerifyResult> {
  const provider = getVeryProvider(env)
  const outcome = await provider.getSessionOutcome({
    upstreamSessionRef: "very-widget",
    providerPayloadRef: proof,
  })
  switch (outcome.status) {
    case "verified":
      return { status: "valid" }
    case "pending":
      return { status: "pending", _diag: outcome._diag }
    case "expired":
      return { status: "expired", _diag: outcome._diag }
    case "failed":
      return { status: "invalid", error: outcome.failureReason, _diag: outcome._diag ?? { outcomeStatus: outcome.status, failureReason: outcome.failureReason } }
  }
}

export function setVeryProviderForTests(override: VeryProvider | null): void {
  testOverride = override
}
