import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createClient } from "@libsql/client"
import app from "../src/index"
import { buildDefaultVerificationCapabilities } from "../src/lib/verification/verification-capabilities"
import { createRouteTestContext, json, mintUpstreamJwt, resetRuntimeCaches } from "./helpers"
import type { Env } from "../src/types"

let cleanup: (() => Promise<void>) | null = null

function requestJson(url: string, body: unknown, env: Env, token?: string): Promise<Response> {
  return Promise.resolve(app.request(
    url,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    },
    env,
  ))
}

async function exchangeJwt(env: Env, sub: string): Promise<{ accessToken: string; userId: string }> {
  const jwt = await mintUpstreamJwt(env, { sub })
  const response = await requestJson("http://pirate.test/auth/session/exchange", {
    proof: {
      type: "jwt_based_auth",
      jwt,
    },
  }, env)
  const body = await json(response) as { access_token: string; user: { user_id: string } }
  return { accessToken: body.access_token, userId: body.user.user_id }
}

async function prepareVerifiedNamespace(env: Env, accessToken: string): Promise<string> {
  const verificationSession = await requestJson("http://pirate.test/verification-sessions", {
    provider: "self",
  }, env, accessToken)
  const verificationBody = await json(verificationSession) as { verification_session_id: string }
  await requestJson(
    `http://pirate.test/verification-sessions/${verificationBody.verification_session_id}/complete`,
    {},
    env,
    accessToken,
  )

  const namespaceSession = await requestJson("http://pirate.test/namespace-verification-sessions", {
    family: "hns",
    root_label: `FeedRoot-${Math.random().toString(16).slice(2)}`,
  }, env, accessToken)
  const namespaceBody = await json(namespaceSession) as { namespace_verification_session_id: string }
  const completed = await requestJson(
    `http://pirate.test/namespace-verification-sessions/${namespaceBody.namespace_verification_session_id}/complete`,
    {},
    env,
    accessToken,
  )
  const completedBody = await json(completed) as { namespace_verification_id: string }
  return completedBody.namespace_verification_id
}

async function completeUniqueHumanVerification(env: Env, accessToken: string): Promise<void> {
  const verificationSession = await requestJson("http://pirate.test/verification-sessions", {
    provider: "self",
  }, env, accessToken)
  const verificationBody = await json(verificationSession) as { verification_session_id: string }
  await requestJson(
    `http://pirate.test/verification-sessions/${verificationBody.verification_session_id}/complete`,
    {},
    env,
    accessToken,
  )
}

async function setPassportWalletScore(
  env: Env,
  userId: string,
  input: {
    score: number
    scoreThreshold: number
    passingScore: boolean
  },
): Promise<void> {
  const client = createClient({
    url: String(env.CONTROL_PLANE_DATABASE_URL),
  })

  try {
    const capabilities = buildDefaultVerificationCapabilities()
    capabilities.wallet_score = {
      state: "verified",
      provider: "passport",
      proof_type: "wallet_score",
      mechanism: "stamps-api-v2",
      verified_at: new Date().toISOString(),
      score: input.score,
      score_threshold: input.scoreThreshold,
      passing_score: input.passingScore,
      last_score_timestamp: new Date().toISOString(),
      expiration_timestamp: null,
      stamps: null,
    }

    await client.execute({
      sql: `
        UPDATE users
        SET verification_capabilities_json = ?2,
            updated_at = ?3
        WHERE user_id = ?1
      `,
      args: [userId, JSON.stringify(capabilities), new Date().toISOString()],
    })
  } finally {
    client.close()
  }
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

describe("feed routes", () => {
  test("home feed is recency-first and does not use raw member inflation for ranking", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const creatorA = await exchangeJwt(ctx.env, "feed-home-creator-a")
    const namespaceVerificationIdA = await prepareVerifiedNamespace(ctx.env, creatorA.accessToken)
    const communityCreateA = await requestJson("http://pirate.test/communities", {
      display_name: "Feed Club Alpha",
      namespace: { namespace_verification_id: namespaceVerificationIdA },
    }, ctx.env, creatorA.accessToken)
    expect(communityCreateA.status).toBe(202)
    const communityA = await json(communityCreateA) as { community: { community_id: string } }

    const walletJoiner1 = await exchangeJwt(ctx.env, "feed-home-wallet-1")
    await setPassportWalletScore(ctx.env, walletJoiner1.userId, {
      score: 100,
      scoreThreshold: 20,
      passingScore: true,
    })
    const walletJoin1 = await app.request(
      `http://pirate.test/communities/${communityA.community.community_id}/join`,
      { method: "POST", headers: { authorization: `Bearer ${walletJoiner1.accessToken}` } },
      ctx.env,
    )
    expect(walletJoin1.status).toBe(200)

    const walletJoiner2 = await exchangeJwt(ctx.env, "feed-home-wallet-2")
    await setPassportWalletScore(ctx.env, walletJoiner2.userId, {
      score: 101,
      scoreThreshold: 20,
      passingScore: true,
    })
    const walletJoin2 = await app.request(
      `http://pirate.test/communities/${communityA.community.community_id}/join`,
      { method: "POST", headers: { authorization: `Bearer ${walletJoiner2.accessToken}` } },
      ctx.env,
    )
    expect(walletJoin2.status).toBe(200)

    const alphaPost = await requestJson(
      `http://pirate.test/communities/${communityA.community.community_id}/posts`,
      {
        post_type: "text",
        title: "Alpha first",
        body: "Older post in a larger raw-membership community.",
        idempotency_key: "feed-home-alpha-post",
      },
      ctx.env,
      creatorA.accessToken,
    )
    expect(alphaPost.status).toBe(201)
    const alphaPostBody = await json(alphaPost) as { post_id: string }

    await new Promise((resolve) => setTimeout(resolve, 5))

    const creatorB = await exchangeJwt(ctx.env, "feed-home-creator-b")
    const namespaceVerificationIdB = await prepareVerifiedNamespace(ctx.env, creatorB.accessToken)
    const communityCreateB = await requestJson("http://pirate.test/communities", {
      display_name: "Feed Club Beta",
      namespace: { namespace_verification_id: namespaceVerificationIdB },
    }, ctx.env, creatorB.accessToken)
    expect(communityCreateB.status).toBe(202)
    const communityB = await json(communityCreateB) as { community: { community_id: string } }

    const betaPost = await requestJson(
      `http://pirate.test/communities/${communityB.community.community_id}/posts`,
      {
        post_type: "text",
        title: "Beta later",
        body: "Newer post in a smaller community.",
        idempotency_key: "feed-home-beta-post",
      },
      ctx.env,
      creatorB.accessToken,
    )
    expect(betaPost.status).toBe(201)
    const betaPostBody = await json(betaPost) as { post_id: string }

    const homeFeed = await app.request("http://pirate.test/feeds/home", {}, ctx.env)
    expect(homeFeed.status).toBe(200)
    const homeFeedBody = await json(homeFeed) as {
      items: Array<{ post: { post_id: string; title: string | null } }>
      next_cursor: string | null
    }
    expect(homeFeedBody.items).toHaveLength(2)
    expect(homeFeedBody.items[0]?.post.post_id).toBe(betaPostBody.post_id)
    expect(homeFeedBody.items[0]?.post.title).toBe("Beta later")
    expect(homeFeedBody.items[1]?.post.post_id).toBe(alphaPostBody.post_id)
    expect(homeFeedBody.next_cursor).toBeNull()

    const communityARead = await app.request(
      `http://pirate.test/communities/${communityA.community.community_id}`,
      { headers: { authorization: `Bearer ${creatorA.accessToken}` } },
      ctx.env,
    )
    expect(communityARead.status).toBe(200)
    const communityAReadBody = await json(communityARead) as {
      member_count: number | null
      qualified_member_count: number | null
    }
    expect(communityAReadBody.member_count).toBe(3)
    expect(communityAReadBody.qualified_member_count).toBe(1)
  })

  test("your communities feed is auth-gated and only includes joined communities", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const denied = await app.request("http://pirate.test/feeds/your-communities", {}, ctx.env)
    expect(denied.status).toBe(401)

    const creatorA = await exchangeJwt(ctx.env, "feed-your-communities-creator-a")
    const namespaceVerificationIdA = await prepareVerifiedNamespace(ctx.env, creatorA.accessToken)
    const communityCreateA = await requestJson("http://pirate.test/communities", {
      display_name: "Your Communities Alpha",
      namespace: { namespace_verification_id: namespaceVerificationIdA },
    }, ctx.env, creatorA.accessToken)
    expect(communityCreateA.status).toBe(202)
    const communityA = await json(communityCreateA) as { community: { community_id: string } }

    const creatorB = await exchangeJwt(ctx.env, "feed-your-communities-creator-b")
    const namespaceVerificationIdB = await prepareVerifiedNamespace(ctx.env, creatorB.accessToken)
    const communityCreateB = await requestJson("http://pirate.test/communities", {
      display_name: "Your Communities Beta",
      namespace: { namespace_verification_id: namespaceVerificationIdB },
    }, ctx.env, creatorB.accessToken)
    expect(communityCreateB.status).toBe(202)
    const communityB = await json(communityCreateB) as { community: { community_id: string } }

    const viewer = await exchangeJwt(ctx.env, "feed-your-communities-viewer")
    await completeUniqueHumanVerification(ctx.env, viewer.accessToken)

    const joined = await app.request(
      `http://pirate.test/communities/${communityA.community.community_id}/join`,
      { method: "POST", headers: { authorization: `Bearer ${viewer.accessToken}` } },
      ctx.env,
    )
    expect(joined.status).toBe(200)

    const postA = await requestJson(
      `http://pirate.test/communities/${communityA.community.community_id}/posts`,
      {
        post_type: "text",
        title: "Joined community post",
        body: "This should appear in Your Communities.",
        idempotency_key: "feed-your-communities-post-a",
      },
      ctx.env,
      creatorA.accessToken,
    )
    expect(postA.status).toBe(201)
    const postABody = await json(postA) as { post_id: string }

    const postB = await requestJson(
      `http://pirate.test/communities/${communityB.community.community_id}/posts`,
      {
        post_type: "text",
        title: "Non-member community post",
        body: "This should stay out of Your Communities.",
        idempotency_key: "feed-your-communities-post-b",
      },
      ctx.env,
      creatorB.accessToken,
    )
    expect(postB.status).toBe(201)

    const yourClubs = await app.request(
      "http://pirate.test/feeds/your-communities",
      { headers: { authorization: `Bearer ${viewer.accessToken}` } },
      ctx.env,
    )
    expect(yourClubs.status).toBe(200)
    const yourClubsBody = await json(yourClubs) as {
      items: Array<{ post: { post_id: string; title: string | null } }>
      next_cursor: string | null
    }
    expect(yourClubsBody.items).toHaveLength(1)
    expect(yourClubsBody.items[0]?.post.post_id).toBe(postABody.post_id)
    expect(yourClubsBody.items[0]?.post.title).toBe("Joined community post")
    expect(yourClubsBody.next_cursor).toBeNull()
  })
})
