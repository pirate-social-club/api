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

async function seedRunningCommunityJob(input: {
  communityDbRoot: string
  communityId: string
  jobId: string
}): Promise<void> {
  const communityClient = createClient({
    url: buildLocalCommunityDbUrl(input.communityDbRoot, input.communityId),
  })
  try {
    await communityClient.execute({
      sql: `
        INSERT INTO community_jobs (
          job_id, community_id, job_type, subject_type, subject_id, status, payload_json,
          result_ref, error_code, attempt_count, available_at, last_checkpoint, last_checkpoint_at,
          attempt_started_at, attempt_deadline_at, created_at, updated_at
        ) VALUES (
          ?1, ?2, 'locked_asset_delivery_prepare', 'asset', 'ast_debug_recycle', 'running', ?3,
          NULL, NULL, 2, NULL, 'story_publish_waiting', '2026-07-08T12:00:00.000Z',
          '2026-07-08T11:59:00.000Z', '2026-07-08T12:30:00.000Z',
          '2026-07-08T11:58:00.000Z', '2026-07-08T12:00:00.000Z'
        )
      `,
      args: [
        input.jobId,
        input.communityId,
        JSON.stringify({ asset_id: "ast_debug_recycle" }),
      ],
    })
  } finally {
    communityClient.close()
  }
}

async function seedAmbiguousStoryEffect(input: {
  communityDbRoot: string
  communityId: string
  assetId: string
  operationId: string
  providerTxRef?: string | null
}): Promise<void> {
  const client = createClient({ url: buildLocalCommunityDbUrl(input.communityDbRoot, input.communityId) })
  try {
    await client.execute({
      sql: `
        INSERT INTO story_registration_effects (
          story_registration_effect_id, community_id, asset_id, effect_key, operation_id,
          registration_kind, chain_id, signer_address, creator_wallet_address,
          primary_content_hash, call_data_hash, status, provider_tx_ref, error_code,
          created_at, updated_at
        ) VALUES (
          'sre_debug', ?1, ?2, ?3, ?4,
          'original', 1315, '0x9999999999999999999999999999999999999999',
          '0x1111111111111111111111111111111111111111', ?5, ?6,
          'reconciliation_required', ?7, 'story_registration_outcome_unknown', ?8, ?8
        )
      `,
      args: [
        input.communityId,
        input.assetId,
        `story_registration:${input.communityId}:${input.assetId}`,
        input.operationId,
        `0x${"22".repeat(32)}`,
        `0x${"44".repeat(32)}`,
        input.providerTxRef ?? null,
        "2026-07-15T10:00:00.000Z",
      ],
    })
  } finally {
    client.close()
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

  test("POST /admin/debug/community-job/recycle requires admin token", async () => {
    const ctx = await createRouteTestContext({ PIRATE_ADMIN_TOKEN: ADMIN_TOKEN })
    cleanup = ctx.cleanup

    const response = await app.request(
      "http://pirate.test/admin/debug/community-job/recycle",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ community_id: "com_cmt_test", job_id: "job_cjb_test" }),
      },
      ctx.env,
    )
    expect(response.status).toBe(401)
  })

  test("POST /admin/debug/staging-d1/reclaim requires admin auth", async () => {
    const ctx = await createRouteTestContext({ ENVIRONMENT: "staging", PIRATE_ADMIN_TOKEN: ADMIN_TOKEN })
    cleanup = ctx.cleanup
    const response = await app.request(
      "http://pirate.test/admin/debug/staging-d1/reclaim",
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      ctx.env,
    )
    expect(response.status).toBe(401)
  })

  test("POST /admin/debug/staging-d1/reclaim is absent outside staging", async () => {
    const ctx = await createRouteTestContext({ ENVIRONMENT: "production", PIRATE_ADMIN_TOKEN: ADMIN_TOKEN })
    cleanup = ctx.cleanup
    const response = await app.request(
      "http://pirate.test/admin/debug/staging-d1/reclaim",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-admin-token": ADMIN_TOKEN },
        body: JSON.stringify({ community_ids: ["cmt_smoke"] }),
      },
      ctx.env,
    )
    expect(response.status).toBe(404)
  })

  test("POST /admin/debug/community-job/recycle queues a running community job", async () => {
    const ctx = await createRouteTestContext({ PIRATE_ADMIN_TOKEN: ADMIN_TOKEN })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "debug-recycle-author")
    const community = await createCommunity(ctx.env, session.accessToken)
    await seedRunningCommunityJob({
      communityDbRoot: ctx.communityDbRoot,
      communityId: community.communityId,
      jobId: "cjb_debug_recycle",
    })

    const response = await app.request(
      "http://pirate.test/admin/debug/community-job/recycle",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-admin-token": ADMIN_TOKEN,
        },
        body: JSON.stringify({
          community_id: `com_${community.communityId}`,
          job_id: "job_cjb_debug_recycle",
          reason: "operator smoke retry",
        }),
      },
      ctx.env,
    )
    expect(response.status).toBe(200)
    const body = await json(response) as {
      ok: boolean
      recycled: boolean
      community_id: string
      job_id: string
      before: {
        status: string
        attempt_count: number
        last_checkpoint: string | null
        attempt_deadline_at: string | null
      }
      after: {
        status: string
        error_code: string | null
        attempt_count: number
        last_checkpoint: string | null
        last_checkpoint_at: string | null
        attempt_started_at: string | null
        attempt_deadline_at: string | null
      }
    }

    expect(body.ok).toBe(true)
    expect(body.recycled).toBe(true)
    expect(body.community_id).toBe(community.communityId)
    expect(body.job_id).toBe("cjb_debug_recycle")
    expect(body.before).toMatchObject({
      status: "running",
      attempt_count: 2,
      last_checkpoint: "story_publish_waiting",
      attempt_deadline_at: "2026-07-08T12:30:00.000Z",
    })
    expect(body.after.status).toBe("queued")
    expect(body.after.error_code).toBe("operator_recycled:operator smoke retry")
    expect(body.after.attempt_count).toBe(0)
    expect(body.after.last_checkpoint).toBeNull()
    expect(body.after.last_checkpoint_at).toBeNull()
    expect(body.after.attempt_started_at).toBeNull()
    expect(body.after.attempt_deadline_at).toBeNull()

    const communityClient = createClient({
      url: buildLocalCommunityDbUrl(ctx.communityDbRoot, community.communityId),
    })
    try {
      const stored = await communityClient.execute({
        sql: `
          SELECT status, error_code, attempt_count, last_checkpoint, attempt_deadline_at
          FROM community_jobs
          WHERE job_id = 'cjb_debug_recycle'
        `,
      })
      expect(stored.rows[0]).toMatchObject({
        status: "queued",
        error_code: "operator_recycled:operator smoke retry",
        attempt_count: 0,
        last_checkpoint: null,
        attempt_deadline_at: null,
      })
    } finally {
      communityClient.close()
    }
  })

  test("admin can inspect and attest a no-broadcast Story incident without shard SQL", async () => {
    const ctx = await createRouteTestContext({ PIRATE_ADMIN_TOKEN: ADMIN_TOKEN })
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "debug-story-effect-author")
    const community = await createCommunity(ctx.env, session.accessToken)
    await seedAmbiguousStoryEffect({
      communityDbRoot: ctx.communityDbRoot,
      communityId: community.communityId,
      assetId: "ast_debug_story",
      operationId: "sro_debug_story",
    })

    const inspect = await app.request(
      `http://pirate.test/admin/debug/story-registration-effect?community_id=com_${community.communityId}&asset_id=asset_ast_debug_story`,
      { headers: { "x-admin-token": ADMIN_TOKEN } },
      ctx.env,
    )
    expect(inspect.status).toBe(200)
    expect(await json(inspect)).toMatchObject({
      community_id: community.communityId,
      asset_id: "ast_debug_story",
      effect: {
        operation_id: "sro_debug_story",
        status: "reconciliation_required",
        provider_tx_ref: null,
      },
    })

    const resolve = await app.request(
      "http://pirate.test/admin/debug/story-registration-effect/confirm-no-broadcast",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-admin-token": ADMIN_TOKEN },
        body: JSON.stringify({
          community_id: `com_${community.communityId}`,
          asset_id: "asset_ast_debug_story",
          operation_id: "sro_debug_story",
          reason: "checked signer history and provider traces",
        }),
      },
      ctx.env,
    )
    expect(resolve.status).toBe(200)
    expect(await json(resolve)).toMatchObject({
      ok: true,
      effect: {
        status: "failed_prebroadcast",
        error_code: "ops_confirmed_no_broadcast:checked signer history and provider traces",
      },
    })

    const audits = await ctx.client.execute({
      sql: `
        SELECT action, metadata_json
        FROM audit_log
        WHERE target_type = 'asset' AND target_id = 'ast_debug_story'
        ORDER BY created_at, audit_event_id
      `,
    })
    expect(audits.rows.map((row) => ({
      action: row.action,
      metadata: JSON.parse(String(row.metadata_json)),
    })).sort((left, right) => String(left.action).localeCompare(String(right.action)))).toEqual([
      {
        action: "story.registration_effect.resolution_applied",
        metadata: expect.objectContaining({
          operation_id: "sro_debug_story",
          resolution: "failed_prebroadcast",
        }),
      },
      {
        action: "story.registration_effect.resolution_requested",
        metadata: expect.objectContaining({
          operation_id: "sro_debug_story",
          requested_resolution: "failed_prebroadcast",
        }),
      },
    ])
  })

  test("no-broadcast action rejects effects that already have a transaction reference", async () => {
    const ctx = await createRouteTestContext({ PIRATE_ADMIN_TOKEN: ADMIN_TOKEN })
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "debug-story-effect-tx-author")
    const community = await createCommunity(ctx.env, session.accessToken)
    await seedAmbiguousStoryEffect({
      communityDbRoot: ctx.communityDbRoot,
      communityId: community.communityId,
      assetId: "ast_debug_story_tx",
      operationId: "sro_debug_story_tx",
      providerTxRef: `0x${"66".repeat(32)}`,
    })

    const response = await app.request(
      "http://pirate.test/admin/debug/story-registration-effect/confirm-no-broadcast",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-admin-token": ADMIN_TOKEN },
        body: JSON.stringify({
          community_id: `com_${community.communityId}`,
          asset_id: "asset_ast_debug_story_tx",
          operation_id: "sro_debug_story_tx",
          reason: "transaction reference exists and must be reconciled",
        }),
      },
      ctx.env,
    )
    expect(response.status).toBe(409)
  })
})
