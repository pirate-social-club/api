import { providerUnavailable } from "../errors"
import { makeId } from "../helpers"
import type { Env, RequestedVerificationCapability, SelfVerificationDisclosures, SelfVerificationLaunch, VerificationIntent } from "../../types"

const SELF_TIMEOUT_MS = 15_000

const SELF_CAPABILITY_ORDER: readonly RequestedVerificationCapability[] = ["unique_human", "age_over_18", "nationality"]

export function canonicalizeRequestedCapabilities(
  provider: "self" | "very",
  requested: RequestedVerificationCapability[],
): RequestedVerificationCapability[] {
  if (provider === "very") return ["unique_human"]
  if (requested.length === 0) return ["unique_human"]
  const set = new Set(requested)
  if (set.has("age_over_18") || set.has("nationality")) {
    set.add("unique_human")
  }
  return SELF_CAPABILITY_ORDER.filter((c) => set.has(c))
}

export function mapCapabilitiesToDisclosures(
  capabilities: RequestedVerificationCapability[],
): SelfVerificationDisclosures {
  const set = new Set(capabilities)
  const disclosures: SelfVerificationDisclosures = {}
  if (set.has("age_over_18")) {
    disclosures.minimum_age = 18
  }
  if (set.has("nationality")) {
    disclosures.nationality = true
  }
  return disclosures
}

export type SelfStartResult = {
  upstreamSessionRef: string
  launch: SelfVerificationLaunch
}

export type SelfVerifiedClaims = {
  age_over_18: boolean
  nationality: string | null
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
      const disclosures = body.disclosures as Record<string, unknown> | undefined
      const claims: SelfVerifiedClaims = {
        age_over_18: disclosures?.minimum_age != null || disclosures?.date_of_birth != null,
        nationality: typeof disclosures?.nationality === "string" ? disclosures.nationality : null,
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
        const upstreamSessionRef = makeId("ss")
        const disclosures = mapCapabilitiesToDisclosures(input.requestedCapabilities)

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

      async getSessionOutcome() {
        return {
          status: "verified",
          claims: {
            age_over_18: true,
            nationality: null,
          },
        }
      },
    }
  }

  const { apiUrl, apiKey } = requireConfiguredSelf(env)

  return {
    async startSession(input) {
      const upstreamSessionRef = makeId("ss")
      const disclosures = mapCapabilitiesToDisclosures(input.requestedCapabilities)

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
