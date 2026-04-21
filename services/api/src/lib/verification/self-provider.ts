import { badRequestError, providerUnavailable } from "../errors"
import { makeId } from "../helpers"
import { normalizeIdentityCountryCode } from "../identity/country-codes"
import type { Env, RequestedVerificationCapability, SelfVerificationDisclosures, SelfVerificationLaunch, VerificationIntent, VerificationRequirement } from "../../types"

const SELF_TIMEOUT_MS = 15_000

const SELF_CAPABILITY_ORDER: readonly RequestedVerificationCapability[] = ["unique_human", "age_over_18", "nationality", "gender"]
const SELF_DEV_STUB_REF_PREFIX = "self-dev-stub"

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
    if (!Number.isInteger(minimumAge) || minimumAge < 1 || minimumAge > 125) {
      throw badRequestError("minimum_age verification requirement must be an integer from 1 to 125")
    }
    normalized.push({ proof_type: "minimum_age", minimum_age: minimumAge })
  }
  return normalized
}

function resolveRequestedMinimumAge(
  capabilities: RequestedVerificationCapability[],
  verificationRequirements: VerificationRequirement[],
): number | null {
  const minimumAges = verificationRequirements
    .filter((requirement) => requirement.proof_type === "minimum_age")
    .map((requirement) => requirement.minimum_age)
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
}

export type SelfSessionOutcome =
  | { status: "verified"; claims: SelfVerifiedClaims }
  | { status: "pending" }
  | { status: "failed"; failureReason: string }
  | { status: "expired" }

export interface SelfProvider {
  startSession(input: {
    userId: string
    requestedCapabilities: RequestedVerificationCapability[]
    verificationRequirements?: VerificationRequirement[]
    verificationIntent: VerificationIntent | null
    policyId: string | null
  }): Promise<SelfStartResult>

  getSessionOutcome(input: {
    upstreamSessionRef: string
    proof: string | null
    providerPayloadRef: string | null
  }): Promise<SelfSessionOutcome>
}

function trimEnv(value: string | undefined): string {
  return String(value || "").trim()
}

function requireConfiguredSelf(env: Env): { apiUrl: string; apiKey: string; appName: string } {
  const apiUrl = trimEnv(env.SELF_API_URL)
  const apiKey = trimEnv(env.SELF_API_KEY)
  const appName = trimEnv(env.SELF_APP_NAME) || "Pirate"
  if (!apiUrl || !apiKey) {
    throw providerUnavailable("Self provider not configured: SELF_API_URL and SELF_API_KEY must be set")
  }
  return { apiUrl, apiKey, appName }
}

function isProductionEnv(env: Env): boolean {
  return String(env.ENVIRONMENT || "").trim().toLowerCase() === "production"
}

async function verifySelfProof(input: {
  apiUrl: string
  apiKey: string
  proof: string
  upstreamSessionRef: string
}): Promise<SelfSessionOutcome> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), SELF_TIMEOUT_MS)

  try {
    const response = await fetch(`${input.apiUrl}/v1/verify`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${input.apiKey}`,
      },
      body: JSON.stringify({
        proof: input.proof,
        session_id: input.upstreamSessionRef,
      }),
      signal: controller.signal,
    })

    const body = await response.json().catch(() => null) as Record<string, unknown> | null
    if (!response.ok) {
      const message = (body?.error as string) || `Self verification request failed with status ${response.status}`
      throw providerUnavailable(message)
    }

    if (!body || typeof body !== "object") {
      throw providerUnavailable("Self verification response was invalid")
    }

    const status = String(body.status || "").trim().toLowerCase()
    if (body.expired === true || status === "expired") {
      return { status: "expired" }
    }

    if (status === "verified" || status === "success" || status === "completed" || body.verified === true) {
      const disclosures = (
        body.disclosures
        ?? body.discloseOutput
        ?? body.disclose_output
        ?? {}
      ) as Record<string, unknown>
      const minimumAge = parseMinimumAgeDisclosure(disclosures)
      const claims: SelfVerifiedClaims = {
        age_over_18: minimumAge != null ? minimumAge >= 18 : disclosures?.date_of_birth != null,
        minimum_age: minimumAge,
        nationality: normalizeIdentityCountryCode(disclosures?.nationality),
        gender: normalizeGenderClaim(disclosures?.gender ?? body.gender),
      }
      return { status: "verified", claims }
    }

    if (status === "pending" || status === "processing") {
      return { status: "pending" }
    }

    return {
      status: "failed",
      failureReason: (body.error as string) || (body.failure_reason as string) || status || "verification_failed",
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw providerUnavailable("Self verification request timed out")
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

function parseMinimumAgeDisclosure(disclosures: Record<string, unknown>): number | null {
  const value = disclosures.minimum_age ?? disclosures.minimumAge ?? disclosures.olderThan
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value
  }
  if (typeof value === "string") {
    const parsed = Number(value)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null
  }
  return null
}

let testOverride: SelfProvider | null = null

export function getSelfProvider(env: Env): SelfProvider {
  if (testOverride) {
    return testOverride
  }

  const endpoint = trimEnv(env.SELF_ENDPOINT) || "https://self.xyz"
  const endpointType = (trimEnv(env.SELF_ENDPOINT_TYPE) || "https") as SelfVerificationLaunch["endpoint_type"]
  const appName = trimEnv(env.SELF_APP_NAME) || "Pirate"

  if (!trimEnv(env.SELF_API_URL) || !trimEnv(env.SELF_API_KEY)) {
    if (isProductionEnv(env)) {
      requireConfiguredSelf(env)
    }

    return {
      async startSession(input) {
        const upstreamSessionRef = encodeDevStubSessionRef(input.requestedCapabilities, input.verificationRequirements ?? [])
        const disclosures = mapCapabilitiesToDisclosures(input.requestedCapabilities, input.verificationRequirements ?? [])

        return {
          upstreamSessionRef,
          launch: {
            app_name: appName,
            endpoint,
            endpoint_type: endpointType,
            scope: input.verificationIntent ?? "profile_verification",
            session_id: upstreamSessionRef,
            user_id: input.userId,
            user_id_type: "uuid",
            disclosures,
          },
        }
      },

      async getSessionOutcome(input) {
        const capabilities = decodeDevStubCapabilities(input.upstreamSessionRef)
        const minimumAge = decodeDevStubMinimumAge(input.upstreamSessionRef)
        return {
          status: "verified",
          claims: {
            age_over_18: capabilities.has("age_over_18") || (minimumAge != null && minimumAge >= 18),
            minimum_age: minimumAge ?? (capabilities.has("age_over_18") ? 18 : null),
            nationality: capabilities.has("nationality") ? "USA" : null,
            gender: capabilities.has("gender") ? "F" : null,
          },
        }
      },
    }
  }

  const { apiUrl, apiKey } = requireConfiguredSelf(env)

  return {
    async startSession(input) {
      const upstreamSessionRef = makeId("ss")
      const disclosures = mapCapabilitiesToDisclosures(input.requestedCapabilities, input.verificationRequirements ?? [])

      return {
        upstreamSessionRef,
        launch: {
          app_name: appName,
          endpoint,
          endpoint_type: endpointType,
          scope: input.verificationIntent ?? "profile_verification",
          session_id: upstreamSessionRef,
          user_id: input.userId,
          user_id_type: "uuid",
          disclosures,
        },
      }
    },

    async getSessionOutcome(input) {
      const proof = input.proof?.trim()
      if (!proof) {
        return { status: "pending" }
      }

      return await verifySelfProof({
        apiUrl,
        apiKey,
        proof,
        upstreamSessionRef: input.upstreamSessionRef,
      })
    },
  }
}

export function setSelfProviderForTests(override: SelfProvider | null): void {
  testOverride = override
}
