import { describe, expect, test } from "bun:test"

import { buildTestEnv } from "./helpers"
import { canonicalizeRequestedCapabilities, getSelfProvider, mapCapabilitiesToDisclosures } from "../src/lib/verification/self-provider"

describe("self-provider capability canonicalization", () => {
  test("adds unique_human when age_over_18 is requested", () => {
    expect(canonicalizeRequestedCapabilities("self", ["age_over_18"])).toEqual([
      "unique_human",
      "age_over_18",
    ])
  })

  test("adds unique_human when nationality is requested", () => {
    expect(canonicalizeRequestedCapabilities("self", ["nationality"])).toEqual([
      "unique_human",
      "nationality",
    ])
  })

  test("adds unique_human when gender is requested", () => {
    expect(canonicalizeRequestedCapabilities("self", ["gender"])).toEqual([
      "unique_human",
      "gender",
    ])
  })

  test("maps gender capability to self disclosures", () => {
    expect(mapCapabilitiesToDisclosures(["unique_human", "gender"])).toEqual({
      gender: true,
    })
  })

  test("non-production self stub returns requested nationality and gender claims", async () => {
    const provider = getSelfProvider(buildTestEnv({ ENVIRONMENT: "test" }))
    const started = await provider.startSession({
      verificationSessionId: "ver_self_stub",
      userId: "usr_test",
      requestedCapabilities: ["unique_human", "nationality", "gender"],
      verificationIntent: "community_join",
      policyId: null,
    })

    const outcome = await provider.getSessionOutcome({
      upstreamSessionRef: started.upstreamSessionRef,
      proof: null,
      providerPayloadRef: null,
    })

    expect(outcome).toEqual({
      status: "verified",
      claims: {
        age_over_18: false,
        minimum_age: null,
        nationality: "USA",
        gender: "F",
        nullifier: started.upstreamSessionRef,
      },
    })
  })

  test("configured Self sessions use the SDK endpoint without an API key", async () => {
    const provider = getSelfProvider(buildTestEnv({ ENVIRONMENT: "staging" }))
    const started = await provider.startSession({
      verificationSessionId: "ver_self_sdk",
      userId: "usr_test",
      publicOrigin: "https://api.pirate.test",
      requestedCapabilities: ["unique_human", "nationality"],
      verificationIntent: "community_join",
      policyId: null,
    })

    expect(started.launch.endpoint).toBe("https://api.pirate.test/verification-sessions/ver_self_sdk/self-callback")
    expect(started.launch.endpoint_type).toBe("staging_https")
    expect(started.launch.user_id).toMatch(/^[0-9a-f-]{36}$/u)
    expect(started.launch.user_defined_data).toContain("ver_self_sdk")
    expect(started.upstreamSessionRef).toContain("\"kind\":\"self-sdk\"")
    expect(started.upstreamSessionRef).toContain("\"mockPassport\":true")
  })

  test("non-production Self sessions prefer the live HTTPS request origin over a stale configured origin", async () => {
    const provider = getSelfProvider(buildTestEnv({
      ENVIRONMENT: "staging",
      PIRATE_API_PUBLIC_ORIGIN: "https://stale-cloudflare.example.com",
    }))
    const started = await provider.startSession({
      verificationSessionId: "ver_self_fresh_tunnel",
      userId: "usr_test",
      publicOrigin: "https://fresh-cloudflare.example.com",
      requestedCapabilities: ["unique_human", "nationality"],
      verificationIntent: "community_join",
      policyId: null,
    })

    expect(started.launch.endpoint).toBe("https://fresh-cloudflare.example.com/verification-sessions/ver_self_fresh_tunnel/self-callback")
    expect(started.upstreamSessionRef).toContain("https://fresh-cloudflare.example.com/verification-sessions/ver_self_fresh_tunnel/self-callback")
  })

  test("production Self sessions use real passport verification without an API key", async () => {
    const provider = getSelfProvider(buildTestEnv({
      ENVIRONMENT: "production",
      PIRATE_API_PUBLIC_ORIGIN: "https://api.pirate.test",
    }))
    const started = await provider.startSession({
      verificationSessionId: "ver_self_prod",
      userId: "usr_test",
      requestedCapabilities: ["unique_human", "nationality"],
      verificationIntent: "community_join",
      policyId: null,
    })

    expect(started.launch.endpoint).toBe("https://api.pirate.test/verification-sessions/ver_self_prod/self-callback")
    expect(started.launch.endpoint_type).toBe("https")
    expect(started.upstreamSessionRef).toContain("\"kind\":\"self-sdk\"")
    expect(started.upstreamSessionRef).toContain("\"mockPassport\":false")
  })
})
