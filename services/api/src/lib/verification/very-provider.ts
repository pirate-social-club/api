import { internalError, providerUnavailable } from "../errors"
import { makeId } from "../helpers"
import { sha256Hex } from "../crypto"
import type { Env, VerificationIntent, VeryWidgetLaunch } from "../../types"

const VERY_TIMEOUT_MS = 15_000
const VERY_BRIDGE_API_URL = "https://bridge.very.org/api/v1/"

export type VeryStartResult = {
  upstreamSessionRef: string
  launch: VeryWidgetLaunch
}

export type VerySessionOutcome =
  | { status: "verified"; attestationData: Record<string, unknown> }
  | { status: "pending" }
  | { status: "failed"; failureReason: string }
  | { status: "expired" }

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
  verified?: boolean
  success?: boolean
  expired?: boolean
  failure_reason?: string | null
  error?: string | null
  data?: Record<string, unknown> | null
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
  const apiUrl = trimEnv(env.VERY_API_URL) || "https://api.very.org"
  const appId = trimEnv(env.VERY_APP_ID)
  if (!appId) {
    throw providerUnavailable("Very provider not configured: VERY_APP_ID must be set")
  }

  const verifyUrl = trimEnv(env.VERY_VERIFY_URL) || deriveVeryVerifyUrl(apiUrl)
  return { appId, verifyUrl }
}

function deriveVeryVerifyUrl(apiUrl: string): string {
  try {
    const url = new URL(apiUrl)
    const pathname = url.pathname.replace(/\/$/, "")
    if (pathname.endsWith("/api/v1/verify") || pathname.endsWith("/verify")) {
      return url.toString()
    }
    url.pathname = pathname ? `${pathname}/api/v1/verify` : "/api/v1/verify"
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

function buildVeryQuery(input: {
  userId: string
  walletAttachmentId: string | null
  verificationIntent: string | null
  policyId: string | null
  upstreamSessionRef: string
  includeSessionId?: boolean
}): Record<string, unknown> {
  const nowSeconds = Math.floor(Date.now() / 1000)
  // Use a broad validity window for anonymous ZK mode. The Very docs example
  // shows a wide timestamp range, and a narrow "now -> +1y" window can reject
  // otherwise valid palm proofs if `val` is not minted at the moment of scan.
  const lowerBoundSeconds = 0
  const upperBoundSeconds = 4_102_444_800 // 2100-01-01T00:00:00Z
  const options: Record<string, unknown> = {
    expiredAtLowerBound: String(nowSeconds),
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
    if (!response.ok) {
      const message = body?.error || body?.failure_reason || `Very verification request failed with status ${response.status}`
      throw providerUnavailable(message)
    }
    if (!body || typeof body !== "object") {
      throw providerUnavailable("Very verification response was invalid")
    }

    const status = String(body.status || "").trim().toLowerCase()
    if (body.expired === true || status === "expired") {
      return { status: "expired" }
    }
    if (
      body.verified === true
      || body.valid === true
      || body.success === true
      || status === "valid"
      || status === "verified"
      || status === "success"
      || status === "completed"
    ) {
      const proofHash = await sha256Hex(input.providerPayloadRef)
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
      return { status: "pending" }
    }

    return {
      status: "failed",
      failureReason: body.failure_reason || body.error || status || "verification_failed",
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

export async function verifyVeryWidgetProof(env: Env, proof: string): Promise<{
  status: "valid" | "pending" | "expired" | "invalid"
  error?: string
}> {
  const provider = getVeryProvider(env)
  const outcome = await provider.getSessionOutcome({
    upstreamSessionRef: "very-widget",
    providerPayloadRef: proof,
  })
  switch (outcome.status) {
    case "verified":
      return { status: "valid" }
    case "pending":
      return { status: "pending" }
    case "expired":
      return { status: "expired" }
    case "failed":
      return { status: "invalid", error: outcome.failureReason }
  }
}

export function setVeryProviderForTests(override: VeryProvider | null): void {
  testOverride = override
}
