import type { Env } from "../../../env"
import { trimEnv } from "../../env-strings"
import { providerUnavailable } from "../../errors"
import { nowIso } from "../../helpers"
import type { Client } from "../../sql-client"
import { evaluateLyricsModeration, identifyAudioSampleWithAcrCloud } from "../../song-artifacts/song-artifact-analysis"
import {
  extractVideoAudioSampleForObject,
  requestVideoAudioSampleFromService,
  type VideoAudioSampleResult,
  type VideoAudioSampleWindow,
} from "../../song-artifacts/video-audio-sample"
import {
  computeVideoRightsOutcome,
  persistVideoRightsAnalysis,
  type VideoAudioSafetyEvaluation,
  type VideoRightsAcrCustomMatch,
  type VideoRightsAcrEvaluation,
  type VideoRightsDeclaredReferences,
} from "../../posts/video-rights-analysis"
import {
  createModerationCase,
  createModerationSignal,
  getOpenModerationCaseForTarget,
} from "../../moderation/community-moderation-store"
import { openCommunityWriteClient } from "../community-read-access"
import type { CommunityJobHandlerInput } from "./handler-types"
import { COMMUNITY_JOB_MAX_ATTEMPTS } from "./runner-types"
import type { DbExecutor } from "../../db-helpers"
import { enqueueCommunityJob } from "./store"
import { parseJobPayload } from "./payload"
import type { Post } from "../../../types"

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

type AudioSampleTranscriber = (input: {
  env: Env
  sampleBytes: ArrayBuffer | Uint8Array
  filename: string
  mimeType: string
  communityId: string
  postId: string
}) => Promise<VideoAudioTranscriptResult>

type VideoAudioTranscriptResult =
  | {
    kind: "completed"
    text: string
    providerResult: Record<string, unknown> | null
  }
  | {
    kind: "skipped"
    reason: string
  }
  | {
    kind: "failed"
    error: string
    providerResult?: Record<string, unknown> | null
  }

const DEFAULT_EXTRACTION_TIMEOUT_MS = 180_000
const DEFAULT_ELEVENLABS_TIMEOUT_MS = 120_000
const DEFAULT_ELEVENLABS_STT_MODEL = "scribe_v2"
const ELEVENLABS_STT_URL = "https://api.elevenlabs.io/v1/speech-to-text"

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

export function parseAcrEvaluation(providerResult: Record<string, unknown> | null): VideoRightsAcrEvaluation {
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
      // Entries tagged content_type "video_audio" are platform video audio
      // (repost-identity signal); everything else, including untagged legacy
      // catalog enrollments, is treated as a platform song.
      const matchSource: VideoRightsAcrCustomMatch["matchSource"] = userDefined.content_type === "video_audio"
        ? "platform_video_audio"
        : "platform_song"
      return { song_artifact_bundle_id: bundleId, matchSource, raw: item }
    })
  return {
    providerError: error === "missing_configuration" ? null : error,
    missingConfiguration: error === "missing_configuration",
    musicMatches,
    customMatches,
    providerResult,
  }
}

function providerTimeoutMs(value: string | undefined, fallbackMs: number): number {
  const parsed = Number.parseInt(trimEnv(value) || "", 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs
}

function parseElevenLabsTranscriptionBody(body: unknown): {
  text: string
  providerResult: Record<string, unknown>
} | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return null
  }
  const record = body as Record<string, unknown>
  const text = typeof record.text === "string" ? record.text.trim() : ""
  return text ? { text, providerResult: record } : null
}

const defaultTranscriber: AudioSampleTranscriber = async (input) => {
  const apiKey = trimEnv(input.env.ELEVENLABS_API_KEY)
  if (!apiKey) {
    return { kind: "skipped", reason: "missing_elevenlabs_configuration" }
  }

  const sampleBytes = input.sampleBytes instanceof Uint8Array
    ? input.sampleBytes.slice().buffer
    : input.sampleBytes
  if (sampleBytes.byteLength <= 0) {
    return { kind: "skipped", reason: "empty_audio_sample" }
  }

  const model = trimEnv(input.env.ELEVENLABS_STT_MODEL) || DEFAULT_ELEVENLABS_STT_MODEL
  const form = new FormData()
  form.set("file", new File([sampleBytes], input.filename, { type: input.mimeType }))
  form.set("model_id", model)

  const timeoutMs = providerTimeoutMs(input.env.ELEVENLABS_TIMEOUT_MS, DEFAULT_ELEVENLABS_TIMEOUT_MS)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(ELEVENLABS_STT_URL, {
      method: "POST",
      headers: { "xi-api-key": apiKey },
      body: form,
      signal: controller.signal,
    })
    if (!response.ok) {
      return { kind: "failed", error: `http_${response.status}` }
    }
    const parsed = parseElevenLabsTranscriptionBody(await response.json().catch(() => null))
    if (!parsed) {
      return { kind: "failed", error: "invalid_response" }
    }
    return {
      kind: "completed",
      text: parsed.text,
      providerResult: {
        provider: "elevenlabs",
        model,
        provider_result: parsed.providerResult,
      },
    }
  } catch (error) {
    return {
      kind: "failed",
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    clearTimeout(timer)
  }
}

async function evaluateVideoAudioSafety(input: {
  env: Env
  sample: Extract<VideoAudioSampleResult, { kind: "sample" }>
  communityId: string
  postId: string
}): Promise<VideoAudioSafetyEvaluation> {
  const transcriber = defaultTranscriber
  const transcript = await transcriber({
    env: input.env,
    sampleBytes: input.sample.bytes,
    filename: `${input.postId}-soundtrack-sample.wav`,
    mimeType: input.sample.mimeType,
    communityId: input.communityId,
    postId: input.postId,
  })
  if (transcript.kind === "skipped") {
    return {
      contentSafetyState: "pending",
      ageGatePolicy: "none",
      transcript: null,
      transcriptProviderResult: null,
      moderationStatus: "skipped",
      moderationError: transcript.reason,
      moderationResult: {
        provider: "video_audio_safety",
        skipped: true,
        skip_reason: transcript.reason,
      },
    }
  }
  if (transcript.kind === "failed") {
    return {
      contentSafetyState: "pending",
      ageGatePolicy: "none",
      transcript: null,
      transcriptProviderResult: transcript.providerResult ?? null,
      moderationStatus: "failed",
      moderationError: transcript.error,
      moderationResult: {
        provider: "video_audio_safety",
        transcript: transcript.providerResult ?? null,
        error: transcript.error,
      },
    }
  }
  const lyricsModeration = await evaluateLyricsModeration({
    env: input.env,
    lyrics: transcript.text,
  })
  return {
    contentSafetyState: lyricsModeration.contentSafetyState,
    ageGatePolicy: lyricsModeration.ageGatePolicy,
    transcript: transcript.text,
    transcriptProviderResult: transcript.providerResult,
    moderationStatus: lyricsModeration.moderationStatus,
    moderationError: lyricsModeration.moderationError,
    moderationResult: {
      provider: "video_audio_safety",
      transcript: transcript.providerResult,
      transcript_text_length: transcript.text.length,
      text_age_gate: lyricsModeration.moderationResult,
    },
  }
}

function contentSafetyRank(value: Post["content_safety_state"]): number {
  switch (value) {
    case "adult":
      return 3
    case "sensitive":
      return 2
    case "safe":
      return 1
    case "pending":
    default:
      return 0
  }
}

export function mergeVideoAudioSafetyWithPost(input: {
  postContentSafetyState: Post["content_safety_state"]
  postAgeGatePolicy: Post["age_gate_policy"]
  audioSafety: VideoAudioSafetyEvaluation | null
}): Pick<Post, "content_safety_state" | "age_gate_policy"> | null {
  const audioSafety = input.audioSafety
  if (!audioSafety || audioSafety.moderationStatus === "skipped" || audioSafety.moderationStatus === "failed") {
    return null
  }
  const nextContentSafetyState = contentSafetyRank(audioSafety.contentSafetyState) > contentSafetyRank(input.postContentSafetyState)
    ? audioSafety.contentSafetyState
    : input.postContentSafetyState
  const nextAgeGatePolicy = input.postAgeGatePolicy === "18_plus" || audioSafety.ageGatePolicy === "18_plus"
    ? "18_plus"
    : "none"
  if (
    nextContentSafetyState === input.postContentSafetyState
    && nextAgeGatePolicy === input.postAgeGatePolicy
  ) {
    return null
  }
  return {
    content_safety_state: nextContentSafetyState,
    age_gate_policy: nextAgeGatePolicy,
  }
}

async function applyVideoAudioSafetyToPost(input: {
  client: Client
  communityId: string
  postId: string
  currentContentSafetyState: Post["content_safety_state"]
  currentAgeGatePolicy: Post["age_gate_policy"]
  audioSafety: VideoAudioSafetyEvaluation | null
  mediaAnalysisResultId: string
  now: string
}): Promise<void> {
  const merged = mergeVideoAudioSafetyWithPost({
    postContentSafetyState: input.currentContentSafetyState,
    postAgeGatePolicy: input.currentAgeGatePolicy,
    audioSafety: input.audioSafety,
  })
  if (!merged) {
    return
  }
  await input.client.execute({
    sql: `
      UPDATE posts
      SET content_safety_state = ?2,
          age_gate_policy = ?3,
          updated_at = ?4
      WHERE post_id = ?1
    `,
    args: [input.postId, merged.content_safety_state, merged.age_gate_policy, input.now],
  })
  if (input.currentAgeGatePolicy !== "18_plus" && merged.age_gate_policy === "18_plus") {
    const existingCase = await getOpenModerationCaseForTarget({
      executor: input.client,
      communityId: input.communityId,
      target: { postId: input.postId },
    })
    const moderationCase = existingCase ?? await createModerationCase({
      executor: input.client,
      communityId: input.communityId,
      target: { postId: input.postId },
      priority: "medium",
      openedBy: "platform_analysis",
      now: input.now,
    })
    await createModerationSignal({
      executor: input.client,
      communityId: input.communityId,
      postId: input.postId,
      moderationCaseId: moderationCase.moderation_case_id,
      signalType: "audio_transcript_age_gate",
      severity: "medium",
      provider: "video_audio_safety",
      providerLabel: "audio_transcript_age_gate",
      analysisResultRef: input.mediaAnalysisResultId,
      evidenceRef: input.audioSafety ? JSON.stringify(input.audioSafety.moderationResult) : null,
      now: input.now,
    })
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
      sql: `
        SELECT post_id, asset_id, upstream_asset_refs_json, status, content_safety_state, age_gate_policy
        FROM posts
        WHERE post_id = ?1
        LIMIT 1
      `,
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
    const currentContentSafetyState = (
      postRow.content_safety_state === "safe"
      || postRow.content_safety_state === "sensitive"
      || postRow.content_safety_state === "adult"
      || postRow.content_safety_state === "pending"
    )
      ? postRow.content_safety_state as Post["content_safety_state"]
      : "pending"
    const currentAgeGatePolicy = postRow.age_gate_policy === "18_plus" ? "18_plus" : "none"

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
    let audioSafety: VideoAudioSafetyEvaluation | null = null
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
      audioSafety = await evaluateVideoAudioSafety({
        env: input.env,
        sample,
        communityId: input.job.community_id,
        postId,
      })
    }

    const decision = computeVideoRightsOutcome({
      declared,
      acr,
      audioTrackPresent,
      analysisSkippedReason,
      blockCommercialMusicMatches: trimEnv(input.env.VIDEO_MEDIA_ANALYSIS_BLOCK_COMMERCIAL_MATCHES) === "1",
    })
    const persisted = await persistVideoRightsAnalysis({
      client: db.client,
      communityId: input.job.community_id,
      postId,
      assetId,
      decision,
      acr,
      declared,
      audioSafety,
      sampleWindow: sample.kind === "sample" ? window : null,
    })
    await applyVideoAudioSafetyToPost({
      client: db.client,
      communityId: input.job.community_id,
      postId,
      currentContentSafetyState,
      currentAgeGatePolicy,
      audioSafety,
      mediaAnalysisResultId: persisted.mediaAnalysisResultId,
      now: nowIso(),
    })
    console.log("[video-media-analysis] outcome recorded", {
      community_id: input.job.community_id,
      post_id: postId,
      outcome: decision.outcome,
      audio_content_safety_state: audioSafety?.contentSafetyState ?? null,
      audio_age_gate_policy: audioSafety?.ageGatePolicy ?? null,
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
