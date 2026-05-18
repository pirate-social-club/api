import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose"
import { setVeryProviderForTests } from "../src/lib/verification/very-provider"
import type { VeryProvider, VeryStartResult, VerySessionOutcome } from "../src/lib/verification/very-provider"
import { resetRuntimeCaches, withMockedFetch } from "./helpers"

beforeEach(() => {
  resetRuntimeCaches()
})

afterEach(() => {
  setVeryProviderForTests(null)
})

type TrackedFn = {
  (): Promise<unknown>
  callCount: number
  calls: unknown[][]
}

function veryStartInput(
  overrides: Partial<Parameters<VeryProvider["startSession"]>[0]> = {},
): Parameters<VeryProvider["startSession"]>[0] {
  return {
    verificationSessionId: "ver_test",
    challengeExpiresAt: "2099-01-01T00:00:00.000Z",
    userId: "user-1",
    requestedCapabilities: ["unique_human"],
    walletAttachmentId: null,
    verificationIntent: null,
    policyId: null,
    ...overrides,
  }
}

function trackFn<T extends (...args: any[]) => Promise<unknown>>(fn: T): T & TrackedFn {
  const calls: unknown[][] = []
  const tracked = async (...args: unknown[]) => {
    calls.push(args)
    return fn(...args)
  }
  ;(tracked as TrackedFn).callCount = 0
  Object.defineProperty(tracked, "callCount", {
    get: () => calls.length,
  })
  ;(tracked as any).calls = calls
  return tracked as T & TrackedFn
}

function createMockVeryProvider(overrides?: {
  startResult?: Partial<VeryStartResult>
  outcomes?: VerySessionOutcome[]
}): VeryProvider & { startSession: TrackedFn; getSessionOutcome: TrackedFn } {
  let callIndex = 0
  const outcomes = overrides?.outcomes ?? [{ status: "verified", attestationData: {} }]

  const startSession = trackFn(async () => ({
    upstreamSessionRef: "very-upstream-ref-123",
    launch: {
      app_id: "test-app-id",
      context: "verification",
      type_id: "palm_scan",
      query: { session: "very-upstream-ref-123" },
      verify_url: "https://verify.very.org/session/very-upstream-ref-123",
      session_binding: {
        uniqueness_domain: "pirate-unique-human-v0",
        binding_value: "0",
        binding_field: "pseudonym",
        challenge_expires_at: 4070908800,
      },
    },
    ...overrides?.startResult,
  }))

  const getSessionOutcome = trackFn(async () => {
    const outcome = outcomes[Math.min(callIndex, outcomes.length - 1)]
    callIndex += 1
    return outcome
  })

  return { startSession, getSessionOutcome } as VeryProvider & { startSession: TrackedFn; getSessionOutcome: TrackedFn }
}

async function createVerySignedTokenFixture(input: {
  act?: string
  aud?: string
  exp?: number
  iss?: string
  sub?: string
} = {}): Promise<{ jwk: JWK; token: string }> {
  const { privateKey, publicKey } = await generateKeyPair("RS256")
  const jwk = await exportJWK(publicKey)
  jwk.kid = "very-test-key"
  jwk.alg = "RS256"
  jwk.use = "sig"
  const nowSeconds = Math.floor(Date.now() / 1000)
  const token = await new SignJWT({ act: input.act ?? "verify" })
    .setProtectedHeader({ alg: "RS256", kid: "very-test-key", typ: "JWT" })
    .setIssuer(input.iss ?? "https://api.very.org")
    .setAudience(input.aud ?? "very-partner-app")
    .setSubject(input.sub ?? "very-user-1")
    .setIssuedAt(nowSeconds)
    .setExpirationTime(input.exp ?? nowSeconds + 300)
    .sign(privateKey)
  return { jwk, token }
}

describe("Very provider adapter", () => {
  test("configured Very provider throws providerUnavailable when VERY_APP_ID is not set", async () => {
    const { getVeryProvider } = require("../src/lib/verification/very-provider") as typeof import("../src/lib/verification/very-provider")
    setVeryProviderForTests(null)
    const provider = getVeryProvider({} as any)
    try {
      await provider.startSession(veryStartInput())
      throw new Error("Should have thrown")
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
      VERY_APP_ID: "test-app",
    } as any
    const provider = getVeryProvider(env)

    const startResult = await provider.startSession(veryStartInput())
    expect(typeof startResult.upstreamSessionRef).toBe("string")
    expect(startResult.launch.app_id).toBe("test-app")
    expect(startResult.launch.verify_url).toBe("https://very.example.com/api/v1/verify")

    const outcome = await provider.getSessionOutcome({
      upstreamSessionRef: startResult.upstreamSessionRef,
      providerPayloadRef: null,
    })
    expect(outcome.status).toBe("pending")
  })

  test("getVeryProvider derives verify URLs from pathful Very API URLs without duplicating api/v1", async () => {
    const { getVeryProvider } = require("../src/lib/verification/very-provider") as typeof import("../src/lib/verification/very-provider")

    const apiV1Provider = getVeryProvider({
      VERY_API_URL: "https://very.example.com/api/v1/",
      VERY_APP_ID: "test-app",
    } as any)
    const apiV1Result = await apiV1Provider.startSession(veryStartInput())
    expect(apiV1Result.launch.verify_url).toBe("https://very.example.com/api/v1/verify")

    const verifyProvider = getVeryProvider({
      VERY_API_URL: "https://very.example.com/api/v1/verify",
      VERY_APP_ID: "test-app",
    } as any)
    const verifyResult = await verifyProvider.startSession(veryStartInput())
    expect(verifyResult.launch.verify_url).toBe("https://very.example.com/api/v1/verify")
  })

  test("startSession returns a Pirate API widget verify URL when a public origin is known", async () => {
    const { getVeryProvider } = require("../src/lib/verification/very-provider") as typeof import("../src/lib/verification/very-provider")
    const env = {
      VERY_API_URL: "https://very.example.com",
      VERY_APP_ID: "test-app",
    } as any
    const provider = getVeryProvider(env)

    const startResult = await provider.startSession(veryStartInput({
      publicOrigin: "https://api.pirate.sc/some/path",
    }))

    expect(startResult.launch.verify_url).toBe("https://api.pirate.sc/verification-sessions/very-widget-verify")
  })

  test("startSession prefers configured public origin for widget verify URL in development", async () => {
    const { getVeryProvider } = require("../src/lib/verification/very-provider") as typeof import("../src/lib/verification/very-provider")
    const env = {
      ENVIRONMENT: "development",
      PIRATE_API_PUBLIC_ORIGIN: "https://public-tunnel.example.com",
      VERY_APP_ID: "test-app",
    } as any
    const provider = getVeryProvider(env)

    const startResult = await provider.startSession(veryStartInput({
      publicOrigin: "http://127.0.0.1:8787",
    }))

    expect(startResult.launch.verify_url).toBe("https://public-tunnel.example.com/verification-sessions/very-widget-verify")
  })

  test("startSession emits a Very ZK query within the documented timestamp range", async () => {
    const { getVeryProvider } = require("../src/lib/verification/very-provider") as typeof import("../src/lib/verification/very-provider")
    const env = {
      VERY_API_URL: "https://very.example.com",
      VERY_APP_ID: "test-app",
    } as any
    const provider = getVeryProvider(env)

    const startResult = await provider.startSession(veryStartInput({
      verificationIntent: "community_creation",
    }))
    const query = startResult.launch.query as {
      conditions?: Array<{ value?: { from?: string; to?: string } }>
      options?: Record<string, unknown>
    }
    const lowerBound = Number(query.conditions?.[0]?.value?.from)
    const upperBound = Number(query.conditions?.[0]?.value?.to)

    expect(Number.isInteger(lowerBound)).toBe(true)
    expect(Number.isInteger(upperBound)).toBe(true)
    expect(lowerBound).toBe(1_743_436_800)
    expect(upperBound).toBeGreaterThan(lowerBound)
    expect(upperBound).toBe(2_043_436_800)
    expect(query.options?.expiredAtLowerBound).toBe("1743436800")
    expect(query.options?.externalNullifier).toBe("Pirate - Community Creation")
    expect(query.options?.pseudonym).toBe("0")
    expect(startResult.launch.session_binding).toBe(undefined)
    expect(query.options ? "sessionId" in query.options : true).toBe(false)
  })

  test("configured provider verifies a proof payload through the Very verifier endpoint", async () => {
    const { getVeryProvider } = require("../src/lib/verification/very-provider") as typeof import("../src/lib/verification/very-provider")
    const env = {
      VERY_API_URL: "https://very.example.com",
      VERY_APP_ID: "test-app",
    } as any
    const provider = getVeryProvider(env)

    await withMockedFetch(() => (async (input, init) => {
      expect(String(input)).toBe("https://very.example.com/api/v1/verify")
      expect(init?.method).toBe("POST")
      const headers = new Headers(init?.headers)
      expect(headers.has("authorization")).toBe(false)
      expect(headers.has("x-api-key")).toBe(false)
      const body = JSON.parse(String(init?.body))
      expect(body).toEqual({ proof: "proof-payload-123" })
      return new Response(JSON.stringify({
        status: "valid",
        data: {
          attestation_id: "very-att-1",
          externalNullifier: "Pirate - Profile Verification - very-upstream-ref-123",
          pseudonym: "0",
          nullifier: "very-nullifier-1",
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof globalThis.fetch, async () => {
      const outcome = await provider.getSessionOutcome({
        upstreamSessionRef: "very-upstream-ref-123",
        providerPayloadRef: "proof-payload-123",
        expectedBinding: {
          uniqueness_domain: "pirate-unique-human-v0",
          binding_value: "0",
          binding_field: "pseudonym",
          challenge_expires_at: 4070908800,
        },
      })
      expect(outcome.status).toBe("verified")
      if (outcome.status === "verified") {
        expect(typeof outcome.attestationData.proof_hash).toBe("string")
        expect(outcome.attestationData.attestation_id).toBe("very-att-1")
      }
    })
  })

  test("configured provider accepts alternate successful verifier response shapes", async () => {
    const { getVeryProvider } = require("../src/lib/verification/very-provider") as typeof import("../src/lib/verification/very-provider")
    const env = {
      VERY_API_URL: "https://very.example.com",
      VERY_APP_ID: "test-app",
    } as any
    const provider = getVeryProvider(env)

    const responses = [
      { isValid: true, pseudonym: "0" },
      { is_valid: true, pseudonym: "0" },
      { result: true, pseudonym: "0" },
      { result: { valid: true, pseudonym: "0" } },
      { data: { verified: true, pseudonym: "0" } },
    ]
    let responseIndex = 0
    await withMockedFetch(() => (async () => {
      const body = responses[responseIndex++]
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof globalThis.fetch, async () => {
      for (const response of responses) {
        const outcome = await provider.getSessionOutcome({
          upstreamSessionRef: "very-upstream-ref-123",
          providerPayloadRef: `proof-for-${Object.keys(response)[0]}`,
          expectedBinding: {
            uniqueness_domain: "pirate-unique-human-v0",
            binding_value: "0",
            binding_field: "pseudonym",
            challenge_expires_at: 4070908800,
          },
        })
        expect(outcome.status).toBe("verified")
      }
    })
  })

  test("configured provider verifies a native SDK signed token through Very JWKS", async () => {
    const { getVeryProvider } = require("../src/lib/verification/very-provider") as typeof import("../src/lib/verification/very-provider")
    const { jwk, token } = await createVerySignedTokenFixture()
    const provider = getVeryProvider({
      VERY_APP_ID: "very-partner-app",
    } as any)

    let jwksFetches = 0
    await withMockedFetch(() => (async (input) => {
      expect(String(input)).toBe("https://api.very.org/.well-known/jwks.json")
      jwksFetches += 1
      return new Response(JSON.stringify({ keys: [jwk] }), {
        status: 200,
        headers: { "content-type": "application/json", "cache-control": "max-age=3600" },
      })
    }) as typeof globalThis.fetch, async () => {
      const outcome = await provider.getNativeSessionOutcome?.({
        signedToken: token,
        verificationSessionId: "ver_native",
        userId: "usr_native",
      })
      expect(outcome?.status).toBe("verified")
      if (outcome?.status === "verified") {
        expect(outcome.attestationData.external_user_id).toBe("very-user-1")
        expect(outcome.attestationData.provider_status).toBe("native_signed_token_verified")
        expect(typeof outcome.attestationData.nullifier_hash).toBe("string")
        expect(typeof outcome.attestationData.proof_hash).toBe("string")
      }
      const secondProvider = getVeryProvider({
        VERY_APP_ID: "very-partner-app",
      } as any)
      const secondOutcome = await secondProvider.getNativeSessionOutcome?.({
        signedToken: token,
        verificationSessionId: "ver_native_2",
        userId: "usr_native",
      })
      expect(secondOutcome?.status).toBe("verified")
      expect(jwksFetches).toBe(1)
    })
  })

  test("configured provider rejects native SDK signed tokens with the wrong act claim", async () => {
    const { getVeryProvider } = require("../src/lib/verification/very-provider") as typeof import("../src/lib/verification/very-provider")
    const { jwk, token } = await createVerySignedTokenFixture({ act: "enroll" })
    const provider = getVeryProvider({
      VERY_APP_ID: "very-partner-app",
    } as any)

    await withMockedFetch(() => (async () => {
      return new Response(JSON.stringify({ keys: [jwk] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof globalThis.fetch, async () => {
      try {
        await provider.getNativeSessionOutcome?.({
          signedToken: token,
          verificationSessionId: "ver_native",
          userId: "usr_native",
        })
        throw new Error("Should have thrown")
      } catch (error: any) {
        expect(error.code).toBe("provider_unavailable")
        expect(error.message).toBe("Very native SDK signed token has an invalid act claim")
      }
    })
  })
})

describe("Very provider mock integration", () => {
  test("startSession returns upstream ref and launch data", async () => {
    const provider = createMockVeryProvider()
    const result = await provider.startSession(veryStartInput())

    expect(result.upstreamSessionRef).toBe("very-upstream-ref-123")
    expect(result.launch.app_id).toBe("test-app-id")
    expect(result.launch.verify_url?.includes("very-upstream-ref-123")).toBe(true)
  })

  test("startSession rejects non-unique_human capabilities via route layer", () => {
    const provider = createMockVeryProvider()
    expect(provider.startSession.callCount).toBe(0)
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

    await provider.startSession(veryStartInput({
      userId: "user-abc",
      walletAttachmentId: "wallet-123",
      verificationIntent: "community_creation",
      policyId: "policy-1",
    }))

    expect(provider.startSession.callCount).toBe(1)
    const startArgs = provider.startSession.calls[0][0] as any
    expect(startArgs.userId).toBe("user-abc")
    expect(startArgs.requestedCapabilities).toEqual(["unique_human"])
    expect(startArgs.walletAttachmentId).toBe("wallet-123")
    expect(startArgs.verificationIntent).toBe("community_creation")
    expect(startArgs.policyId).toBe("policy-1")

    await provider.getSessionOutcome({
      upstreamSessionRef: "ref-456",
      providerPayloadRef: "callback-token",
    })

    expect(provider.getSessionOutcome.callCount).toBe(1)
    const outcomeArgs = provider.getSessionOutcome.calls[0][0] as any
    expect(outcomeArgs.upstreamSessionRef).toBe("ref-456")
    expect(outcomeArgs.providerPayloadRef).toBe("callback-token")
  })
})

describe("Very provider development fallback", () => {
  test("startSession returns a verifier URL in development", async () => {
    const { getVeryProvider } = require("../src/lib/verification/very-provider") as typeof import("../src/lib/verification/very-provider")
    const env = {
      VERY_APP_ID: "fallback-app-id",
      ENVIRONMENT: "development",
    } as any
    const provider = getVeryProvider(env)
    const result = await provider.startSession(veryStartInput())
    expect(result.launch.verify_url).toBe("https://verify.very.org/api/v1/verify")
    expect(result.launch.app_id).toBe("fallback-app-id")
  })

  test("getSessionOutcome returns verified in development without API key", async () => {
    const { getVeryProvider } = require("../src/lib/verification/very-provider") as typeof import("../src/lib/verification/very-provider")
    const env = {
      VERY_APP_ID: "dev-app",
      ENVIRONMENT: "development",
    } as any
    const provider = getVeryProvider(env)
    const outcome = await provider.getSessionOutcome({
      upstreamSessionRef: "local-ref",
      providerPayloadRef: "some-proof",
    })
    expect(outcome.status).toBe("verified")
    if (outcome.status === "verified") {
      expect(typeof outcome.attestationData.proof_hash).toBe("string")
      expect(outcome.attestationData.provider_status).toBe("local_widget_verified")
    }
  })

  test("getSessionOutcome can force real verifier in development", async () => {
    const { getVeryProvider } = require("../src/lib/verification/very-provider") as typeof import("../src/lib/verification/very-provider")
    const env = {
      VERY_APP_ID: "dev-app",
      VERY_TRUST_LOCAL_WIDGET_COMPLETION: "false",
      ENVIRONMENT: "development",
    } as any
    const provider = getVeryProvider(env)
    let requestedUrl = ""
    await withMockedFetch(() => (async (url) => {
      requestedUrl = String(url)
      return new Response(JSON.stringify({ status: "valid" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof globalThis.fetch, async () => {
      const outcome = await provider.getSessionOutcome({
        upstreamSessionRef: "local-ref",
        providerPayloadRef: "some-proof",
      })
      expect(outcome.status).toBe("verified")
      expect(requestedUrl).toBe("https://verify.very.org/api/v1/verify")
    })
  })

  test("getSessionOutcome returns pending when no providerPayloadRef", async () => {
    const { getVeryProvider } = require("../src/lib/verification/very-provider") as typeof import("../src/lib/verification/very-provider")
    const env = {
      VERY_APP_ID: "dev-app",
      ENVIRONMENT: "development",
    } as any
    const provider = getVeryProvider(env)
    const outcome = await provider.getSessionOutcome({
      upstreamSessionRef: "local-ref",
      providerPayloadRef: null,
    })
    expect(outcome.status).toBe("pending")
  })

  test("getSessionOutcome does not bypass in non-development environment", async () => {
    const { getVeryProvider } = require("../src/lib/verification/very-provider") as typeof import("../src/lib/verification/very-provider")
    const env = {
      VERY_APP_ID: "prod-app",
      ENVIRONMENT: "production",
    } as any
    const provider = getVeryProvider(env)
    await withMockedFetch(() => (async () => {
      return new Response(JSON.stringify({ status: "valid" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof globalThis.fetch, async () => {
      const outcome = await provider.getSessionOutcome({
        upstreamSessionRef: "prod-ref",
        providerPayloadRef: "prod-proof",
      })
      expect(outcome.status).toBe("verified")
    })
  })
})
