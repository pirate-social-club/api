import type { Env } from "../../env"
import { trimEnv } from "../env-strings"
import type { Post, SongArtifactUpload } from "../../types"
import { fetchSongArtifactBytes } from "./song-artifact-storage"

type LyricsModerationOutcome = {
  analysisState: Post["analysis_state"]
  contentSafetyState: Post["content_safety_state"]
  ageGatePolicy: Post["age_gate_policy"]
  moderationStatus: "completed" | "failed"
  moderationError: string | null
  moderationResult: Record<string, unknown>
}

type AudioIdentificationOutcome = {
  analysisState: Post["analysis_state"]
  moderationStatus: "completed" | "failed"
  moderationError: string | null
  moderationResult: Record<string, unknown>
}

type AlignmentOutcome = {
  alignmentStatus: "completed" | "failed"
  alignmentError: string | null
  timedLyrics: Record<string, unknown> | null
}

const SONG_ANALYSIS_SLOW_STEP_MS = 10_000
const SONG_ANALYSIS_STALLED_STEP_MS = 45_000
const DEFAULT_OPENROUTER_TIMEOUT_MS = 20_000
const DEFAULT_ACRCLOUD_TIMEOUT_MS = 30_000
const DEFAULT_ELEVENLABS_TIMEOUT_MS = 120_000

export type SongBundleAnalysisResult = {
  analysisState: Post["analysis_state"]
  contentSafetyState: Post["content_safety_state"]
  ageGatePolicy: Post["age_gate_policy"]
  moderationStatus: "completed" | "failed"
  moderationError: string | null
  moderationResult: Record<string, unknown> | null
  alignmentStatus: "completed" | "failed"
  alignmentError: string | null
  timedLyrics: Record<string, unknown> | null
}

function providerTimeoutMs(value: string | undefined, fallbackMs: number): number {
  const parsed = Number.parseInt(trimEnv(value) || "", 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function withSongAnalysisStep<T>(
  step: string,
  fields: Record<string, unknown>,
  operation: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now()
  console.info("[song-artifacts] analysis step started", { ...fields, step })
  const slowTimer = setTimeout(() => {
    console.warn("[song-artifacts] analysis step still pending", {
      ...fields,
      elapsed_ms: Date.now() - startedAt,
      step,
    })
  }, SONG_ANALYSIS_SLOW_STEP_MS)
  const stalledTimer = setTimeout(() => {
    console.warn("[song-artifacts] analysis step appears stalled", {
      ...fields,
      elapsed_ms: Date.now() - startedAt,
      step,
    })
  }, SONG_ANALYSIS_STALLED_STEP_MS)

  try {
    const result = await operation()
    console.info("[song-artifacts] analysis step completed", {
      ...fields,
      elapsed_ms: Date.now() - startedAt,
      step,
    })
    return result
  } catch (error) {
    console.error("[song-artifacts] analysis step failed", {
      ...fields,
      elapsed_ms: Date.now() - startedAt,
      message: errorMessage(error),
      step,
    })
    throw error
  } finally {
    clearTimeout(slowTimer)
    clearTimeout(stalledTimer)
  }
}

function resolveProviderLyricsOutcome(result: Record<string, unknown>): {
  analysisState: Post["analysis_state"]
  contentSafetyState: Post["content_safety_state"]
  ageGatePolicy: Post["age_gate_policy"]
} {
  const rating = typeof result.age_gate_rating === "string"
    ? result.age_gate_rating
    : null

  if (rating === "adult") {
    return {
      analysisState: "allow",
      contentSafetyState: "adult",
      ageGatePolicy: "18_plus",
    }
  }

  if (rating === "sensitive") {
    return {
      analysisState: "allow",
      contentSafetyState: "sensitive",
      ageGatePolicy: "none",
    }
  }

  if (rating !== "safe") {
    return {
      analysisState: "review_required",
      contentSafetyState: "pending",
      ageGatePolicy: "none",
    }
  }

  return {
    analysisState: "allow",
    contentSafetyState: "safe",
    ageGatePolicy: "none",
  }
}

async function classifyLyricsAgeGate(input: {
  env: Env
  lyrics: string
}): Promise<Record<string, unknown> | null> {
  const apiKey = trimEnv(input.env.OPENROUTER_API_KEY)
  if (!apiKey) {
    return {
      provider: "openrouter",
      error: "missing_configuration",
    }
  }

  const baseUrl = trimEnv(input.env.OPENROUTER_BASE_URL) || "https://openrouter.ai/api/v1"
  const model = trimEnv(input.env.OPENROUTER_MODEL) || "google/gemini-3.1-flash-lite-preview"
  const timeoutMs = providerTimeoutMs(input.env.OPENROUTER_TIMEOUT_MS, DEFAULT_OPENROUTER_TIMEOUT_MS)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await withSongAnalysisStep("openrouter lyrics classification request", {
      lyrics_length: input.lyrics.length,
      model,
      provider: "openrouter",
      timeout_ms: timeoutMs,
    }, () => fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_completion_tokens: 120,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "song_lyrics_age_gate",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["age_gate_rating", "reason"],
              properties: {
                age_gate_rating: {
                  type: "string",
                  enum: ["safe", "sensitive", "adult"],
                },
                reason: {
                  type: "string",
                },
              },
            },
          },
        },
        messages: [
          {
            role: "system",
            content:
              "Classify song lyrics for age-gating only. Never recommend blocking or review. " +
              "Return adult only for explicit sexual content suitable for 18+ gating. " +
              "Return sensitive for profanity or mature themes that do not require 18+ gating. " +
              "Return safe otherwise.",
          },
          {
            role: "user",
            content: input.lyrics,
          },
        ],
      }),
      signal: controller.signal,
    }))
    if (!response.ok) {
      return {
        provider: "openrouter",
        error: `http_${response.status}`,
      }
    }
    const body = await response.json().catch(() => null)
    if (!body || typeof body !== "object") {
      return {
        provider: "openrouter",
        error: "invalid_response",
      }
    }
    const content = (body as {
      choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>
    }).choices?.[0]?.message?.content

    const normalizedContent = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
          .filter((part) => part && typeof part === "object" && part.type === "text" && typeof part.text === "string")
          .map((part) => String(part.text))
          .join("")
        : ""

    if (!normalizedContent.trim()) {
      return {
        provider: "openrouter",
        error: "invalid_response",
      }
    }

    const parsed = JSON.parse(normalizedContent) as Record<string, unknown>
    return {
      provider: "openrouter",
      model,
      classification: parsed,
      provider_result: body,
      ...(typeof parsed.age_gate_rating === "string" ? { age_gate_rating: parsed.age_gate_rating } : {}),
      ...(typeof parsed.reason === "string" ? { reason: parsed.reason } : {}),
    }
  } catch (error) {
      return {
      provider: "openrouter",
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

async function evaluateLyricsModeration(input: {
  env: Env
  lyrics: string
}): Promise<LyricsModerationOutcome> {
  if (!input.lyrics.trim()) {
    return {
      analysisState: "allow",
      contentSafetyState: "safe",
      ageGatePolicy: "none",
      moderationStatus: "completed",
      moderationError: null,
      moderationResult: {
        provider: "openrouter",
        skipped: true,
        skip_reason: "empty_lyrics",
        analysis_state: "allow",
        content_safety_state: "safe",
        age_gate_policy: "none",
      },
    }
  }

  const providerResult = await classifyLyricsAgeGate(input)
  const providerFailed = Boolean(providerResult && typeof providerResult.error === "string")
  const providerOutcome = providerFailed
    ? {
        analysisState: "allow" as const,
        contentSafetyState: "pending" as const,
        ageGatePolicy: "none" as const,
      }
    : resolveProviderLyricsOutcome(providerResult as Record<string, unknown>)

  return {
    analysisState: providerOutcome.analysisState,
    contentSafetyState: providerOutcome.contentSafetyState,
    ageGatePolicy: providerOutcome.ageGatePolicy,
    moderationStatus: providerFailed ? "failed" : "completed",
    moderationError: providerFailed ? String(providerResult?.error || "OpenRouter song lyrics classification failed") : null,
    moderationResult: {
      provider: "openrouter",
      provider_result: providerResult,
      analysis_state: providerOutcome.analysisState,
      content_safety_state: providerOutcome.contentSafetyState,
      age_gate_policy: providerOutcome.ageGatePolicy,
    },
  }
}

async function buildAcrCloudSignature(
  secret: string,
  stringToSign: string,
): Promise<string> {
  const imported = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  )
  const signature = await crypto.subtle.sign("HMAC", imported, new TextEncoder().encode(stringToSign))
  const bytes = new Uint8Array(signature)
  let binary = ""
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

async function identifyAudioWithAcrCloud(input: {
  env: Env
  upload: SongArtifactUpload
}): Promise<Record<string, unknown> | null> {
  const accessKey = trimEnv(input.env.ACRCLOUD_ACCESS_KEY)
  const accessSecret = trimEnv(input.env.ACRCLOUD_ACCESS_SECRET)
  const host = trimEnv(input.env.ACRCLOUD_HOST)
  if (!accessKey || !accessSecret || !host || !input.upload.storage_object_key) {
    console.info("[song-artifacts] ACRCloud identification skipped", {
      has_access_key: Boolean(accessKey),
      has_access_secret: Boolean(accessSecret),
      has_host: Boolean(host),
      has_storage_object_key: Boolean(input.upload.storage_object_key),
      provider: "acrcloud",
      upload: input.upload.id,
    })
    return {
      provider: "acrcloud",
      error: "missing_configuration",
    }
  }
  const storageObjectKey = input.upload.storage_object_key

  const contentResponse = await withSongAnalysisStep("acrcloud load audio sample", {
    content_hash_present: Boolean(input.upload.content_hash),
    filename: input.upload.filename,
    provider: "acrcloud",
    size_bytes: input.upload.size_bytes,
    upload: input.upload.id,
  }, () => fetchSongArtifactBytes({
    env: input.env,
    objectKey: storageObjectKey,
  }))
  const content = await withSongAnalysisStep("acrcloud read audio sample", {
    provider: "acrcloud",
    upload: input.upload.id,
  }, () => contentResponse.arrayBuffer())

  return identifyAudioSampleWithAcrCloud({
    env: input.env,
    sampleBytes: content,
    filename: input.upload.filename || "audio.bin",
    mimeType: input.upload.mime_type || "application/octet-stream",
    logContext: { upload: input.upload.id },
  })
}

// Bytes-based core shared by the song-upload path above and the video
// soundtrack analysis job (which extracts a short audio sample first and has
// no SongArtifactUpload row for the sample itself).
export async function identifyAudioSampleWithAcrCloud(input: {
  env: Env
  sampleBytes: ArrayBuffer | Uint8Array
  filename: string
  mimeType: string
  logContext?: Record<string, unknown>
}): Promise<Record<string, unknown> | null> {
  const accessKey = trimEnv(input.env.ACRCLOUD_ACCESS_KEY)
  const accessSecret = trimEnv(input.env.ACRCLOUD_ACCESS_SECRET)
  const host = trimEnv(input.env.ACRCLOUD_HOST)
  if (!accessKey || !accessSecret || !host) {
    console.info("[song-artifacts] ACRCloud identification skipped", {
      has_access_key: Boolean(accessKey),
      has_access_secret: Boolean(accessSecret),
      has_host: Boolean(host),
      provider: "acrcloud",
      ...input.logContext,
    })
    return {
      provider: "acrcloud",
      error: "missing_configuration",
    }
  }

  const path = trimEnv(input.env.ACRCLOUD_IDENTIFY_PATH) || "/v1/identify"
  const endpoint = `https://${host.replace(/^https?:\/\//, "").replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const stringToSign = ["POST", path.startsWith("/") ? path : `/${path}`, accessKey, "audio", "1", timestamp].join("\n")
  const signature = await buildAcrCloudSignature(accessSecret, stringToSign)
  const content = input.sampleBytes instanceof Uint8Array
    ? input.sampleBytes.slice().buffer
    : input.sampleBytes
  const body = new FormData()
  body.set("access_key", accessKey)
  body.set("sample_bytes", String(content.byteLength))
  body.set("timestamp", timestamp)
  body.set("signature", signature)
  body.set("data_type", "audio")
  body.set("signature_version", "1")
  body.set("sample", new File([content], input.filename, { type: input.mimeType }))

  const timeoutMs = providerTimeoutMs(input.env.ACRCLOUD_TIMEOUT_MS, DEFAULT_ACRCLOUD_TIMEOUT_MS)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await withSongAnalysisStep("acrcloud identify request", {
      endpoint_host: host.replace(/^https?:\/\//, "").replace(/\/+$/, ""),
      provider: "acrcloud",
      sample_bytes: content.byteLength,
      timeout_ms: timeoutMs,
      ...input.logContext,
    }, () => fetch(endpoint, {
      method: "POST",
      body,
      signal: controller.signal,
    }))
    if (!response.ok) {
      return {
        provider: "acrcloud",
        error: `http_${response.status}`,
      }
    }
    const parsed = await response.json().catch(() => null)
    if (!parsed || typeof parsed !== "object") {
      return {
        provider: "acrcloud",
        error: "invalid_response",
      }
    }
    return parsed as Record<string, unknown>
  } catch (error) {
    return {
      provider: "acrcloud",
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

async function evaluateAudioIdentification(input: {
  env: Env
  primaryAudioUpload: SongArtifactUpload
}): Promise<AudioIdentificationOutcome> {
  const providerResult = await identifyAudioWithAcrCloud({
    env: input.env,
    upload: input.primaryAudioUpload,
  })
  const providerFailed = Boolean(providerResult && typeof providerResult.error === "string")
  const missingConfiguration = providerResult?.error === "missing_configuration"
  const metadata = (providerResult as {
    metadata?: {
      music?: unknown[]
      custom_files?: unknown[]
    }
  } | null)?.metadata
  const matchFound = Boolean(
    (Array.isArray(metadata?.music) && metadata.music.length)
    || (Array.isArray(metadata?.custom_files) && metadata.custom_files.length),
  )

  return {
    analysisState: providerFailed
      ? missingConfiguration
        ? "allow"
        : "review_required"
      : matchFound
        ? "allow_with_required_reference"
        : "allow",
    moderationStatus: providerFailed ? "failed" : "completed",
    moderationError: providerFailed ? String(providerResult?.error || "ACRCloud identification failed") : null,
    moderationResult: {
      provider: "acrcloud",
      provider_result: providerResult,
      match_found: matchFound,
    },
  }
}

async function alignLyricsWithElevenLabs(input: {
  env: Env
  lyrics: string
  primaryAudioUpload: SongArtifactUpload
}): Promise<Record<string, unknown> | null> {
  const apiKey = trimEnv(input.env.ELEVENLABS_API_KEY)
  const url = trimEnv(input.env.ELEVENLABS_FORCE_ALIGNMENT_URL) || "https://api.elevenlabs.io/v1/forced-alignment"
  if (!apiKey || !url) {
    console.info("[song-artifacts] ElevenLabs forced alignment skipped", {
      has_api_key: Boolean(apiKey),
      has_url: Boolean(url),
      provider: "elevenlabs",
      upload: input.primaryAudioUpload.id,
    })
    return {
      provider: "elevenlabs",
      error: "missing_configuration",
    }
  }

  const timeoutMs = providerTimeoutMs(input.env.ELEVENLABS_TIMEOUT_MS, DEFAULT_ELEVENLABS_TIMEOUT_MS)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    if (!input.primaryAudioUpload.storage_object_key) {
      return {
        provider: "elevenlabs",
        error: "missing_audio_object",
      }
    }
    const storageObjectKey = input.primaryAudioUpload.storage_object_key

    const audioResponse = await withSongAnalysisStep("elevenlabs load alignment audio", {
      filename: input.primaryAudioUpload.filename,
      provider: "elevenlabs",
      size_bytes: input.primaryAudioUpload.size_bytes,
      upload: input.primaryAudioUpload.id,
    }, () => fetchSongArtifactBytes({
      env: input.env,
      objectKey: storageObjectKey,
    }))
    const audioBytes = await withSongAnalysisStep("elevenlabs read alignment audio", {
      provider: "elevenlabs",
      upload: input.primaryAudioUpload.id,
    }, () => audioResponse.arrayBuffer())
    const form = new FormData()
    form.set(
      "file",
      new File(
        [audioBytes],
        input.primaryAudioUpload.filename || "alignment-audio.bin",
        { type: input.primaryAudioUpload.mime_type || "application/octet-stream" },
      ),
    )
    form.set("text", input.lyrics)

    const response = await withSongAnalysisStep("elevenlabs forced alignment request", {
      audio_bytes: audioBytes.byteLength,
      lyrics_length: input.lyrics.length,
      provider: "elevenlabs",
      timeout_ms: timeoutMs,
      upload: input.primaryAudioUpload.id,
    }, () => fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
      },
      body: form,
      signal: controller.signal,
    }))
    if (!response.ok) {
      return {
        provider: "elevenlabs",
        error: `http_${response.status}`,
      }
    }
    const parsed = await response.json().catch(() => null)
    if (!parsed || typeof parsed !== "object") {
      return {
        provider: "elevenlabs",
        error: "invalid_response",
      }
    }
    return parsed as Record<string, unknown>
  } catch (error) {
    return {
      provider: "elevenlabs",
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

function normalizeTimedLyrics(result: Record<string, unknown>): Record<string, unknown> {
  if (Array.isArray(result.segments)) {
    return result
  }

  const words = Array.isArray(result.words) ? result.words : []
  return {
    provider: "elevenlabs",
    segments: words
      .map((word) => {
        if (!word || typeof word !== "object") {
          return null
        }
        const text = "text" in word && typeof word.text === "string" ? word.text : null
        const start = "start" in word && typeof word.start === "number" ? word.start : null
        const end = "end" in word && typeof word.end === "number" ? word.end : null
        if (!text || start === null || end === null) {
          return null
        }
        return {
          start_ms: Math.round(start * 1000),
          end_ms: Math.round(end * 1000),
          text,
          loss: "loss" in word && typeof word.loss === "number" ? word.loss : null,
        }
      })
      .filter((segment): segment is { start_ms: number; end_ms: number; text: string; loss: number | null } => Boolean(segment)),
    provider_result: result,
  }
}

async function evaluateAlignment(input: {
  env: Env
  lyrics: string
  primaryAudioUpload: SongArtifactUpload
}): Promise<AlignmentOutcome> {
  if (!input.lyrics.trim()) {
    return {
      alignmentStatus: "completed",
      alignmentError: null,
      timedLyrics: null,
    }
  }

  const providerResult = await alignLyricsWithElevenLabs(input)
  if (providerResult && typeof providerResult.error === "string") {
    return {
      alignmentStatus: "failed",
      alignmentError: String(providerResult.error),
      timedLyrics: null,
    }
  }

  return {
    alignmentStatus: "completed",
    alignmentError: null,
    timedLyrics: normalizeTimedLyrics(providerResult ?? {}),
  }
}

function mergeAnalysisStates(
  left: Post["analysis_state"],
  right: Post["analysis_state"],
): Post["analysis_state"] {
  const precedence: Record<Post["analysis_state"], number> = {
    blocked: 4,
    review_required: 3,
    allow_with_required_reference: 2,
    allow: 1,
    pending: 0,
  }
  return precedence[left] >= precedence[right] ? left : right
}

export async function analyzeSongBundle(input: {
  env: Env
  lyrics: string
  primaryAudioUpload: SongArtifactUpload
}): Promise<SongBundleAnalysisResult> {
  const startedAt = Date.now()
  console.info("[song-artifacts] song analysis started", {
    lyrics_length: input.lyrics.length,
    primary_audio_upload: input.primaryAudioUpload.id,
    primary_audio_size_bytes: input.primaryAudioUpload.size_bytes,
  })
  const lyricsModeration = await withSongAnalysisStep("lyrics moderation", {
    lyrics_length: input.lyrics.length,
    primary_audio_upload: input.primaryAudioUpload.id,
  }, () => evaluateLyricsModeration({
    env: input.env,
    lyrics: input.lyrics,
  }))
  const audioIdentification = await withSongAnalysisStep("audio identification", {
    primary_audio_upload: input.primaryAudioUpload.id,
  }, () => evaluateAudioIdentification({
    env: input.env,
    primaryAudioUpload: input.primaryAudioUpload,
  }))
  const alignment = await withSongAnalysisStep("forced alignment", {
    lyrics_length: input.lyrics.length,
    primary_audio_upload: input.primaryAudioUpload.id,
  }, () => evaluateAlignment({
    env: input.env,
    lyrics: input.lyrics,
    primaryAudioUpload: input.primaryAudioUpload,
  }))
  const analysisState = mergeAnalysisStates(lyricsModeration.analysisState, audioIdentification.analysisState)
  console.info("[song-artifacts] song analysis completed", {
    alignment_error: alignment.alignmentError,
    alignment_status: alignment.alignmentStatus,
    analysis_state: analysisState,
    audio_identification_error: audioIdentification.moderationError,
    audio_identification_status: audioIdentification.moderationStatus,
    elapsed_ms: Date.now() - startedAt,
    lyrics_moderation_error: lyricsModeration.moderationError,
    lyrics_moderation_status: lyricsModeration.moderationStatus,
    primary_audio_upload: input.primaryAudioUpload.id,
  })

  return {
    analysisState,
    contentSafetyState: lyricsModeration.contentSafetyState,
    ageGatePolicy: lyricsModeration.ageGatePolicy,
    moderationStatus:
      lyricsModeration.moderationStatus === "failed" || audioIdentification.moderationStatus === "failed"
        ? "failed"
        : "completed",
    moderationError: lyricsModeration.moderationError || audioIdentification.moderationError,
    moderationResult: {
      provider: "song_bundle_analysis",
      lyrics: lyricsModeration.moderationResult,
      audio_identification: audioIdentification.moderationResult,
      analysis_state: analysisState,
      content_safety_state: lyricsModeration.contentSafetyState,
      age_gate_policy: lyricsModeration.ageGatePolicy,
    },
    alignmentStatus: alignment.alignmentStatus,
    alignmentError: alignment.alignmentError,
    timedLyrics: alignment.timedLyrics,
  }
}
