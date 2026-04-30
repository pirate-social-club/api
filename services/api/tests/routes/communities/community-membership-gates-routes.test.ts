import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { app } from "../../../src/index"
import { setSelfProviderForTests } from "../../../src/lib/verification/self-provider"
import type { SelfProvider } from "../../../src/lib/verification/self-provider"
import { createRouteTestContext, json, resetRuntimeCaches } from "../../helpers"
import {
  completeNationalityVerification,
  completeUniqueHumanVerification,
  exchangeJwt,
  prepareVerifiedNamespace,
  requestJson,
  setPassportWalletScore,
} from "./community-routes-test-helpers"
import { createMembershipGatedCommunity } from "./community-membership-gate-test-helpers"

let cleanup: (() => Promise<void>) | null = null

function gatePolicy(gate: Record<string, unknown>): Record<string, unknown> {
  return {
    version: 1,
    expression: {
      op: "gate",
      gate,
    },
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
  test("create wallet score-gated community succeeds with valid config", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "wallet-score-gate-creator")
    const created = await createMembershipGatedCommunity({
      env: ctx.env,
      creatorAccessToken: session.accessToken,
      displayName: "Passport Score Club",
      gate: {
        type: "wallet_score",
        provider: "passport",
        minimum_score: 20,
      },
    })

    expect(created.membershipMode).toBe("gated")
  })

  test("create wallet score gate missing minimum_score fails with eligibility_failed", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "wallet-score-gate-invalid-creator")
    await completeUniqueHumanVerification(ctx.env, session.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Invalid Passport Score Club",
      membership_mode: "gated",
      gate_policy: gatePolicy({
        type: "wallet_score",
        provider: "passport",
      }),
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(403)
    const body = await json(communityCreate) as { code: string; message: string }
    expect(body.code).toBe("eligibility_failed")
    expect(body.message).toMatch(/minimum_score/)
  })

  test("join-eligibility returns verification_required when wallet score is missing", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "wallet-score-elig-creator")
    const created = await createMembershipGatedCommunity({
      env: ctx.env,
      creatorAccessToken: creator.accessToken,
      displayName: "Missing Passport Score Club",
      gate: {
        type: "wallet_score",
        provider: "passport",
        minimum_score: 20,
      },
    })

    const joiner = await exchangeJwt(ctx.env, "wallet-score-elig-joiner")
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
      membership_gate_summaries: Array<{ gate_type: string; minimum_score?: number }>
      wallet_score_status?: { current_score_decimal: string | null; required_score_decimal: string | null; passing_score: boolean | null; last_scored_at: number | null }
    }
    expect(eligibilityBody.status).toBe("verification_required")
    expect(eligibilityBody.missing_capabilities).toContain("wallet_score")
    expect(eligibilityBody.suggested_verification_provider).toBe("passport")
    expect(eligibilityBody.suggested_verification_intent).toBe("community_join")
    expect(eligibilityBody.membership_gate_summaries[0].minimum_score).toBe(20)
    expect(eligibilityBody.wallet_score_status).toEqual({
      current_score_decimal: null,
      required_score_decimal: "20",
      passing_score: null,
      last_scored_at: null,
    })
  })

  test("join-eligibility returns wallet_score_too_low when Passport score is below threshold", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "wallet-score-low-creator")
    const created = await createMembershipGatedCommunity({
      env: ctx.env,
      creatorAccessToken: creator.accessToken,
      displayName: "Low Passport Score Club",
      gate: {
        type: "wallet_score",
        provider: "passport",
        minimum_score: 30,
      },
    })

    const joiner = await exchangeJwt(ctx.env, "wallet-score-low-joiner")
    await completeUniqueHumanVerification(ctx.env, joiner.accessToken)
    await setPassportWalletScore(ctx.env, joiner.userId, {
      score: 24,
      scoreThreshold: 20,
      passingScore: true,
    })

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
      failure_reason: string | null
      missing_capabilities: string[]
      wallet_score_status?: { current_score_decimal: string | null; required_score_decimal: string | null; passing_score: boolean | null; last_scored_at: number | null }
    }
    expect(eligibilityBody.status).toBe("verification_required")
    expect(eligibilityBody.missing_capabilities).toContain("wallet_score")
    expect(eligibilityBody.wallet_score_status).toMatchObject({
      current_score_decimal: "24",
      required_score_decimal: "30",
      passing_score: true,
    })
    expect(typeof eligibilityBody.wallet_score_status?.last_scored_at).toBe("number")
  })

  test("join mutation succeeds when Passport score meets threshold", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "wallet-score-join-creator")
    const created = await createMembershipGatedCommunity({
      env: ctx.env,
      creatorAccessToken: creator.accessToken,
      displayName: "Passing Passport Score Club",
      gate: {
        type: "wallet_score",
        provider: "passport",
        minimum_score: 30,
      },
    })

    const joiner = await exchangeJwt(ctx.env, "wallet-score-joiner")
    await setPassportWalletScore(ctx.env, joiner.userId, {
      score: 35,
      scoreThreshold: 20,
      passingScore: true,
    })

    const joined = await app.request(
      `http://pirate.test/communities/${created.communityId}/join`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${joiner.accessToken}` },
      },
      ctx.env,
    )
    expect(joined.status).toBe(200)
    const joinedBody = await json(joined) as { status: string }
    expect(joinedBody.status).toBe("joined")
  })

  test("create nationality-gated community succeeds with valid config", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "nat-gate-creator")
    const created = await createMembershipGatedCommunity({
      env: ctx.env,
      creatorAccessToken: session.accessToken,
      displayName: "Nationality Gated Club",
      gate: {
        type: "nationality",
        provider: "self",
        allowed: ["AR"],
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
        namespace_verification: namespaceVerificationId,
      },
      membership_mode: "gated",
      gate_policy: gatePolicy({
        type: "nationality",
        provider: "self",
      }),
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(403)
    const body = await json(communityCreate) as { code: string; message: string }
    expect(body.code).toBe("eligibility_failed")
    expect(body.message).toBe("nationality gate requires allowed country codes")
  })

  test("create nationality gate with invalid provider fails with eligibility_failed", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "nat-gate-bad-provider-creator")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Bad Provider Club",
      namespace: {
        namespace_verification: namespaceVerificationId,
      },
      membership_mode: "gated",
      gate_policy: gatePolicy({
        type: "nationality",
        provider: "very",
        allowed: ["US"],
      }),
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(403)
    const body = await json(communityCreate) as { code: string; message: string }
    expect(body.code).toBe("eligibility_failed")
    expect(body.message).toMatch(/provider must be self/)
  })

  test("preview returns nationality gate summary for gated community", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "nat-preview-creator")
    const created = await createMembershipGatedCommunity({
      env: ctx.env,
      creatorAccessToken: creator.accessToken,
      displayName: "Preview Nationality Club",
      gate: {
        type: "nationality",
        provider: "self",
        allowed: ["AR"],
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
      id: string
      membership_mode: string
      membership_gate_summaries: Array<{ gate_type: string; required_value?: string; accepted_providers?: string[] }>
      viewer_membership_status: string
    }
    expect(previewBody.membership_mode).toBe("gated")
    expect(previewBody.membership_gate_summaries).toHaveLength(1)
    const nationalitySummary = previewBody.membership_gate_summaries.find((gate) => gate.gate_type === "nationality")
    expect(nationalitySummary?.required_value).toBe("ARG")
    expect(nationalitySummary?.accepted_providers).toEqual(["self"])
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
      gate: {
        type: "nationality",
        provider: "self",
        allowed: ["US"],
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
      gate: {
        type: "nationality",
        provider: "self",
        allowed: ["US"],
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
        claims: { age_over_18: true, nationality: "AR", gender: null, nullifier: "self-test-ref:ar-elig" },
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
    expect(eligibilityBody.status).toBe("verification_required")
  })

  test("join-eligibility returns joinable on nationality match", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "nat-elig-match-creator")
    const created = await createMembershipGatedCommunity({
      env: ctx.env,
      creatorAccessToken: creator.accessToken,
      displayName: "Match Nationality Club",
      gate: {
        type: "nationality",
        provider: "self",
        allowed: ["US"],
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
        claims: { age_over_18: true, nationality: "US", gender: null, nullifier: "self-test-ref:us-elig" },
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
      gate: {
        type: "nationality",
        provider: "self",
        allowed: ["US"],
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
      gate: {
        type: "nationality",
        provider: "self",
        allowed: ["US"],
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
        claims: { age_over_18: true, nationality: "AR", gender: null, nullifier: "self-test-ref:ar-join" },
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
    expect(deniedBody.details.failure_reason).toBe("missing_verification")
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
      gate: {
        type: "nationality",
        provider: "self",
        allowed: ["US"],
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
        claims: { age_over_18: true, nationality: "US", gender: null, nullifier: "self-test-ref:us-join" },
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
    const allowedBody = await json(allowedJoin) as { community: string; status: string }
    expect(allowedBody.community).toBe(created.communityId)
    expect(allowedBody.status).toBe("joined")
  })

})
