import type { Env } from "../../../env"
import { trimEnv } from "../../env-strings"
import { providerUnavailable } from "../../errors"
import { nowIso } from "../../helpers"
import type { Client } from "../../sql-client"
import { identifyAudioSampleWithAcrCloud } from "../../song-artifacts/song-artifact-analysis"
import {
  extractVideoAudioSampleForObject,
  requestVideoAudioSampleFromService,
  type VideoAudioSampleResult,
  type VideoAudioSampleWindow,
} from "../../song-artifacts/video-audio-sample"
import {
  computeVideoRightsOutcome,
  persistVideoRightsAnalysis,
  type VideoRightsAcrCustomMatch,
  type VideoRightsAcrEvaluation,
  type VideoRightsDeclaredReferences,
} from "../../posts/video-rights-analysis"
import { openCommunityWriteClient } from "../community-read-access"
import type { CommunityJobHandlerInput } from "./handler-types"
import { COMMUNITY_JOB_MAX_ATTEMPTS } from "./runner-types"
import type { DbExecutor } from "../../db-helpers"
import { enqueueCommunityJob } from "./store"
import { parseJobPayload } from "./payload"

type VideoMediaAnalysisJobPayload = {
  post_id: string
  storage_object_key: string
  mime_type?: string | null
  duration_ms?: number | null
}

type VideoAudioSampleExtractor = (input: {
  env: Env
  objectKey: string
  window: VideoAudioSampleWindow
}) => Promise<VideoAudioSampleResult>

const DEFAULT_EXTRACTION_TIMEOUT_MS = 180_000

function isLocalServiceHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
}

function canRunLocalFfmpeg(env: Env): boolean {
  if (trimEnv(env.SONG_PREVIEW_FFMPEG_BIN) === "__test_passthrough__") {
    return false
  }
  const runtime = (globalThis as typeof globalThis & { Bun?: { spawn?: unknown } }).Bun
  return Boolean(runtime && typeof runtime.spawn === "function")
}

function extractionServiceUrl(env: Env): string | null {
  const configured = trimEnv(env.SONG_PREVIEW_SERVICE_URL)
  if (!configured) return null
  let url: URL
  try {
    url = new URL(configured)
  } catch {
    throw providerUnavailable("Song preview service URL is invalid", { reason: "invalid_song_preview_service_url" })
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalServiceHost(url.hostname))) {
    throw providerUnavailable("Song preview service URL must use HTTPS outside localhost", {
      reason: "insecure_song_preview_service_url",
    })
  }
  return url.toString()
}

const defaultExtractor: VideoAudioSampleExtractor = async (input) => {
  if (canRunLocalFfmpeg(input.env)) {
    return extractVideoAudioSampleForObject(input)
  }
  const serviceUrl = extractionServiceUrl(input.env)
  if (!serviceUrl && !input.env.SONG_PREVIEW_SERVICE) {
    return { kind: "skipped", reason: "extraction_unavailable" }
  }
  return requestVideoAudioSampleFromService({
    env: input.env,
    serviceUrl,
    objectKey: input.objectKey,
    window: input.window,
    timeoutMs: DEFAULT_EXTRACTION_TIMEOUT_MS,
  })
}

export function chooseVideoSampleWindow(durationMs: number | null | undefined): VideoAudioSampleWindow {
  const totalMs = Number.isFinite(Number(durationMs)) && Number(durationMs) > 0
    ? Math.trunc(Number(durationMs))
    : null
  if (!totalMs) {
    // Duration unknown: skip a typical intro, take a minute.
    return { start_ms: 15_000, duration_ms: 60_000 }
  }
  const startMs = Math.min(45_000, Math.trunc(totalMs * 0.2))
  const windowMs = Math.max(1_000, Math.min(60_000, totalMs - startMs))
  return { start_ms: startMs, duration_ms: windowMs }
}

function parseAcrEvaluation(providerResult: Record<string, unknown> | null): VideoRightsAcrEvaluation {
  const error = providerResult && typeof providerResult.error === "string" ? providerResult.error : null
  const metadata = (providerResult as {
    metadata?: { music?: unknown[]; custom_files?: unknown[] }
  } | null)?.metadata
  const musicMatches = Array.isArray(metadata?.music)
    ? metadata.music.filter((item): item is Record<string, unknown> => item != null && typeof item === "object")
    : []
  const customMatches: VideoRightsAcrCustomMatch[] = (Array.isArray(metadata?.custom_files) ? metadata.custom_files : [])
    .filter((item): item is Record<string, unknown> => item != null && typeof item === "object")
    .map((item) => {
      // The bucket sync stores user_defined JSON with song_artifact_bundle_id;
      // depending on the ACR response shape those fields come back nested or
      // flattened onto the item.
      const userDefined = item.user_defined != null && typeof item.user_defined === "object"
        ? item.user_defined as Record<string, unknown>
        : item
      const bundleId = typeof userDefined.song_artifact_bundle_id === "string" && userDefined.song_artifact_bundle_id.trim()
        ? userDefined.song_artifact_bundle_id.trim()
        : null
      return { song_artifact_bundle_id: bundleId, raw: item }
    })
  return {
    providerError: error === "missing_configuration" ? null : error,
    missingConfiguration: error === "missing_configuration",
    musicMatches,
    customMatches,
    providerResult,
  }
}

async function resolveDeclaredReferences(input: {
  client: Client
  upstreamAssetRefsJson: string | null
}): Promise<VideoRightsDeclaredReferences> {
  const refs = (() => {
    if (!input.upstreamAssetRefsJson) return [] as string[]
    try {
      const parsed = JSON.parse(input.upstreamAssetRefsJson)
      return Array.isArray(parsed) ? parsed.filter((ref): ref is string => typeof ref === "string" && Boolean(ref.trim())) : []
    } catch {
      return [] as string[]
    }
  })()

  const localAssetIds: string[] = []
  const unresolvedRefs: string[] = []
  for (const ref of refs) {
    const trimmed = ref.trim()
    if (trimmed.startsWith("story:asset:")) {
      localAssetIds.push(trimmed.slice("story:asset:".length))
    } else if (trimmed.startsWith("ast_")) {
      localAssetIds.push(trimmed)
    } else {
      unresolvedRefs.push(trimmed)
    }
  }

  if (!localAssetIds.length) {
    return { declaredBundleIds: [], declaredAssetIds: [], unresolvedRefs }
  }

  const placeholders = localAssetIds.map((_ref, index) => `?${index + 1}`).join(", ")
  const result = await input.client.execute({
    sql: `SELECT asset_id, song_artifact_bundle_id FROM assets WHERE asset_id IN (${placeholders})`,
    args: localAssetIds,
  })
  const declaredAssetIds: string[] = []
  const declaredBundleIds: string[] = []
  const foundAssetIds = new Set<string>()
  for (const row of result.rows) {
    const assetId = typeof row.asset_id === "string" ? row.asset_id : null
    if (!assetId) continue
    foundAssetIds.add(assetId)
    declaredAssetIds.push(assetId)
    const bundleId = typeof row.song_artifact_bundle_id === "string" && row.song_artifact_bundle_id.trim()
      ? row.song_artifact_bundle_id.trim()
      : null
    if (bundleId) {
      declaredBundleIds.push(bundleId)
    }
  }
  for (const assetId of localAssetIds) {
    if (!foundAssetIds.has(assetId)) {
      unresolvedRefs.push(assetId)
    }
  }
  return { declaredBundleIds, declaredAssetIds, unresolvedRefs }
}

export async function runVideoMediaAnalysis(input: CommunityJobHandlerInput): Promise<string | null> {
  const payload = parseJobPayload<VideoMediaAnalysisJobPayload>(input.job.payload_json)
  const postId = payload?.post_id?.trim()
  const storageObjectKey = payload?.storage_object_key?.trim()
  if (!postId || !storageObjectKey) {
    return null
  }

  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.job.community_id)
  try {
    const existing = await db.client.execute({
      sql: `SELECT media_analysis_result_id FROM media_analysis_results WHERE source_post_id = ?1 LIMIT 1`,
      args: [postId],
    })
    const existingId = existing.rows[0]?.media_analysis_result_id
    if (typeof existingId === "string" && existingId) {
      return existingId
    }

    const postResult = await db.client.execute({
      sql: `SELECT post_id, asset_id, upstream_asset_refs_json, status FROM posts WHERE post_id = ?1 LIMIT 1`,
      args: [postId],
    })
    const postRow = postResult.rows[0]
    if (!postRow) {
      return null
    }
    const postStatus = typeof postRow.status === "string" ? postRow.status : ""
    if (postStatus === "deleted" || postStatus === "removed") {
      return null
    }
    const assetId = typeof postRow.asset_id === "string" && postRow.asset_id ? postRow.asset_id : null

    const declared = await resolveDeclaredReferences({
      client: db.client,
      upstreamAssetRefsJson: typeof postRow.upstream_asset_refs_json === "string"
        ? postRow.upstream_asset_refs_json
        : null,
    })

    const window = chooseVideoSampleWindow(payload?.duration_ms)
    const extractor = defaultExtractor
    const sample = await extractor({ env: input.env, objectKey: storageObjectKey, window })

    let acr: VideoRightsAcrEvaluation = {
      providerError: null,
      missingConfiguration: false,
      musicMatches: [],
      customMatches: [],
      providerResult: null,
    }
    let analysisSkippedReason: string | null = null
    let audioTrackPresent = true
    if (sample.kind === "no_audio_track") {
      audioTrackPresent = false
    } else if (sample.kind === "skipped") {
      analysisSkippedReason = sample.reason
    } else {
      const identify = identifyAudioSampleWithAcrCloud
      acr = parseAcrEvaluation(await identify({
        env: input.env,
        sampleBytes: sample.bytes,
        filename: `${postId}-soundtrack-sample.wav`,
        mimeType: sample.mimeType,
        logContext: { post: postId, community: input.job.community_id },
      }))
      if (acr.providerError && input.job.attempt_count < COMMUNITY_JOB_MAX_ATTEMPTS) {
        // Transient provider failure: let the job runner retry; only the
        // terminal attempt persists a review_required outcome.
        throw providerUnavailable(`ACRCloud identification failed: ${acr.providerError}`)
      }
    }

    const decision = computeVideoRightsOutcome({
      declared,
      acr,
      audioTrackPresent,
      analysisSkippedReason,
    })
    const persisted = await persistVideoRightsAnalysis({
      client: db.client,
      communityId: input.job.community_id,
      postId,
      assetId,
      decision,
      acr,
      declared,
      sampleWindow: sample.kind === "sample" ? window : null,
    })
    console.log("[video-media-analysis] outcome recorded", {
      community_id: input.job.community_id,
      post_id: postId,
      outcome: decision.outcome,
      policy_reason_code: decision.policyReasonCode,
      media_analysis_result_id: persisted.mediaAnalysisResultId,
      rights_review_case_id: persisted.rightsReviewCaseId,
    })
    return persisted.mediaAnalysisResultId
  } finally {
    db.close()
  }
}

// Enqueue-only: soundtrack analysis is not latency-critical, so the scheduled
// job runner picks it up instead of a request-time kick. Gated on an env flag
// until the 1120 rights_review_cases rollout reaches every shard.
export async function enqueueVideoMediaAnalysisIfEnabled(input: {
  env: Env
  client: DbExecutor
  communityId: string
  postId: string
  storageObjectKey: string | null | undefined
  mimeType?: string | null
  durationMs?: number | null
  createdAt?: string
}): Promise<void> {
  if (trimEnv(input.env.VIDEO_MEDIA_ANALYSIS_ENABLED) !== "1") {
    return
  }
  const storageObjectKey = input.storageObjectKey?.trim()
  if (!storageObjectKey) {
    return
  }
  const payload: VideoMediaAnalysisJobPayload = {
    post_id: input.postId,
    storage_object_key: storageObjectKey,
    mime_type: input.mimeType ?? null,
    duration_ms: input.durationMs ?? null,
  }
  await enqueueCommunityJob({
    client: input.client,
    communityId: input.communityId,
    jobType: "video_media_analysis",
    subjectType: "post",
    subjectId: input.postId,
    payloadJson: JSON.stringify(payload),
    createdAt: input.createdAt ?? nowIso(),
  })
}
