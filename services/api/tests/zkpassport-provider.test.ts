import { afterEach, describe, expect, test } from "bun:test"
import { getZkPassportProvider } from "../src/lib/verification/zkpassport-provider"
import type { Env } from "../src/env"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

async function startSessionDevMode(envOverrides: Record<string, string>): Promise<boolean | null | undefined> {
  const env = { PIRATE_WEB_PUBLIC_ORIGIN: "https://pirate.sc", ...envOverrides } as unknown as Env
  const session = await getZkPassportProvider(env).startSession({
    verificationSessionId: "ver_devmode_test",
    userId: "user_devmode_test",
    requestedCapabilities: ["nationality"],
    verificationRequirements: [{ proof_type: "nationality", required_values: ["US"] }],
    verificationIntent: null,
    policyId: null,
    challengeExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  })
  return session.launch.dev_mode
}

describe("zkpassport dev mode", () => {
  test("sends the lightweight SDK-compatible query contract to the remote verifier", async () => {
    const env = {
      ENVIRONMENT: "staging",
      PIRATE_WEB_PUBLIC_ORIGIN: "https://pirate.sc",
      ZKPASSPORT_VERIFIER_URL: "http://localhost/verify",
    } as unknown as Env
    const provider = getZkPassportProvider(env)
    const session = await provider.startSession({
      verificationSessionId: "ver_remote_query_test",
      userId: "user_remote_query_test",
      requestedCapabilities: ["minimum_age", "nationality", "gender"],
      verificationRequirements: [
        { proof_type: "minimum_age", minimum_age: 18 },
        { proof_type: "nationality", required_values: ["US"] },
      ],
      verificationIntent: "community_join",
      policyId: null,
      challengeExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    })
    const sessionRef = JSON.parse(session.upstreamSessionRef.slice("zkpassport-sdk:".length)) as {
      binding: string
    }
    const captured: { verifierBody?: Record<string, unknown> } = {}
    globalThis.fetch = (async (_input, init) => {
      captured.verifierBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return Response.json({ verified: true, uniqueIdentifier: "document-nullifier" })
    }) as typeof fetch

    const outcome = await provider.getSessionOutcome({
      upstreamSessionRef: session.upstreamSessionRef,
      providerPayloadRef: {
        proofs: [{}],
        queryResult: {
          bind: { custom_data: sessionRef.binding },
          age: { gte: { result: true } },
          nationality: { disclose: { result: "USA" } },
          gender: { disclose: { result: "F" } },
        },
      },
    })

    expect(outcome.status).toBe("verified")
    expect(captured.verifierBody?.originalQuery).toEqual({
      bind: { custom_data: sessionRef.binding },
      nationality: { disclose: true },
      gender: { disclose: true },
      age: { gte: 18 },
    })
  })

  test("supports a unique-human-only nullifier query", async () => {
    const env = { ENVIRONMENT: "test", PIRATE_WEB_PUBLIC_ORIGIN: "https://pirate.sc" } as unknown as Env
    const session = await getZkPassportProvider(env).startSession({
      verificationSessionId: "ver_unique_human_test",
      userId: "user_unique_human_test",
      requestedCapabilities: ["unique_human"],
      verificationRequirements: [],
      verificationIntent: "community_join",
      policyId: null,
      challengeExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    })

    expect(session.launch.requested_capabilities).toEqual(["unique_human"])
  })

  test("ZKPASSPORT_DEV_MODE is ignored in production", async () => {
    expect(await startSessionDevMode({ ENVIRONMENT: "production", ZKPASSPORT_DEV_MODE: "1" })).toBe(false)
  })

  test("ZKPASSPORT_DEV_MODE enables dev mode outside production", async () => {
    expect(await startSessionDevMode({ ENVIRONMENT: "staging", ZKPASSPORT_DEV_MODE: "1" })).toBe(true)
  })

  test("dev mode defaults off outside production without the flag", async () => {
    expect(await startSessionDevMode({ ENVIRONMENT: "staging" })).toBe(false)
  })

  test("the test environment defaults dev mode on", async () => {
    expect(await startSessionDevMode({ ENVIRONMENT: "test" })).toBe(true)
  })
})
