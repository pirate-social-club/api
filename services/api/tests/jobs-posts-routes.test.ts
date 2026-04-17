import { afterEach, describe, expect, test } from "bun:test"
import { createClient } from "@libsql/client"
import app from "../src/index"
import { buildLocalCommunityDbUrl } from "../src/lib/communities/community-local-db"
import type { Env } from "../src/types"
import { createRouteTestContext, json, mintUpstreamJwt, resetRuntimeCaches } from "./helpers"

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

async function prepareVerifiedNamespace(env: Env, accessToken: string): Promise<string> {
  await completeUniqueHumanVerification(env, accessToken)

  const namespaceSession = await requestJson("http://pirate.test/namespace-verification-sessions", {
    family: "hns",
    root_label: "FocusedRouteCoverageRoot",
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

async function createCommunity(env: Env, accessToken: string, displayName: string): Promise<{
  communityId: string
  createJobId: string
  registryJobId: string
}> {
  const namespaceVerificationId = await prepareVerifiedNamespace(env, accessToken)
  const response = await requestJson("http://pirate.test/communities", {
    display_name: displayName,
    namespace: {
      namespace_verification_id: namespaceVerificationId,
    },
  }, env, accessToken)

  expect(response.status).toBe(202)
  const body = await json(response) as {
    community: {
      community_id: string
      registry_publication_job_id: string | null
    }
    job: {
      job_id: string
    }
  }

  expect(typeof body.community.registry_publication_job_id).toBe("string")

  return {
    communityId: body.community.community_id,
    createJobId: body.job.job_id,
    registryJobId: String(body.community.registry_publication_job_id),
  }
}

async function addCommunityMember(communityDbRoot: string, communityId: string, userId: string): Promise<void> {
  const client = createClient({
    url: buildLocalCommunityDbUrl(communityDbRoot, communityId),
  })

  try {
    const now = new Date().toISOString()
    await client.execute({
      sql: `
        INSERT INTO community_memberships (
          membership_id, community_id, user_id, status, joined_at, left_at, banned_at, created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, 'member', ?4, NULL, NULL, ?4, ?4
        )
        ON CONFLICT(membership_id) DO UPDATE SET
          status = excluded.status,
          joined_at = excluded.joined_at,
          left_at = excluded.left_at,
          banned_at = excluded.banned_at,
          updated_at = excluded.updated_at
      `,
      args: [`mbr_${communityId}_${userId}`, communityId, userId, now],
    })
  } finally {
    client.close()
  }
}

afterEach(async () => {
  resetRuntimeCaches()
  if (cleanup) {
    await cleanup()
    cleanup = null
  }
})

describe("jobs routes", () => {
  test("GET /jobs/:jobId returns community creation and registry publication jobs", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "jobs-routes-author")
    const community = await createCommunity(ctx.env, session.accessToken, "Jobs Route Club")

    const createJob = await app.request(
      `http://pirate.test/jobs/${community.createJobId}`,
      {
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(createJob.status).toBe(200)
    const createJobBody = await json(createJob) as { job_id: string; status: string; subject_id: string }
    expect(createJobBody.job_id).toBe(community.createJobId)
    expect(createJobBody.status).toBe("succeeded")
    expect(createJobBody.subject_id).toBe(community.communityId)

    const registryJob = await app.request(
      `http://pirate.test/jobs/${community.registryJobId}`,
      {
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(registryJob.status).toBe(200)
    const registryJobBody = await json(registryJob) as {
      job_id: string
      job_type: string
      status: string
      subject_id: string
    }
    expect(registryJobBody.job_id).toBe(community.registryJobId)
    expect(registryJobBody.job_type).toBe("community_registry_publication")
    expect(registryJobBody.status).toBe("succeeded")
    expect(registryJobBody.subject_id).toBe(community.communityId)
  })
})

describe("posts routes", () => {
  test("GET /posts/:postId returns a created post", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "posts-routes-author")
    const community = await createCommunity(ctx.env, session.accessToken, "Posts Route Club")

    const createdPost = await requestJson(
      `http://pirate.test/communities/${community.communityId}/posts`,
      {
        post_type: "text",
        title: "Focused route coverage",
        body: "Dedicated post route test.",
        idempotency_key: "posts-routes-create-1",
      },
      ctx.env,
      session.accessToken,
    )
    expect(createdPost.status).toBe(201)
    const createdPostBody = await json(createdPost) as { post_id: string; title: string | null }
    expect(createdPostBody.title).toBe("Focused route coverage")

    const fetchedPost = await app.request(
      `http://pirate.test/posts/${createdPostBody.post_id}?locale=es`,
      {
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(fetchedPost.status).toBe(200)
    const fetchedPostBody = await json(fetchedPost) as {
      post: { post_id: string; title: string | null }
      resolved_locale: string
      translation_state: string
    }
    expect(fetchedPostBody.post.post_id).toBe(createdPostBody.post_id)
    expect(fetchedPostBody.post.title).toBe("Focused route coverage")
    expect(fetchedPostBody.resolved_locale).toBe("es")
    expect(fetchedPostBody.translation_state).toBe("same_language")
  })

  test("POST /posts/:postId/vote enforces verification and records a verified member vote", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "posts-routes-vote-creator")
    const community = await createCommunity(ctx.env, creator.accessToken, "Vote Route Club")

    const createdPost = await requestJson(
      `http://pirate.test/communities/${community.communityId}/posts`,
      {
        post_type: "text",
        title: "Vote on me",
        body: "Dedicated vote route test.",
        idempotency_key: "posts-routes-vote-1",
      },
      ctx.env,
      creator.accessToken,
    )
    expect(createdPost.status).toBe(201)
    const postBody = await json(createdPost) as { post_id: string }

    const unverifiedMember = await exchangeJwt(ctx.env, "posts-routes-unverified-member")
    await addCommunityMember(ctx.communityDbRoot, community.communityId, unverifiedMember.userId)

    const deniedVote = await requestJson(
      `http://pirate.test/posts/${postBody.post_id}/vote`,
      { value: 1 },
      ctx.env,
      unverifiedMember.accessToken,
    )
    expect(deniedVote.status).toBe(403)
    const deniedVoteBody = await json(deniedVote) as { code: string; message: string }
    expect(deniedVoteBody.code).toBe("verification_required")
    expect(deniedVoteBody.message).toBe("unique_human verification is required")

    const verifiedMember = await exchangeJwt(ctx.env, "posts-routes-verified-member")
    await completeUniqueHumanVerification(ctx.env, verifiedMember.accessToken)
    await addCommunityMember(ctx.communityDbRoot, community.communityId, verifiedMember.userId)

    const acceptedVote = await requestJson(
      `http://pirate.test/posts/${postBody.post_id}/vote`,
      { value: 1 },
      ctx.env,
      verifiedMember.accessToken,
    )
    expect(acceptedVote.status).toBe(200)
    const acceptedVoteBody = await json(acceptedVote) as { post_id: string; value: number }
    expect(acceptedVoteBody.post_id).toBe(postBody.post_id)
    expect(acceptedVoteBody.value).toBe(1)
  })
})
