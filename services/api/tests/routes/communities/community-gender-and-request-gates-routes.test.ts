import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import app from "../../../src/index"
import { setSelfProviderForTests } from "../../../src/lib/verification/self-provider"
import type { SelfProvider } from "../../../src/lib/verification/self-provider"
import { createRouteTestContext, json, resetRuntimeCaches } from "../../helpers"
import {
  completeGenderVerification,
  completeUniqueHumanVerification,
  exchangeJwt,
  prepareVerifiedNamespace,
  requestJson,
} from "./community-routes-test-helpers"
import { createMembershipGatedCommunity } from "./community-membership-gate-test-helpers"

let cleanup: (() => Promise<void>) | null = null

beforeEach(() => {
  resetRuntimeCaches()
})

afterEach(async () => {
  setSelfProviderForTests(null)
  if (cleanup) {
    await cleanup()
    cleanup = null
  }
})

describe("community gender and request gate routes", () => {
  test("join-eligibility returns verification_required when gender is missing", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "gender-elig-missing-creator")
    const created = await createMembershipGatedCommunity({
      env: ctx.env,
      creatorAccessToken: creator.accessToken,
      displayName: "Missing Gender Club",
      gateRule: {
        scope: "membership",
        gate_family: "identity_proof",
        gate_type: "gender",
        proof_requirements: [
          {
            proof_type: "gender",
            accepted_providers: ["self"],
            config: { required_value: "M" },
          },
        ],
      },
    })

    const joiner = await exchangeJwt(ctx.env, "gender-elig-missing-joiner")
    await completeUniqueHumanVerification(ctx.env, joiner.accessToken)

    const eligibility = await app.request(
      `http://pirate.test/communities/${created.communityId}/join-eligibility`,
      {
        headers: { authorization: `Bearer ${joiner.accessToken}` },
      },
      ctx.env,
    )
    expect(eligibility.status).toBe(200)
    const eligibilityBody = await json(eligibility) as {
      status: string
      missing_capabilities: string[]
      suggested_verification_provider: string | null
      suggested_verification_intent: string | null
    }
    expect(eligibilityBody.status).toBe("verification_required")
    expect(eligibilityBody.missing_capabilities).toContain("gender")
    expect(eligibilityBody.suggested_verification_provider).toBe("self")
    expect(eligibilityBody.suggested_verification_intent).toBe("community_join")
  })

  test("join mutation returns gate_failed with failure_reason gender_mismatch on mismatch", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "gender-join-mismatch-creator")
    const created = await createMembershipGatedCommunity({
      env: ctx.env,
      creatorAccessToken: creator.accessToken,
      displayName: "Join Mismatch Gender Club",
      gateRule: {
        scope: "membership",
        gate_family: "identity_proof",
        gate_type: "gender",
        proof_requirements: [
          {
            proof_type: "gender",
            accepted_providers: ["self"],
            config: { required_value: "M" },
          },
        ],
      },
    })

    const joiner = await exchangeJwt(ctx.env, "gender-join-mismatch-joiner")
    setSelfProviderForTests({
      startSession: async () => ({
        upstreamSessionRef: "self-test-ref",
        launch: {
          app_name: "Pirate",
          endpoint: "https://self.xyz",
          endpoint_type: "https",
          scope: "community_join",
          session_id: "self-test-ref",
          user_id: "test",
          user_id_type: "uuid",
          disclosures: { gender: true, ofac: true },
        },
      }),
      getSessionOutcome: async () => ({
        status: "verified",
        claims: { age_over_18: true, nationality: null, gender: "F", ofac_clear: true },
      }),
    } satisfies SelfProvider)
    await completeGenderVerification(ctx.env, joiner.accessToken)

    const deniedJoin = await app.request(
      `http://pirate.test/communities/${created.communityId}/join`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${joiner.accessToken}` },
      },
      ctx.env,
    )
    expect(deniedJoin.status).toBe(403)
    const deniedBody = await json(deniedJoin) as {
      code: string
      details: { failure_reason: string; membership_gate_summaries: Array<{ gate_type: string }> }
    }
    expect(deniedBody.code).toBe("gate_failed")
    expect(deniedBody.details.failure_reason).toBe("gender_mismatch")
    expect(deniedBody.details.membership_gate_summaries[0].gate_type).toBe("gender")
  })

  test("join mutation succeeds after self gender verification", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "gender-join-success-creator")
    const created = await createMembershipGatedCommunity({
      env: ctx.env,
      creatorAccessToken: creator.accessToken,
      displayName: "Join Success Gender Club",
      gateRule: {
        scope: "membership",
        gate_family: "identity_proof",
        gate_type: "gender",
        proof_requirements: [
          {
            proof_type: "gender",
            accepted_providers: ["self"],
            config: { required_value: "F" },
          },
        ],
      },
    })

    const joiner = await exchangeJwt(ctx.env, "gender-join-success-joiner")
    setSelfProviderForTests({
      startSession: async () => ({
        upstreamSessionRef: "self-test-ref",
        launch: {
          app_name: "Pirate",
          endpoint: "https://self.xyz",
          endpoint_type: "https",
          scope: "community_join",
          session_id: "self-test-ref",
          user_id: "test",
          user_id_type: "uuid",
          disclosures: { gender: true, ofac: true },
        },
      }),
      getSessionOutcome: async () => ({
        status: "verified",
        claims: { age_over_18: true, nationality: null, gender: "F", ofac_clear: true },
      }),
    } satisfies SelfProvider)
    await completeGenderVerification(ctx.env, joiner.accessToken)

    const allowedJoin = await app.request(
      `http://pirate.test/communities/${created.communityId}/join`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${joiner.accessToken}` },
      },
      ctx.env,
    )
    expect(allowedJoin.status).toBe(200)
    const allowedBody = await json(allowedJoin) as { community_id: string; status: string }
    expect(allowedBody.community_id).toBe(created.communityId)
    expect(allowedBody.status).toBe("joined")
  })

  test("preview returns membership_mode 'request' for request-mode community", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "request-preview-creator")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, creator.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Request Mode Preview Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
      membership_mode: "request",
    }, ctx.env, creator.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const preview = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/preview`,
      {
        headers: { authorization: `Bearer ${creator.accessToken}` },
      },
      ctx.env,
    )
    expect(preview.status).toBe(200)
    const previewBody = await json(preview) as {
      membership_mode: string
    }
    expect(previewBody.membership_mode).toBe("request")
  })

  test("join-eligibility returns joinable with joinable_now false for request-mode community", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "request-elig-creator")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, creator.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Request Mode Eligibility Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
      membership_mode: "request",
    }, ctx.env, creator.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const joiner = await exchangeJwt(ctx.env, "request-elig-joiner")
    await completeUniqueHumanVerification(ctx.env, joiner.accessToken)

    const eligibility = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/join-eligibility`,
      {
        headers: { authorization: `Bearer ${joiner.accessToken}` },
      },
      ctx.env,
    )
    expect(eligibility.status).toBe(200)
    const eligibilityBody = await json(eligibility) as {
      status: string
      membership_mode: string
      joinable_now: boolean
    }
    expect(eligibilityBody.membership_mode).toBe("request")
    expect(eligibilityBody.status).toBe("requestable")
    expect(eligibilityBody.joinable_now).toBe(false)
  })
})
