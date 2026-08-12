import { createClient } from "@libsql/client"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { buildLocalCommunityDbUrl } from "../../../src/lib/communities/community-local-db"
import { setSelfProviderForTests } from "../../../src/lib/verification/self-provider"
import { solveTestAltchaPayload } from "../../altcha-test-helpers"
import { buildVerifiedSelfProvider, createRouteTestContext, json, resetRuntimeCaches } from "../../helpers"
import {
  createCommunity,
  exchangeJwt,
  requestJson,
} from "../comments/comments-routes-test-helpers"

const POW_ONLY_POLICY = {
  version: 1,
  expression: {
    op: "gate",
    gate: { type: "altcha_pow" },
  },
} as const

const POW_OR_SCORE_POLICY = {
  version: 1,
  expression: {
    op: "or",
    children: [
      { op: "gate", gate: { type: "altcha_pow" } },
      { op: "gate", gate: { type: "wallet_score", provider: "passport", minimum_score: 30 } },
    ],
  },
} as const

const POW_AND_HUMAN_POLICY = {
  version: 1,
  expression: {
    op: "and",
    children: [
      { op: "gate", gate: { type: "altcha_pow" } },
      { op: "gate", gate: { type: "unique_human", provider: "self" } },
    ],
  },
} as const

const ALTCHA_ENV = {
  ALTCHA_HMAC_SECRET: "test-altcha-secret",
  ALTCHA_HMAC_KEY_SECRET: "test-altcha-key-secret",
  ALTCHA_POW_COST: "1",
  ALTCHA_POW_COUNTER_MIN: "1",
  ALTCHA_POW_COUNTER_MAX: "2",
}

let cleanup: (() => Promise<void>) | null = null

beforeEach(() => {
  resetRuntimeCaches()
  setSelfProviderForTests(buildVerifiedSelfProvider("self-pow-open-participation-ref"))
})

afterEach(async () => {
  resetRuntimeCaches()
  if (cleanup) {
    await cleanup()
    cleanup = null
  }
})

async function fetchMembershipAndFollow(communityDbRoot: string, communityId: string, userId: string): Promise<{
  membershipStatus: string | null
  followStatus: string | null
}> {
  const client = createClient({ url: buildLocalCommunityDbUrl(communityDbRoot, communityId) })
  try {
    const membership = await client.execute({
      sql: "SELECT status FROM community_memberships WHERE community_id = ?1 AND user_id = ?2",
      args: [communityId, userId],
    })
    const follow = await client.execute({
      sql: "SELECT status FROM community_follows WHERE community_id = ?1 AND user_id = ?2",
      args: [communityId, userId],
    })
    return {
      membershipStatus: membership.rows[0]?.status == null ? null : String(membership.rows[0].status),
      followStatus: follow.rows[0]?.status == null ? null : String(follow.rows[0].status),
    }
  } finally {
    client.close()
  }
}

async function banUser(communityDbRoot: string, communityId: string, userId: string): Promise<void> {
  const client = createClient({ url: buildLocalCommunityDbUrl(communityDbRoot, communityId) })
  try {
    const now = new Date().toISOString()
    await client.execute({
      sql: `
        INSERT INTO community_memberships (
          membership_id, community_id, user_id, status, joined_at, left_at, banned_at, created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, 'banned', ?4, NULL, ?4, ?4, ?4
        )
        ON CONFLICT(membership_id) DO UPDATE SET
          status = 'banned',
          banned_at = excluded.banned_at,
          updated_at = excluded.updated_at
      `,
      args: [`mbr_${communityId}_${userId}`, communityId, userId, now],
    })
  } finally {
    client.close()
  }
}

async function createPowOnlyCommunityWithPost(ctx: { env: Parameters<typeof exchangeJwt>[0] }): Promise<{
  communityId: string
  postId: string
  creatorToken: string
}> {
  const creator = await exchangeJwt(ctx.env, "pow-open-creator")
  const community = await createCommunity(ctx.env, creator.accessToken, "PoW Open Club", POW_ONLY_POLICY)
  const createdPost = await requestJson(
    `http://pirate.test/communities/${community.communityId}/posts`,
    {
      post_type: "text",
      title: "Open participation",
      body: "Vote and comment without joining.",
      idempotency_key: "pow-open-post-1",
    },
    ctx.env,
    creator.accessToken,
  )
  expect(createdPost.status).toBe(201)
  const postBody = await json(createdPost) as { id: string }
  return { communityId: community.communityId, postId: postBody.id, creatorToken: creator.accessToken }
}

describe("PoW-only open participation", () => {
  test("non-member vote requires a proof, then succeeds and auto-follows without joining", async () => {
    const ctx = await createRouteTestContext(ALTCHA_ENV)
    cleanup = ctx.cleanup
    const { communityId, postId } = await createPowOnlyCommunityWithPost(ctx)

    const outsider = await exchangeJwt(ctx.env, "pow-open-outsider-vote")

    const missingProof = await requestJson(
      `http://pirate.test/posts/${postId}/vote`,
      { value: 1 },
      ctx.env,
      outsider.accessToken,
    )
    expect(missingProof.status).toBe(403)
    const missingProofBody = await json(missingProof) as { code: string }
    expect(missingProofBody.code).toBe("gate_failed")

    const altcha = await solveTestAltchaPayload({
      env: ctx.env,
      actorUserId: outsider.userId,
      scope: "vote",
      action: `post:${postId}:1`,
    })
    const acceptedVote = await requestJson(
      `http://pirate.test/posts/${postId}/vote`,
      { value: 1, altcha },
      ctx.env,
      outsider.accessToken,
    )
    expect(acceptedVote.status).toBe(200)

    const state = await fetchMembershipAndFollow(ctx.communityDbRoot, communityId, outsider.userId)
    expect(state.membershipStatus).toBeNull()
    expect(state.followStatus).toBe("active")
  })

  test("a non-member vote does not reactivate an explicit unfollow", async () => {
    const ctx = await createRouteTestContext(ALTCHA_ENV)
    cleanup = ctx.cleanup
    const { communityId, postId } = await createPowOnlyCommunityWithPost(ctx)
    const outsider = await exchangeJwt(ctx.env, "pow-open-explicit-unfollow")

    const firstAltcha = await solveTestAltchaPayload({
      env: ctx.env,
      actorUserId: outsider.userId,
      scope: "vote",
      action: `post:${postId}:1`,
    })
    const firstVote = await requestJson(
      `http://pirate.test/posts/${postId}/vote`,
      { value: 1, altcha: firstAltcha },
      ctx.env,
      outsider.accessToken,
    )
    expect(firstVote.status).toBe(200)

    const unfollow = await requestJson(
      `http://pirate.test/communities/${communityId}/unfollow`,
      {},
      ctx.env,
      outsider.accessToken,
    )
    expect(unfollow.status).toBe(200)

    const secondAltcha = await solveTestAltchaPayload({
      env: ctx.env,
      actorUserId: outsider.userId,
      scope: "vote",
      action: `post:${postId}:-1`,
    })
    const secondVote = await requestJson(
      `http://pirate.test/posts/${postId}/vote`,
      { value: -1, altcha: secondAltcha },
      ctx.env,
      outsider.accessToken,
    )
    expect(secondVote.status).toBe(200)

    const state = await fetchMembershipAndFollow(ctx.communityDbRoot, communityId, outsider.userId)
    expect(state.membershipStatus).toBeNull()
    expect(state.followStatus).toBe("inactive")
  })

  test("non-member comment succeeds with a proof and auto-follows without joining", async () => {
    const ctx = await createRouteTestContext(ALTCHA_ENV)
    cleanup = ctx.cleanup
    const { communityId, postId } = await createPowOnlyCommunityWithPost(ctx)

    const outsider = await exchangeJwt(ctx.env, "pow-open-outsider-comment")
    const altcha = await solveTestAltchaPayload({
      env: ctx.env,
      actorUserId: outsider.userId,
      scope: "comment_create",
      action: `post:${postId}`,
    })
    const commentResponse = await requestJson(
      `http://pirate.test/communities/${communityId}/posts/${postId}/comments`,
      { body: "Commenting without joining", altcha },
      ctx.env,
      outsider.accessToken,
    )
    expect(commentResponse.status).toBe(201)

    const state = await fetchMembershipAndFollow(ctx.communityDbRoot, communityId, outsider.userId)
    expect(state.membershipStatus).toBeNull()
    expect(state.followStatus).toBe("active")
  })

  test("non-member post create succeeds with a proof and auto-follows without joining", async () => {
    const ctx = await createRouteTestContext(ALTCHA_ENV)
    cleanup = ctx.cleanup
    const { communityId } = await createPowOnlyCommunityWithPost(ctx)

    const outsider = await exchangeJwt(ctx.env, "pow-open-outsider-post")
    const altcha = await solveTestAltchaPayload({
      env: ctx.env,
      actorUserId: outsider.userId,
      scope: "post_create",
      action: `community:com_${communityId}`,
    })
    const createdPost = await requestJson(
      `http://pirate.test/communities/${communityId}/posts`,
      {
        post_type: "text",
        title: "Posting without joining",
        body: "The proof is the gate.",
        idempotency_key: "pow-open-outsider-post-1",
        altcha,
      },
      ctx.env,
      outsider.accessToken,
    )
    expect(createdPost.status).toBe(201)

    const state = await fetchMembershipAndFollow(ctx.communityDbRoot, communityId, outsider.userId)
    expect(state.membershipStatus).toBeNull()
    expect(state.followStatus).toBe("active")
  })

  test("banned users stay blocked even with a valid proof", async () => {
    const ctx = await createRouteTestContext(ALTCHA_ENV)
    cleanup = ctx.cleanup
    const { communityId, postId } = await createPowOnlyCommunityWithPost(ctx)

    const outsider = await exchangeJwt(ctx.env, "pow-open-banned")
    await banUser(ctx.communityDbRoot, communityId, outsider.userId)

    const altcha = await solveTestAltchaPayload({
      env: ctx.env,
      actorUserId: outsider.userId,
      scope: "vote",
      action: `post:${postId}:1`,
    })
    const vote = await requestJson(
      `http://pirate.test/posts/${postId}/vote`,
      { value: 1, altcha },
      ctx.env,
      outsider.accessToken,
    )
    expect(vote.status).toBe(403)
    const voteBody = await json(vote) as { code: string }
    expect(voteBody.code).toBe("membership_required")

    const state = await fetchMembershipAndFollow(ctx.communityDbRoot, communityId, outsider.userId)
    expect(state.followStatus).not.toBe("active")
  })

  test("an OR gate that proof-of-work alone satisfies follows the voter instead of joining them", async () => {
    // The dankmeme shape: or(wallet_score, unique_human, altcha_pow). Anyone
    // can clear it with a browser check, so the gate is already open and a
    // join step in front of it gates nothing.
    const ctx = await createRouteTestContext(ALTCHA_ENV)
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "pow-or-creator")
    const community = await createCommunity(ctx.env, creator.accessToken, "PoW Or Score Club", POW_OR_SCORE_POLICY)
    const createdPost = await requestJson(
      `http://pirate.test/communities/${community.communityId}/posts`,
      {
        post_type: "text",
        title: "Open interactions",
        body: "Verified or merely-human, no join either way.",
        idempotency_key: "pow-or-post-1",
      },
      ctx.env,
      creator.accessToken,
    )
    expect(createdPost.status).toBe(201)
    const postBody = await json(createdPost) as { id: string }

    const outsider = await exchangeJwt(ctx.env, "pow-or-outsider")
    const altcha = await solveTestAltchaPayload({
      env: ctx.env,
      actorUserId: outsider.userId,
      scope: "vote",
      action: `post:${postBody.id}:1`,
    })
    const vote = await requestJson(
      `http://pirate.test/posts/${postBody.id}/vote`,
      { value: 1, altcha },
      ctx.env,
      outsider.accessToken,
    )
    expect(vote.status).toBe(200)

    const state = await fetchMembershipAndFollow(ctx.communityDbRoot, community.communityId, outsider.userId)
    expect(state.membershipStatus).toBeNull()
    expect(state.followStatus).toBe("active")
  })

  test("a gate requiring identity alongside proof-of-work still requires membership", async () => {
    const ctx = await createRouteTestContext(ALTCHA_ENV)
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "pow-and-creator")
    const community = await createCommunity(ctx.env, creator.accessToken, "PoW And Human Club", POW_AND_HUMAN_POLICY)
    const createdPost = await requestJson(
      `http://pirate.test/communities/${community.communityId}/posts`,
      {
        post_type: "text",
        title: "Identity required",
        body: "A browser check alone cannot satisfy this gate.",
        idempotency_key: "pow-and-post-1",
      },
      ctx.env,
      creator.accessToken,
    )
    expect(createdPost.status).toBe(201)
    const postBody = await json(createdPost) as { id: string }

    const outsider = await exchangeJwt(ctx.env, "pow-and-outsider")
    const altcha = await solveTestAltchaPayload({
      env: ctx.env,
      actorUserId: outsider.userId,
      scope: "vote",
      action: `post:${postBody.id}:1`,
    })
    const vote = await requestJson(
      `http://pirate.test/posts/${postBody.id}/vote`,
      { value: 1, altcha },
      ctx.env,
      outsider.accessToken,
    )
    expect(vote.status).toBe(403)
    const voteBody = await json(vote) as { code: string }
    expect(voteBody.code).toBe("membership_required")

    const state = await fetchMembershipAndFollow(ctx.communityDbRoot, community.communityId, outsider.userId)
    expect(state.followStatus).not.toBe("active")
  })
})
