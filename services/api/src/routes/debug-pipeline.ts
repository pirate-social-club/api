import { Hono, type Context } from "hono"
import { authenticateAdminTokenOnly, type AuthenticatedEnv } from "../lib/auth-middleware"
import { getCommunityRepository } from "../lib/communities/db-community-repository"
import { openCommunityReadClient, openCommunityWriteClient } from "../lib/communities/community-read-access"
import { recycleCommunityJobForRetry } from "../lib/communities/jobs/store"
import { getControlPlaneClient } from "../lib/runtime-deps"
import { getPostById } from "../lib/posts/community-post-query-store"
import {
  getStoryRegistrationEffect,
  type StoryRegistrationEffect,
} from "../lib/story/story-registration-effect-store"
import {
  parseStoryRegistrationResolutionResult,
  StoryRegistrationResolutionError,
  verifyStoryRegistrationReceipt,
  verifyStoryRegistrationRevertedReceipt,
} from "../lib/story/story-registration-effect-resolution"
import {
  operatorAttestStoryRegistrationNotBroadcast,
  operatorConfirmStoryRegistration,
  operatorConfirmStoryRegistrationReverted,
} from "../lib/story/story-registration-effect-ops"
import { getLinkEnrichmentByNormalizedUrl, listLinkEnrichmentUsages } from "../lib/posts/link-enrichment/repository"
import { normalizeLinkUrl } from "../lib/posts/link-enrichment/url-normalization"
import { decodePublicAssetId, decodePublicCommunityId, decodePublicJobId, decodePublicPostId } from "../lib/public-ids"

const debugPipeline = new Hono<AuthenticatedEnv>()

function requireDebugAdmin(c: Context<AuthenticatedEnv>) {
  const admin = authenticateAdminTokenOnly({
    env: c.env,
    token: c.req.header("x-admin-token"),
  })
  if (!admin) {
    return null
  }
  return admin
}

debugPipeline.get("/post-pipeline", async (c) => {
  if (!requireDebugAdmin(c)) {
    return c.json({ error: "unauthorized" }, 401)
  }

  const rawPostId = c.req.query("post_id")
  if (!rawPostId) {
    return c.json({ error: "post_id query parameter is required" }, 400)
  }

  const postId = rawPostId.startsWith("pst_") ? rawPostId : decodePublicPostId(rawPostId)
  if (!postId) {
    return c.json({ error: "invalid post_id" }, 400)
  }

  const communityRepository = getCommunityRepository(c.env)
  const projection = await communityRepository.getCommunityPostProjectionByPostId(postId)
  if (!projection) {
    return c.json({ error: "post_not_found", post_id: postId }, 404)
  }

  const communityId = projection.community_id
  const db = await openCommunityReadClient(c.env, communityRepository, communityId)
  try {
    const post = await getPostById(db.client, postId)
    if (!post) {
      return c.json({ error: "post_not_in_community_db", post_id: postId, community_id: communityId }, 404)
    }

    const jobs = await db.client.execute({
      sql: `
        SELECT job_id, job_type, subject_type, subject_id, status, payload_json, result_ref,
               error_code, attempt_count, available_at, created_at, updated_at
        FROM community_jobs
        WHERE subject_id LIKE ?1
           OR payload_json LIKE ?2
        ORDER BY created_at DESC
        LIMIT 50
      `,
      args: [`%${postId}%`, `%${postId}%`],
    })

    const linkUrl = post.post_type === "link" && post.link_url?.trim() ? post.link_url.trim() : null
    const normalizedUrl = linkUrl ? normalizeLinkUrl(linkUrl) : null

    let linkEnrichment = null
    let linkUsages: Array<{ normalized_url: string; community_id: string; post_id: string; snapshot_synced_at: string | null }> = []
    if (normalizedUrl && c.env.CONTROL_PLANE_DATABASE_URL) {
      const controlPlaneClient = getControlPlaneClient(c.env)
      try {
        const record = await getLinkEnrichmentByNormalizedUrl(controlPlaneClient, normalizedUrl)
        if (record) {
          linkEnrichment = {
            normalized_url: record.normalized_url,
            provider: record.provider,
            status: record.status,
            title: record.title,
            source_language: record.source_language,
            has_markdown: Boolean(record.markdown?.trim()),
            summary_status: record.summary_status,
            has_summary: Boolean(record.summary_json),
            error: record.error,
            fetched_at: record.fetched_at,
            summarized_at: record.summarized_at,
          }
        }

        const usages = await listLinkEnrichmentUsages({
          client: controlPlaneClient,
          normalizedUrl,
        })
        linkUsages = usages.map((u) => ({
          normalized_url: u.normalized_url,
          community_id: u.community_id,
          post_id: u.post_id,
          snapshot_synced_at: u.snapshot_synced_at,
        }))
      } finally {
        controlPlaneClient.close?.()
      }
    }

    return c.json({
      debug_schema_version: 2,
      post: {
        post_id: post.post_id,
        community_id: post.community_id,
        post_type: post.post_type,
        title: post.title ? `${String(post.title).slice(0, 100)}...` : null,
        source_language: post.source_language,
        translation_policy: post.translation_policy,
        link_url: post.link_url,
        link_og_title: post.link_og_title,
        has_link_og_image: Boolean(post.link_og_image_url),
        has_link_enrichment_snapshot: Boolean(post.link_enrichment_snapshot_json),
        link_enrichment_synced_at: post.link_enrichment_synced_at,
        status: post.status,
        created_at: post.created_at,
      },
      pipeline_config: {
        has_control_plane_database_url: Boolean(c.env.CONTROL_PLANE_DATABASE_URL),
        has_firecrawl_api_key: Boolean(c.env.FIRECRAWL_API_KEY?.trim()),
        has_openrouter_api_key: Boolean(c.env.OPENROUTER_API_KEY?.trim()),
      },
      link_enrichment: normalizedUrl
        ? {
            normalized_url: normalizedUrl,
            record: linkEnrichment,
            usages: linkUsages,
            control_plane_checked: Boolean(c.env.CONTROL_PLANE_DATABASE_URL),
          }
        : null,
      jobs: jobs.rows.map((row) => ({
        job_id: row.job_id,
        job_type: row.job_type,
        subject_type: row.subject_type,
        subject_id: row.subject_id,
        status: row.status,
        result_ref: row.result_ref ?? null,
        error_code: row.error_code ?? null,
        attempt_count: row.attempt_count,
        available_at: row.available_at ?? null,
        created_at: row.created_at,
        updated_at: row.updated_at,
      })),
    })
  } finally {
    db.close()
  }
})

debugPipeline.post("/community-job/recycle", async (c) => {
  if (!requireDebugAdmin(c)) {
    return c.json({ error: "unauthorized" }, 401)
  }

  let body: {
    community_id?: unknown
    job_id?: unknown
    reason?: unknown
  }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: "invalid_json" }, 400)
  }

  const rawCommunityId = typeof body.community_id === "string" ? body.community_id.trim() : ""
  const rawJobId = typeof body.job_id === "string" ? body.job_id.trim() : ""
  if (!rawCommunityId || !rawJobId) {
    return c.json({ error: "community_id and job_id are required" }, 400)
  }

  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 120) : null
  const communityId = decodePublicCommunityId(rawCommunityId)
  const jobId = decodePublicJobId(rawJobId)
  const communityRepository = getCommunityRepository(c.env)
  const db = await openCommunityWriteClient(c.env, communityRepository, communityId)
  try {
    const result = await recycleCommunityJobForRetry({
      client: db.client,
      communityId,
      jobId,
      now: new Date().toISOString(),
      reason,
    })
    if (!result) {
      return c.json({ error: "job_not_found", community_id: communityId, job_id: jobId }, 404)
    }

    return c.json({
      ok: true,
      recycled: result.before.status !== result.after.status && result.after.status === "queued",
      community_id: communityId,
      job_id: jobId,
      before: {
        status: result.before.status,
        error_code: result.before.error_code,
        attempt_count: result.before.attempt_count,
        last_checkpoint: result.before.last_checkpoint,
        last_checkpoint_at: result.before.last_checkpoint_at,
        attempt_started_at: result.before.attempt_started_at,
        attempt_deadline_at: result.before.attempt_deadline_at,
        available_at: result.before.available_at,
        updated_at: result.before.updated_at,
      },
      after: {
        status: result.after.status,
        error_code: result.after.error_code,
        attempt_count: result.after.attempt_count,
        last_checkpoint: result.after.last_checkpoint,
        last_checkpoint_at: result.after.last_checkpoint_at,
        attempt_started_at: result.after.attempt_started_at,
        attempt_deadline_at: result.after.attempt_deadline_at,
        available_at: result.after.available_at,
        updated_at: result.after.updated_at,
      },
    }, 200)
  } finally {
    db.close()
  }
})

function storyEffectResponse(effect: StoryRegistrationEffect) {
  return {
    operation_id: effect.operationId,
    registration_kind: effect.registrationKind,
    chain_id: effect.chainId,
    signer_address: effect.signerAddress,
    creator_wallet_address: effect.creatorWalletAddress,
    primary_content_hash: effect.primaryContentHash,
    call_data_hash: effect.callDataHash,
    status: effect.status,
    provider_tx_ref: effect.providerTxRef,
    error_code: effect.errorCode,
    attempt_count: effect.attemptCount,
  }
}

function storyEffectResolutionFields(body: Record<string, unknown>, requireProviderTxRef: boolean) {
  const fields = {
    rawCommunityId: typeof body.community_id === "string" ? body.community_id.trim() : "",
    rawAssetId: typeof body.asset_id === "string" ? body.asset_id.trim() : "",
    operationId: typeof body.operation_id === "string" ? body.operation_id.trim() : "",
    providerTxRef: typeof body.provider_tx_ref === "string" ? body.provider_tx_ref.trim() : "",
    reason: typeof body.reason === "string" ? body.reason.trim() : "",
  }
  return fields.rawCommunityId
      && fields.rawAssetId
      && fields.operationId
      && fields.reason.length >= 10
      && (!requireProviderTxRef || fields.providerTxRef)
    ? fields
    : null
}

debugPipeline.get("/story-registration-effect", async (c) => {
  if (!requireDebugAdmin(c)) return c.json({ error: "unauthorized" }, 401)
  const rawCommunityId = c.req.query("community_id")?.trim() ?? ""
  const rawAssetId = c.req.query("asset_id")?.trim() ?? ""
  if (!rawCommunityId || !rawAssetId) {
    return c.json({ error: "community_id and asset_id are required" }, 400)
  }

  const communityId = decodePublicCommunityId(rawCommunityId)
  const assetId = decodePublicAssetId(rawAssetId)
  const repository = getCommunityRepository(c.env)
  const db = await openCommunityReadClient(c.env, repository, communityId)
  try {
    const effect = await getStoryRegistrationEffect({ client: db.client, communityId, assetId })
    if (!effect) return c.json({ error: "story_registration_effect_not_found" }, 404)
    return c.json({
      community_id: communityId,
      asset_id: assetId,
      effect: storyEffectResponse(effect),
    })
  } finally {
    db.close()
  }
})

debugPipeline.post("/story-registration-effect/confirm-no-broadcast", async (c) => {
  const admin = requireDebugAdmin(c)
  if (!admin) return c.json({ error: "unauthorized" }, 401)
  let body: Record<string, unknown>
  try {
    body = await c.req.json<Record<string, unknown>>()
  } catch {
    return c.json({ error: "invalid_json" }, 400)
  }
  const fields = storyEffectResolutionFields(body, false)
  if (!fields) {
    return c.json({ error: "community_id, asset_id, operation_id, and a detailed reason are required" }, 400)
  }

  const communityId = decodePublicCommunityId(fields.rawCommunityId)
  const assetId = decodePublicAssetId(fields.rawAssetId)
  const repository = getCommunityRepository(c.env)
  const db = await openCommunityWriteClient(c.env, repository, communityId)
  try {
    try {
      const effect = await operatorAttestStoryRegistrationNotBroadcast({
        env: c.env,
        client: db.client,
        communityId,
        assetId,
        expectedOperationId: fields.operationId,
        actorId: admin.adminActorId,
        reason: fields.reason,
        now: new Date().toISOString(),
      })
      return c.json({
        ok: true,
        community_id: communityId,
        asset_id: assetId,
        effect: storyEffectResponse(effect),
        next_action: "recycle the owning finalize job; the next reservation may now retry",
      })
    } catch (error) {
      if (error instanceof Error && error.message === "story_registration_resolution_conflict") {
        return c.json({
          error: "story_registration_resolution_conflict",
          message: "effect changed, is not awaiting reconciliation, or already has a transaction reference",
        }, 409)
      }
      throw error
    }
  } finally {
    db.close()
  }
})

debugPipeline.post("/story-registration-effect/confirm-receipt", async (c) => {
  const admin = requireDebugAdmin(c)
  if (!admin) return c.json({ error: "unauthorized" }, 401)
  let body: Record<string, unknown>
  try {
    body = await c.req.json<Record<string, unknown>>()
  } catch {
    return c.json({ error: "invalid_json" }, 400)
  }
  const fields = storyEffectResolutionFields(body, true)
  if (!fields) {
    return c.json({
      error: "community_id, asset_id, operation_id, provider_tx_ref, and a detailed reason are required",
    }, 400)
  }

  const communityId = decodePublicCommunityId(fields.rawCommunityId)
  const assetId = decodePublicAssetId(fields.rawAssetId)
  const repository = getCommunityRepository(c.env)
  const db = await openCommunityWriteClient(c.env, repository, communityId)
  try {
    const effect = await getStoryRegistrationEffect({ client: db.client, communityId, assetId })
    if (!effect) return c.json({ error: "story_registration_effect_not_found" }, 404)
    if (effect.operationId !== fields.operationId || effect.status !== "reconciliation_required") {
      return c.json({ error: "story_registration_resolution_conflict" }, 409)
    }
    try {
      const result = parseStoryRegistrationResolutionResult(body.result, effect.registrationKind)
      const evidence = await verifyStoryRegistrationReceipt({
        env: c.env,
        effect,
        providerTxRef: fields.providerTxRef,
        result,
      })
      const confirmed = await operatorConfirmStoryRegistration({
        env: c.env,
        client: db.client,
        communityId,
        assetId,
        expectedOperationId: fields.operationId,
        actorId: admin.adminActorId,
        reason: fields.reason,
        now: new Date().toISOString(),
        result,
        evidence,
      })
      return c.json({
        ok: true,
        community_id: communityId,
        asset_id: assetId,
        effect: storyEffectResponse(confirmed),
        receipt_evidence: evidence,
        next_action: "recycle the owning finalize job; it will replay the confirmed result",
      })
    } catch (error) {
      if (error instanceof StoryRegistrationResolutionError) {
        return c.json({ error: error.code, message: error.message }, error.httpStatus)
      }
      if (error instanceof Error && error.message === "story_registration_resolution_conflict") {
        return c.json({ error: "story_registration_resolution_conflict" }, 409)
      }
      throw error
    }
  } finally {
    db.close()
  }
})

debugPipeline.post("/story-registration-effect/confirm-reverted", async (c) => {
  const admin = requireDebugAdmin(c)
  if (!admin) return c.json({ error: "unauthorized" }, 401)
  let body: Record<string, unknown>
  try {
    body = await c.req.json<Record<string, unknown>>()
  } catch {
    return c.json({ error: "invalid_json" }, 400)
  }
  const fields = storyEffectResolutionFields(body, true)
  if (!fields) {
    return c.json({
      error: "community_id, asset_id, operation_id, provider_tx_ref, and a detailed reason are required",
    }, 400)
  }

  const communityId = decodePublicCommunityId(fields.rawCommunityId)
  const assetId = decodePublicAssetId(fields.rawAssetId)
  const repository = getCommunityRepository(c.env)
  const db = await openCommunityWriteClient(c.env, repository, communityId)
  try {
    const effect = await getStoryRegistrationEffect({ client: db.client, communityId, assetId })
    if (!effect) return c.json({ error: "story_registration_effect_not_found" }, 404)
    if (effect.operationId !== fields.operationId || effect.status !== "reconciliation_required") {
      return c.json({ error: "story_registration_resolution_conflict" }, 409)
    }
    try {
      const evidence = await verifyStoryRegistrationRevertedReceipt({
        env: c.env,
        effect,
        providerTxRef: fields.providerTxRef,
      })
      const retryable = await operatorConfirmStoryRegistrationReverted({
        env: c.env,
        client: db.client,
        communityId,
        assetId,
        expectedOperationId: fields.operationId,
        actorId: admin.adminActorId,
        reason: fields.reason,
        now: new Date().toISOString(),
        evidence,
      })
      return c.json({
        ok: true,
        community_id: communityId,
        asset_id: assetId,
        effect: storyEffectResponse(retryable),
        receipt_evidence: evidence,
        next_action: "recycle the owning finalize job; the reverted transaction is safe to retry",
      })
    } catch (error) {
      if (error instanceof StoryRegistrationResolutionError) {
        return c.json({ error: error.code, message: error.message }, error.httpStatus)
      }
      if (error instanceof Error && error.message === "story_registration_resolution_conflict") {
        return c.json({ error: "story_registration_resolution_conflict" }, 409)
      }
      throw error
    }
  } finally {
    db.close()
  }
})

export default debugPipeline
