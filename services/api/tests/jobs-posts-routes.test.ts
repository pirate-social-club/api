import { afterEach, describe, expect, test } from "bun:test"
import { createClient } from "@libsql/client"
import app from "../src/index"
import { buildLocalCommunityDbUrl } from "../src/lib/communities/community-local-db"
import { computePostSourceHash } from "../src/lib/localization/content-source-hash"
import { getPostById } from "../src/lib/posts/community-post-store"
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
    }
    job: {
      job_id: string
    }
  }

  return {
    communityId: body.community.community_id,
    createJobId: body.job.job_id,
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

async function insertThreadSnapshot(input: {
  communityDbRoot: string
  communityId: string
  postId: string
  commentCount: number
  swarmManifestRef: string
  swarmFeedRef?: string | null
}): Promise<void> {
  const client = createClient({
    url: buildLocalCommunityDbUrl(input.communityDbRoot, input.communityId),
  })

  try {
    const now = new Date().toISOString()
    await client.execute({
      sql: `
        INSERT INTO thread_snapshots (
          thread_snapshot_id, community_id, thread_root_post_id, snapshot_seq,
          published_through_comment_created_at, comment_count, swarm_manifest_ref,
          swarm_feed_ref, created_at
        ) VALUES (
          ?1, ?2, ?3, 1,
          ?4, ?5, ?6,
          ?7, ?4
        )
      `,
      args: [
        `tsn_${input.postId}`,
        input.communityId,
        input.postId,
        now,
        input.commentCount,
        input.swarmManifestRef,
        input.swarmFeedRef ?? null,
      ],
    })
  } finally {
    client.close()
  }
}

async function insertPostTranslation(input: {
  communityDbRoot: string
  communityId: string
  postId: string
  locale: string
  translatedTitle?: string | null
  translatedBody: string
  translatedCaption?: string | null
}): Promise<void> {
  const client = createClient({
    url: buildLocalCommunityDbUrl(input.communityDbRoot, input.communityId),
  })

  try {
    const post = await getPostById(client, input.postId)
    if (!post) {
      throw new Error(`missing post ${input.postId}`)
    }
    const sourceHash = await computePostSourceHash(post)
    const now = new Date().toISOString()
    await client.execute({
      sql: `
        INSERT INTO content_translations (
          content_translation_id, content_type, content_id, locale, source_hash,
          source_language, outcome, translated_title, translated_body, translated_caption, provider,
          provider_model, provider_result_json, created_at, updated_at
        ) VALUES (
          ?1, 'post', ?2, ?3, ?4,
          ?5, 'translated', ?6, ?7, ?8, 'openrouter',
          'google/gemini-2.5-flash-lite-preview-09-2025', NULL, ?9, ?9
        )
      `,
      args: [
        `ctr_${input.postId}_${input.locale}`,
        input.postId,
        input.locale,
        sourceHash,
        post.source_language ?? "en",
        input.translatedTitle ?? null,
        input.translatedBody,
        input.translatedCaption ?? null,
        now,
      ],
    })
  } finally {
    client.close()
  }
}

async function fetchCommunityJobsByType(input: {
  communityDbRoot: string
  communityId: string
  jobType: string
}): Promise<Array<{ subject_id: string; payload_json: string | null; status: string }>> {
  const client = createClient({
    url: buildLocalCommunityDbUrl(input.communityDbRoot, input.communityId),
  })

  try {
    const result = await client.execute({
      sql: `
        SELECT subject_id, payload_json, status
        FROM community_jobs
        WHERE job_type = ?1
        ORDER BY created_at ASC, job_id ASC
      `,
      args: [input.jobType],
    })
    return result.rows.map((row) => ({
      subject_id: String(row.subject_id),
      payload_json: row.payload_json == null ? null : String(row.payload_json),
      status: String(row.status),
    }))
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
  test("GET /jobs/:jobId returns the community creation job", async () => {
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
        translation_policy: "machine_allowed",
        idempotency_key: "posts-routes-create-1",
      },
      ctx.env,
      session.accessToken,
    )
    expect(createdPost.status).toBe(201)
    const createdPostBody = await json(createdPost) as { post_id: string; title: string | null }
    expect(createdPostBody.title).toBe("Focused route coverage")

    await insertThreadSnapshot({
      communityDbRoot: ctx.communityDbRoot,
      communityId: community.communityId,
      postId: createdPostBody.post_id,
      commentCount: 3,
      swarmManifestRef: "swarm-manifest:post-thread",
      swarmFeedRef: "swarm-feed:post-thread",
    })
    await insertPostTranslation({
      communityDbRoot: ctx.communityDbRoot,
      communityId: community.communityId,
      postId: createdPostBody.post_id,
      locale: "es",
      translatedTitle: "Cobertura enfocada de rutas",
      translatedBody: "Prueba dedicada de la ruta de publicaciones.",
    })

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
      thread_snapshot: {
        thread_root_post_id: string
        comment_count: number
        swarm_manifest_ref: string
        swarm_feed_ref: string | null
      } | null
      resolved_locale: string
      translation_state: string
      machine_translated: boolean
      translated_title: string | null
      translated_body: string | null
    }
    expect(fetchedPostBody.post.post_id).toBe(createdPostBody.post_id)
    expect(fetchedPostBody.post.title).toBe("Focused route coverage")
    expect(fetchedPostBody.thread_snapshot?.thread_root_post_id).toBe(createdPostBody.post_id)
    expect(fetchedPostBody.thread_snapshot?.comment_count).toBe(3)
    expect(fetchedPostBody.thread_snapshot?.swarm_manifest_ref).toBe("swarm-manifest:post-thread")
    expect(fetchedPostBody.thread_snapshot?.swarm_feed_ref).toBe("swarm-feed:post-thread")
    expect(fetchedPostBody.resolved_locale).toBe("es")
    expect(fetchedPostBody.translation_state).toBe("ready")
    expect(fetchedPostBody.machine_translated).toBe(true)
    expect(fetchedPostBody.translated_title).toBe("Cobertura enfocada de rutas")
    expect(fetchedPostBody.translated_body).toBe("Prueba dedicada de la ruta de publicaciones.")
  })

  test("GET /posts/:postId enqueues a lazy translation job for a non-tier locale cache miss", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "posts-routes-lazy-translation")
    const community = await createCommunity(ctx.env, session.accessToken, "Posts Lazy Translation Club")

    const createdPost = await requestJson(
      `http://pirate.test/communities/${community.communityId}/posts`,
      {
        post_type: "text",
        title: "Lazy locale coverage",
        body: "This should queue a translation job.",
        translation_policy: "machine_allowed",
        idempotency_key: "posts-routes-lazy-translation-1",
      },
      ctx.env,
      session.accessToken,
    )
    expect(createdPost.status).toBe(201)
    const createdPostBody = await json(createdPost) as { post_id: string }

    const fetchedPost = await app.request(
      `http://pirate.test/posts/${createdPostBody.post_id}?locale=nl`,
      {
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(fetchedPost.status).toBe(200)
    const fetchedPostBody = await json(fetchedPost) as {
      resolved_locale: string
      translation_state: string
    }
    expect(fetchedPostBody.resolved_locale).toBe("nl")
    expect(fetchedPostBody.translation_state).toBe("pending")

    const translationJobs = await fetchCommunityJobsByType({
      communityDbRoot: ctx.communityDbRoot,
      communityId: community.communityId,
      jobType: "post_translation_materialize",
    })
    expect(translationJobs.some((job) => job.subject_id === `${createdPostBody.post_id}:nl`)).toBe(true)
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
