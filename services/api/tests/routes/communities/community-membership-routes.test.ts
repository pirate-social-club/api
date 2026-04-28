import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import app from "../../../src/index"
import { createRouteTestContext, json, resetRuntimeCaches } from "../../helpers"
import { setVeryProviderForTests } from "../../../src/lib/verification/very-provider"
import type { VeryProvider } from "../../../src/lib/verification/very-provider"
import {
  completeUniqueHumanVerification,
  exchangeJwt,
  prepareVerifiedNamespace,
  requestJson,
  setPassportWalletScore,
} from "./community-routes-test-helpers"

let cleanup: (() => Promise<void>) | null = null

beforeEach(() => {
  resetRuntimeCaches()
})

afterEach(async () => {
  if (cleanup) {
    await cleanup()
    cleanup = null
  }
})

describe("community membership routes", () => {
  test("request membership lifecycle supports list, approval, rejection, and pending eligibility", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "community-request-lifecycle-creator")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, creator.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Request Lifecycle Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
      membership_mode: "request",
      gate_rules: [],
    }, ctx.env, creator.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }
    const communityId = communityCreateBody.community.community_id

    const joiner = await exchangeJwt(ctx.env, "community-request-lifecycle-joiner")
    await completeUniqueHumanVerification(ctx.env, joiner.accessToken)

    const initialEligibility = await app.request(
      `http://pirate.test/communities/${communityId}/join-eligibility`,
      { headers: { authorization: `Bearer ${joiner.accessToken}` } },
      ctx.env,
    )
    expect(initialEligibility.status).toBe(200)
    expect((await json(initialEligibility) as { status: string }).status).toBe("requestable")

    const request = await requestJson(
      `http://pirate.test/communities/${communityId}/join`,
      { note: "I can help moderate release threads." },
      ctx.env,
      joiner.accessToken,
    )
    expect(request.status).toBe(200)
    expect((await json(request) as { status: string }).status).toBe("requested")

    const duplicateRequest = await requestJson(
      `http://pirate.test/communities/${communityId}/join`,
      { note: "Updating my note should not create a second request." },
      ctx.env,
      joiner.accessToken,
    )
    expect(duplicateRequest.status).toBe(200)
    expect((await json(duplicateRequest) as { status: string }).status).toBe("requested")

    const pendingEligibility = await app.request(
      `http://pirate.test/communities/${communityId}/join-eligibility`,
      { headers: { authorization: `Bearer ${joiner.accessToken}` } },
      ctx.env,
    )
    expect(pendingEligibility.status).toBe(200)
    expect((await json(pendingEligibility) as { status: string }).status).toBe("pending_request")

    const unauthorizedList = await app.request(
      `http://pirate.test/communities/${communityId}/membership-requests`,
      { headers: { authorization: `Bearer ${joiner.accessToken}` } },
      ctx.env,
    )
    expect(unauthorizedList.status).toBe(404)

    const creatorTasks = await app.request(
      "http://pirate.test/notifications/tasks",
      { headers: { authorization: `Bearer ${creator.accessToken}` } },
      ctx.env,
    )
    expect(creatorTasks.status).toBe(200)
    const creatorTasksBody = await json(creatorTasks) as {
      items: Array<{ type: string; subject_id: string; payload: Record<string, unknown> | null }>
    }
    expect(creatorTasksBody.items.some((task) => (
      task.type === "membership_review"
      && task.subject_id === communityId
      && task.payload?.request_count === 1
    ))).toBe(true)

    const list = await app.request(
      `http://pirate.test/communities/${communityId}/membership-requests`,
      { headers: { authorization: `Bearer ${creator.accessToken}` } },
      ctx.env,
    )
    expect(list.status).toBe(200)
    const listBody = await json(list) as {
      items: Array<{
        membership_request_id: string
        applicant_user_id: string
        applicant_handle?: string | null
        note?: string | null
        status: string
      }>
      next_cursor: string | null
    }
    expect(listBody.items).toHaveLength(1)
    expect(listBody.items[0]?.applicant_user_id).toBe(joiner.userId)
    expect(listBody.items[0]?.applicant_handle).toBeTruthy()
    expect(listBody.items[0]?.note).toBe("I can help moderate release threads.")
    expect(listBody.items[0]?.status).toBe("pending")

    const requestId = listBody.items[0]?.membership_request_id ?? ""
    const unauthorizedApprove = await app.request(
      `http://pirate.test/communities/${communityId}/membership-requests/${requestId}/approve`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${joiner.accessToken}` },
      },
      ctx.env,
    )
    expect(unauthorizedApprove.status).toBe(404)

    const approve = await app.request(
      `http://pirate.test/communities/${communityId}/membership-requests/${requestId}/approve`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${creator.accessToken}` },
      },
      ctx.env,
    )
    expect(approve.status).toBe(200)
    expect((await json(approve) as { status: string }).status).toBe("approved")

    const doubleApprove = await app.request(
      `http://pirate.test/communities/${communityId}/membership-requests/${requestId}/approve`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${creator.accessToken}` },
      },
      ctx.env,
    )
    expect(doubleApprove.status).toBe(409)

    const joinedEligibility = await app.request(
      `http://pirate.test/communities/${communityId}/join-eligibility`,
      { headers: { authorization: `Bearer ${joiner.accessToken}` } },
      ctx.env,
    )
    expect(joinedEligibility.status).toBe(200)
    expect((await json(joinedEligibility) as { status: string }).status).toBe("already_joined")

    const creatorTasksAfterApproval = await app.request(
      "http://pirate.test/notifications/tasks",
      { headers: { authorization: `Bearer ${creator.accessToken}` } },
      ctx.env,
    )
    expect(creatorTasksAfterApproval.status).toBe(200)
    const creatorTasksAfterApprovalBody = await json(creatorTasksAfterApproval) as {
      items: Array<{ type: string; subject_id: string }>
    }
    expect(creatorTasksAfterApprovalBody.items.some((task) => (
      task.type === "membership_review"
      && task.subject_id === communityId
    ))).toBe(false)

    const rejectedJoiner = await exchangeJwt(ctx.env, "community-request-lifecycle-rejected-joiner")
    await completeUniqueHumanVerification(ctx.env, rejectedJoiner.accessToken)
    const rejectedRequest = await requestJson(
      `http://pirate.test/communities/${communityId}/join`,
      { note: "Please let me in." },
      ctx.env,
      rejectedJoiner.accessToken,
    )
    expect(rejectedRequest.status).toBe(200)

    const rejectionList = await app.request(
      `http://pirate.test/communities/${communityId}/membership-requests`,
      { headers: { authorization: `Bearer ${creator.accessToken}` } },
      ctx.env,
    )
    const rejectionListBody = await json(rejectionList) as {
      items: Array<{ membership_request_id: string; applicant_user_id: string }>
    }
    const rejectedRequestId = rejectionListBody.items.find((item) => item.applicant_user_id === rejectedJoiner.userId)?.membership_request_id ?? ""
    expect(rejectedRequestId).toBeTruthy()

    const reject = await app.request(
      `http://pirate.test/communities/${communityId}/membership-requests/${rejectedRequestId}/reject`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${creator.accessToken}` },
      },
      ctx.env,
    )
    expect(reject.status).toBe(200)
    expect((await json(reject) as { status: string }).status).toBe("rejected")

    const rejectedEligibility = await app.request(
      `http://pirate.test/communities/${communityId}/join-eligibility`,
      { headers: { authorization: `Bearer ${rejectedJoiner.accessToken}` } },
      ctx.env,
    )
    expect(rejectedEligibility.status).toBe(200)
    expect((await json(rejectedEligibility) as { status: string }).status).toBe("requestable")
  })

  test("community create without gate_rules keeps open communities ungated", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "community-open-default-creator")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, creator.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Join Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
      membership_mode: "open",
    }, ctx.env, creator.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const unverifiedUser = await exchangeJwt(ctx.env, "community-open-default-joiner")
    const eligibility = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/join-eligibility`,
      {
        headers: {
          authorization: `Bearer ${unverifiedUser.accessToken}`,
        },
      },
      ctx.env,
    )

    expect(eligibility.status).toBe(200)
    const eligibilityBody = await json(eligibility) as {
      status: string
      membership_gate_summaries: Array<{ gate_type: string; accepted_providers?: string[] }>
      missing_capabilities: string[]
      suggested_verification_provider: string | null
    }
    expect(eligibilityBody.status).toBe("joinable")
    expect(eligibilityBody.membership_gate_summaries).toEqual([])
    expect(eligibilityBody.missing_capabilities).toEqual([])
    expect(eligibilityBody.suggested_verification_provider ?? null).toBeNull()

    const allowedJoin = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/join`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${unverifiedUser.accessToken}`,
        },
      },
      ctx.env,
    )

    expect(allowedJoin.status).toBe(200)
    const allowedBody = await json(allowedJoin) as { community_id: string; status: string }
    expect(allowedBody.community_id).toBe(communityCreateBody.community.community_id)
    expect(allowedBody.status).toBe("joined")
  })

  test("explicit empty gates allow unverified users to join open communities", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "community-open-no-gates-creator")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, creator.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate No Gate Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
      membership_mode: "open",
      gate_rules: [],
    }, ctx.env, creator.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const joiner = await exchangeJwt(ctx.env, "community-open-no-gates-joiner")
    const allowedJoin = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/join`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${joiner.accessToken}`,
        },
      },
      ctx.env,
    )

    expect(allowedJoin.status).toBe(200)
    const allowedBody = await json(allowedJoin) as { community_id: string; status: string }
    expect(allowedBody.community_id).toBe(communityCreateBody.community.community_id)
    expect(allowedBody.status).toBe("joined")
  })

  test("community join accepts a passport wallet score that passes the platform threshold", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const verifiedCreator = await exchangeJwt(ctx.env, "community-wallet-score-creator")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, verifiedCreator.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Wallet Score Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
      membership_mode: "open",
      gate_rules: [],
    }, ctx.env, verifiedCreator.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const walletScoreJoiner = await exchangeJwt(ctx.env, "community-wallet-score-joiner")
    await setPassportWalletScore(ctx.env, walletScoreJoiner.userId, {
      score: 123.4,
      scoreThreshold: 20,
      passingScore: true,
    })

    const allowedJoin = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/join`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${walletScoreJoiner.accessToken}`,
        },
      },
      ctx.env,
    )

    expect(allowedJoin.status).toBe(200)
    const allowedBody = await json(allowedJoin) as { community_id: string; status: string }
    expect(allowedBody.community_id).toBe(communityCreateBody.community.community_id)
    expect(allowedBody.status).toBe("joined")
  })

  test("gated community join enforces membership proof requirements", async () => {
    const ctx = await createRouteTestContext({
      VERY_API_URL: "https://very.test",
      VERY_APP_ID: "very-test-app",
    })
    cleanup = ctx.cleanup

    const verifiedCreator = await exchangeJwt(ctx.env, "community-gated-creator")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, verifiedCreator.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Gated Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
      membership_mode: "gated",
      gate_rules: [
        {
          scope: "membership",
          gate_family: "identity_proof",
          gate_type: "unique_human",
          proof_requirements: [
            {
              proof_type: "unique_human",
              accepted_providers: ["self"],
            },
          ],
        },
      ],
    }, ctx.env, verifiedCreator.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const veryJoiner = await exchangeJwt(ctx.env, "community-gated-very-joiner")
    setVeryProviderForTests({
      startSession: async () => ({
        upstreamSessionRef: "very-test-ref",
        launch: {
          app_id: "test",
          context: "verification",
          type_id: "palm_scan",
          query: {},
          verify_url: "https://verify.very.org/test",
          session_binding: {
            uniqueness_domain: "pirate-unique-human-v0",
            binding_value: "0",
            binding_field: "pseudonym",
            challenge_expires_at: "2099-01-01T00:00:00.000Z",
          },
        },
      }),
      getSessionOutcome: async () => ({
        status: "verified",
        attestationData: {
          externalNullifier: "pirate-unique-human-v0",
          pseudonym: "0",
          nullifier: "very-membership-route-nullifier",
        },
      }),
    } satisfies VeryProvider)
    await completeUniqueHumanVerification(ctx.env, veryJoiner.accessToken, "very")
    setVeryProviderForTests(null)

    const deniedJoin = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/join`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${veryJoiner.accessToken}`,
        },
      },
      ctx.env,
    )

    expect(deniedJoin.status).toBe(403)
    const deniedBody = await json(deniedJoin) as { code: string; message: string }
    expect(deniedBody.code).toBe("gate_failed")
    expect(deniedBody.message).toBe("Community membership requirements are not satisfied")

    const selfJoiner = await exchangeJwt(ctx.env, "community-gated-self-joiner")
    const selfVerification = await requestJson("http://pirate.test/verification-sessions", {
      provider: "self",
    }, ctx.env, selfJoiner.accessToken)
    const selfVerificationBody = await json(selfVerification) as { verification_session_id: string }
    await requestJson(
      `http://pirate.test/verification-sessions/${selfVerificationBody.verification_session_id}/complete`,
      {},
      ctx.env,
      selfJoiner.accessToken,
    )

    const allowedJoin = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/join`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${selfJoiner.accessToken}`,
        },
      },
      ctx.env,
    )

    expect(allowedJoin.status).toBe(200)
    const allowedBody = await json(allowedJoin) as { community_id: string; status: string }
    expect(allowedBody.community_id).toBe(communityCreateBody.community.community_id)
    expect(allowedBody.status).toBe("joined")
  })

  test("community create rejects invalid accepted_providers combinations for supported public v0 gates", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-invalid-provider-creator")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken)

    const invalidGenderProvider = await requestJson("http://pirate.test/communities", {
      display_name: "Invalid Gender Provider Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
      membership_mode: "gated",
      gate_rules: [
        {
          scope: "membership",
          gate_family: "identity_proof",
          gate_type: "gender",
          proof_requirements: [
            {
              proof_type: "gender",
              accepted_providers: ["passport"],
              config: {
                required_value: "M",
              },
            },
          ],
        },
      ],
    }, ctx.env, session.accessToken)
    expect(invalidGenderProvider.status).toBe(403)
    const invalidGenderProviderBody = await json(invalidGenderProvider) as { code: string; message: string }
    expect(invalidGenderProviderBody.code).toBe("eligibility_failed")
    expect(invalidGenderProviderBody.message).toMatch(/Invalid accepted_providers for gender/)

    const invalidWalletScoreProvider = await requestJson("http://pirate.test/communities", {
      display_name: "Invalid Wallet Provider Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
      membership_mode: "gated",
      gate_rules: [
        {
          scope: "membership",
          gate_family: "identity_proof",
          gate_type: "wallet_score",
          proof_requirements: [
            {
              proof_type: "wallet_score",
              accepted_providers: ["self"],
            },
          ],
        },
      ],
    }, ctx.env, session.accessToken)
    expect(invalidWalletScoreProvider.status).toBe(403)
    const invalidWalletScoreProviderBody = await json(invalidWalletScoreProvider) as { code: string; message: string }
    expect(invalidWalletScoreProviderBody.code).toBe("eligibility_failed")
    expect(invalidWalletScoreProviderBody.message).toMatch(/Invalid accepted_providers for wallet_score/)
  })

  test("community create accepts gender gates in public v0", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-gender-gate-creator")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken)

    const response = await requestJson("http://pirate.test/communities", {
      display_name: "Gender Gated Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
      membership_mode: "gated",
      gate_rules: [
        {
          scope: "membership",
          gate_family: "identity_proof",
          gate_type: "gender",
          proof_requirements: [
            {
              proof_type: "gender",
              accepted_providers: ["self"],
              config: {
                required_value: "M",
              },
            },
          ],
        },
      ],
    }, ctx.env, session.accessToken)

    expect(response.status).toBe(202)
    const body = await json(response) as {
      community: { community_id: string }
      job: { status: string }
    }
    expect(typeof body.community.community_id).toBe("string")
    expect(["queued", "succeeded"]).toContain(body.job.status)
  })
})
