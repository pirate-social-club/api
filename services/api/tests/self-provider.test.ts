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

  test("maps sanctions requirement to self OFAC disclosure", () => {
    expect(mapCapabilitiesToDisclosures(["unique_human", "nationality"], [{ proof_type: "sanctions_clear" }])).toEqual({
      nationality: true,
      ofac: true,
    })
  })

  test("non-production self stub returns requested nationality and gender claims", async () => {
    const provider = getSelfProvider(buildTestEnv({ ENVIRONMENT: "test" }))
    const started = await provider.startSession({
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
        ofac_clear: null,
      },
    })
  })

  test("non-production self stub returns OFAC clear when requested", async () => {
    const provider = getSelfProvider(buildTestEnv({ ENVIRONMENT: "test" }))
    const started = await provider.startSession({
      userId: "usr_test",
      requestedCapabilities: ["unique_human", "nationality"],
      verificationRequirements: [{ proof_type: "sanctions_clear" }],
      verificationIntent: "community_join",
      policyId: null,
    })

    expect(started.launch.disclosures.ofac).toBe(true)

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
        gender: null,
        ofac_clear: true,
      },
    })
  })
})
