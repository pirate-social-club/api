import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createClient } from "@libsql/client"
import app from "../src/index"
import { buildLocalCommunityDbUrl } from "../src/lib/communities/community-local-db"
import { buildDefaultVerificationCapabilities } from "../src/lib/verification/verification-capabilities"
import { createRouteTestContext, json, mintUpstreamJwt, resetRuntimeCaches } from "./helpers"
import { setVeryProviderForTests } from "../src/lib/verification/very-provider"
import { setSelfProviderForTests } from "../src/lib/verification/self-provider"
import type { VeryProvider } from "../src/lib/verification/very-provider"
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
    root_label: "PirateCommunityRoot",
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

async function completeUniqueHumanVerification(
  env: Env,
  accessToken: string,
  provider: "self" | "very" = "self",
): Promise<void> {
  const verificationSession = await requestJson("http://pirate.test/verification-sessions", {
    provider,
  }, env, accessToken)
  const verificationBody = await json(verificationSession) as { verification_session_id: string }
  await requestJson(
    `http://pirate.test/verification-sessions/${verificationBody.verification_session_id}/complete`,
    {},
    env,
    accessToken,
  )
}

async function completeNationalityVerification(
  env: Env,
  accessToken: string,
): Promise<void> {
  const verificationSession = await requestJson("http://pirate.test/verification-sessions", {
    provider: "self",
    requested_capabilities: ["nationality"],
  }, env, accessToken)
  const verificationBody = await json(verificationSession) as { verification_session_id: string }
  await requestJson(
    `http://pirate.test/verification-sessions/${verificationBody.verification_session_id}/complete`,
    {},
    env,
    accessToken,
  )
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
    url: String(env.TURSO_CONTROL_PLANE_DATABASE_URL),
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

async function setPrimaryWalletAttachment(
  env: Env,
  userId: string,
  walletAddress: string,
): Promise<void> {
  const client = createClient({
    url: String(env.TURSO_CONTROL_PLANE_DATABASE_URL),
  })

  try {
    const walletAttachmentId = `wal_${userId}`
    const now = new Date().toISOString()
    await client.execute({
      sql: `
        INSERT INTO wallet_attachments (
          wallet_attachment_id, user_id, chain_namespace, wallet_address_normalized, wallet_address_display,
          source_provider, source_subject, attachment_kind, is_primary, status, attached_at, detached_at, created_at, updated_at
        ) VALUES (
          ?1, ?2, 'eip155:84532', ?3, ?3,
          'test', ?2, 'external', 1, 'active', ?4, NULL, ?4, ?4
        )
        ON CONFLICT(wallet_attachment_id) DO UPDATE SET
          wallet_address_normalized = excluded.wallet_address_normalized,
          wallet_address_display = excluded.wallet_address_display,
          is_primary = 1,
          status = 'active',
          detached_at = NULL,
          updated_at = excluded.updated_at
      `,
      args: [walletAttachmentId, userId, walletAddress, now],
    })

    await client.execute({
      sql: `
        UPDATE users
        SET primary_wallet_attachment_id = ?2,
            updated_at = ?3
        WHERE user_id = ?1
      `,
      args: [userId, walletAttachmentId, now],
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

describe("community routes", () => {
  test("community create, job fetch, post create, and post read work through the full route stack", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-user")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Test Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: {
        community_id: string
        display_name: string
        namespace_verification_id: string | null
        provisioning_state: string
        registry_publication_state: string
        registry_publication_job_id: string | null
        status: string
      }
      job: { job_id: string; status: string }
    }
    expect(communityCreateBody.community.display_name).toBe("Pirate Test Club")
    expect(communityCreateBody.community.namespace_verification_id).toBe(namespaceVerificationId)
    expect(communityCreateBody.community.provisioning_state).toBe("active")
    expect(communityCreateBody.community.registry_publication_state).toBe("published")
    expect(typeof communityCreateBody.community.registry_publication_job_id).toBe("string")
    expect(communityCreateBody.community.status).toBe("active")
    expect(communityCreateBody.job.status).toBe("succeeded")

    const communityGet = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}`,
      {
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(communityGet.status).toBe(200)

    const jobGet = await app.request(
      `http://pirate.test/jobs/${communityCreateBody.job.job_id}`,
      {
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(jobGet.status).toBe(200)
    const jobBody = await json(jobGet) as { status: string; subject_id: string }
    expect(jobBody.status).toBe("succeeded")
    expect(jobBody.subject_id).toBe(communityCreateBody.community.community_id)

    const registryJob = await app.request(
      `http://pirate.test/jobs/${communityCreateBody.community.registry_publication_job_id}`,
      {
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(registryJob.status).toBe(200)
    const registryJobBody = await json(registryJob) as { job_type: string; status: string; subject_id: string }
    expect(registryJobBody.job_type).toBe("community_registry_publication")
    expect(registryJobBody.status).toBe("succeeded")
    expect(registryJobBody.subject_id).toBe(communityCreateBody.community.community_id)

    const createdPost = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
      {
        post_type: "text",
        title: "Hello Pirate",
        body: "Testing the local community flow.",
        idempotency_key: "post-key-1",
      },
      ctx.env,
      session.accessToken,
    )
    expect(createdPost.status).toBe(201)
    const postBody = await json(createdPost) as {
      post_id: string
      community_id: string
      status: string
      title: string | null
      author_user_id: string | null
    }
    expect(postBody.community_id).toBe(communityCreateBody.community.community_id)
    expect(postBody.status).toBe("published")
    expect(postBody.title).toBe("Hello Pirate")
    expect(postBody.author_user_id).toBe(session.userId)

    const retriedPost = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
      {
        post_type: "text",
        title: "Hello Pirate",
        body: "Testing the local community flow.",
        idempotency_key: "post-key-1",
      },
      ctx.env,
      session.accessToken,
    )
    expect(retriedPost.status).toBe(201)
    const retriedPostBody = await json(retriedPost) as {
      post_id: string
      community_id: string
      status: string
    }
    expect(retriedPostBody.post_id).toBe(postBody.post_id)
    expect(retriedPostBody.community_id).toBe(postBody.community_id)
    expect(retriedPostBody.status).toBe("published")

    const fetchedPost = await app.request(
      `http://pirate.test/posts/${postBody.post_id}?locale=es`,
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
    expect(fetchedPostBody.post.post_id).toBe(postBody.post_id)
    expect(fetchedPostBody.post.title).toBe("Hello Pirate")
    expect(fetchedPostBody.resolved_locale).toBe("es")
    expect(fetchedPostBody.translation_state).toBe("same_language")

    const reviewHeldPost = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
      {
        post_type: "text",
        title: "[review-required] Hello Pirate",
        body: "Force the local review-held stub path.",
        idempotency_key: "post-key-review-required",
      },
      ctx.env,
      session.accessToken,
    )
    expect(reviewHeldPost.status).toBe(202)
    const reviewHeldPostBody = await json(reviewHeldPost) as {
      post_id: string
      community_id: string
      status: string
      analysis_state: string
      content_safety_state: string
    }
    expect(reviewHeldPostBody.community_id).toBe(communityCreateBody.community.community_id)
    expect(reviewHeldPostBody.status).toBe("draft")
    expect(reviewHeldPostBody.analysis_state).toBe("review_required")
    expect(reviewHeldPostBody.content_safety_state).toBe("pending")

    const fetchedReviewHeldPost = await app.request(
      `http://pirate.test/posts/${reviewHeldPostBody.post_id}?locale=es`,
      {
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(fetchedReviewHeldPost.status).toBe(200)
    const fetchedReviewHeldPostBody = await json(fetchedReviewHeldPost) as {
      post: {
        post_id: string
        status: string
        analysis_state: string
        content_safety_state: string
      }
      resolved_locale: string
    }
    expect(fetchedReviewHeldPostBody.post.post_id).toBe(reviewHeldPostBody.post_id)
    expect(fetchedReviewHeldPostBody.post.status).toBe("draft")
    expect(fetchedReviewHeldPostBody.post.analysis_state).toBe("review_required")
    expect(fetchedReviewHeldPostBody.post.content_safety_state).toBe("pending")
    expect(fetchedReviewHeldPostBody.resolved_locale).toBe("es")

    const blockedPost = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
      {
        post_type: "text",
        title: "[blocked] Hello Pirate",
        body: "Force the local blocked stub path.",
        idempotency_key: "post-key-blocked",
      },
      ctx.env,
      session.accessToken,
    )
    expect(blockedPost.status).toBe(422)
    const blockedPostBody = await json(blockedPost) as { code: string }
    expect(blockedPostBody.code).toBe("analysis_blocked")

    const controlPlaneProjectionCount = await ctx.client.execute({
      sql: `
        SELECT COUNT(*) AS count
        FROM community_post_projections
        WHERE community_id = ?1
      `,
      args: [communityCreateBody.community.community_id],
    })
    expect(Number(controlPlaneProjectionCount.rows[0]?.count ?? 0)).toBe(2)

    const communityDb = createClient({
      url: buildLocalCommunityDbUrl(ctx.communityDbRoot, communityCreateBody.community.community_id),
    })
    try {
      const communityPostCount = await communityDb.execute({
        sql: `
          SELECT COUNT(*) AS count
          FROM posts
          WHERE community_id = ?1
        `,
        args: [communityCreateBody.community.community_id],
      })
      expect(Number(communityPostCount.rows[0]?.count ?? 0)).toBe(2)
    } finally {
      communityDb.close()
    }

    const listedPosts = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts?locale=es`,
      {
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(listedPosts.status).toBe(200)
    const listedPostsBody = await json(listedPosts) as {
      items: Array<{
        post: { post_id: string; status: string }
        resolved_locale: string
      }>
      next_cursor: string | null
    }
    expect(listedPostsBody.items).toHaveLength(1)
    expect(listedPostsBody.items[0]?.post.post_id).toBe(postBody.post_id)
    expect(listedPostsBody.items[0]?.post.status).toBe("published")
    expect(listedPostsBody.items[0]?.resolved_locale).toBe("es")
    expect(listedPostsBody.items.some((item) => item.post.post_id === reviewHeldPostBody.post_id)).toBe(false)
    expect(listedPostsBody.next_cursor).toBeNull()
  })

  test("community create returns publication_error when the publisher times out after provisioning succeeds", async () => {
    const publisherToken = "publisher-test-token"
    const publisherBaseUrl = "http://publisher.test"
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input, init) => {
      const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (!requestUrl.startsWith(publisherBaseUrl)) {
        return originalFetch(input as never, init)
      }

      const url = new URL(requestUrl)
      const authorization = init?.headers instanceof Headers
        ? init.headers.get("authorization")
        : Array.isArray(init?.headers)
          ? init?.headers.find(([key]) => key.toLowerCase() === "authorization")?.[1]
          : init?.headers && "authorization" in init.headers
            ? String((init.headers as Record<string, unknown>).authorization)
            : null

      if (authorization !== `Bearer ${publisherToken}`) {
        return new Response(JSON.stringify({ error_code: "publisher_unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        })
      }

      if (url.pathname === "/internal/v0/create-community-attempt") {
        return new Response(JSON.stringify({
          ok: true,
          registry_attempt_id: "rga_timeout_test",
          actor_primary_wallet_snapshot: null,
          actor_governance_address_snapshot: null,
          result_ref: "publisher://attempt/rga_timeout_test",
        }), {
          headers: { "content-type": "application/json" },
        })
      }

      if (url.pathname === "/internal/v0/publish-community-create") {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 150)
          const signal = init?.signal
          if (signal) {
            signal.addEventListener("abort", () => {
              clearTimeout(timer)
              const error = new Error("aborted")
              error.name = "AbortError"
              reject(error)
            }, { once: true })
          }
        })
        return new Response(JSON.stringify({
          ok: true,
          status: "published",
          result_ref: "tableland://community/cmt_timeout_test",
          registry_published_at: new Date().toISOString(),
        }), {
          headers: { "content-type": "application/json" },
        })
      }

      return new Response("not found", { status: 404 })
    }) as typeof globalThis.fetch

    try {
      const ctx = await createRouteTestContext({
        REGISTRY_PUBLISHER_URL: publisherBaseUrl,
        REGISTRY_PUBLISHER_AUTH_TOKEN: publisherToken,
        REGISTRY_PUBLISHER_TIMEOUT_MS: "25",
      })
      cleanup = ctx.cleanup

      const session = await exchangeJwt(ctx.env, "publisher-timeout-user")
      const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken)

      const communityCreate = await requestJson("http://pirate.test/communities", {
        display_name: "Timeout Club",
        namespace: {
          namespace_verification_id: namespaceVerificationId,
        },
      }, ctx.env, session.accessToken)

      expect(communityCreate.status).toBe(202)
      const body = await json(communityCreate) as {
        community: {
          community_id: string
          provisioning_state: string
          registry_publication_state: string
          registry_publication_job_id: string | null
          registry_error_code: string | null
        }
        job: {
          job_id: string
          status: string
        }
      }

      expect(body.job.status).toBe("succeeded")
      expect(body.community.provisioning_state).toBe("active")
      expect(body.community.registry_publication_state).toBe("publication_error")
      expect(typeof body.community.registry_publication_job_id).toBe("string")
      expect(body.community.registry_error_code).toBe("registry_publisher_timeout")

      const registryJob = await app.request(
        `http://pirate.test/jobs/${body.community.registry_publication_job_id}`,
        {
          headers: {
            authorization: `Bearer ${session.accessToken}`,
          },
        },
        ctx.env,
      )

      expect(registryJob.status).toBe(200)
      const registryJobBody = await json(registryJob) as { status: string; error_code: string | null }
      expect(registryJobBody.status).toBe("failed")
      expect(registryJobBody.error_code).toBe("registry_publisher_timeout")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("community create sends the primary wallet snapshot to the publisher attempt call", async () => {
    const publisherToken = "publisher-test-token"
    const publisherBaseUrl = "http://publisher.test"
    const originalFetch = globalThis.fetch
    let createAttemptBody: Record<string, unknown> | null = null

    globalThis.fetch = (async (input, init) => {
      const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (!requestUrl.startsWith(publisherBaseUrl)) {
        return originalFetch(input as never, init)
      }

      const url = new URL(requestUrl)
      if (url.pathname === "/internal/v0/create-community-attempt") {
        createAttemptBody = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null
        return new Response(JSON.stringify({
          ok: true,
          registry_attempt_id: "rga_wallet_snapshot_test",
          actor_primary_wallet_snapshot: createAttemptBody?.actor_primary_wallet_snapshot ?? null,
          actor_governance_address_snapshot: createAttemptBody?.actor_governance_address_snapshot ?? null,
          result_ref: "publisher://attempt/rga_wallet_snapshot_test",
        }), {
          headers: { "content-type": "application/json" },
        })
      }

      if (url.pathname === "/internal/v0/publish-community-create") {
        return new Response(JSON.stringify({
          ok: true,
          status: "published",
          result_ref: "tableland://community/cmt_wallet_snapshot_test",
          registry_published_at: new Date().toISOString(),
        }), {
          headers: { "content-type": "application/json" },
        })
      }

      return new Response("not found", { status: 404 })
    }) as typeof globalThis.fetch

    try {
      const ctx = await createRouteTestContext({
        REGISTRY_PUBLISHER_URL: publisherBaseUrl,
        REGISTRY_PUBLISHER_AUTH_TOKEN: publisherToken,
      })
      cleanup = ctx.cleanup

      const session = await exchangeJwt(ctx.env, "publisher-wallet-snapshot-user")
      await setPrimaryWalletAttachment(ctx.env, session.userId, "0x1234000000000000000000000000000000005678")
      const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken)

      const communityCreate = await requestJson("http://pirate.test/communities", {
        display_name: "Wallet Snapshot Club",
        namespace: {
          namespace_verification_id: namespaceVerificationId,
        },
      }, ctx.env, session.accessToken)

      expect(communityCreate.status).toBe(202)
      expect(createAttemptBody?.["actor_primary_wallet_snapshot"]).toBe("0x1234000000000000000000000000000000005678")
      expect(createAttemptBody?.["actor_governance_address_snapshot"] ?? null).toBeNull()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("post create returns 403 until the member completes unique_human verification", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const verifiedCreator = await exchangeJwt(ctx.env, "community-verified-creator")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, verifiedCreator.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Verified Posting Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, verifiedCreator.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const unverifiedMember = await exchangeJwt(ctx.env, "community-unverified-member")
    await addCommunityMember(
      ctx.communityDbRoot,
      communityCreateBody.community.community_id,
      unverifiedMember.userId,
    )
    const deniedPost = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
      {
        post_type: "text",
        title: "Blocked post",
        body: "This should require unique_human verification.",
        idempotency_key: "post-key-unverified-member",
      },
      ctx.env,
      unverifiedMember.accessToken,
    )

    expect(deniedPost.status).toBe(403)
    const deniedBody = await json(deniedPost) as { code: string; message: string }
    expect(deniedBody.code).toBe("verification_required")
    expect(deniedBody.message).toBe("unique_human verification is required")
  })

  test("anonymous post create also requires unique_human verification", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const verifiedCreator = await exchangeJwt(ctx.env, "community-anon-verified-creator")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, verifiedCreator.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Anonymous Posting Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, verifiedCreator.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const unverifiedMember = await exchangeJwt(ctx.env, "community-anon-unverified-member")
    await addCommunityMember(
      ctx.communityDbRoot,
      communityCreateBody.community.community_id,
      unverifiedMember.userId,
    )
    const deniedPost = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
      {
        post_type: "text",
        title: "Blocked anonymous post",
        body: "Anonymous posting still needs strong human verification.",
        identity_mode: "anonymous",
        anonymous_scope: "community_stable",
        idempotency_key: "post-key-unverified-anonymous-member",
      },
      ctx.env,
      unverifiedMember.accessToken,
    )

    expect(deniedPost.status).toBe(403)
    const deniedBody = await json(deniedPost) as { code: string; message: string }
    expect(deniedBody.code).toBe("verification_required")
    expect(deniedBody.message).toBe("unique_human verification is required")
  })

  test("post create returns 404 for a verified non-member", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const verifiedCreator = await exchangeJwt(ctx.env, "community-post-owner")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, verifiedCreator.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Non Member Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, verifiedCreator.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const verifiedNonMember = await exchangeJwt(ctx.env, "community-verified-non-member")
    await completeUniqueHumanVerification(ctx.env, verifiedNonMember.accessToken)

    const deniedPost = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
      {
        post_type: "text",
        title: "Hello From Outside",
        body: "This user is verified but not a member.",
        idempotency_key: "post-key-non-member",
      },
      ctx.env,
      verifiedNonMember.accessToken,
    )

    expect(deniedPost.status).toBe(404)
    const deniedBody = await json(deniedPost) as { code: string; message: string }
    expect(deniedBody.code).toBe("not_found")
    expect(deniedBody.message).toBe("Community not found")
  })

  test("review-held post direct read is limited to the author and community owner", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "community-review-held-owner")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, owner.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Review Held Visibility Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, owner.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const author = await exchangeJwt(ctx.env, "community-review-held-author")
    await completeUniqueHumanVerification(ctx.env, author.accessToken)
    await addCommunityMember(ctx.communityDbRoot, communityCreateBody.community.community_id, author.userId)

    const reviewHeldPost = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
      {
        post_type: "text",
        title: "[review-required] Member Draft",
        body: "This post should remain hidden from other members.",
        idempotency_key: "post-key-review-held-member-author",
      },
      ctx.env,
      author.accessToken,
    )
    expect(reviewHeldPost.status).toBe(202)
    const reviewHeldBody = await json(reviewHeldPost) as {
      post_id: string
      status: string
      author_user_id: string | null
    }
    expect(reviewHeldBody.status).toBe("draft")
    expect(reviewHeldBody.author_user_id).toBe(author.userId)

    const ownerRead = await app.request(
      `http://pirate.test/posts/${reviewHeldBody.post_id}`,
      {
        headers: {
          authorization: `Bearer ${owner.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(ownerRead.status).toBe(200)
    const ownerReadBody = await json(ownerRead) as {
      post: { post_id: string; status: string }
    }
    expect(ownerReadBody.post.post_id).toBe(reviewHeldBody.post_id)
    expect(ownerReadBody.post.status).toBe("draft")

    const otherMember = await exchangeJwt(ctx.env, "community-review-held-other-member")
    await addCommunityMember(ctx.communityDbRoot, communityCreateBody.community.community_id, otherMember.userId)

    const deniedRead = await app.request(
      `http://pirate.test/posts/${reviewHeldBody.post_id}`,
      {
        headers: {
          authorization: `Bearer ${otherMember.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(deniedRead.status).toBe(404)
    const deniedBody = await json(deniedRead) as { code: string; message: string }
    expect(deniedBody.code).toBe("not_found")
    expect(deniedBody.message).toBe("Post not found")
  })

  test("anonymous post create returns 400 when anonymous_scope is missing", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-anonymous-validation")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Anonymous Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const deniedPost = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
      {
        post_type: "text",
        identity_mode: "anonymous",
        title: "Anonymous Without Scope",
        body: "Missing anonymous scope should fail validation.",
        idempotency_key: "post-key-anonymous-missing-scope",
      },
      ctx.env,
      session.accessToken,
    )

    expect(deniedPost.status).toBe(400)
    const deniedBody = await json(deniedPost) as { code: string; message: string }
    expect(deniedBody.code).toBe("bad_request")
    expect(deniedBody.message).toBe("anonymous_scope is required for anonymous posts")
  })

  test("link post create returns 400 when link_url is missing", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-link-validation")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Links Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const deniedPost = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
      {
        post_type: "link",
        title: "Broken Link Post",
        body: "Missing link_url should fail validation.",
        idempotency_key: "post-key-link-missing-url",
      },
      ctx.env,
      session.accessToken,
    )

    expect(deniedPost.status).toBe(400)
    const deniedBody = await json(deniedPost) as { code: string; message: string }
    expect(deniedBody.code).toBe("bad_request")
    expect(deniedBody.message).toBe("link_url is required for link posts")
  })

  test("community create returns 400 for missing required fields", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-invalid-create")

    const response = await requestJson("http://pirate.test/communities", {
      display_name: "",
      governance_mode: "multisig",
      namespace: {},
    }, ctx.env, session.accessToken)

    expect(response.status).toBe(400)
    const body = await json(response) as { code: string }
    expect(body.code).toBe("bad_request")
  })

  test("post create returns 400 when community_id is repeated in the body", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-post-invalid-body")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Test Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const response = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
      {
        community_id: communityCreateBody.community.community_id,
        post_type: "text",
        idempotency_key: "post-key-duplicate-community-id",
      },
      ctx.env,
      session.accessToken,
    )

    expect(response.status).toBe(400)
    const body = await json(response) as { code: string }
    expect(body.code).toBe("bad_request")
  })

  test("community join requires a platform trust credential even for open communities", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const verifiedCreator = await exchangeJwt(ctx.env, "community-join-creator")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, verifiedCreator.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Join Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
      membership_mode: "open",
    }, ctx.env, verifiedCreator.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const unverifiedUser = await exchangeJwt(ctx.env, "community-unverified-joiner")
    const deniedJoin = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/join`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${unverifiedUser.accessToken}`,
        },
      },
      ctx.env,
    )

    expect(deniedJoin.status).toBe(403)
    const deniedBody = await json(deniedJoin) as { code: string; message: string }
    expect(deniedBody.code).toBe("gate_failed")
    expect(deniedBody.message).toBe("A platform trust credential is required to join this community")

    const verifiedJoiner = await exchangeJwt(ctx.env, "community-verified-joiner")
    await completeUniqueHumanVerification(ctx.env, verifiedJoiner.accessToken)

    const allowedJoin = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/join`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${verifiedJoiner.accessToken}`,
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
      VERY_API_KEY: "very-test-key",
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
        },
      }),
      getSessionOutcome: async () => ({
        status: "verified",
        attestationData: {},
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
    await completeUniqueHumanVerification(ctx.env, selfJoiner.accessToken, "self")

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

  test("community create rejects invalid accepted_providers combinations", async () => {
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

  test("post vote requires unique_human verification", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "community-vote-creator")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, creator.accessToken)
    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Voting Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, creator.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const createdPost = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
      {
        post_type: "text",
        title: "Vote me",
        body: "A post to exercise vote gating.",
        idempotency_key: "vote-post-key-1",
      },
      ctx.env,
      creator.accessToken,
    )
    expect(createdPost.status).toBe(201)
    const postBody = await json(createdPost) as { post_id: string }

    const unverifiedMember = await exchangeJwt(ctx.env, "community-unverified-voter")
    await addCommunityMember(ctx.communityDbRoot, communityCreateBody.community.community_id, unverifiedMember.userId)

    const deniedVote = await requestJson(
      `http://pirate.test/posts/${postBody.post_id}/vote`,
      { value: 1 },
      ctx.env,
      unverifiedMember.accessToken,
    )
    expect(deniedVote.status).toBe(403)
    const deniedBody = await json(deniedVote) as { code: string; message: string }
    expect(deniedBody.code).toBe("verification_required")
    expect(deniedBody.message).toBe("unique_human verification is required")

    const verifiedMember = await exchangeJwt(ctx.env, "community-verified-voter")
    await completeUniqueHumanVerification(ctx.env, verifiedMember.accessToken)
    await addCommunityMember(ctx.communityDbRoot, communityCreateBody.community.community_id, verifiedMember.userId)

    const allowedVote = await requestJson(
      `http://pirate.test/posts/${postBody.post_id}/vote`,
      { value: 1 },
      ctx.env,
      verifiedMember.accessToken,
    )
    expect(allowedVote.status).toBe(200)
    const allowedBody = await json(allowedVote) as { post_id: string; value: number }
    expect(allowedBody.post_id).toBe(postBody.post_id)
    expect(allowedBody.value).toBe(1)

    const updatedVote = await requestJson(
      `http://pirate.test/posts/${postBody.post_id}/vote`,
      { value: -1 },
      ctx.env,
      verifiedMember.accessToken,
    )
    expect(updatedVote.status).toBe(200)
    const updatedBody = await json(updatedVote) as { post_id: string; value: number }
    expect(updatedBody.post_id).toBe(postBody.post_id)
    expect(updatedBody.value).toBe(-1)

    const listedPosts = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
      {
        headers: {
          authorization: `Bearer ${verifiedMember.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(listedPosts.status).toBe(200)
    const listedPostsBody = await json(listedPosts) as {
      items: Array<{
        post: { post_id: string }
        upvote_count: number
        downvote_count: number
        like_count: number
        viewer_vote: number | null
      }>
    }
    expect(listedPostsBody.items).toHaveLength(1)
    expect(listedPostsBody.items[0]?.post.post_id).toBe(postBody.post_id)
    expect(listedPostsBody.items[0]?.upvote_count).toBe(0)
    expect(listedPostsBody.items[0]?.downvote_count).toBe(1)
    expect(listedPostsBody.items[0]?.like_count).toBe(0)
    expect(listedPostsBody.items[0]?.viewer_vote).toBe(-1)
  })

  test("create nationality-gated community succeeds with valid config", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "nat-gate-creator")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Nationality Gated Club",
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
              config: { required_value: "AR" },
            },
          ],
        },
      ],
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string; membership_mode: string }
    }
    expect(communityCreateBody.community.membership_mode).toBe("gated")
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
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, creator.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Preview Nationality Club",
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
              config: { required_value: "AR" },
            },
          ],
        },
      ],
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
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, creator.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Eligibility Nationality Club",
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
              config: { required_value: "US" },
            },
          ],
        },
      ],
    }, ctx.env, creator.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const joiner = await exchangeJwt(ctx.env, "nat-elig-joiner-unverified")
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
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, creator.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Mismatch Nationality Club",
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
              config: { required_value: "US" },
            },
          ],
        },
      ],
    }, ctx.env, creator.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

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
        claims: { age_over_18: true, nationality: "AR" },
      }),
    } satisfies import("../src/lib/verification/self-provider").SelfProvider)
    await completeNationalityVerification(ctx.env, joiner.accessToken)
    setSelfProviderForTests(null)

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
      membership_gate_summaries: Array<{ gate_type: string }>
    }
    expect(eligibilityBody.status).toBe("gate_failed")
  })

  test("join-eligibility returns joinable on nationality match", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "nat-elig-match-creator")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, creator.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Match Nationality Club",
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
              config: { required_value: "US" },
            },
          ],
        },
      ],
    }, ctx.env, creator.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

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
        claims: { age_over_18: true, nationality: "US" },
      }),
    } satisfies import("../src/lib/verification/self-provider").SelfProvider)
    await completeNationalityVerification(ctx.env, joiner.accessToken)
    setSelfProviderForTests(null)

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
      joinable_now: boolean
    }
    expect(eligibilityBody.status).toBe("joinable")
    expect(eligibilityBody.joinable_now).toBe(true)
  })

  test("join mutation returns gate_failed with failure_reason missing_verification when nationality is missing", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "nat-join-missing-creator")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, creator.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Join Missing Nationality Club",
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
              config: { required_value: "US" },
            },
          ],
        },
      ],
    }, ctx.env, creator.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const joiner = await exchangeJwt(ctx.env, "nat-join-missing-joiner")
    await completeUniqueHumanVerification(ctx.env, joiner.accessToken)

    const deniedJoin = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/join`,
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
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, creator.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Join Mismatch Nationality Club",
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
              config: { required_value: "US" },
            },
          ],
        },
      ],
    }, ctx.env, creator.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

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
        claims: { age_over_18: true, nationality: "AR" },
      }),
    } satisfies import("../src/lib/verification/self-provider").SelfProvider)
    await completeNationalityVerification(ctx.env, joiner.accessToken)
    setSelfProviderForTests(null)

    const deniedJoin = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/join`,
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
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, creator.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Join Success Nationality Club",
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
              config: { required_value: "US" },
            },
          ],
        },
      ],
    }, ctx.env, creator.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

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
        claims: { age_over_18: true, nationality: "US" },
      }),
    } satisfies import("../src/lib/verification/self-provider").SelfProvider)
    await completeNationalityVerification(ctx.env, joiner.accessToken)
    setSelfProviderForTests(null)

    const allowedJoin = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/join`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${joiner.accessToken}` },
      },
      ctx.env,
    )
    expect(allowedJoin.status).toBe(200)
    const allowedBody = await json(allowedJoin) as { community_id: string; status: string }
    expect(allowedBody.community_id).toBe(communityCreateBody.community.community_id)
    expect(allowedBody.status).toBe("joined")
  })
})
