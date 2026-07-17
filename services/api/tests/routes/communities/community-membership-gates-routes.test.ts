import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { solveChallenge, type Challenge, type Payload } from "altcha-lib"
import { deriveKey } from "altcha-lib/algorithms/pbkdf2"
import { app } from "../../../src/index"
import { setSelfProviderForTests } from "../../../src/lib/verification/self-provider"
import type { SelfProvider } from "../../../src/lib/verification/self-provider"
import type { AltchaScope } from "../../../src/lib/verification/altcha-provider"
import type { Env } from "../../../src/types"
import { createRouteTestContext, json, resetRuntimeCaches } from "../../helpers"
import {
  completeNationalityVerification,
  completeUniqueHumanVerification,
  exchangeJwt,
  prepareVerifiedNamespace,
  requestJson,
  setPassportWalletScore,
  setUniqueHumanVerificationProvider,
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

function orGatePolicy(gates: Record<string, unknown>[]): Record<string, unknown> {
  return {
    version: 1,
    expression: {
      op: "or",
      children: gates.map((gate) => ({
        op: "gate",
        gate,
      })),
    },
  }
}

async function createMembershipGatedCommunityWithPolicy(input: {
  env: Env
  creatorAccessToken: string
  displayName: string
  gatePolicy: Record<string, unknown>
}): Promise<{ communityId: string; membershipMode: string }> {
  await completeUniqueHumanVerification(input.env, input.creatorAccessToken)
  const communityCreate = await requestJson("http://pirate.test/communities", {
    display_name: input.displayName,
    membership_mode: "gated",
    gate_policy: input.gatePolicy,
  }, input.env, input.creatorAccessToken)
  expect(communityCreate.status).toBe(202)
  const communityCreateBody = await json(communityCreate) as {
    community: { id: string; membership_mode: string }
  }
  return {
    communityId: communityCreateBody.community.id,
    membershipMode: communityCreateBody.community.membership_mode,
  }
}

async function solveAltchaProofFromRoute(input: {
  env: Env
  accessToken: string
  scope: AltchaScope
  action: string
}): Promise<string> {
  const response = await app.request(
    `http://pirate.test/verification/altcha/challenge?scope=${input.scope}&action=${encodeURIComponent(input.action)}`,
    {
      headers: { authorization: `Bearer ${input.accessToken}` },
    },
    input.env,
  )
  expect(response.status).toBe(200)
  const challenge = await json(response) as Challenge
  const solution = await solveChallenge({ challenge, deriveKey })
  if (!solution) {
    throw new Error("ALTCHA challenge did not solve")
  }
  return btoa(JSON.stringify({ challenge, solution } satisfies Payload))
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
  test("ALTCHA-gated communities require solved proofs for join, post, comments, and replies", async () => {
    const ctx = await createRouteTestContext({
      ALTCHA_HMAC_SECRET: "test-altcha-secret",
      ALTCHA_HMAC_KEY_SECRET: "test-altcha-key-secret",
      ALTCHA_POW_COST: "1",
      ALTCHA_POW_COUNTER_MIN: "1",
      ALTCHA_POW_COUNTER_MAX: "2",
    })
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "altcha-gate-route-creator")
    const created = await createMembershipGatedCommunity({
      env: ctx.env,
      creatorAccessToken: creator.accessToken,
      displayName: "ALTCHA Gate Club",
      gate: { type: "altcha_pow" },
    })

    const member = await exchangeJwt(ctx.env, "altcha-gate-route-member")

    const deniedJoin = await app.request(
      `http://pirate.test/communities/${created.communityId}/join`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${member.accessToken}` },
      },
      ctx.env,
    )
    expect(deniedJoin.status).toBe(403)
    const deniedJoinBody = await json(deniedJoin) as {
      code: string
      details?: { missing_capabilities?: string[]; membership_gate_summaries?: Array<{ gate_type: string }> }
    }
    expect(deniedJoinBody.code).toBe("gate_failed")
    expect(deniedJoinBody.details?.missing_capabilities).toContain("altcha_pow")
    expect(deniedJoinBody.details?.membership_gate_summaries?.[0]?.gate_type).toBe("altcha_pow")

    const joinProof = await solveAltchaProofFromRoute({
      env: ctx.env,
      accessToken: member.accessToken,
      scope: "community_join",
      action: `community:${created.communityId}`,
    })
    const joined = await app.request(
      `http://pirate.test/communities/${created.communityId}/join`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${member.accessToken}`,
          "x-pirate-altcha": joinProof,
        },
      },
      ctx.env,
    )
    expect(joined.status).toBe(200)
    const joinedBody = await json(joined) as { status: string }
    expect(joinedBody.status).toBe("joined")

    const deniedPost = await requestJson(
      `http://pirate.test/communities/${created.communityId}/posts`,
      {
        post_type: "text",
        title: "Missing proof",
        body: "This should be blocked",
        idempotency_key: "altcha-route-post-missing-proof",
      },
      ctx.env,
      member.accessToken,
    )
    expect(deniedPost.status).toBe(403)

    const postProof = await solveAltchaProofFromRoute({
      env: ctx.env,
      accessToken: member.accessToken,
      scope: "post_create",
      action: `community:${created.communityId}`,
    })
    const createdPost = await app.request(
      `http://pirate.test/communities/${created.communityId}/posts`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${member.accessToken}`,
          "content-type": "application/json",
          "x-pirate-altcha": postProof,
        },
        body: JSON.stringify({
          post_type: "text",
          title: "Solved proof",
          body: "This post has a valid ALTCHA proof",
          idempotency_key: "altcha-route-post-valid-proof",
        }),
      },
      ctx.env,
    )
    expect(createdPost.status).toBe(201)
    const postBody = await json(createdPost) as { id: string }

    const replayedPost = await app.request(
      `http://pirate.test/communities/${created.communityId}/posts`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${member.accessToken}`,
          "content-type": "application/json",
          "x-pirate-altcha": postProof,
        },
        body: JSON.stringify({
          post_type: "text",
          title: "Replayed proof",
          body: "This should be blocked",
          idempotency_key: "altcha-route-post-replayed-proof",
        }),
      },
      ctx.env,
    )
    expect(replayedPost.status).toBe(403)
    const replayedPostBody = await json(replayedPost) as {
      code: string
      details?: { gate_evaluation?: { trace?: { reason?: string } } }
    }
    expect(replayedPostBody.code).toBe("gate_failed")
    expect(replayedPostBody.details?.gate_evaluation?.trace?.reason).toBe("replayed")

    const deniedPostVote = await app.request(
      `http://pirate.test/posts/${postBody.id}/vote`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${member.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ value: 1 }),
      },
      ctx.env,
    )
    expect(deniedPostVote.status).toBe(403)
    const deniedPostVoteBody = await json(deniedPostVote) as {
      code: string
      message: string
      details?: { missing_capabilities?: string[] }
    }
    expect(deniedPostVoteBody.code).toBe("gate_failed")
    expect(deniedPostVoteBody.message).toBe("Proof-of-work is required to vote in this community")
    expect(deniedPostVoteBody.details?.missing_capabilities).toContain("altcha_pow")

    const postVoteProof = await solveAltchaProofFromRoute({
      env: ctx.env,
      accessToken: member.accessToken,
      scope: "vote",
      action: `post:${postBody.id}:1`,
    })
    const postVote = await app.request(
      `http://pirate.test/posts/${postBody.id}/vote`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${member.accessToken}`,
          "content-type": "application/json",
          "x-pirate-altcha": postVoteProof,
        },
        body: JSON.stringify({ value: 1 }),
      },
      ctx.env,
    )
    expect(postVote.status).toBe(200)
    const postVoteBody = await json(postVote) as { post: string; value: number }
    expect(postVoteBody.post).toBe(postBody.id)
    expect(postVoteBody.value).toBe(1)

    const commentProof = await solveAltchaProofFromRoute({
      env: ctx.env,
      accessToken: member.accessToken,
      scope: "comment_create",
      action: `post:${postBody.id}`,
    })
    const topLevelComment = await app.request(
      `http://pirate.test/communities/${created.communityId}/posts/${postBody.id}/comments`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${member.accessToken}`,
          "content-type": "application/json",
          "x-pirate-altcha": commentProof,
        },
        body: JSON.stringify({ body: "Top-level comment with proof" }),
      },
      ctx.env,
    )
    expect(topLevelComment.status).toBe(201)
    const topLevelBody = await json(topLevelComment) as { id: string; depth: number }
    expect(topLevelBody.depth).toBe(0)

    const commentVoteProof = await solveAltchaProofFromRoute({
      env: ctx.env,
      accessToken: member.accessToken,
      scope: "vote",
      action: `comment:${topLevelBody.id}:-1`,
    })
    const commentVote = await app.request(
      `http://pirate.test/comments/${topLevelBody.id}/vote`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${member.accessToken}`,
          "content-type": "application/json",
          "x-pirate-altcha": commentVoteProof,
        },
        body: JSON.stringify({ value: -1 }),
      },
      ctx.env,
    )
    expect(commentVote.status).toBe(200)
    const commentVoteBody = await json(commentVote) as { comment_id: string; value: number }
    expect(`cmt_${commentVoteBody.comment_id}`).toBe(topLevelBody.id)
    expect(commentVoteBody.value).toBe(-1)

    const replyProof = await solveAltchaProofFromRoute({
      env: ctx.env,
      accessToken: member.accessToken,
      scope: "comment_create",
      action: `comment:${topLevelBody.id}`,
    })
    const reply = await app.request(
      `http://pirate.test/comments/${topLevelBody.id}/replies`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${member.accessToken}`,
          "content-type": "application/json",
          "x-pirate-altcha": replyProof,
        },
        body: JSON.stringify({ body: "Reply with proof" }),
      },
      ctx.env,
    )
    expect(reply.status).toBe(201)
    const replyBody = await json(reply) as { parent_comment: string | null; depth: number }
    expect(replyBody.parent_comment).toBe(topLevelBody.id)
    expect(replyBody.depth).toBe(1)
  })

  test("Very-verified members can vote in Very OR proof-of-work communities without ALTCHA", async () => {
    const ctx = await createRouteTestContext({
      ALTCHA_HMAC_SECRET: "test-altcha-secret",
      ALTCHA_HMAC_KEY_SECRET: "test-altcha-key-secret",
      ALTCHA_POW_COST: "1",
      ALTCHA_POW_COUNTER_MIN: "1",
      ALTCHA_POW_COUNTER_MAX: "2",
    })
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "very-or-pow-vote-creator")
    const created = await createMembershipGatedCommunityWithPolicy({
      env: ctx.env,
      creatorAccessToken: creator.accessToken,
      displayName: "Very Or PoW Vote Club",
      gatePolicy: orGatePolicy([
        { type: "unique_human", provider: "very" },
        { type: "altcha_pow" },
      ]),
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
      gate_match_mode: string | null
      membership_gate_expression: unknown
    }
    expect(previewBody.gate_match_mode).toBe("any")
    expect(previewBody.membership_gate_expression).toEqual({
      op: "or",
      children: [
        { op: "gate", gate: { gate_id: "legacy_0_0", gate_type: "unique_human", accepted_providers: ["very"] } },
        { op: "gate", gate: { gate_id: "legacy_0_1", gate_type: "altcha_pow" } },
      ],
    })

    const createdPost = await requestJson(
      `http://pirate.test/communities/${created.communityId}/posts`,
      {
        post_type: "text",
        title: "Vote without fallback proof",
        body: "A Very-verified member should not need the PoW fallback.",
        idempotency_key: "very-or-pow-vote-post",
      },
      ctx.env,
      creator.accessToken,
    )
    expect(createdPost.status).toBe(201)
    const postBody = await json(createdPost) as { id: string }

    const member = await exchangeJwt(ctx.env, "very-or-pow-vote-member")
    await setUniqueHumanVerificationProvider(ctx.env, member.userId, "very")
    const joined = await app.request(
      `http://pirate.test/communities/${created.communityId}/join`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${member.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(joined.status).toBe(200)

    const vote = await app.request(
      `http://pirate.test/posts/${postBody.id}/vote`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${member.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ value: 1 }),
      },
      ctx.env,
    )
    expect(vote.status).toBe(200)
    const voteBody = await json(vote) as { post: string; value: number }
    expect(voteBody.post).toBe(postBody.id)
    expect(voteBody.value).toBe(1)
  })

  test("unverified members can still use proof-of-work fallback to vote in Very OR communities", async () => {
    const ctx = await createRouteTestContext({
      ALTCHA_HMAC_SECRET: "test-altcha-secret",
      ALTCHA_HMAC_KEY_SECRET: "test-altcha-key-secret",
      ALTCHA_POW_COST: "1",
      ALTCHA_POW_COUNTER_MIN: "1",
      ALTCHA_POW_COUNTER_MAX: "2",
    })
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "very-or-pow-fallback-vote-creator")
    const created = await createMembershipGatedCommunityWithPolicy({
      env: ctx.env,
      creatorAccessToken: creator.accessToken,
      displayName: "Very Or PoW Fallback Vote Club",
      gatePolicy: orGatePolicy([
        { type: "unique_human", provider: "very" },
        { type: "altcha_pow" },
      ]),
    })

    const createdPost = await requestJson(
      `http://pirate.test/communities/${created.communityId}/posts`,
      {
        post_type: "text",
        title: "Vote with fallback proof",
        body: "An unverified member should still be able to use the PoW fallback.",
        idempotency_key: "very-or-pow-fallback-vote-post",
      },
      ctx.env,
      creator.accessToken,
    )
    expect(createdPost.status).toBe(201)
    const postBody = await json(createdPost) as { id: string }

    const member = await exchangeJwt(ctx.env, "very-or-pow-fallback-vote-member")
    const joinProof = await solveAltchaProofFromRoute({
      env: ctx.env,
      accessToken: member.accessToken,
      scope: "community_join",
      action: `community:${created.communityId}`,
    })
    const joined = await app.request(
      `http://pirate.test/communities/${created.communityId}/join`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${member.accessToken}`,
          "x-pirate-altcha": joinProof,
        },
      },
      ctx.env,
    )
    expect(joined.status).toBe(200)

    const deniedVote = await app.request(
      `http://pirate.test/posts/${postBody.id}/vote`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${member.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ value: 1 }),
      },
      ctx.env,
    )
    expect(deniedVote.status).toBe(403)

    const voteProof = await solveAltchaProofFromRoute({
      env: ctx.env,
      accessToken: member.accessToken,
      scope: "vote",
      action: `post:${postBody.id}:1`,
    })
    const vote = await app.request(
      `http://pirate.test/posts/${postBody.id}/vote`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${member.accessToken}`,
          "content-type": "application/json",
          "x-pirate-altcha": voteProof,
        },
        body: JSON.stringify({ value: 1 }),
      },
      ctx.env,
    )
    expect(vote.status).toBe(200)
    const voteBody = await json(vote) as { post: string; value: number }
    expect(voteBody.post).toBe(postBody.id)
    expect(voteBody.value).toBe(1)
  })

  test("passing Passport-score members can vote in wallet-score OR proof-of-work communities without ALTCHA", async () => {
    const ctx = await createRouteTestContext({
      ALTCHA_HMAC_SECRET: "test-altcha-secret",
      ALTCHA_HMAC_KEY_SECRET: "test-altcha-key-secret",
      ALTCHA_POW_COST: "1",
      ALTCHA_POW_COUNTER_MIN: "1",
      ALTCHA_POW_COUNTER_MAX: "2",
    })
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "wallet-or-pow-vote-creator")
    const created = await createMembershipGatedCommunityWithPolicy({
      env: ctx.env,
      creatorAccessToken: creator.accessToken,
      displayName: "Wallet Or PoW Vote Club",
      gatePolicy: orGatePolicy([
        { type: "wallet_score", provider: "passport", minimum_score: 20 },
        { type: "altcha_pow" },
      ]),
    })

    const createdPost = await requestJson(
      `http://pirate.test/communities/${created.communityId}/posts`,
      {
        post_type: "text",
        title: "Vote with wallet score",
        body: "A passing Passport score should not need the PoW fallback.",
        idempotency_key: "wallet-or-pow-vote-post",
      },
      ctx.env,
      creator.accessToken,
    )
    expect(createdPost.status).toBe(201)
    const postBody = await json(createdPost) as { id: string }

    const member = await exchangeJwt(ctx.env, "wallet-or-pow-vote-member")
    await setPassportWalletScore(ctx.env, member.userId, {
      passingScore: true,
      score: 30,
      scoreThreshold: 20,
    })
    const joined = await app.request(
      `http://pirate.test/communities/${created.communityId}/join`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${member.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(joined.status).toBe(200)

    const vote = await app.request(
      `http://pirate.test/posts/${postBody.id}/vote`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${member.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ value: 1 }),
      },
      ctx.env,
    )
    expect(vote.status).toBe(200)
    const voteBody = await json(vote) as { post: string; value: number }
    expect(voteBody.post).toBe(postBody.id)
    expect(voteBody.value).toBe(1)
  })

  test("ALTCHA-gated community creator can post without proof-of-work", async () => {
    const ctx = await createRouteTestContext({
      ALTCHA_HMAC_SECRET: "test-altcha-secret",
      ALTCHA_HMAC_KEY_SECRET: "test-altcha-key-secret",
      ALTCHA_POW_COST: "1",
      ALTCHA_POW_COUNTER_MIN: "1",
      ALTCHA_POW_COUNTER_MAX: "2",
    })
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "altcha-gate-creator-bypass")
    const created = await createMembershipGatedCommunity({
      env: ctx.env,
      creatorAccessToken: creator.accessToken,
      displayName: "ALTCHA Creator Bypass Club",
      gate: { type: "altcha_pow" },
    })

    const creatorPost = await requestJson(
      `http://pirate.test/communities/${created.communityId}/posts`,
      {
        post_type: "text",
        title: "Creator post without ALTCHA",
        body: "Creators should bypass action gates",
        idempotency_key: "altcha-creator-post-bypass",
      },
      ctx.env,
      creator.accessToken,
    )
    expect(creatorPost.status).toBe(201)

    const moderator = await exchangeJwt(ctx.env, "altcha-gate-moderator-bypass")
    const grantModerator = await requestJson(
      `http://pirate.test/communities/${created.communityId}/roles/grant`,
      {
        user_id: moderator.userId,
        role: "moderator",
      },
      ctx.env,
      creator.accessToken,
    )
    expect(grantModerator.status).toBe(200)

    const moderatorPost = await requestJson(
      `http://pirate.test/communities/${created.communityId}/posts`,
      {
        post_type: "text",
        title: "Moderator post without ALTCHA",
        body: "Moderators should bypass action gates.",
        idempotency_key: "altcha-moderator-post-bypass",
      },
      ctx.env,
      moderator.accessToken,
    )
    expect(moderatorPost.status).toBe(201)

    const member = await exchangeJwt(ctx.env, "altcha-gate-member-bypass")
    const joinProof = await solveAltchaProofFromRoute({
      env: ctx.env,
      accessToken: member.accessToken,
      scope: "community_join",
      action: `community:${created.communityId}`,
    })
    const joined = await app.request(
      `http://pirate.test/communities/${created.communityId}/join`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${member.accessToken}`,
          "x-pirate-altcha": joinProof,
        },
      },
      ctx.env,
    )
    expect(joined.status).toBe(200)

    const deniedMemberPost = await requestJson(
      `http://pirate.test/communities/${created.communityId}/posts`,
      {
        post_type: "text",
        title: "Member post without ALTCHA",
        body: "Members should still need action gates",
        idempotency_key: "altcha-member-post-denied",
      },
      ctx.env,
      member.accessToken,
    )
    expect(deniedMemberPost.status).toBe(403)
    const deniedMemberPostBody = await json(deniedMemberPost) as {
      code: string
      message: string
      details?: { suggested_verification_intent?: string | null }
    }
    expect(deniedMemberPostBody.code).toBe("gate_failed")
    expect(deniedMemberPostBody.message).toBe("Proof-of-work is required to post in this community")
    expect(deniedMemberPostBody.details?.suggested_verification_intent).toBe("post_create")
  })

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
      missing_capabilities?: string[]
      wallet_score_status?: { current_score_decimal: string | null; required_score_decimal: string | null; passing_score: boolean | null; last_scored_at: number | null }
    }
    expect(eligibilityBody.status).toBe("gate_failed")
    expect(eligibilityBody.failure_reason).toBe("wallet_score_too_low")
    expect(eligibilityBody.missing_capabilities).toBeUndefined()
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

  test("create nationality gate without allowed countries succeeds as any-nationality gate", async () => {
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
    expect(communityCreate.status).toBe(202)
    const body = await json(communityCreate) as {
      community: {
        membership_mode: string
        gate_policy?: { expression?: { gate?: { type?: string; allowed?: string[] } } } | null
      }
    }
    expect(body.community.membership_mode).toBe("gated")
    expect(body.community.gate_policy?.expression?.gate?.type).toBe("nationality")
    expect(body.community.gate_policy?.expression?.gate?.allowed).toEqual([])
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
      gate_match_mode: string | null
      membership_gate_summaries: Array<{ gate_type: string; required_value?: string; accepted_providers?: string[] }>
      viewer_membership_status: string
    }
    expect(previewBody.membership_mode).toBe("gated")
    expect(previewBody.gate_match_mode).toBe("all")
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
      failure_reason: string | null
      membership_gate_summaries: Array<{ gate_type: string }>
    }
    expect(eligibilityBody.status).toBe("gate_failed")
    expect(eligibilityBody.failure_reason).toBe("nationality_mismatch")
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
