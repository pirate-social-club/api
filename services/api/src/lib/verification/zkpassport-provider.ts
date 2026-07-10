import { ZKPassport, type ProofResult, type Query, type QueryResult } from "@zkpassport/sdk"
import { badRequestError, providerUnavailable } from "../errors"
import { isProductionEnv, makeId } from "../helpers"
import { trimEnv } from "../env-strings"
import { normalizeIdentityCountryCode } from "../identity/country-codes"
import { sha256Hex } from "../crypto"
import type { Env } from "../../env"
import type { RequestedVerificationCapability, VerificationIntent, VerificationRequirement, VerificationSessionLaunch } from "../../types"

const ZKPASSPORT_REF_PREFIX = "zkpassport-sdk"
const ZKPASSPORT_DOCUMENT_CAPABILITIES: readonly RequestedVerificationCapability[] = ["minimum_age", "nationality", "gender"]
const DEFAULT_ZKPASSPORT_VALIDITY_SECONDS = 60 * 60
const DEFAULT_ZKPASSPORT_VERIFIER_TIMEOUT_MS = 30_000

type ZkPassportDocumentCapability = typeof ZKPASSPORT_DOCUMENT_CAPABILITIES[number]
type ZkPassportProofPayload = { proofs: ProofResult[]; queryResult: QueryResult }
type ZkPassportProofVerificationResult = {
  verified: boolean
  uniqueIdentifier: string | null
  queryResultErrors?: unknown
}

type ZkPassportBinding = {
  sid: string
  uid: string
  n: string
  exp: number
}

type ZkPassportSessionRef = {
  kind: typeof ZKPASSPORT_REF_PREFIX
  domain: string
  scope: string
  binding: string
  requestedCapabilities: ZkPassportDocumentCapability[]
  verificationRequirements: VerificationRequirement[]
  devMode: boolean
  validitySeconds: number
}

type ZkPassportStartResult = {
  upstreamSessionRef: string
  launch: NonNullable<VerificationSessionLaunch["zkpassport"]>
}

export type ZkPassportVerifiedClaims = {
  uniqueIdentifier: string
  proofHash: string | null
  nationality: string | null
  minimumAge: number | null
  gender: "M" | "F" | null
}

export type ZkPassportSessionOutcome =
  | { status: "verified"; claims: ZkPassportVerifiedClaims }
  | { status: "failed"; failureReason: string }
  | { status: "expired" }

export interface ZkPassportProvider {
  startSession(input: {
    verificationSessionId: string
    userId: string
    publicOrigin?: string | null
    requestedCapabilities: RequestedVerificationCapability[]
    verificationRequirements?: VerificationRequirement[]
    verificationIntent: VerificationIntent | null
    policyId: string | null
    challengeExpiresAt: string
  }): Promise<ZkPassportStartResult>

  getSessionOutcome(input: {
    upstreamSessionRef: string
    providerPayloadRef: unknown
  }): Promise<ZkPassportSessionOutcome>
}

function truthyEnv(value: string | undefined): boolean {
  return /^(1|true|yes)$/iu.test(trimEnv(value))
}

function zkPassportDomain(env: Env, publicOrigin?: string | null): string {
  const explicit = trimEnv((env as Env & { ZKPASSPORT_DOMAIN?: string }).ZKPASSPORT_DOMAIN)
  if (explicit) return explicit.replace(/^https?:\/\//u, "").replace(/\/+$/u, "")

  const candidate = trimEnv(env.PIRATE_WEB_PUBLIC_ORIGIN)
    || trimEnv(publicOrigin ?? undefined)
    || trimEnv(env.PIRATE_API_PUBLIC_ORIGIN)
  if (!candidate) {
    throw providerUnavailable("ZKPassport provider not configured: set ZKPASSPORT_DOMAIN or PIRATE_WEB_PUBLIC_ORIGIN")
  }
  try {
    return new URL(candidate).host
  } catch {
    return candidate.replace(/^https?:\/\//u, "").replace(/\/+$/u, "")
  }
}

function zkPassportScope(env: Env): string {
  return trimEnv((env as Env & { ZKPASSPORT_SCOPE?: string }).ZKPASSPORT_SCOPE) || "pirate-document-proof-v0"
}

function zkPassportLogo(env: Env): string | null {
  return trimEnv((env as Env & { ZKPASSPORT_LOGO_URL?: string }).ZKPASSPORT_LOGO_URL)
    || (trimEnv(env.PIRATE_WEB_PUBLIC_ORIGIN) ? `${trimEnv(env.PIRATE_WEB_PUBLIC_ORIGIN).replace(/\/+$/u, "")}/favicon.svg` : null)
}

function zkPassportDevMode(env: Env): boolean {
  return truthyEnv((env as Env & { ZKPASSPORT_DEV_MODE?: string }).ZKPASSPORT_DEV_MODE)
    || (!isProductionEnv(env) && trimEnv(env.ENVIRONMENT) === "test")
}

function zkPassportValiditySeconds(env: Env): number {
  const raw = Number((env as Env & { ZKPASSPORT_VALIDITY_SECONDS?: string }).ZKPASSPORT_VALIDITY_SECONDS)
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_ZKPASSPORT_VALIDITY_SECONDS
}

function zkPassportVerifierTimeoutMs(env: Env): number {
  const raw = Number((env as Env & { ZKPASSPORT_VERIFIER_TIMEOUT_MS?: string }).ZKPASSPORT_VERIFIER_TIMEOUT_MS)
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_ZKPASSPORT_VERIFIER_TIMEOUT_MS
}

function isLocalVerifierHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
}

function zkPassportVerifierEndpoint(env: Env): string | null {
  const configured = trimEnv((env as Env & { ZKPASSPORT_VERIFIER_URL?: string }).ZKPASSPORT_VERIFIER_URL)
  if (!configured) return null

  let url: URL
  try {
    url = new URL(configured)
  } catch {
    throw providerUnavailable("ZKPassport verifier URL is invalid", { reason: "invalid_verifier_url" })
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalVerifierHost(url.hostname))) {
    throw providerUnavailable("ZKPassport verifier URL must use HTTPS outside localhost", {
      reason: "insecure_verifier_url",
    })
  }
  if (url.pathname === "" || url.pathname === "/") {
    url.pathname = "/verify"
  }
  return url.toString()
}

function zkPassportLocalVerifyWritingDirectory(env: Env): string {
  return trimEnv((env as Env & { ZKPASSPORT_LOCAL_VERIFY_WRITING_DIRECTORY?: string }).ZKPASSPORT_LOCAL_VERIFY_WRITING_DIRECTORY)
    || "/tmp"
}

function normalizeZkPassportRequestedCapabilities(
  requested: readonly RequestedVerificationCapability[],
  verificationRequirements: readonly VerificationRequirement[],
): ZkPassportDocumentCapability[] {
  const set = new Set<ZkPassportDocumentCapability>()
  for (const capability of requested) {
    if (!ZKPASSPORT_DOCUMENT_CAPABILITIES.includes(capability as ZkPassportDocumentCapability)) {
      throw badRequestError("ZKPassport verification sessions only support minimum_age, nationality, and gender")
    }
    set.add(capability as ZkPassportDocumentCapability)
  }
  if (verificationRequirements.some((requirement) => requirement.proof_type === "minimum_age")) {
    set.add("minimum_age")
  }
  if (verificationRequirements.some((requirement) => requirement.proof_type === "nationality")) {
    set.add("nationality")
  }
  const normalized = ZKPASSPORT_DOCUMENT_CAPABILITIES.filter((capability) => set.has(capability))
  if (normalized.length === 0) {
    throw badRequestError("ZKPassport verification sessions require at least one document capability")
  }
  return normalized
}

function requiredMinimumAge(requirements: readonly VerificationRequirement[]): number | null {
  const ages: number[] = []
  for (const requirement of requirements) {
    const minimumAge = requirement.proof_type === "minimum_age" ? requirement.minimum_age : undefined
    if (Number.isInteger(minimumAge)) {
      ages.push(minimumAge as number)
    }
  }
  return ages.length > 0 ? Math.max(...ages) : null
}

function normalizeGenderClaim(value: unknown): "M" | "F" | null {
  if (typeof value !== "string") return null
  const normalized = value.trim().toUpperCase()
  if (normalized === "M" || normalized === "MALE") return "M"
  if (normalized === "F" || normalized === "FEMALE") return "F"
  return null
}

function buildBinding(input: {
  verificationSessionId: string
  userId: string
  expiresAt: string
}): string {
  const expiresAtSeconds = Math.floor(Date.parse(input.expiresAt) / 1000)
  if (!Number.isFinite(expiresAtSeconds)) {
    throw providerUnavailable("ZKPassport session has an invalid expiry")
  }
  const binding: ZkPassportBinding = {
    sid: input.verificationSessionId,
    uid: input.userId,
    n: makeId("zkn"),
    exp: expiresAtSeconds,
  }
  const encoded = JSON.stringify(binding)
  if (encoded.length > 500) {
    throw providerUnavailable("ZKPassport binding exceeds custom_data limit")
  }
  return encoded
}

function parseBinding(value: string): ZkPassportBinding | null {
  try {
    const parsed = JSON.parse(value) as Partial<ZkPassportBinding>
    return typeof parsed.sid === "string"
      && typeof parsed.uid === "string"
      && typeof parsed.n === "string"
      && typeof parsed.exp === "number"
      ? parsed as ZkPassportBinding
      : null
  } catch {
    return null
  }
}

function encodeSessionRef(input: Omit<ZkPassportSessionRef, "kind">): string {
  return `${ZKPASSPORT_REF_PREFIX}:${JSON.stringify({ kind: ZKPASSPORT_REF_PREFIX, ...input })}`
}

function decodeSessionRef(value: string): ZkPassportSessionRef | null {
  if (!value.startsWith(`${ZKPASSPORT_REF_PREFIX}:`)) return null
  try {
    const parsed = JSON.parse(value.slice(ZKPASSPORT_REF_PREFIX.length + 1)) as Partial<ZkPassportSessionRef>
    if (
      parsed.kind !== ZKPASSPORT_REF_PREFIX
      || typeof parsed.domain !== "string"
      || typeof parsed.scope !== "string"
      || typeof parsed.binding !== "string"
      || !Array.isArray(parsed.requestedCapabilities)
      || !Array.isArray(parsed.verificationRequirements)
      || typeof parsed.devMode !== "boolean"
      || typeof parsed.validitySeconds !== "number"
    ) {
      return null
    }
    return parsed as ZkPassportSessionRef
  } catch {
    return null
  }
}

function buildOriginalQuery(input: {
  domain: string
  binding: string
  requestedCapabilities: readonly ZkPassportDocumentCapability[]
  verificationRequirements: readonly VerificationRequirement[]
}): Query {
  const zkPassport = new ZKPassport(input.domain)
  let builder = zkPassport.createQuery().bind("custom_data", input.binding)

  if (input.requestedCapabilities.includes("nationality")) {
    builder = builder.disclose("nationality")
  }
  if (input.requestedCapabilities.includes("gender")) {
    builder = builder.disclose("gender")
  }
  if (input.requestedCapabilities.includes("minimum_age")) {
    const minimumAge = requiredMinimumAge(input.verificationRequirements)
    if (minimumAge == null) {
      throw badRequestError("ZKPassport minimum_age verification requires a minimum_age verification requirement")
    }
    builder = builder.gte("age", minimumAge)
  }

  return builder.done().query
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readZkPassportPayload(value: unknown): ZkPassportProofPayload | null {
  const record = readRecord(value)
  const verification = readRecord(record?.verification) ?? record
  const proofs = verification?.proofs
  const queryResult = verification?.queryResult ?? verification?.query_result
  if (!Array.isArray(proofs) || !queryResult || typeof queryResult !== "object" || Array.isArray(queryResult)) {
    return null
  }
  return { proofs: proofs as ProofResult[], queryResult: queryResult as QueryResult }
}

function customDataFromQueryResult(queryResult: QueryResult): string | null {
  const customData = queryResult.bind?.custom_data
  return typeof customData === "string" && customData.trim() ? customData.trim() : null
}

function extractClaims(input: {
  queryResult: QueryResult
  requestedCapabilities: readonly ZkPassportDocumentCapability[]
  verificationRequirements: readonly VerificationRequirement[]
  uniqueIdentifier: string
  proofHash: string | null
}): ZkPassportVerifiedClaims | { failureReason: string } {
  let nationality: string | null = null
  let minimumAge: number | null = null
  let gender: "M" | "F" | null = null

  if (input.requestedCapabilities.includes("nationality")) {
    nationality = normalizeIdentityCountryCode(input.queryResult.nationality?.disclose?.result) ?? null
    if (!nationality) return { failureReason: "missing_required_claims:nationality" }
  }

  if (input.requestedCapabilities.includes("minimum_age")) {
    const minimumAgeRequirement = requiredMinimumAge(input.verificationRequirements)
    if (minimumAgeRequirement == null || input.queryResult.age?.gte?.result !== true) {
      return { failureReason: `missing_required_claims:minimum_age:${minimumAgeRequirement ?? "unknown"}` }
    }
    minimumAge = minimumAgeRequirement
  }

  if (input.requestedCapabilities.includes("gender")) {
    gender = normalizeGenderClaim(input.queryResult.gender?.disclose?.result)
    if (!gender) return { failureReason: "missing_required_claims:gender" }
  }

  return {
    uniqueIdentifier: input.uniqueIdentifier,
    proofHash: input.proofHash,
    nationality,
    minimumAge,
    gender,
  }
}

function readVerifierResult(value: unknown): ZkPassportProofVerificationResult | null {
  const record = readRecord(value)
  if (!record || typeof record.verified !== "boolean") {
    return null
  }
  const uniqueIdentifier = typeof record.uniqueIdentifier === "string" && record.uniqueIdentifier.trim()
    ? record.uniqueIdentifier.trim()
    : null
  return {
    verified: record.verified,
    uniqueIdentifier,
    queryResultErrors: record.queryResultErrors,
  }
}

async function verifyWithRemoteZkPassportVerifier(input: {
  env: Env
  endpoint: string
  sessionRef: ZkPassportSessionRef
  originalQuery: Query
  payload: ZkPassportProofPayload
}): Promise<ZkPassportProofVerificationResult> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), zkPassportVerifierTimeoutMs(input.env))
  const sharedSecret = trimEnv((input.env as Env & { ZKPASSPORT_VERIFIER_SHARED_SECRET?: string }).ZKPASSPORT_VERIFIER_SHARED_SECRET)
  let response: Response
  try {
    response = await fetch(input.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(sharedSecret ? { authorization: `Bearer ${sharedSecret}` } : {}),
      },
      body: JSON.stringify({
        domain: input.sessionRef.domain,
        proofs: input.payload.proofs,
        originalQuery: input.originalQuery,
        queryResult: input.payload.queryResult,
        validity: input.sessionRef.validitySeconds,
        scope: input.sessionRef.scope,
        devMode: input.sessionRef.devMode,
      }),
      signal: controller.signal,
    })
  } catch (error) {
    throw providerUnavailable("ZKPassport verifier request failed", {
      reason: error instanceof Error && error.name === "AbortError" ? "verifier_timeout" : "verifier_request_failed",
    })
  } finally {
    clearTimeout(timeoutId)
  }

  const resultPayload = await response.json().catch(() => null)
  if (!response.ok) {
    const resultRecord = readRecord(resultPayload)
    throw providerUnavailable("ZKPassport verifier rejected the request", {
      status: response.status,
      reason: typeof resultRecord?.code === "string" ? resultRecord.code : "verifier_error",
    })
  }

  const result = readVerifierResult(resultPayload)
  if (!result) {
    throw providerUnavailable("ZKPassport verifier returned an invalid response", {
      reason: "invalid_verifier_response",
    })
  }
  return result
}

async function verifyWithLocalZkPassportSdk(input: {
  env: Env
  sessionRef: ZkPassportSessionRef
  originalQuery: Query
  payload: ZkPassportProofPayload
}): Promise<ZkPassportProofVerificationResult> {
  const zkPassport = new ZKPassport(input.sessionRef.domain)
  const result = await zkPassport.verify({
    proofs: input.payload.proofs,
    originalQuery: input.originalQuery,
    queryResult: input.payload.queryResult,
    validity: input.sessionRef.validitySeconds,
    scope: input.sessionRef.scope,
    devMode: input.sessionRef.devMode,
    writingDirectory: zkPassportLocalVerifyWritingDirectory(input.env),
  })
  return {
    verified: result.verified,
    uniqueIdentifier: result.uniqueIdentifier ?? null,
    queryResultErrors: result.queryResultErrors,
  }
}

async function verifyZkPassportProof(input: {
  env: Env
  sessionRef: ZkPassportSessionRef
  originalQuery: Query
  payload: ZkPassportProofPayload
}): Promise<ZkPassportProofVerificationResult> {
  const verifierEndpoint = zkPassportVerifierEndpoint(input.env)
  if (verifierEndpoint) {
    return verifyWithRemoteZkPassportVerifier({
      ...input,
      endpoint: verifierEndpoint,
    })
  }

  if (truthyEnv((input.env as Env & { ZKPASSPORT_LOCAL_VERIFY_ENABLED?: string }).ZKPASSPORT_LOCAL_VERIFY_ENABLED)) {
    return verifyWithLocalZkPassportSdk(input)
  }

  throw providerUnavailable("ZKPassport verifier is not configured for this runtime", {
    reason: "remote_verifier_required",
  })
}

function createConfiguredZkPassportProvider(env: Env): ZkPassportProvider {
  return {
    async startSession(input) {
      const verificationRequirements = input.verificationRequirements ?? []
      const requestedCapabilities = normalizeZkPassportRequestedCapabilities(input.requestedCapabilities, verificationRequirements)
      const domain = zkPassportDomain(env, input.publicOrigin)
      const scope = zkPassportScope(env)
      const binding = buildBinding({
        verificationSessionId: input.verificationSessionId,
        userId: input.userId,
        expiresAt: input.challengeExpiresAt,
      })
      const devMode = zkPassportDevMode(env)
      const validitySeconds = zkPassportValiditySeconds(env)
      buildOriginalQuery({ domain, binding, requestedCapabilities, verificationRequirements })

      return {
        upstreamSessionRef: encodeSessionRef({
          domain,
          scope,
          binding,
          requestedCapabilities,
          verificationRequirements,
          devMode,
          validitySeconds,
        }),
        launch: {
          domain,
          name: trimEnv(env.SELF_APP_NAME) || "Pirate",
          logo: zkPassportLogo(env),
          purpose: "Verify document attributes for Pirate community access",
          scope,
          binding,
          validity_seconds: validitySeconds,
          dev_mode: devMode,
          requested_capabilities: requestedCapabilities,
          verification_requirements: verificationRequirements,
        },
      }
    },

    async getSessionOutcome(input) {
      const sessionRef = decodeSessionRef(input.upstreamSessionRef)
      if (!sessionRef) {
        throw providerUnavailable("ZKPassport session reference is invalid")
      }
      const binding = parseBinding(sessionRef.binding)
      if (!binding) {
        throw providerUnavailable("ZKPassport binding is invalid")
      }
      if (binding.exp * 1000 <= Date.now()) {
        return { status: "expired" }
      }
      const payload = readZkPassportPayload(input.providerPayloadRef)
      if (!payload) {
        throw badRequestError("ZKPassport completion requires proofs and queryResult")
      }
      const customData = customDataFromQueryResult(payload.queryResult)
      if (customData !== sessionRef.binding) {
        return { status: "failed", failureReason: "binding_mismatch" }
      }

      const originalQuery = buildOriginalQuery({
        domain: sessionRef.domain,
        binding: sessionRef.binding,
        requestedCapabilities: sessionRef.requestedCapabilities,
        verificationRequirements: sessionRef.verificationRequirements,
      })
      const proofHash = await sha256Hex(JSON.stringify({
        proofs: payload.proofs,
        queryResult: payload.queryResult,
      }))
      const result = await verifyZkPassportProof({
        env,
        sessionRef,
        originalQuery,
        payload,
      })

      if (!result.verified) {
        return { status: "failed", failureReason: "proof_verification_failed" }
      }
      if (!result.uniqueIdentifier) {
        return { status: "failed", failureReason: "missing_unique_identifier" }
      }

      const claims = extractClaims({
        queryResult: payload.queryResult,
        requestedCapabilities: sessionRef.requestedCapabilities,
        verificationRequirements: sessionRef.verificationRequirements,
        uniqueIdentifier: result.uniqueIdentifier,
        proofHash,
      })
      if ("failureReason" in claims) {
        return { status: "failed", failureReason: claims.failureReason }
      }
      return { status: "verified", claims }
    },
  }
}

let testOverride: ZkPassportProvider | null = null

export function getZkPassportProvider(env: Env): ZkPassportProvider {
  return testOverride ?? createConfiguredZkPassportProvider(env)
}

export function setZkPassportProviderForTests(override: ZkPassportProvider | null): void {
  testOverride = override
}
