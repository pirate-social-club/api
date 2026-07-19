import { Hono, type Context } from "hono"

import type { Env } from "../env"
import { trimEnv } from "../lib/env-strings"
import { authenticateOperatorCredential, requireOperatorScope, STORY_SETTLEMENT_REPAIR_SCOPE } from "../lib/operator-credential-auth"
import { badRequestError, providerUnavailable } from "../lib/errors"
import { decodePublicCommunityId } from "../lib/public-ids"
import { getCommunityRepository } from "../lib/communities/db-community-repository"
import { openCommunityWriteClient } from "../lib/communities/community-read-access"
import { getControlPlaneClient } from "../lib/runtime-deps"

type OpsEnv = { Bindings: Env }
const route = new Hono<OpsEnv>()
const MAX_BATCH_SIZE = 10

function record(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value !== "string") return null
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function duration(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

function durationServiceUrl(env: Env): string {
  const configured = trimEnv(env.SONG_PREVIEW_SERVICE_URL)
  if (!configured) return "https://song-preview-service.internal/duration"
  const url = new URL(configured)
  url.pathname = "/duration"
  url.search = ""
  return url.toString()
}

async function probeDuration(input: { env: Env; communityId: string; bundleId: string }): Promise<number | null> {
  const secret = trimEnv(input.env.SONG_PREVIEW_SHARED_SECRET)
  if (!secret) throw providerUnavailable("Song preview shared secret is missing")
  const request = new Request(durationServiceUrl(input.env), {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify({ community_id: input.communityId, song_artifact_bundle: input.bundleId }),
  })
  const response = input.env.SONG_PREVIEW_SERVICE
    ? await input.env.SONG_PREVIEW_SERVICE.fetch(request)
    : await fetch(request)
  if (!response.ok) return null
  const body = await response.json() as { duration_ms?: unknown }
  return duration(body.duration_ms)
}

async function operator(c: Context<OpsEnv>) {
  const actor = await authenticateOperatorCredential({ env: c.env, authorization: c.req.header("authorization") })
  requireOperatorScope(actor, STORY_SETTLEMENT_REPAIR_SCOPE)
  return actor
}

route.post("/batches", async (c) => {
  const actor = await operator(c)
  const body = await c.req.json<Record<string, unknown>>().catch(() => { throw badRequestError("invalid_json_body") })
  const publicCommunityId = text(body.community_id)
  if (!publicCommunityId) throw badRequestError("community_id_required")
  const communityId = decodePublicCommunityId(publicCommunityId)
  const cursor = text(body.cursor)
  const requestedLimit = body.limit == null ? MAX_BATCH_SIZE : Number(body.limit)
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > MAX_BATCH_SIZE) {
    throw badRequestError(`limit_must_be_between_1_and_${MAX_BATCH_SIZE}`)
  }
  const execute = body.execute === true
  const repository = getCommunityRepository(c.env)
  const db = await openCommunityWriteClient(c.env, repository, communityId)
  const control = getControlPlaneClient(c.env)
  try {
    const candidates = await db.client.execute({
      sql: `
        SELECT post_id, song_artifact_bundle_id
        FROM posts
        WHERE post_type = 'song'
          AND song_duration_ms IS NULL
          AND song_artifact_bundle_id IS NOT NULL
          AND song_artifact_bundle_id <> ''
          AND (?1 IS NULL OR post_id > ?1)
        ORDER BY post_id ASC
        LIMIT ?2
      `,
      args: [cursor, requestedLimit],
    })
    let probed = 0
    let updatedBundles = 0
    let updatedPosts = 0
    let failures = 0
    let nextCursor: string | null = cursor

    for (const candidate of candidates.rows) {
      const postId = text(candidate.post_id)
      const bundleId = text(candidate.song_artifact_bundle_id)
      if (!postId || !bundleId) continue
      nextCursor = postId
      try {
        const row = (await control.execute({
          sql: `SELECT primary_audio_json FROM song_artifact_bundles WHERE community_id = ?1 AND song_artifact_bundle_id = ?2 LIMIT 1`,
          args: [communityId, bundleId],
        })).rows[0]
        const primaryAudio = record(row?.primary_audio_json)
        if (!primaryAudio) {
          failures += 1
          continue
        }
        let durationMs = duration(primaryAudio.duration_ms)
        if (durationMs === null) {
          durationMs = await probeDuration({ env: c.env, communityId, bundleId })
          probed += 1
        }
        if (durationMs === null) {
          failures += 1
          continue
        }
        if (execute && duration(primaryAudio.duration_ms) === null) {
          const oldJson = typeof row?.primary_audio_json === "string" ? row.primary_audio_json : JSON.stringify(primaryAudio)
          const result = await control.execute({
            sql: `
              UPDATE song_artifact_bundles
              SET primary_audio_json = ?3, updated_at = CURRENT_TIMESTAMP
              WHERE community_id = ?1 AND song_artifact_bundle_id = ?2 AND primary_audio_json = ?4
            `,
            args: [communityId, bundleId, JSON.stringify({ ...primaryAudio, duration_ms: durationMs }), oldJson],
          })
          if ((result.rowsAffected ?? 0) > 0) updatedBundles += 1
        }
        if (execute) {
          const result = await db.client.execute({
            sql: `UPDATE posts SET song_duration_ms = ?2, updated_at = CURRENT_TIMESTAMP WHERE post_id = ?1 AND song_duration_ms IS NULL`,
            args: [postId, durationMs],
          })
          if ((result.rowsAffected ?? 0) > 0) updatedPosts += 1
        }
      } catch (error) {
        failures += 1
        console.warn("[song-duration-backfill] candidate failed", { communityId, postId, bundleId, error: error instanceof Error ? error.message : String(error) })
      }
    }

    console.info("[song-duration-backfill] batch completed", {
      operatorCredentialId: actor.operatorCredentialId,
      operatorActorId: actor.operatorActorId,
      communityId,
      execute,
      candidates: candidates.rows.length,
      probed,
      updatedBundles,
      updatedPosts,
      failures,
      nextCursor,
    })
    return c.json({
      community_id: publicCommunityId,
      execute,
      candidates: candidates.rows.length,
      probed,
      updated_bundles: updatedBundles,
      updated_posts: updatedPosts,
      failures,
      next_cursor: nextCursor,
      has_more: candidates.rows.length === requestedLimit,
    })
  } finally {
    await db.close()
    await repository.close?.()
  }
})

export default route
