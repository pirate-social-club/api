import type { Env, Post, SongArtifactUpload } from "../../types"
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

function trimEnv(value: string | undefined): string {
  return String(value || "").trim()
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
  const timeoutMs = Number.parseInt(trimEnv(input.env.OPENROUTER_TIMEOUT_MS) || "", 10)
  const controller = new AbortController()
  const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null

  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
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
    })
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
  const contentResponse = await fetchSongArtifactBytes({
    env: input.env,
    objectKey: input.upload.storage_object_key,
  })
  const contentType = input.upload.mime_type || "application/octet-stream"
  const content = await contentResponse.arrayBuffer()
  const body = new FormData()
  body.set("access_key", accessKey)
  body.set("sample_bytes", String(content.byteLength))
  body.set("timestamp", timestamp)
  body.set("signature", signature)
  body.set("data_type", "audio")
  body.set("signature_version", "1")
  body.set("sample", new File([content], input.upload.filename || "audio.bin", { type: contentType }))

  const timeoutMs = Number.parseInt(trimEnv(input.env.ACRCLOUD_TIMEOUT_MS) || "", 10)
  const controller = new AbortController()
  const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      body,
      signal: controller.signal,
    })
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
      ? "review_required"
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
    return {
      provider: "elevenlabs",
      error: "missing_configuration",
    }
  }

  const timeoutMs = Number.parseInt(trimEnv(input.env.ELEVENLABS_TIMEOUT_MS) || "", 10)
  const controller = new AbortController()
  const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null

  try {
    if (!input.primaryAudioUpload.storage_object_key) {
      return {
        provider: "elevenlabs",
        error: "missing_audio_object",
      }
    }

    const audioResponse = await fetchSongArtifactBytes({
      env: input.env,
      objectKey: input.primaryAudioUpload.storage_object_key,
    })
    const audioBytes = await audioResponse.arrayBuffer()
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

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
      },
      body: form,
      signal: controller.signal,
    })
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
  const lyricsModeration = await evaluateLyricsModeration({
    env: input.env,
    lyrics: input.lyrics,
  })
  const audioIdentification = await evaluateAudioIdentification({
    env: input.env,
    primaryAudioUpload: input.primaryAudioUpload,
  })
  const alignment = await evaluateAlignment({
    env: input.env,
    lyrics: input.lyrics,
    primaryAudioUpload: input.primaryAudioUpload,
  })

  return {
    analysisState: mergeAnalysisStates(lyricsModeration.analysisState, audioIdentification.analysisState),
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
      analysis_state: mergeAnalysisStates(lyricsModeration.analysisState, audioIdentification.analysisState),
      content_safety_state: lyricsModeration.contentSafetyState,
      age_gate_policy: lyricsModeration.ageGatePolicy,
    },
    alignmentStatus: alignment.alignmentStatus,
    alignmentError: alignment.alignmentError,
    timedLyrics: alignment.timedLyrics,
  }
}
