import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { app } from "../../../src/index"
import { createRouteTestContext, json, resetRuntimeCaches } from "../../helpers"
import { setVeryProviderForTests } from "../../../src/lib/verification/very-provider"
import type { VeryProvider } from "../../../src/lib/verification/very-provider"
import {
  completeUniqueHumanVerification,
  exchangeJwt,
  requestJson,
  setPassportWalletScore,
} from "./community-routes-test-helpers"

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

function createdCommunityId(body: { community: { id?: string; community_id?: string } }): string {
  return body.community.community_id ?? body.community.id ?? ""
}

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

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Request Lifecycle Club",
      membership_mode: "request",
    }, ctx.env, creator.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { id?: string; community_id?: string }
    }
    const communityId = createdCommunityId(communityCreateBody)

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
      items: Array<{ type: string; subject: string; payload: Record<string, unknown> | null }>
    }
    expect(creatorTasksBody.items.some((task) => (
      task.type === "membership_review"
      && task.subject === communityId
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
        id: string
        applicant_user: string
        applicant_handle?: string | null
        note?: string | null
        status: string
      }>
      next_cursor: string | null
    }
    expect(listBody.items).toHaveLength(1)
    expect(listBody.items[0]?.applicant_user).toBe(`usr_${joiner.userId}`)
    expect(listBody.items[0]?.applicant_handle).toBeTruthy()
    expect(listBody.items[0]?.note).toBe("I can help moderate release threads.")
    expect(listBody.items[0]?.status).toBe("pending")

    const requestId = listBody.items[0]?.id ?? ""
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
      items: Array<{ type: string; subject: string }>
    }
    expect(creatorTasksAfterApprovalBody.items.some((task) => (
      task.type === "membership_review"
      && task.subject === communityId
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
      items: Array<{ id: string; applicant_user: string }>
    }
    const rejectedRequestId = rejectionListBody.items.find((item) => item.applicant_user === `usr_${rejectedJoiner.userId}`)?.id ?? ""
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

  test("community create rejects open membership", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "community-open-default-creator")

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Join Club",
      membership_mode: "open",
    }, ctx.env, creator.accessToken)

    expect(communityCreate.status).toBe(403)
    const body = await json(communityCreate) as { code: string; message: string }
    expect(body.code).toBe("eligibility_failed")
    expect(body.message).toBe("Public v0 community creation only allows request or gated membership")
  })

  test("gated community create requires at least one membership gate", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "community-gated-no-gates-creator")

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate No Gate Club",
      membership_mode: "gated",
    }, ctx.env, creator.accessToken)

    expect(communityCreate.status).toBe(403)
    const body = await json(communityCreate) as { code: string; message: string }
    expect(body.code).toBe("eligibility_failed")
    expect(body.message).toBe("Gated membership requires a membership gate policy")
  })

  test("community create rejects gate policy unless membership is gated", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "community-open-stale-gate-creator")

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Confusing Open Passport Club",
      membership_mode: "request",
      gate_policy: gatePolicy({
        type: "wallet_score",
        provider: "passport",
        minimum_score: 20,
      }),
    }, ctx.env, creator.accessToken)

    expect(communityCreate.status).toBe(403)
    const body = await json(communityCreate) as { code: string; message: string }
    expect(body.code).toBe("eligibility_failed")
    expect(body.message).toBe("Membership gate policy requires gated membership")
  })

  test("community join accepts a passport wallet score that passes the platform threshold", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const verifiedCreator = await exchangeJwt(ctx.env, "community-wallet-score-creator")

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Wallet Score Club",
      membership_mode: "gated",
      gate_policy: gatePolicy({
        type: "wallet_score",
        provider: "passport",
        minimum_score: 20,
      }),
    }, ctx.env, verifiedCreator.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { id?: string; community_id?: string }
    }
    const communityId = createdCommunityId(communityCreateBody)

    const walletScoreJoiner = await exchangeJwt(ctx.env, "community-wallet-score-joiner")
    await setPassportWalletScore(ctx.env, walletScoreJoiner.userId, {
      score: 123.4,
      scoreThreshold: 20,
      passingScore: true,
    })

    const allowedJoin = await app.request(
      `http://pirate.test/communities/${communityId}/join`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${walletScoreJoiner.accessToken}`,
        },
      },
      ctx.env,
    )

    expect(allowedJoin.status).toBe(200)
    const allowedBody = await json(allowedJoin) as { community: string; status: string }
    expect(allowedBody.community).toBe(communityId)
    expect(allowedBody.status).toBe("joined")
  })

  test("gated community join enforces membership proof requirements", async () => {
    const ctx = await createRouteTestContext({
      VERY_API_URL: "https://very.test",
      VERY_APP_ID: "very-test-app",
    })
    cleanup = ctx.cleanup

    const verifiedCreator = await exchangeJwt(ctx.env, "community-gated-creator")

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Gated Club",
      membership_mode: "gated",
      gate_policy: gatePolicy({
        type: "unique_human",
        provider: "self",
      }),
    }, ctx.env, verifiedCreator.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { id?: string; community_id?: string }
    }
    const communityId = createdCommunityId(communityCreateBody)

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
            challenge_expires_at: 4070908800,
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
      `http://pirate.test/communities/${communityId}/join`,
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
    expect(deniedBody.message).toBe("Verification is required to join this community")

    const selfJoiner = await exchangeJwt(ctx.env, "community-gated-self-joiner")
    const selfVerification = await requestJson("http://pirate.test/verification-sessions", {
      provider: "self",
    }, ctx.env, selfJoiner.accessToken)
    const selfVerificationBody = await json(selfVerification) as { id: string }
    await requestJson(
      `http://pirate.test/verification-sessions/${selfVerificationBody.id}/complete`,
      {},
      ctx.env,
      selfJoiner.accessToken,
    )

    const allowedJoin = await app.request(
      `http://pirate.test/communities/${communityId}/join`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${selfJoiner.accessToken}`,
        },
      },
      ctx.env,
    )

    expect(allowedJoin.status).toBe(200)
    const allowedBody = await json(allowedJoin) as { community: string; status: string }
    expect(allowedBody.community).toBe(communityId)
    expect(allowedBody.status).toBe("joined")
  })

  test("community create rejects invalid accepted_providers combinations for supported public v0 gates", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-invalid-provider-creator")

    const invalidGenderProvider = await requestJson("http://pirate.test/communities", {
      display_name: "Invalid Gender Provider Club",
      membership_mode: "gated",
      gate_policy: gatePolicy({
        type: "gender",
        provider: "passport",
        allowed: ["M"],
      }),
    }, ctx.env, session.accessToken)
    expect(invalidGenderProvider.status).toBe(403)
    const invalidGenderProviderBody = await json(invalidGenderProvider) as { code: string; message: string }
    expect(invalidGenderProviderBody.code).toBe("eligibility_failed")
    expect(invalidGenderProviderBody.message).toBe("gender gate provider must be self")

    const invalidWalletScoreProvider = await requestJson("http://pirate.test/communities", {
      display_name: "Invalid Wallet Provider Club",
      membership_mode: "gated",
      gate_policy: gatePolicy({
        type: "wallet_score",
        provider: "self",
        minimum_score: 20,
      }),
    }, ctx.env, session.accessToken)
    expect(invalidWalletScoreProvider.status).toBe(403)
    const invalidWalletScoreProviderBody = await json(invalidWalletScoreProvider) as { code: string; message: string }
    expect(invalidWalletScoreProviderBody.code).toBe("eligibility_failed")
    expect(invalidWalletScoreProviderBody.message).toBe("wallet_score gate provider must be passport")
  })

  test("community create accepts gender gates in public v0", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-gender-gate-creator")

    const response = await requestJson("http://pirate.test/communities", {
      display_name: "Gender Gated Club",
      membership_mode: "gated",
      gate_policy: gatePolicy({
        type: "gender",
        provider: "self",
        allowed: ["M"],
      }),
    }, ctx.env, session.accessToken)

    expect(response.status).toBe(202)
    const body = await json(response) as {
      community: { id?: string; community_id?: string }
      job: { status: string }
    }
    expect(typeof createdCommunityId(body)).toBe("string")
    expect(["queued", "succeeded"]).toContain(body.job.status)
  })
})
