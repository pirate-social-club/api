import type {
  AttestationId,
  SelfBackendVerifier,
  VerificationConfig,
  VerificationResult,
} from "@selfxyz/core"
import { badRequestError, providerUnavailable } from "../errors"
import { isProductionEnv, makeId } from "../helpers"
import { normalizeIdentityCountryCode } from "../identity/country-codes"
import { logVerificationDebug } from "./verification-logging"
import type { Env, RequestedVerificationCapability, SelfVerificationDisclosures, SelfVerificationLaunch, VerificationIntent, VerificationRequirement } from "../../types"

const SELF_CAPABILITY_ORDER: readonly RequestedVerificationCapability[] = ["unique_human", "age_over_18", "nationality", "gender"]
const SELF_DEV_STUB_REF_PREFIX = "self-dev-stub"
const SELF_SDK_REF_PREFIX = "self-sdk"

type SelfCoreModule = typeof import("@selfxyz/core")

let selfCoreModulePromise: Promise<SelfCoreModule> | null = null

function loadSelfCoreModule(): Promise<SelfCoreModule> {
  selfCoreModulePromise ??= import("@selfxyz/core")
  return selfCoreModulePromise
}

type SelfProofPayload = {
  attestationId: AttestationId
  proof: Parameters<SelfBackendVerifier["verify"]>[1]
  publicSignals: Parameters<SelfBackendVerifier["verify"]>[2]
  userContextData: string
}

type SelfSdkSessionRef = {
  kind: "self-sdk"
  endpoint: string
  mockPassport: boolean
  scope: string
  selfUserId: string
  userDefinedData: string
  verificationConfig: VerificationConfig
}

function normalizeGenderClaim(value: unknown): "M" | "F" | null {
  if (typeof value !== "string") {
    return null
  }

  // Self currently exposes a document marker, not a broader identity model.
  const normalized = value.trim().toUpperCase()
  if (normalized === "M" || normalized === "MALE") {
    return "M"
  }
  if (normalized === "F" || normalized === "FEMALE") {
    return "F"
  }
  return null
}

function encodeDevStubSessionRef(requestedCapabilities: RequestedVerificationCapability[], verificationRequirements: VerificationRequirement[]): string {
  const minimumAge = resolveRequestedMinimumAge(requestedCapabilities, verificationRequirements) ?? ""
  return `${SELF_DEV_STUB_REF_PREFIX}:${encodeURIComponent(requestedCapabilities.join(","))}:${minimumAge}:${makeId("ss")}`
}

function decodeDevStubCapabilities(upstreamSessionRef: string): Set<RequestedVerificationCapability> {
  if (!upstreamSessionRef.startsWith(`${SELF_DEV_STUB_REF_PREFIX}:`)) {
    return new Set()
  }

  const [, encodedCapabilities] = upstreamSessionRef.split(":", 3)
  const decoded = decodeURIComponent(encodedCapabilities || "")
  return new Set(
    decoded
      .split(",")
      .map((cap) => cap.trim())
      .filter((cap): cap is RequestedVerificationCapability => SELF_CAPABILITY_ORDER.includes(cap as RequestedVerificationCapability)),
  )
}

function decodeDevStubMinimumAge(upstreamSessionRef: string): number | null {
  if (!upstreamSessionRef.startsWith(`${SELF_DEV_STUB_REF_PREFIX}:`)) {
    return null
  }

  const [, , rawMinimumAge] = upstreamSessionRef.split(":", 4)
  const minimumAge = Number(rawMinimumAge)
  return Number.isInteger(minimumAge) && minimumAge > 0 ? minimumAge : null
}

function encodeSelfSdkSessionRef(input: Omit<SelfSdkSessionRef, "kind">): string {
  return `${SELF_SDK_REF_PREFIX}:${JSON.stringify({ kind: SELF_SDK_REF_PREFIX, ...input })}`
}

function decodeSelfSdkSessionRef(upstreamSessionRef: string): SelfSdkSessionRef | null {
  if (!upstreamSessionRef.startsWith(`${SELF_SDK_REF_PREFIX}:`)) {
    return null
  }
  try {
    const parsed = JSON.parse(upstreamSessionRef.slice(SELF_SDK_REF_PREFIX.length + 1)) as Partial<SelfSdkSessionRef>
    if (
      parsed.kind !== SELF_SDK_REF_PREFIX
      || typeof parsed.endpoint !== "string"
      || typeof parsed.mockPassport !== "boolean"
      || typeof parsed.scope !== "string"
      || typeof parsed.selfUserId !== "string"
      || typeof parsed.userDefinedData !== "string"
      || parsed.verificationConfig == null
      || typeof parsed.verificationConfig !== "object"
    ) {
      return null
    }
    return parsed as SelfSdkSessionRef
  } catch {
    return null
  }
}

export function canonicalizeRequestedCapabilities(
  provider: "self" | "very",
  requested: RequestedVerificationCapability[],
): RequestedVerificationCapability[] {
  if (provider === "very") return ["unique_human"]
  if (requested.length === 0) return ["unique_human"]
  const set = new Set(requested)
  const unsupported = Array.from(set).filter((cap) => !SELF_CAPABILITY_ORDER.includes(cap))
  if (unsupported.length > 0) {
    throw badRequestError(`Unsupported Self requested_capabilities: ${unsupported.join(", ")}`)
  }
  if (set.has("age_over_18") || set.has("nationality") || set.has("gender")) {
    set.add("unique_human")
  }
  return SELF_CAPABILITY_ORDER.filter((c) => set.has(c))
}

export function mapCapabilitiesToDisclosures(
  capabilities: RequestedVerificationCapability[],
  verificationRequirements: VerificationRequirement[] = [],
): SelfVerificationDisclosures {
  const set = new Set(capabilities)
  const disclosures: SelfVerificationDisclosures = {}
  const minimumAge = resolveRequestedMinimumAge(capabilities, verificationRequirements)
  if (minimumAge != null) {
    disclosures.minimum_age = minimumAge
  }
  if (set.has("nationality")) {
    disclosures.nationality = true
  }
  if (set.has("gender")) {
    disclosures.gender = true
  }
  return disclosures
}

export function normalizeVerificationRequirements(
  provider: "self" | "very",
  requirements: VerificationRequirement[] | null | undefined,
): VerificationRequirement[] {
  if (provider === "very") return []
  const normalized: VerificationRequirement[] = []
  for (const requirement of requirements ?? []) {
    if (requirement?.proof_type !== "minimum_age") {
      throw badRequestError(`Unsupported Self verification requirement: ${String(requirement?.proof_type ?? "unknown")}`)
    }
    const minimumAge = Number(requirement.minimum_age)
    if (!Number.isInteger(minimumAge) || minimumAge < 18 || minimumAge > 125) {
      throw badRequestError("minimum_age verification requirement must be an integer from 18 to 125")
    }
    normalized.push({ proof_type: "minimum_age", minimum_age: minimumAge })
  }
  return normalized
}

function resolveRequestedMinimumAge(
  capabilities: RequestedVerificationCapability[],
  verificationRequirements: VerificationRequirement[],
): number | null {
  const minimumAges: number[] = []
  for (const requirement of verificationRequirements) {
    const minimumAge = requirement.minimum_age
    if (requirement.proof_type === "minimum_age" && typeof minimumAge === "number" && Number.isInteger(minimumAge)) {
      minimumAges.push(minimumAge)
    }
  }
  if (capabilities.includes("age_over_18")) {
    minimumAges.push(18)
  }
  if (minimumAges.length === 0) {
    return null
  }
  return Math.max(...minimumAges)
}

export type SelfStartResult = {
  upstreamSessionRef: string
  launch: SelfVerificationLaunch
}

export type SelfVerifiedClaims = {
  age_over_18: boolean
  minimum_age?: number | null
  nationality: string | null
  gender: "M" | "F" | null
  nullifier: string | null
}

export type SelfSessionOutcome =
  | { status: "verified"; claims: SelfVerifiedClaims }
  | { status: "pending" }
  | { status: "failed"; failureReason: string }
  | { status: "expired" }

export interface SelfProvider {
  startSession(input: {
    verificationSessionId: string
    userId: string
    publicOrigin?: string | null
    requestedCapabilities: RequestedVerificationCapability[]
    verificationRequirements?: VerificationRequirement[]
    verificationIntent: VerificationIntent | null
    policyId: string | null
  }): Promise<SelfStartResult>

  getSessionOutcome(input: {
    upstreamSessionRef: string
    attestationId?: string | null
    proof: unknown
    providerPayloadRef: unknown
  }): Promise<SelfSessionOutcome>
}

function trimEnv(value: string | undefined): string {
  return String(value || "").trim()
}

function normalizeOrigin(value: string | null | undefined): string | null {
  const trimmed = String(value || "").trim()
  if (!trimmed) {
    return null
  }
  try {
    return new URL(trimmed).origin
  } catch {
    return null
  }
}

function isHttpsOrigin(origin: string | null): origin is string {
  return origin != null && origin.startsWith("https://")
}

function isAutomatedTestEnv(env: Env): boolean {
  return String(env.ENVIRONMENT || "").trim().toLowerCase() === "test"
}

function shouldUseSelfDevStub(input: {
  env: Env
  publicOrigin?: string | null
}): boolean {
  return isAutomatedTestEnv(input.env)
}

function shouldUseSelfMockPassport(env: Env): boolean {
  return !isProductionEnv(env)
}

function parseMinimumAgeDisclosure(disclosures: Record<string, unknown>): number | null {
  const value = disclosures.minimumAge ?? disclosures.minimum_age ?? disclosures.olderThan
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value
  }
  if (typeof value === "string") {
    const parsed = Number(value)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null
  }
  return null
}

function buildVerificationConfig(
  capabilities: RequestedVerificationCapability[],
  verificationRequirements: VerificationRequirement[],
): VerificationConfig {
  const minimumAge = resolveRequestedMinimumAge(capabilities, verificationRequirements)
  return {
    ...(minimumAge != null ? { minimumAge } : {}),
  }
}

function buildSelfEndpoint(env: Env, verificationSessionId: string, publicOrigin?: string | null): string {
  const rawEndpoint = trimEnv(env.SELF_ENDPOINT)
  if (rawEndpoint) {
    return rawEndpoint.replace(/\{verification_session_id\}/g, encodeURIComponent(verificationSessionId))
  }
  const origin = resolveSelfCallbackOrigin(env, publicOrigin)
  if (!origin) {
    throw providerUnavailable("Self provider not configured: PIRATE_API_PUBLIC_ORIGIN or SELF_ENDPOINT must be set")
  }
  if (!isHttpsOrigin(origin)) {
    throw providerUnavailable("Self provider requires a public HTTPS callback origin; set PIRATE_API_PUBLIC_ORIGIN or SELF_ENDPOINT to an HTTPS URL")
  }
  return `${origin}/verification-sessions/${encodeURIComponent(verificationSessionId)}/self-callback`
}

function resolveSelfCallbackOrigin(env: Env, publicOrigin?: string | null): string | null {
  const configuredOrigin = normalizeOrigin(env.PIRATE_API_PUBLIC_ORIGIN)
  const requestOrigin = normalizeOrigin(publicOrigin)

  if (isProductionEnv(env)) {
    return configuredOrigin ?? requestOrigin
  }

  if (isHttpsOrigin(requestOrigin) && requestOrigin !== configuredOrigin) {
    return requestOrigin
  }

  return configuredOrigin ?? requestOrigin
}

function endpointTypeForEnvironment(env: Env): SelfVerificationLaunch["endpoint_type"] {
  const configured = trimEnv(env.SELF_ENDPOINT_TYPE)
  if (configured === "https" || configured === "staging_https" || configured === "celo" || configured === "staging_celo") {
    return configured
  }
  return isProductionEnv(env) ? "https" : "staging_https"
}

function parseProviderPayload(value: unknown): Record<string, unknown> | null {
  if (value == null) {
    return null
  }
  if (typeof value === "string") {
    const trimmed = value.trim()
    if (!trimmed) return null
    try {
      const parsed = JSON.parse(trimmed) as unknown
      return parsed != null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
    } catch {
      return null
    }
  }
  return typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function parseSelfProofPayload(input: {
  attestationId?: string | null
  proof: unknown
  providerPayloadRef: unknown
}): SelfProofPayload | null {
  const body = parseProviderPayload(input.providerPayloadRef) ?? parseProviderPayload(input.proof)
  if (!body) {
    return null
  }
  const rawAttestationId = body.attestationId ?? body.attestation_id ?? input.attestationId
  const attestationId = Number(rawAttestationId)
  const proof = body.proof
  const publicSignals = body.publicSignals ?? body.public_signals
  const userContextData = body.userContextData ?? body.user_context_data
  if (
    (attestationId !== 1 && attestationId !== 2 && attestationId !== 3 && attestationId !== 4)
    || proof == null
    || typeof proof !== "object"
    || !Array.isArray(publicSignals)
    || typeof userContextData !== "string"
  ) {
    return null
  }
  return {
    attestationId,
    proof: proof as SelfProofPayload["proof"],
    publicSignals: publicSignals as SelfProofPayload["publicSignals"],
    userContextData,
  }
}

function buildClaimsFromVerificationResult(result: VerificationResult): SelfVerifiedClaims | null {
  if (result.isValidDetails.isValid !== true) {
    return null
  }
  const disclosures = result.discloseOutput as unknown as Record<string, unknown>
  const minimumAge = parseMinimumAgeDisclosure(disclosures)
  const nullifier = typeof disclosures.nullifier === "string" && disclosures.nullifier.trim()
    ? disclosures.nullifier.trim()
    : null
  return {
    age_over_18: minimumAge != null ? minimumAge >= 18 : Boolean(result.discloseOutput.dateOfBirth),
    minimum_age: minimumAge,
    nationality: normalizeIdentityCountryCode(result.discloseOutput.nationality),
    gender: normalizeGenderClaim(result.discloseOutput.gender),
    nullifier,
  }
}

let testOverride: SelfProvider | null = null

function createSelfDevStubProvider(env: Env): SelfProvider {
  const appName = trimEnv(env.SELF_APP_NAME) || "Pirate"

  return {
    async startSession(input) {
      if (isProductionEnv(env)) {
        buildSelfEndpoint(env, input.verificationSessionId, input.publicOrigin)
      }
      const upstreamSessionRef = encodeDevStubSessionRef(input.requestedCapabilities, input.verificationRequirements ?? [])
      const disclosures = mapCapabilitiesToDisclosures(input.requestedCapabilities, input.verificationRequirements ?? [])
      const selfUserId = crypto.randomUUID()

      logVerificationDebug(env, "[self-provider] dev stub launch", {
        verificationSessionId: input.verificationSessionId,
        userId: input.userId,
        requestedCapabilities: input.requestedCapabilities,
        verificationRequirements: input.verificationRequirements ?? [],
        disclosures,
        scope: input.verificationIntent ?? "profile_verification",
      })

      return {
        upstreamSessionRef,
        launch: {
          app_name: appName,
          endpoint: "https://redirect.self.xyz",
          endpoint_type: "staging_https",
          scope: input.verificationIntent ?? "profile_verification",
          session_id: upstreamSessionRef,
          user_id: selfUserId,
          user_id_type: "uuid",
          disclosures,
          dev_mode: true,
          user_defined_data: JSON.stringify({
            verification_session_id: input.verificationSessionId,
            user_id: input.userId,
          }),
          version: 2,
        },
      }
    },

    async getSessionOutcome(input) {
      if (!input.upstreamSessionRef.startsWith(`${SELF_DEV_STUB_REF_PREFIX}:`)) {
        return { status: "pending" }
      }
      const capabilities = decodeDevStubCapabilities(input.upstreamSessionRef)
      const minimumAge = decodeDevStubMinimumAge(input.upstreamSessionRef)
      return {
        status: "verified",
        claims: {
          age_over_18: capabilities.has("age_over_18") || (minimumAge != null && minimumAge >= 18),
          minimum_age: minimumAge ?? (capabilities.has("age_over_18") ? 18 : null),
          nationality: capabilities.has("nationality") ? "USA" : null,
          gender: capabilities.has("gender") ? "F" : null,
          nullifier: input.upstreamSessionRef,
        },
      }
    },
  }
}

function createSelfSdkProvider(env: Env, options: { mockPassport: boolean }): SelfProvider {
  const endpointType = endpointTypeForEnvironment(env)
  const appName = trimEnv(env.SELF_APP_NAME) || "Pirate"

  return {
    async startSession(input) {
      const disclosures = mapCapabilitiesToDisclosures(input.requestedCapabilities, input.verificationRequirements ?? [])
      const verificationConfig = buildVerificationConfig(input.requestedCapabilities, input.verificationRequirements ?? [])
      const endpoint = buildSelfEndpoint(env, input.verificationSessionId, input.publicOrigin)
      const scope = input.verificationIntent ?? "profile_verification"
      const selfUserId = crypto.randomUUID()
      const userDefinedData = JSON.stringify({
        verification_session_id: input.verificationSessionId,
        user_id: input.userId,
      })
      const upstreamSessionRef = encodeSelfSdkSessionRef({
        endpoint,
        mockPassport: options.mockPassport,
        scope,
        selfUserId,
        userDefinedData,
        verificationConfig,
      })

      logVerificationDebug(env, "[self-provider] sdk launch", {
        verificationSessionId: input.verificationSessionId,
        userId: input.userId,
        requestedCapabilities: input.requestedCapabilities,
        verificationRequirements: input.verificationRequirements ?? [],
        disclosures,
        verificationConfig,
        endpointType,
        endpoint,
        scope,
        mockPassport: options.mockPassport,
      })

      return {
        upstreamSessionRef,
        launch: {
          app_name: appName,
          endpoint,
          endpoint_type: endpointType,
          scope,
          session_id: upstreamSessionRef,
          user_id: selfUserId,
          user_id_type: "uuid",
          disclosures,
          dev_mode: options.mockPassport,
          user_defined_data: userDefinedData,
          version: 2,
        },
      }
    },

    async getSessionOutcome(input) {
      const sessionRef = decodeSelfSdkSessionRef(input.upstreamSessionRef)
      const payload = parseSelfProofPayload(input)
      if (!sessionRef || !payload) {
        return { status: "pending" }
      }

      try {
        const { AllIds, DefaultConfigStore, SelfBackendVerifier } = await loadSelfCoreModule()
        const verifier = new SelfBackendVerifier(
          sessionRef.scope,
          sessionRef.endpoint,
          sessionRef.mockPassport,
          AllIds,
          new DefaultConfigStore(sessionRef.verificationConfig),
          "uuid",
        )
        const result = await verifier.verify(
          payload.attestationId,
          payload.proof,
          payload.publicSignals,
          payload.userContextData,
        )
        if (
          result.userData.userIdentifier !== sessionRef.selfUserId
          || result.userData.userDefinedData !== sessionRef.userDefinedData
        ) {
          return { status: "failed", failureReason: "self_user_context_mismatch" }
        }
        const claims = buildClaimsFromVerificationResult(result)
        if (!claims) {
          return { status: "failed", failureReason: "self_proof_invalid" }
        }
        return { status: "verified", claims }
      } catch (error) {
        return {
          status: "failed",
          failureReason: error instanceof Error ? error.message : "self_verification_failed",
        }
      }
    },
  }
}

function createConfiguredSelfProvider(env: Env): SelfProvider {
  const devStubProvider = createSelfDevStubProvider(env)
  const sdkProvider = createSelfSdkProvider(env, { mockPassport: shouldUseSelfMockPassport(env) })

  return {
    startSession(input) {
      return shouldUseSelfDevStub({ env, publicOrigin: input.publicOrigin })
        ? devStubProvider.startSession(input)
        : sdkProvider.startSession(input)
    },

    getSessionOutcome(input) {
      return input.upstreamSessionRef.startsWith(`${SELF_DEV_STUB_REF_PREFIX}:`)
        ? devStubProvider.getSessionOutcome(input)
        : sdkProvider.getSessionOutcome(input)
    },
  }
}

export function getSelfProvider(env: Env): SelfProvider {
  if (testOverride) {
    return testOverride
  }

  return createConfiguredSelfProvider(env)
}

export function setSelfProviderForTests(override: SelfProvider | null): void {
  testOverride = override
}
