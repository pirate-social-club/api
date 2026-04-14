import { providerUnavailable } from "../errors"
import { makeId } from "../helpers"
import type { VeryWidgetLaunch } from "../../types"
import type { Env } from "../../types"

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

let testOverride: VeryProvider | null = null

export function getVeryProvider(env: Env): VeryProvider {
  if (testOverride) {
    return testOverride
  }

  const apiUrl = String(env.VERY_API_URL || "").trim()
  const apiKey = String(env.VERY_API_KEY || "").trim()
  const appId = String(env.VERY_APP_ID || "").trim()

  if (!apiUrl || !apiKey || !appId) {
    throw providerUnavailable("Very provider not configured: VERY_API_URL, VERY_API_KEY, and VERY_APP_ID must be set")
  }

  // TODO: Replace this stub with a real HTTP client that calls Very's API.
  //
  // This stub creates sessions and returns pending on getSessionOutcome.
  // It does NOT auto-verify — that would be a trust-on-complete path that
  // defeats the purpose of provider-aware verification. Until the real
  // Very HTTP integration is implemented, sessions will stay pending.
  //
  // For testing, use setVeryProviderForTests() to install a mock that
  // returns the outcomes you need.
  //
  // Once the Very API contract is confirmed, replace both method bodies
  // with real HTTP calls:
  //   startSession:  POST {apiUrl}/sessions -> upstream session + launch payload
  //   getSessionOutcome: GET {apiUrl}/sessions/{ref} -> real provider status
  return {
    async startSession(input) {
      const upstreamSessionRef = makeId("vs")
      return {
        upstreamSessionRef,
        launch: {
          app_id: appId,
          context: "verification",
          type_id: "palm_scan",
          query: { session: upstreamSessionRef, user_id: input.userId },
          verify_url: `${apiUrl}/verify/${upstreamSessionRef}`,
        },
      }
    },

    async getSessionOutcome(input) {
      // TODO: Call GET {apiUrl}/sessions/{upstreamSessionRef} to check real status.
      // Until the real HTTP integration is implemented, return pending.
      // This ensures the verification flow cannot auto-approve without
      // either a test mock or a real provider confirming verification.
      return { status: "pending" }
    },
  }
}

export function setVeryProviderForTests(override: VeryProvider | null): void {
  testOverride = override
}
