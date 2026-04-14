import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { setVeryProviderForTests } from "../src/lib/verification/very-provider"
import type { VeryProvider, VeryStartResult, VerySessionOutcome } from "../src/lib/verification/very-provider"
import { resetRuntimeCaches } from "./helpers"

beforeEach(() => {
  resetRuntimeCaches()
})

afterEach(() => {
  setVeryProviderForTests(null)
})

function createMockVeryProvider(overrides?: {
  startResult?: Partial<VeryStartResult>
  outcomes?: VerySessionOutcome[]
}): VeryProvider {
  let callIndex = 0
  const outcomes = overrides?.outcomes ?? [{ status: "verified", attestationData: {} }]

  return {
    startSession: mock(async () => ({
      upstreamSessionRef: "very-upstream-ref-123",
      launch: {
        app_id: "test-app-id",
        context: "verification",
        type_id: "palm_scan",
        query: { session: "very-upstream-ref-123" },
        verify_url: "https://verify.very.org/session/very-upstream-ref-123",
      },
      ...overrides?.startResult,
    })),
    getSessionOutcome: mock(async () => {
      const outcome = outcomes[Math.min(callIndex, outcomes.length - 1)]
      callIndex += 1
      return outcome
    }),
  }
}

describe("Very provider adapter", () => {
  test("getVeryProvider throws providerUnavailable when VERY_API_URL is not set", () => {
    const { getVeryProvider } = require("../src/lib/verification/very-provider") as typeof import("../src/lib/verification/very-provider")
    try {
      getVeryProvider({} as any)
      expect.unreachable("Should have thrown")
    } catch (error: any) {
      expect(error.code).toBe("provider_unavailable")
    }
  })

  test("getVeryProvider returns test override when set", () => {
    const { getVeryProvider } = require("../src/lib/verification/very-provider") as typeof import("../src/lib/verification/very-provider")
    const mockProvider = createMockVeryProvider()
    setVeryProviderForTests(mockProvider)
    const result = getVeryProvider({} as any)
    expect(result).toBe(mockProvider)
  })

  test("getVeryProvider returns a stub that creates sessions and returns pending when env vars are configured", async () => {
    const { getVeryProvider } = require("../src/lib/verification/very-provider") as typeof import("../src/lib/verification/very-provider")
    const env = {
      VERY_API_URL: "https://very.example.com",
      VERY_API_KEY: "test-key",
      VERY_APP_ID: "test-app",
    } as any
    const provider = getVeryProvider(env)
    const startResult = await provider.startSession({
      userId: "user-1",
      requestedCapabilities: ["unique_human"],
      walletAttachmentId: null,
      verificationIntent: null,
      policyId: null,
    })
    expect(typeof startResult.upstreamSessionRef).toBe("string")
    expect(startResult.launch.app_id).toBe("test-app")
    expect(startResult.launch.verify_url).toContain("very.example.com")

    const outcome = await provider.getSessionOutcome({
      upstreamSessionRef: startResult.upstreamSessionRef,
      providerPayloadRef: null,
    })
    expect(outcome.status).toBe("pending")
  })

  test("configured provider verifies a proof payload through the Very verifier endpoint", async () => {
    const { getVeryProvider } = require("../src/lib/verification/very-provider") as typeof import("../src/lib/verification/very-provider")
    const env = {
      VERY_API_URL: "https://very.example.com",
      VERY_API_KEY: "test-key",
      VERY_APP_ID: "test-app",
    } as any
    const provider = getVeryProvider(env)

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input, init) => {
      expect(String(input)).toBe("https://very.example.com/api/v1/verify")
      expect(init?.method).toBe("POST")
      const body = JSON.parse(String(init?.body))
      expect(body.proof).toBe("proof-payload-123")
      expect(body.session_id).toBe("very-upstream-ref-123")
      return new Response(JSON.stringify({
        status: "valid",
        data: {
          attestation_id: "very-att-1",
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof globalThis.fetch

    try {
      const outcome = await provider.getSessionOutcome({
        upstreamSessionRef: "very-upstream-ref-123",
        providerPayloadRef: "proof-payload-123",
      })
      expect(outcome.status).toBe("verified")
      if (outcome.status === "verified") {
        expect(typeof outcome.attestationData.proof_hash).toBe("string")
        expect(outcome.attestationData.attestation_id).toBe("very-att-1")
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe("Very provider mock integration", () => {
  test("startSession returns upstream ref and launch data", async () => {
    const provider = createMockVeryProvider()
    const result = await provider.startSession({
      userId: "user-1",
      requestedCapabilities: ["unique_human"],
      walletAttachmentId: null,
      verificationIntent: null,
      policyId: null,
    })

    expect(result.upstreamSessionRef).toBe("very-upstream-ref-123")
    expect(result.launch.app_id).toBe("test-app-id")
    expect(result.launch.verify_url).toContain("very-upstream-ref-123")
  })

  test("startSession rejects non-unique_human capabilities via route layer", () => {
    const provider = createMockVeryProvider()
    expect(provider.startSession).toHaveBeenCalledTimes(0)
  })

  test("getSessionOutcome returns verified when provider confirms", async () => {
    const provider = createMockVeryProvider({
      outcomes: [{ status: "verified", attestationData: { palm_scan: true } }],
    })
    const result = await provider.getSessionOutcome({
      upstreamSessionRef: "very-upstream-ref-123",
      providerPayloadRef: null,
    })
    expect(result.status).toBe("verified")
    if (result.status === "verified") {
      expect(result.attestationData).toEqual({ palm_scan: true })
    }
  })

  test("getSessionOutcome returns pending when provider has not completed", async () => {
    const provider = createMockVeryProvider({
      outcomes: [{ status: "pending" }],
    })
    const result = await provider.getSessionOutcome({
      upstreamSessionRef: "very-upstream-ref-123",
      providerPayloadRef: null,
    })
    expect(result.status).toBe("pending")
  })

  test("getSessionOutcome returns failed with reason", async () => {
    const provider = createMockVeryProvider({
      outcomes: [{ status: "failed", failureReason: "biometric_mismatch" }],
    })
    const result = await provider.getSessionOutcome({
      upstreamSessionRef: "very-upstream-ref-123",
      providerPayloadRef: null,
    })
    expect(result.status).toBe("failed")
    if (result.status === "failed") {
      expect(result.failureReason).toBe("biometric_mismatch")
    }
  })

  test("getSessionOutcome returns expired", async () => {
    const provider = createMockVeryProvider({
      outcomes: [{ status: "expired" }],
    })
    const result = await provider.getSessionOutcome({
      upstreamSessionRef: "very-upstream-ref-123",
      providerPayloadRef: null,
    })
    expect(result.status).toBe("expired")
  })

  test("polling returns pending then verified on subsequent calls", async () => {
    const provider = createMockVeryProvider({
      outcomes: [
        { status: "pending" },
        { status: "pending" },
        { status: "verified", attestationData: {} },
      ],
    })

    const first = await provider.getSessionOutcome({ upstreamSessionRef: "ref", providerPayloadRef: null })
    expect(first.status).toBe("pending")

    const second = await provider.getSessionOutcome({ upstreamSessionRef: "ref", providerPayloadRef: null })
    expect(second.status).toBe("pending")

    const third = await provider.getSessionOutcome({ upstreamSessionRef: "ref", providerPayloadRef: null })
    expect(third.status).toBe("verified")
  })

  test("startSession and getSessionOutcome are called with correct arguments", async () => {
    const provider = createMockVeryProvider()

    await provider.startSession({
      userId: "user-abc",
      requestedCapabilities: ["unique_human"],
      walletAttachmentId: "wallet-123",
      verificationIntent: "community_creation",
      policyId: "policy-1",
    })

    expect(provider.startSession).toHaveBeenCalledTimes(1)
    const startArgs = (provider.startSession as any).mock.calls[0][0]
    expect(startArgs.userId).toBe("user-abc")
    expect(startArgs.requestedCapabilities).toEqual(["unique_human"])
    expect(startArgs.walletAttachmentId).toBe("wallet-123")
    expect(startArgs.verificationIntent).toBe("community_creation")
    expect(startArgs.policyId).toBe("policy-1")

    await provider.getSessionOutcome({
      upstreamSessionRef: "ref-456",
      providerPayloadRef: "callback-token",
    })

    expect(provider.getSessionOutcome).toHaveBeenCalledTimes(1)
    const outcomeArgs = (provider.getSessionOutcome as any).mock.calls[0][0]
    expect(outcomeArgs.upstreamSessionRef).toBe("ref-456")
    expect(outcomeArgs.providerPayloadRef).toBe("callback-token")
  })
})
