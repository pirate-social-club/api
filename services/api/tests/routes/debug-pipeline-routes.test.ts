import { afterEach, describe, expect, test } from "bun:test"
import { createClient } from "@libsql/client"
import { app } from "../../src/index"
import { buildLocalCommunityDbUrl } from "../../src/lib/communities/community-local-db"
import type { Env } from "../../src/types"
import { createRouteTestContext, json, mintUpstreamJwt } from "../helpers"

const ADMIN_TOKEN = "test-admin-token-abc123"

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
  const body = await json(response) as { access_token: string; user: { id: string } }
  return { accessToken: body.access_token, userId: body.user.id.replace(/^usr_/, "") }
}

async function createCommunity(env: Env, accessToken: string): Promise<{ communityId: string }> {
  const response = await requestJson("http://pirate.test/communities", {
    display_name: "Debug Pipeline Club",
    membership_mode: "request",
  }, env, accessToken)
  expect(response.status).toBe(202)
  const body = await json(response) as { community: { id: string } }
  return { communityId: body.community.id.replace(/^com_/, "") }
}

async function createLinkPost(input: {
  env: Env
  accessToken: string
  communityId: string
}): Promise<{ publicPostId: string; rawPostId: string; linkUrl: string }> {
  const linkUrl = "https://example.com/story?token=secret-debug-token"
  const response = await requestJson(
    `http://pirate.test/communities/${input.communityId}/posts`,
    {
      post_type: "link",
      title: "Debuggable link",
      link_url: linkUrl,
      translation_policy: "machine_allowed",
      idempotency_key: "debug-pipeline-link-post",
    },
    input.env,
    input.accessToken,
  )
  expect(response.status).toBe(201)
  const body = await json(response) as { id: string }
  return {
    publicPostId: body.id,
    rawPostId: body.id.replace(/^post_/, ""),
    linkUrl,
  }
}

async function seedPipelineState(input: {
  communityDbRoot: string
  controlPlaneClient: ReturnType<typeof createClient>
  communityId: string
  postId: string
  normalizedUrl: string
}): Promise<void> {
  const now = new Date().toISOString()
  await input.controlPlaneClient.execute({
    sql: `
      INSERT INTO link_enrichments (
        link_enrichment_id, normalized_url, canonical_url, provider, status,
        title, description, publisher, published_at, image_url,
        markdown, summary_json, translations_json, summary_status, summary_model,
        error, fetched_at, summarized_at, created_at, updated_at
      ) VALUES (
        'len_debug_pipeline', ?1, ?1, 'firecrawl', 'ready',
        'Debug article', 'Description', 'Example', NULL, NULL,
        '# Debug article', '{"short_summary":"ok"}', NULL, 'ready', 'test-model',
        NULL, ?2, ?2, ?2, ?2
      )
    `,
    args: [input.normalizedUrl, now],
  })
  await input.controlPlaneClient.execute({
    sql: `
      INSERT INTO link_enrichment_usages (
        normalized_url, community_id, post_id, link_enrichment_id,
        snapshot_synced_at, created_at, updated_at
      ) VALUES (
        ?1, ?2, ?3, 'len_debug_pipeline',
        ?4, ?4, ?4
      )
    `,
    args: [input.normalizedUrl, input.communityId, input.postId, now],
  })

  const communityClient = createClient({
    url: buildLocalCommunityDbUrl(input.communityDbRoot, input.communityId),
  })
  try {
    await communityClient.execute({
      sql: `
        INSERT INTO community_jobs (
          job_id, community_id, job_type, subject_type, subject_id, status, payload_json,
          result_ref, error_code, attempt_count, available_at, created_at, updated_at
        ) VALUES (
          'job_debug_translation', ?1, 'post_translation_materialize', 'post_translation', ?2, 'failed', ?3,
          NULL, 'OPENROUTER_API_KEY is not configured', 3, NULL, ?4, ?4
        )
      `,
      args: [
        input.communityId,
        `${input.postId}:es`,
        JSON.stringify({ post_id: input.postId, locale: "es" }),
        now,
      ],
    })
  } finally {
    communityClient.close()
  }
}

afterEach(async () => {
  await cleanup?.()
  cleanup = null
})

describe("debug pipeline routes", () => {
  test("GET /admin/debug/post-pipeline requires the admin token", async () => {
    const ctx = await createRouteTestContext({ PIRATE_ADMIN_TOKEN: ADMIN_TOKEN })
    cleanup = ctx.cleanup

    const response = await app.request(
      "http://pirate.test/admin/debug/post-pipeline?post_id=post_pst_missing",
      {},
      ctx.env,
    )
    expect(response.status).toBe(401)

    const wrongToken = await app.request(
      "http://pirate.test/admin/debug/post-pipeline?post_id=post_pst_missing",
      { headers: { "x-admin-token": "wrong-token" } },
      ctx.env,
    )
    expect(wrongToken.status).toBe(401)
  })

  test("GET /admin/debug/post-pipeline returns post, enrichment, config, and jobs", async () => {
    const ctx = await createRouteTestContext({
      PIRATE_ADMIN_TOKEN: ADMIN_TOKEN,
      FIRECRAWL_API_KEY: "test-firecrawl-key",
      OPENROUTER_API_KEY: "test-openrouter-key",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "debug-pipeline-author")
    const community = await createCommunity(ctx.env, session.accessToken)
    const post = await createLinkPost({
      env: ctx.env,
      accessToken: session.accessToken,
      communityId: community.communityId,
    })
    const normalizedUrl = "https://example.com/story?token=secret-debug-token"
    await seedPipelineState({
      communityDbRoot: ctx.communityDbRoot,
      controlPlaneClient: ctx.client,
      communityId: community.communityId,
      postId: post.rawPostId,
      normalizedUrl,
    })

    const response = await app.request(
      `http://pirate.test/admin/debug/post-pipeline?post_id=${post.publicPostId}`,
      { headers: { "x-admin-token": ADMIN_TOKEN } },
      ctx.env,
    )
    expect(response.status).toBe(200)
    const body = await json(response) as {
      post: {
        post_id: string
        post_type: string
        translation_policy: string | null
        link_url: string | null
      }
      pipeline_config: {
        has_control_plane_database_url: boolean
        has_firecrawl_api_key: boolean
        has_openrouter_api_key: boolean
      }
      link_enrichment: {
        normalized_url: string
        record: {
          provider: string
          status: string
          has_markdown: boolean
          summary_status: string | null
          has_summary: boolean
        } | null
        usages: Array<{ community_id: string; post_id: string }>
      }
      jobs: Array<{ job_type: string; status: string; error_code: string | null; attempt_count: number }>
    }

    expect(body.post.post_id).toBe(post.rawPostId)
    expect(body.post.post_type).toBe("link")
    expect(body.post.translation_policy).toBe("machine_allowed")
    expect(body.post.link_url).toBe(post.linkUrl)
    expect(body.pipeline_config).toEqual({
      has_control_plane_database_url: true,
      has_firecrawl_api_key: true,
      has_openrouter_api_key: true,
    })
    expect(body.link_enrichment.normalized_url).toBe(normalizedUrl)
    expect(body.link_enrichment.record).toMatchObject({
      provider: "firecrawl",
      status: "ready",
      has_markdown: true,
      summary_status: "ready",
      has_summary: true,
    })
    expect(body.link_enrichment.usages.some((usage) => (
      usage.community_id === community.communityId
        && usage.post_id === post.rawPostId
    ))).toBe(true)
    expect(body.jobs.some((job) => (
      job.job_type === "post_translation_materialize"
        && job.status === "failed"
        && job.error_code === "OPENROUTER_API_KEY is not configured"
        && job.attempt_count === 3
    ))).toBe(true)
  })
})
