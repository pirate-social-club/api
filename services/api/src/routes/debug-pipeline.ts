import { Hono } from "hono"
import { authenticateAdminTokenOnly, type AuthenticatedEnv } from "../lib/auth-middleware"
import { getCommunityRepository } from "../lib/communities/db-community-repository"
import { openCommunityDb } from "../lib/communities/community-db-factory"
import { getControlPlaneClient } from "../lib/runtime-deps"
import { getPostById } from "../lib/posts/community-post-query-store"
import { getLinkEnrichmentByNormalizedUrl, listLinkEnrichmentUsages } from "../lib/posts/link-enrichment/repository"
import { normalizeLinkUrl } from "../lib/posts/link-enrichment/url-normalization"
import { decodePublicPostId } from "../lib/public-ids"

const debugPipeline = new Hono<AuthenticatedEnv>()

debugPipeline.get("/post-pipeline", async (c) => {
  const admin = authenticateAdminTokenOnly({
    env: c.env,
    token: c.req.header("x-admin-token"),
  })
  if (!admin) {
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
  const db = await openCommunityDb(c.env, communityRepository, communityId)
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

export default debugPipeline
