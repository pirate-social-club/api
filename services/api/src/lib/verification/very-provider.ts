import { internalError, providerUnavailable } from "../errors"
import { makeId } from "../helpers"
import type { Env, VerificationIntent, VeryWidgetLaunch } from "../../types"

const VERY_TIMEOUT_MS = 15_000
const encoder = new TextEncoder()

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

function trimEnv(value: string | undefined): string {
  return String(value || "").trim()
}

function requireConfiguredVery(env: Env): { apiUrl: string; apiKey: string; appId: string; verifyUrl: string } {
  const apiUrl = trimEnv(env.VERY_API_URL)
  const apiKey = trimEnv(env.VERY_API_KEY)
  const appId = trimEnv(env.VERY_APP_ID)
  if (!apiUrl || !apiKey || !appId) {
    throw providerUnavailable("Very provider not configured: VERY_API_URL, VERY_API_KEY, and VERY_APP_ID must be set")
  }

  const verifyUrl = trimEnv(env.VERY_VERIFY_URL) || deriveVeryVerifyUrl(apiUrl)
  return { apiUrl, apiKey, appId, verifyUrl }
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

function buildExternalNullifier(input: {
  verificationIntent: string | null
  policyId: string | null
  upstreamSessionRef: string
}): string {
  const intent = normalizeVerificationIntent(input.verificationIntent)
  if (input.policyId) {
    return `Pirate - ${intent} - ${input.policyId}`
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
}): Record<string, unknown> {
  const nowSeconds = Math.floor(Date.now() / 1000)
  const oneYearSeconds = nowSeconds + 365 * 24 * 60 * 60
  return {
    conditions: [
      {
        identifier: "val",
        operation: "IN",
        value: {
          from: String(nowSeconds),
          to: String(oneYearSeconds),
        },
      },
    ],
    options: {
      expiredAtLowerBound: String(nowSeconds),
      externalNullifier: buildExternalNullifier(input),
      equalCheckId: "0",
      pseudonym: input.walletAttachmentId ?? input.userId,
      sessionId: input.upstreamSessionRef,
    },
  }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value))
  return Array.from(new Uint8Array(digest), (part) => part.toString(16).padStart(2, "0")).join("")
}

async function verifyVeryPayload(input: {
  verifyUrl: string
  apiKey: string
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
        authorization: `Bearer ${input.apiKey}`,
        "x-api-key": input.apiKey,
      },
      body: JSON.stringify({
        proof: input.providerPayloadRef,
        session_id: input.upstreamSessionRef,
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
          }),
          verify_url: verifyUrl,
        },
      }
    },

    async getSessionOutcome(input) {
      const { apiKey, verifyUrl } = requireConfiguredVery(env)
      if (!input.providerPayloadRef?.trim()) {
        return { status: "pending" }
      }
      return await verifyVeryPayload({
        verifyUrl,
        apiKey,
        providerPayloadRef: input.providerPayloadRef.trim(),
        upstreamSessionRef: input.upstreamSessionRef,
      })
    },
  }
}

export function setVeryProviderForTests(override: VeryProvider | null): void {
  testOverride = override
}
