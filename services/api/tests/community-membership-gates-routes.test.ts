import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import app from "../src/index"
import { setSelfProviderForTests } from "../src/lib/verification/self-provider"
import type { SelfProvider } from "../src/lib/verification/self-provider"
import type { Env } from "../src/types"
import { createRouteTestContext, json, resetRuntimeCaches } from "./helpers"
import {
  completeGenderVerification,
  completeNationalityVerification,
  completeUniqueHumanVerification,
  exchangeJwt,
  prepareVerifiedNamespace,
  requestJson,
} from "./community-routes-test-helpers"

let cleanup: (() => Promise<void>) | null = null

async function createMembershipGatedCommunity(input: {
  env: Env
  creatorAccessToken: string
  displayName: string
  gateRule: Record<string, unknown>
}): Promise<{ communityId: string; membershipMode: string }> {
  const namespaceVerificationId = await prepareVerifiedNamespace(input.env, input.creatorAccessToken)
  const communityCreate = await requestJson("http://pirate.test/communities", {
    display_name: input.displayName,
    namespace: {
      namespace_verification_id: namespaceVerificationId,
    },
    membership_mode: "gated",
    gate_rules: [input.gateRule],
  }, input.env, input.creatorAccessToken)
  expect(communityCreate.status).toBe(202)
  const communityCreateBody = await json(communityCreate) as {
    community: { community_id: string; membership_mode: string }
  }
  return {
    communityId: communityCreateBody.community.community_id,
    membershipMode: communityCreateBody.community.membership_mode,
  }
}

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

describe("community membership gate routes", () => {
  test("create nationality-gated community succeeds with valid config", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "nat-gate-creator")
    const created = await createMembershipGatedCommunity({
      env: ctx.env,
      creatorAccessToken: session.accessToken,
      displayName: "Nationality Gated Club",
      gateRule: {
        scope: "membership",
        gate_family: "identity_proof",
        gate_type: "nationality",
        proof_requirements: [
          {
            proof_type: "nationality",
            accepted_providers: ["self"],
            config: { required_value: "AR" },
          },
        ],
      },
    })

    expect(created.membershipMode).toBe("gated")
  })

  test("create nationality gate missing required_value fails with eligibility_failed", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "nat-gate-no-value-creator")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Missing Value Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
      membership_mode: "gated",
      gate_rules: [
        {
          scope: "membership",
          gate_family: "identity_proof",
          gate_type: "nationality",
          proof_requirements: [
            {
              proof_type: "nationality",
              accepted_providers: ["self"],
            },
          ],
        },
      ],
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(403)
    const body = await json(communityCreate) as { code: string; message: string }
    expect(body.code).toBe("eligibility_failed")
    expect(body.message).toMatch(/required_value/)
  })

  test("create nationality gate with invalid provider fails with eligibility_failed", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "nat-gate-bad-provider-creator")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Bad Provider Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
      membership_mode: "gated",
      gate_rules: [
        {
          scope: "membership",
          gate_family: "identity_proof",
          gate_type: "nationality",
          proof_requirements: [
            {
              proof_type: "nationality",
              accepted_providers: ["very"],
              config: { required_value: "US" },
            },
          ],
        },
      ],
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(403)
    const body = await json(communityCreate) as { code: string; message: string }
    expect(body.code).toBe("eligibility_failed")
    expect(body.message).toMatch(/accepted_providers/)
  })

  test("preview returns nationality gate summary for gated community", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "nat-preview-creator")
    const created = await createMembershipGatedCommunity({
      env: ctx.env,
      creatorAccessToken: creator.accessToken,
      displayName: "Preview Nationality Club",
      gateRule: {
        scope: "membership",
        gate_family: "identity_proof",
        gate_type: "nationality",
        proof_requirements: [
          {
            proof_type: "nationality",
            accepted_providers: ["self"],
            config: { required_value: "AR" },
          },
        ],
      },
    })

    const preview = await app.request(
      `http://pirate.test/communities/${created.communityId}/preview`,
      {
        headers: { authorization: `Bearer ${creator.accessToken}` },
      },
      ctx.env,
    )
    expect(preview.status).toBe(200)
    const previewBody = await json(preview) as {
      community_id: string
      membership_mode: string
      membership_gate_summaries: Array<{ gate_type: string; required_value?: string; accepted_providers?: string[] }>
      viewer_membership_status: string
    }
    expect(previewBody.membership_mode).toBe("gated")
    expect(previewBody.membership_gate_summaries).toHaveLength(1)
    expect(previewBody.membership_gate_summaries[0].gate_type).toBe("nationality")
    expect(previewBody.membership_gate_summaries[0].required_value).toBe("AR")
    expect(previewBody.membership_gate_summaries[0].accepted_providers).toEqual(["self"])
    expect(previewBody.viewer_membership_status).toBe("member")
  })

  test("join-eligibility returns verification_required when nationality is missing", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "nat-elig-creator")
    const created = await createMembershipGatedCommunity({
      env: ctx.env,
      creatorAccessToken: creator.accessToken,
      displayName: "Eligibility Nationality Club",
      gateRule: {
        scope: "membership",
        gate_family: "identity_proof",
        gate_type: "nationality",
        proof_requirements: [
          {
            proof_type: "nationality",
            accepted_providers: ["self"],
            config: { required_value: "US" },
          },
        ],
      },
    })

    const joiner = await exchangeJwt(ctx.env, "nat-elig-joiner-unverified")
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
      membership_gate_summaries: Array<{ gate_type: string }>
    }
    expect(eligibilityBody.status).toBe("verification_required")
    expect(eligibilityBody.missing_capabilities).toContain("nationality")
    expect(eligibilityBody.suggested_verification_provider).toBe("self")
    expect(eligibilityBody.suggested_verification_intent).toBe("community_join")
  })

  test("join-eligibility returns gate_failed on nationality mismatch", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "nat-elig-mismatch-creator")
    const created = await createMembershipGatedCommunity({
      env: ctx.env,
      creatorAccessToken: creator.accessToken,
      displayName: "Mismatch Nationality Club",
      gateRule: {
        scope: "membership",
        gate_family: "identity_proof",
        gate_type: "nationality",
        proof_requirements: [
          {
            proof_type: "nationality",
            accepted_providers: ["self"],
            config: { required_value: "US" },
          },
        ],
      },
    })

    const joiner = await exchangeJwt(ctx.env, "nat-elig-mismatch-joiner")
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
          disclosures: { nationality: true },
        },
      }),
      getSessionOutcome: async () => ({
        status: "verified",
        claims: { age_over_18: true, nationality: "AR", gender: null },
      }),
    } satisfies SelfProvider)
    await completeNationalityVerification(ctx.env, joiner.accessToken)

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
      membership_gate_summaries: Array<{ gate_type: string }>
    }
    expect(eligibilityBody.status).toBe("gate_failed")
  })

  test("join-eligibility returns joinable on nationality match", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "nat-elig-match-creator")
    const created = await createMembershipGatedCommunity({
      env: ctx.env,
      creatorAccessToken: creator.accessToken,
      displayName: "Match Nationality Club",
      gateRule: {
        scope: "membership",
        gate_family: "identity_proof",
        gate_type: "nationality",
        proof_requirements: [
          {
            proof_type: "nationality",
            accepted_providers: ["self"],
            config: { required_value: "US" },
          },
        ],
      },
    })

    const joiner = await exchangeJwt(ctx.env, "nat-elig-match-joiner")
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
          disclosures: { nationality: true },
        },
      }),
      getSessionOutcome: async () => ({
        status: "verified",
        claims: { age_over_18: true, nationality: "US", gender: null },
      }),
    } satisfies SelfProvider)
    await completeNationalityVerification(ctx.env, joiner.accessToken)

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
      joinable_now: boolean
    }
    expect(eligibilityBody.status).toBe("joinable")
    expect(eligibilityBody.joinable_now).toBe(true)
  })

  test("join mutation returns gate_failed with failure_reason missing_verification when nationality is missing", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "nat-join-missing-creator")
    const created = await createMembershipGatedCommunity({
      env: ctx.env,
      creatorAccessToken: creator.accessToken,
      displayName: "Join Missing Nationality Club",
      gateRule: {
        scope: "membership",
        gate_family: "identity_proof",
        gate_type: "nationality",
        proof_requirements: [
          {
            proof_type: "nationality",
            accepted_providers: ["self"],
            config: { required_value: "US" },
          },
        ],
      },
    })

    const joiner = await exchangeJwt(ctx.env, "nat-join-missing-joiner")
    await completeUniqueHumanVerification(ctx.env, joiner.accessToken)

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
      details: { failure_reason: string; missing_capabilities: string[]; membership_gate_summaries: Array<{ gate_type: string }> }
    }
    expect(deniedBody.code).toBe("gate_failed")
    expect(deniedBody.details.failure_reason).toBe("missing_verification")
    expect(deniedBody.details.missing_capabilities).toContain("nationality")
    expect(deniedBody.details.membership_gate_summaries[0].gate_type).toBe("nationality")
  })

  test("join mutation returns gate_failed with failure_reason nationality_mismatch on mismatch", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "nat-join-mismatch-creator")
    const created = await createMembershipGatedCommunity({
      env: ctx.env,
      creatorAccessToken: creator.accessToken,
      displayName: "Join Mismatch Nationality Club",
      gateRule: {
        scope: "membership",
        gate_family: "identity_proof",
        gate_type: "nationality",
        proof_requirements: [
          {
            proof_type: "nationality",
            accepted_providers: ["self"],
            config: { required_value: "US" },
          },
        ],
      },
    })

    const joiner = await exchangeJwt(ctx.env, "nat-join-mismatch-joiner")
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
          disclosures: { nationality: true },
        },
      }),
      getSessionOutcome: async () => ({
        status: "verified",
        claims: { age_over_18: true, nationality: "AR", gender: null },
      }),
    } satisfies SelfProvider)
    await completeNationalityVerification(ctx.env, joiner.accessToken)

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
    expect(deniedBody.details.failure_reason).toBe("nationality_mismatch")
    expect(deniedBody.details.membership_gate_summaries[0].gate_type).toBe("nationality")
  })

  test("join mutation succeeds after self nationality verification", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "nat-join-success-creator")
    const created = await createMembershipGatedCommunity({
      env: ctx.env,
      creatorAccessToken: creator.accessToken,
      displayName: "Join Success Nationality Club",
      gateRule: {
        scope: "membership",
        gate_family: "identity_proof",
        gate_type: "nationality",
        proof_requirements: [
          {
            proof_type: "nationality",
            accepted_providers: ["self"],
            config: { required_value: "US" },
          },
        ],
      },
    })

    const joiner = await exchangeJwt(ctx.env, "nat-join-success-joiner")
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
          disclosures: { nationality: true },
        },
      }),
      getSessionOutcome: async () => ({
        status: "verified",
        claims: { age_over_18: true, nationality: "US", gender: null },
      }),
    } satisfies SelfProvider)
    await completeNationalityVerification(ctx.env, joiner.accessToken)

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
          disclosures: { gender: true },
        },
      }),
      getSessionOutcome: async () => ({
        status: "verified",
        claims: { age_over_18: true, nationality: null, gender: "F" },
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
          disclosures: { gender: true },
        },
      }),
      getSessionOutcome: async () => ({
        status: "verified",
        claims: { age_over_18: true, nationality: null, gender: "F" },
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
