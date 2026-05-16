import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose"
import { internalError, providerUnavailable } from "../errors"
import { envFlag, makeId } from "../helpers"
import { sha256Hex } from "../crypto"
import { logVerificationDebug } from "./verification-logging"
import type { Env } from "../../env"
import type { VerificationIntent, VerySessionBinding, VeryWidgetLaunch } from "../../types"
import { unixSeconds } from "../../serializers/time"

const VERY_TIMEOUT_MS = 15_000
const VERY_BRIDGE_API_URL = "https://bridge.very.org/api/v1/"
const VERY_OAUTH_TOKEN_URL = "https://api.very.org/oauth2/token"
const VERY_OAUTH_ISSUER = "https://connect.very.org"
const VERY_VERIFY_API_URL = "https://verify.very.org/api/v1/verify"
export const VERY_UNIQUE_HUMAN_DOMAIN = "pirate-unique-human-v0"
const VERY_WIDGET_PSEUDONYM = "0"
const VERY_WIDGET_TIMESTAMP_LOWER_BOUND_SECONDS = 1_743_436_800
const VERY_WIDGET_TIMESTAMP_UPPER_BOUND_SECONDS = 2_043_436_800

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
    verificationSessionId: string
    userId: string
    requestedCapabilities: Array<"unique_human">
    walletAttachmentId: string | null
    verificationIntent: string | null
    policyId: string | null
    challengeExpiresAt: string
    publicOrigin?: string | null
  }): Promise<VeryStartResult>

  getSessionOutcome(input: {
    upstreamSessionRef: string
    providerPayloadRef: string | null
    expectedBinding?: VerySessionBinding | null
  }): Promise<VerySessionOutcome>

  getNativeSessionOutcome?(input: {
    authorizationCode: string
    verificationSessionId: string
    userId: string
  }): Promise<VerySessionOutcome>
}

type VeryOAuthTokenResponse = {
  access_token?: string
  token_type?: string
  expires_in?: number
  id_token?: string
  refresh_token?: string
  scope?: string
  error?: string
  error_description?: string
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

function shouldUseLocalWidgetCompletionTrust(env: Env): boolean {
  return envFlag(env.VERY_TRUST_LOCAL_WIDGET_COMPLETION, isDevelopmentEnv(env))
}

function shouldTrustBridgeCompletionOnVerifier5xx(env: Env): boolean {
  return envFlag(env.VERY_TRUST_BRIDGE_COMPLETION_ON_VERIFIER_5XX, false)
}

function shouldEnableNativeOAuth(env: Env): boolean {
  return envFlag(env.VERY_NATIVE_OAUTH_ENABLED, false)
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

function requireConfiguredVeryOAuth(env: Env): {
  clientId: string
  clientSecret: string
  issuer: string
  jwksUrl: string
  redirectUri: string
  tokenUrl: string
} {
  if (!shouldEnableNativeOAuth(env)) {
    throw providerUnavailable("Very native SDK OAuth is not enabled")
  }
  const clientId = trimEnv(env.VERY_OAUTH_CLIENT_ID)
  const clientSecret = trimEnv(env.VERY_OAUTH_CLIENT_SECRET)
  const redirectUri = trimEnv(env.VERY_OAUTH_REDIRECT_URI)
  if (!clientId) {
    throw providerUnavailable("Very native SDK OAuth not configured: VERY_OAUTH_CLIENT_ID must be set")
  }
  if (!clientSecret) {
    throw providerUnavailable("Very native SDK OAuth not configured: VERY_OAUTH_CLIENT_SECRET must be set")
  }
  if (!redirectUri) {
    throw providerUnavailable("Very native SDK OAuth not configured: VERY_OAUTH_REDIRECT_URI must be set")
  }

  const issuer = trimEnv(env.VERY_OAUTH_ISSUER) || VERY_OAUTH_ISSUER
  const jwksUrl = trimEnv(env.VERY_OAUTH_JWKS_URL) || `${issuer.replace(/\/$/, "")}/.well-known/jwks.json`
  const tokenUrl = trimEnv(env.VERY_OAUTH_TOKEN_URL) || VERY_OAUTH_TOKEN_URL
  try {
    new URL(issuer)
    new URL(jwksUrl)
    new URL(redirectUri)
    new URL(tokenUrl)
  } catch {
    throw providerUnavailable("Very native SDK OAuth URL configuration is invalid")
  }
  return { clientId, clientSecret, issuer, jwksUrl, redirectUri, tokenUrl }
}

export function assertVeryNativeOAuthConfigured(env: Env): void {
  requireConfiguredVeryOAuth(env)
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
  const requestOrigin = normalizeOrigin(input.publicOrigin)
  const origin = normalizeOrigin(input.env.PIRATE_API_PUBLIC_ORIGIN)
    ?? requestOrigin
  if (!origin) {
    return input.providerVerifyUrl
  }
  return `${origin}/verification-sessions/very-widget-verify`
}

export function buildVerySessionBinding(input: {
  verificationSessionId: string
  challengeExpiresAt: string
}): VerySessionBinding {
  return {
    uniqueness_domain: VERY_UNIQUE_HUMAN_DOMAIN,
    binding_value: VERY_WIDGET_PSEUDONYM,
    binding_field: "pseudonym",
    challenge_expires_at: unixSeconds(input.challengeExpiresAt),
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
  return `Pirate - ${intent}`
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

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function getVeryResponseRecord(body: VeryVerifyResponse): Record<string, unknown> {
  return {
    ...(objectRecord(body.result) ?? {}),
    ...(objectRecord(body.data) ?? {}),
    ...body,
  }
}

function getStringValue(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "string" && value.trim()) {
      return value.trim()
    }
  }
  return null
}

function validateVeryBinding(input: {
  body: VeryVerifyResponse
  expectedBinding?: VerySessionBinding | null
}): string | null {
  const binding = input.expectedBinding
  if (!binding) {
    return null
  }
  const record = getVeryResponseRecord(input.body)
  const actualBindingValue = getStringValue(record, [binding.binding_field ?? "pseudonym", "pseudonym", "challenge"])
  if (actualBindingValue !== binding.binding_value) {
    return "very_session_binding_mismatch"
  }
  const actualDomain = getStringValue(record, ["uniqueness_domain"])
  if (actualDomain != null && actualDomain !== binding.uniqueness_domain) {
    return "very_uniqueness_domain_mismatch"
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

function isVerifier5xx(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  const responseStatus = (error as Error & { details?: { _diag?: { responseStatus?: unknown } } }).details?._diag?.responseStatus
  return typeof responseStatus === "number" && responseStatus >= 500
}

function isVeryBridgeSessionId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
}

async function getVeryBridgeSessionStatus(input: {
  env: Env
  sessionId: string
}): Promise<Record<string, unknown>> {
  const response = await proxyVeryBridgeRequest({
    env: input.env,
    method: "GET",
    path: `session/${encodeURIComponent(input.sessionId)}`,
  })
  return response.body
}

function buildVeryQuery(input: {
  userId: string
  walletAttachmentId: string | null
  verificationIntent: string | null
  policyId: string | null
  upstreamSessionRef: string
  sessionBinding: VerySessionBinding
}): Record<string, unknown> {
  const options: Record<string, unknown> = {
    expiredAtLowerBound: String(VERY_WIDGET_TIMESTAMP_LOWER_BOUND_SECONDS),
    externalNullifier: buildExternalNullifier(input),
    equalCheckId: "0",
    pseudonym: input.sessionBinding.binding_value,
  }
  return {
    conditions: [
      {
            identifier: "val",
            operation: "IN",
            value: {
              from: String(VERY_WIDGET_TIMESTAMP_LOWER_BOUND_SECONDS),
              to: String(VERY_WIDGET_TIMESTAMP_UPPER_BOUND_SECONDS),
            },
          },
        ],
    options,
  }
}

async function verifyVeryPayload(input: {
  env: Env
  verifyUrl: string
  providerPayloadRef: string
  upstreamSessionRef: string
  expectedBinding?: VerySessionBinding | null
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
      const diag = summarizeVeryVerifyResponse({
        body,
        proofHash,
        responseStatus: response.status,
        upstreamSessionRef: input.upstreamSessionRef,
      })
      console.warn("[very-provider] verifier returned non-ok", diag)
      const err = providerUnavailable(
        body?.error || body?.failure_reason || `Very verification request failed with status ${response.status}`,
        { _diag: diag },
      )
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
      const bindingFailure = validateVeryBinding({ body, expectedBinding: input.expectedBinding })
      if (bindingFailure) {
        return { status: "failed", failureReason: bindingFailure }
      }
      return {
        status: "verified",
        attestationData: {
          proof_hash: proofHash,
          provider_session_ref: input.upstreamSessionRef,
          provider_status: status || "verified",
          ...(input.expectedBinding
            ? {
              uniqueness_domain: input.expectedBinding.uniqueness_domain,
              [input.expectedBinding.binding_field ?? "pseudonym"]: input.expectedBinding.binding_value,
            }
            : {}),
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
      logVerificationDebug(input.env, "[very-provider] verifier returned pending", diag)
      return { status: "pending", _diag: diag }
    }

    const diag = summarizeVeryVerifyResponse({
      body,
      proofHash,
      responseStatus: response.status,
      upstreamSessionRef: input.upstreamSessionRef,
    })
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

async function exchangeVeryNativeAuthCode(input: {
  authorizationCode: string
  env: Env
}): Promise<{
  idToken: string
  subject: string
  payload: JWTPayload
}> {
  const config = requireConfiguredVeryOAuth(input.env)
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code: input.authorizationCode,
    redirect_uri: config.redirectUri,
  })
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), VERY_TIMEOUT_MS)

  try {
    const response = await fetch(config.tokenUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
      signal: controller.signal,
    })
    const tokenResponse = await response.json().catch(() => null) as VeryOAuthTokenResponse | null
    if (!response.ok) {
      throw providerUnavailable(
        tokenResponse?.error_description || tokenResponse?.error || `Very OAuth token exchange failed with status ${response.status}`,
        {
          _diag: {
            responseStatus: response.status,
            responseKeys: tokenResponse && typeof tokenResponse === "object" ? Object.keys(tokenResponse).sort() : [],
          },
        },
      )
    }
    const idToken = typeof tokenResponse?.id_token === "string" ? tokenResponse.id_token.trim() : ""
    if (!idToken) {
      throw providerUnavailable("Very OAuth token response did not include an id_token")
    }

    const verification = await jwtVerify(
      idToken,
      createRemoteJWKSet(new URL(config.jwksUrl)),
      {
        audience: config.clientId,
        issuer: config.issuer,
      },
    )
    const subject = typeof verification.payload.sub === "string" ? verification.payload.sub.trim() : ""
    if (!subject) {
      throw providerUnavailable("Very OAuth id_token did not include a subject")
    }
    return { idToken, payload: verification.payload, subject }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw providerUnavailable("Very OAuth token exchange timed out")
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

function createConfiguredVeryProvider(env: Env): VeryProvider {
  return {
    async startSession(input) {
      const { appId, verifyUrl } = requireConfiguredVery(env)
      const upstreamSessionRef = makeId("vs")
      const sessionBinding = buildVerySessionBinding({
        verificationSessionId: input.verificationSessionId,
        challengeExpiresAt: input.challengeExpiresAt,
      })
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
            sessionBinding,
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
      try {
        return await verifyVeryPayload({
          env,
          verifyUrl,
          providerPayloadRef: input.providerPayloadRef.trim(),
          upstreamSessionRef: input.upstreamSessionRef,
          expectedBinding: input.expectedBinding ?? null,
        })
      } catch (error) {
        if (
          !shouldTrustBridgeCompletionOnVerifier5xx(env)
          || !isVerifier5xx(error)
          || !isVeryBridgeSessionId(input.upstreamSessionRef)
          || input.expectedBinding
        ) {
          throw error
        }
        const bridgeStatus = await getVeryBridgeSessionStatus({
          env,
          sessionId: input.upstreamSessionRef,
        })
        if (bridgeStatus.status !== "completed" || !bridgeStatus.response) {
          throw error
        }
        console.warn("[very-provider] trusting completed bridge session after verifier 5xx", {
          upstreamSessionRef: input.upstreamSessionRef,
        })
        return {
          status: "verified",
          attestationData: {
            proof_hash: await sha256Hex(input.providerPayloadRef.trim()),
            provider_session_ref: input.upstreamSessionRef,
            provider_status: "bridge_completed_verifier_5xx",
          },
        }
      }
    },

    async getNativeSessionOutcome(input) {
      const { subject } = await exchangeVeryNativeAuthCode({
        authorizationCode: input.authorizationCode,
        env,
      })
      const proofHash = await sha256Hex(input.authorizationCode)
      return {
        status: "verified",
        attestationData: {
          external_user_id: subject,
          nullifier_hash: await sha256Hex(`${VERY_UNIQUE_HUMAN_DOMAIN}:native:${subject}`),
          proof_hash: proofHash,
          provider_session_ref: input.verificationSessionId,
          provider_status: "native_oauth_verified",
        },
      }
    },
  }
}

function withLocalWidgetCompletionTrust(provider: VeryProvider): VeryProvider {
  return {
    startSession(input) {
      return provider.startSession(input)
    },

    getNativeSessionOutcome(input) {
      return provider.getNativeSessionOutcome
        ? provider.getNativeSessionOutcome(input)
        : Promise.resolve({ status: "failed", failureReason: "native_oauth_unavailable" })
    },

    async getSessionOutcome(input) {
      const providerPayloadRef = input.providerPayloadRef?.trim()
      if (!providerPayloadRef) {
        return provider.getSessionOutcome(input)
      }

      console.warn("[very-provider] trusting local widget completion")
      return {
        status: "verified",
        attestationData: {
          proof_hash: await sha256Hex(providerPayloadRef),
          provider_session_ref: input.upstreamSessionRef,
          provider_status: "local_widget_verified",
          uniqueness_domain: input.expectedBinding?.uniqueness_domain ?? VERY_UNIQUE_HUMAN_DOMAIN,
          pseudonym: input.expectedBinding?.binding_value ?? input.upstreamSessionRef,
          nullifier_hash: await sha256Hex(`${VERY_UNIQUE_HUMAN_DOMAIN}:${providerPayloadRef}`),
        },
      }
    },
  }
}

export function getVeryProvider(env: Env): VeryProvider {
  if (testOverride) {
    return testOverride
  }

  const provider = createConfiguredVeryProvider(env)
  return shouldUseLocalWidgetCompletionTrust(env)
    ? withLocalWidgetCompletionTrust(provider)
    : provider
}

export function setVeryProviderForTests(override: VeryProvider | null): void {
  testOverride = override
}
