import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { CommunityRepository } from "../communities/control-plane-community-repository"
import { openCommunityDb } from "../communities/community-db-factory"
import { attachSongModerationSignalsAndCase } from "../moderation/community-moderation-store"
import { nowIso } from "../helpers"
import type {
  Env,
  SongArtifactBundle,
  SongLyricsTranslationDoc,
  SongModerationResultDoc,
  SongTimedLyricsDoc,
  SongTimedLyricsLine,
  SongTimedLyricsWord,
  RightsReviewCase,
} from "../../types"
import type { SongArtifactBundleRepository } from "./control-plane-song-artifact-repository"
import { resolveLocalSongArtifactUploadPath } from "./local-song-artifact-upload-storage"
import {
  createRightsReviewCase,
  getPostBySongArtifactBundleId,
  updatePostAnalysisResultRef,
  updateSongPostModerationByBundleId,
} from "./community-post-store"
import {
  createMediaAnalysisResultFromModeration,
  getMediaAnalysisResultById,
  mediaAnalysisHasAcrcloudMatch,
  updateMediaAnalysisResultSafety,
} from "./post-analysis"
import { readStoredSongArtifactBytes, storageRefToFetchUrl } from "./song-artifact-storage"

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions"
const ELEVENLABS_API_URL = "https://api.elevenlabs.io/v1/forced-alignment"
const DEFAULT_SONG_LYRICS_LLM_MODEL = "google/gemini-3.1-flash-lite-preview"
const DEFAULT_SONG_LYRICS_TRANSLATION_TARGET_LOCALES = [
  "en",
  "es",
  "pt-BR",
  "ru",
  "tr",
  "ar",
  "hi",
  "id",
  "ja",
  "ko",
  "zh-Hans",
  "zh-Hant",
  "vi",
] as const
const LYRICS_TRANSLATION_MAX_LINES = 600
const OPENROUTER_TIMEOUT_MS = 35_000
const ELEVENLABS_TIMEOUT_MS = 20_000
const MAX_REASONABLE_WORD_DURATION_S = 3
const TYPICAL_SHORT_WORD_DURATION_S = 0.4
const GAP_BEFORE_WORD_S = 0.15

type OpenRouterLyricsModerationPayload = {
  detectedSourceLanguage: string | null
  translations: Record<string, string[]>
  moderation: {
    sexualContent: "none" | "mild" | "adult" | "graphic"
    sexualMinors: boolean
    selfHarm: boolean
    violence: boolean
    hateOrHarassment: boolean
    reviewRequired: boolean
    blocked: boolean
    summary: string
  }
  coverArtModeration: {
    sexualContent: "none" | "mild" | "adult" | "graphic"
    sexualMinors: boolean
    reviewRequired: boolean
    blocked: boolean
    summary: string
  } | null
}

type ElevenLabsWord = {
  text: string
  start: number
  end: number
  loss?: number
}

type ElevenLabsResponse = {
  words?: ElevenLabsWord[]
  loss?: number
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function asBoolean(value: unknown): boolean {
  return value === true
}

function normalizeLocaleTag(raw: string | null | undefined): string {
  const base = String(raw || "").trim().replace(/_/g, "-")
  if (!base) {
    return "en"
  }

  const parts = base.split("-").map((part) => part.trim()).filter(Boolean)
  if (parts.length === 0) {
    return "en"
  }

  const language = parts[0].toLowerCase()
  let script = ""
  let region = ""
  const variants: string[] = []

  for (let index = 1; index < parts.length; index += 1) {
    const token = parts[index]
    if (!script && /^[A-Za-z]{4}$/.test(token)) {
      script = token.charAt(0).toUpperCase() + token.slice(1).toLowerCase()
      continue
    }
    if (!region && /^([A-Za-z]{2}|\d{3})$/.test(token)) {
      region = token.toUpperCase()
      continue
    }
    variants.push(token.toLowerCase())
  }

  const out = [language]
  if (script) out.push(script)
  if (region) out.push(region)
  if (variants.length > 0) out.push(...variants)
  return out.join("-")
}

function extractStructuredJson(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced?.[1]) {
    return fenced[1].trim()
  }

  const start = trimmed.indexOf("{")
  const end = trimmed.lastIndexOf("}")
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1)
  }

  throw new Error("structured_json_missing")
}

function summarizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.trim().slice(0, 500) || "unknown_error"
}

function isoBeforeSeconds(seconds: number): string | null {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return null
  }
  return new Date(Date.now() - (seconds * 1000)).toISOString()
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutCode: string): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error(timeoutCode)), timeoutMs)
      }),
    ])
  } finally {
    if (timeoutHandle !== null) {
      clearTimeout(timeoutHandle)
    }
  }
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  timeoutMs: number,
  timeoutCode: string,
): Promise<Response> {
  const controller = new AbortController()
  const handle = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(input, {
      ...(init || {}),
      signal: controller.signal,
    })
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(timeoutCode)
    }
    throw error
  } finally {
    clearTimeout(handle)
  }
}

function buildPseudoRef(bundleId: string, suffix: "translated-lyrics" | "timed-lyrics" | "moderation"): string {
  return `pirate://song-artifact-bundles/${bundleId}/${suffix}`
}

function resolveLyricsTranslationTargetLocales(env: Env): string[] {
  const configured = String(env.SONG_LYRICS_TRANSLATION_TARGET_LOCALES || "")
    .split(",")
    .map((part) => normalizeLocaleTag(part))
    .filter(Boolean)
  const input = configured.length > 0 ? configured : [...DEFAULT_SONG_LYRICS_TRANSLATION_TARGET_LOCALES]
  return [...new Set(input)]
}

function resolveLyricsLlmModel(env: Env): string {
  return String(env.SONG_LYRICS_LLM_MODEL || "").trim() || DEFAULT_SONG_LYRICS_LLM_MODEL
}

function parseSongEnrichmentStaleAfterSeconds(env: Env): number {
  const parsed = Number(String(env.SONG_ENRICHMENT_STALE_AFTER_SECONDS ?? "").trim())
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 900
  }
  return Math.max(1, Math.trunc(parsed))
}

function buildLyricsModerationResponseFormat(targetLocales: readonly string[], lineCount: number): Record<string, unknown> {
  const translationProperties = Object.fromEntries(
    targetLocales.map((locale) => [
      locale,
      {
        type: "array",
        minItems: lineCount,
        maxItems: lineCount,
        items: { type: "string" },
      },
    ]),
  )

  return {
    type: "json_schema",
    json_schema: {
      name: "song_lyrics_enrichment",
      strict: true,
      schema: {
        type: "object",
        properties: {
          detectedSourceLanguage: {
            type: ["string", "null"],
          },
          translations: {
            type: "object",
            properties: translationProperties,
            required: [...targetLocales],
            additionalProperties: false,
          },
          moderation: {
            type: "object",
            properties: {
              sexualContent: {
                type: "string",
                enum: ["none", "mild", "adult", "graphic"],
              },
              sexualMinors: { type: "boolean" },
              selfHarm: { type: "boolean" },
              violence: { type: "boolean" },
              hateOrHarassment: { type: "boolean" },
              reviewRequired: { type: "boolean" },
              blocked: { type: "boolean" },
              summary: { type: "string" },
            },
            required: [
              "sexualContent",
              "sexualMinors",
              "selfHarm",
              "violence",
              "hateOrHarassment",
              "reviewRequired",
              "blocked",
              "summary",
            ],
            additionalProperties: false,
          },
          coverArtModeration: {
            type: ["object", "null"],
            properties: {
              sexualContent: {
                type: "string",
                enum: ["none", "mild", "adult", "graphic"],
              },
              sexualMinors: { type: "boolean" },
              reviewRequired: { type: "boolean" },
              blocked: { type: "boolean" },
              summary: { type: "string" },
            },
            required: [
              "sexualContent",
              "sexualMinors",
              "reviewRequired",
              "blocked",
              "summary",
            ],
            additionalProperties: false,
          },
        },
        required: ["detectedSourceLanguage", "translations", "moderation", "coverArtModeration"],
        additionalProperties: false,
      },
    },
  }
}

async function callOpenRouter(input: {
  env: Env
  model: string
  system: string
  user: string | Array<Record<string, unknown>>
  responseFormat: Record<string, unknown>
}): Promise<string> {
  const apiKey = String(input.env.OPENROUTER_API_KEY || "").trim()
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY missing")
  }

  const response = await fetchWithTimeout(
    OPENROUTER_API_URL,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://pirate.sc",
        "X-Title": "Pirate Song Enrichment",
      },
      body: JSON.stringify({
        model: input.model,
        temperature: 0,
        max_tokens: 12_000,
        response_format: input.responseFormat,
        messages: [
          { role: "system", content: input.system },
          { role: "user", content: input.user },
        ],
      }),
    },
    OPENROUTER_TIMEOUT_MS,
    "openrouter_timeout",
  )

  if (!response.ok) {
    const body = await response.text().catch(() => "")
    throw new Error(`openrouter_failed:${response.status}:${body.slice(0, 300)}`)
  }

  const parsed = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>
  }
  const content = parsed.choices?.[0]?.message?.content?.trim()
  if (!content) {
    throw new Error("openrouter_empty_content")
  }
  return content
}

function parseLyricsModerationModelOutput(input: {
  raw: string
  targetLocales: readonly string[]
  expectedLineCount: number
}): OpenRouterLyricsModerationPayload {
  const parsed = JSON.parse(extractStructuredJson(input.raw)) as unknown
  const payload = asRecord(parsed)
  if (!payload) {
    throw new Error("lyrics_enrichment_invalid_payload")
  }

  const translationsPayload = asRecord(payload.translations)
  const moderationPayload = asRecord(payload.moderation)
  if (!translationsPayload || !moderationPayload) {
    throw new Error("lyrics_enrichment_missing_sections")
  }

  const translations: Record<string, string[]> = {}
  for (const targetLocaleRaw of input.targetLocales) {
    const locale = normalizeLocaleTag(targetLocaleRaw)
    const rawLines = translationsPayload[targetLocaleRaw] ?? translationsPayload[locale]
    if (!Array.isArray(rawLines) || rawLines.length !== input.expectedLineCount) {
      throw new Error(`lyrics_translation_line_count_mismatch:${locale}`)
    }
    translations[locale] = rawLines.map((line) => {
      if (typeof line !== "string") {
        throw new Error(`lyrics_translation_line_invalid:${locale}`)
      }
      return line
    })
  }

  const sexualContent = asString(moderationPayload.sexualContent)
  if (!["none", "mild", "adult", "graphic"].includes(sexualContent)) {
    throw new Error("lyrics_moderation_invalid_sexual_content")
  }

  return {
    detectedSourceLanguage: asString(payload.detectedSourceLanguage) ? normalizeLocaleTag(asString(payload.detectedSourceLanguage)) : null,
    translations,
    moderation: {
      sexualContent: sexualContent as OpenRouterLyricsModerationPayload["moderation"]["sexualContent"],
      sexualMinors: asBoolean(moderationPayload.sexualMinors),
      selfHarm: asBoolean(moderationPayload.selfHarm),
      violence: asBoolean(moderationPayload.violence),
      hateOrHarassment: asBoolean(moderationPayload.hateOrHarassment),
      reviewRequired: asBoolean(moderationPayload.reviewRequired),
      blocked: asBoolean(moderationPayload.blocked),
      summary: asString(moderationPayload.summary),
    },
    coverArtModeration: (() => {
      if (payload.coverArtModeration == null) {
        return null
      }
      const coverArtModeration = asRecord(payload.coverArtModeration)
      if (!coverArtModeration) {
        throw new Error("cover_art_moderation_invalid_payload")
      }
      const sexualContent = asString(coverArtModeration.sexualContent)
      if (!["none", "mild", "adult", "graphic"].includes(sexualContent)) {
        throw new Error("cover_art_moderation_invalid_sexual_content")
      }
      return {
        sexualContent: sexualContent as OpenRouterLyricsModerationPayload["moderation"]["sexualContent"],
        sexualMinors: asBoolean(coverArtModeration.sexualMinors),
        reviewRequired: asBoolean(coverArtModeration.reviewRequired),
        blocked: asBoolean(coverArtModeration.blocked),
        summary: asString(coverArtModeration.summary),
      }
    })(),
  }
}

async function resolveCoverArtVisionUrl(input: {
  env: Env
  coverArt: NonNullable<SongArtifactBundle["cover_art"]>
}): Promise<string> {
  const trimmed = input.coverArt.storage_ref.trim()
  const localStubPrefix = "ipfs://local-song-artifact-upload/"
  if (trimmed.startsWith(localStubPrefix)) {
    const uploadId = trimmed.slice(localStubPrefix.length)
    if (!uploadId) {
      throw new Error("local_cover_art_missing")
    }
    const bytes = await readFile(await resolveLocalSongArtifactUploadPath({
      env: input.env,
      uploadId,
    }))
    const mimeType = String(input.coverArt.mime_type || "").trim() || "image/png"
    return `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`
  }
  return storageRefToFetchUrl(input.env, input.coverArt.storage_ref)
}

async function translateAndModerateLyrics(input: {
  env: Env
  bundle: SongArtifactBundle
}): Promise<{
  translatedLyrics: SongLyricsTranslationDoc
  moderationResult: SongModerationResultDoc
}> {
  const lines = input.bundle.lyrics.split(/\r?\n/)
  if (lines.length <= 0) {
    throw new Error("lyrics_translation_no_lines")
  }
  if (lines.length > LYRICS_TRANSLATION_MAX_LINES) {
    throw new Error(`lyrics_translation_too_many_lines:${lines.length}`)
  }

  const targetLocales = resolveLyricsTranslationTargetLocales(input.env)
  const model = resolveLyricsLlmModel(input.env)
  const coverArtVisionUrl = input.bundle.cover_art
    ? await resolveCoverArtVisionUrl({
        env: input.env,
        coverArt: input.bundle.cover_art,
      })
    : null
  const raw = await callOpenRouter({
    env: input.env,
    model,
    system: [
      "Translate song lyrics line-by-line and review them for safety.",
      "If a cover art image is provided, also review that image for sexual-content risk.",
      "Rules:",
      "- Keep one-to-one line mapping exactly. Do not merge, split, drop, or reorder lines.",
      "- Preserve tone and meaning.",
      "- Preserve explicit sexual language if it exists; do not sanitize the translation.",
      "- Flag reviewRequired for adult sexual content, graphic sexual content, or ambiguous risky cases.",
      "- Flag blocked only for clearly disallowed content such as sexual content involving minors.",
      "- For coverArtModeration, return null if no cover image is provided.",
      "- Return only valid JSON matching the schema.",
    ].join("\n"),
    user: coverArtVisionUrl
      ? [
          {
            type: "text",
            text: JSON.stringify({
              lyricsSha256: input.bundle.lyrics_sha256,
              targetLocales,
              lines: lines.map((text, index) => ({ index, text })),
              hasCoverArt: true,
            }),
          },
          {
            type: "image_url",
            image_url: {
              url: coverArtVisionUrl,
            },
          },
        ]
      : JSON.stringify({
          lyricsSha256: input.bundle.lyrics_sha256,
          targetLocales,
          lines: lines.map((text, index) => ({ index, text })),
          hasCoverArt: false,
        }),
    responseFormat: buildLyricsModerationResponseFormat(targetLocales, lines.length),
  })
  const payload = parseLyricsModerationModelOutput({
    raw,
    targetLocales,
    expectedLineCount: lines.length,
  })

  return {
    translatedLyrics: {
      kind: "lyrics.translation.bundle.v1",
      version: 1,
      created_at: nowIso(),
      model,
      detected_source_language: payload.detectedSourceLanguage,
      target_locales: Object.keys(payload.translations),
      translations: Object.fromEntries(
        Object.entries(payload.translations).map(([locale, translatedLines]) => [
          locale,
          translatedLines.map((text, index) => ({
            id: `line-${index + 1}`,
            index,
            text,
          })),
        ]),
      ),
    },
    moderationResult: {
      kind: "lyrics.moderation.v1",
      version: 1,
      created_at: nowIso(),
      model,
      detected_source_language: payload.detectedSourceLanguage,
      sexual_content: payload.moderation.sexualContent,
      sexual_minors: payload.moderation.sexualMinors,
      self_harm: payload.moderation.selfHarm,
      violence: payload.moderation.violence,
      hate_or_harassment: payload.moderation.hateOrHarassment,
      review_required: payload.moderation.reviewRequired,
      blocked: payload.moderation.blocked,
      summary: payload.moderation.summary,
      cover_art_sexual_content: payload.coverArtModeration?.sexualContent ?? null,
      cover_art_sexual_minors: payload.coverArtModeration?.sexualMinors ?? false,
      cover_art_review_required: payload.coverArtModeration?.reviewRequired ?? false,
      cover_art_blocked: payload.coverArtModeration?.blocked ?? false,
      cover_art_summary: payload.coverArtModeration?.summary ?? null,
    },
  }
}

function parseAlignedLines(words: ElevenLabsWord[]): Array<{ words: ElevenLabsWord[]; startMs: number | null; endMs: number | null }> {
  const lines: Array<{ words: ElevenLabsWord[]; startMs: number | null; endMs: number | null }> = []
  let current: ElevenLabsWord[] = []

  const pushLine = (lineWords: ElevenLabsWord[]) => {
    const content = lineWords.filter((word) => word.text.trim().length > 0)
    lines.push({
      words: [...lineWords],
      startMs: content.length > 0 ? Math.round(content[0].start * 1000) : null,
      endMs: content.length > 0 ? Math.round(content[content.length - 1].end * 1000) : null,
    })
  }

  for (const word of words) {
    if (word.text === "\n") {
      pushLine(current)
      current = []
      continue
    }
    current.push(word)
  }

  pushLine(current)
  return lines
}

function fixIntroStretchedWords(words: ElevenLabsWord[]): ElevenLabsWord[] {
  const fixed = words.map((word) => ({ ...word }))
  let currentLineStart = 0

  for (let index = 0; index < fixed.length; index += 1) {
    const word = fixed[index]
    if (word.text === "\n") {
      currentLineStart = index + 1
      continue
    }
    if (index !== currentLineStart) {
      continue
    }

    let firstContentIndex = index
    while (firstContentIndex < fixed.length && fixed[firstContentIndex].text.trim() === "") {
      firstContentIndex += 1
    }
    if (firstContentIndex >= fixed.length || fixed[firstContentIndex].text === "\n") {
      continue
    }

    const first = fixed[firstContentIndex]
    const duration = first.end - first.start
    if (duration <= MAX_REASONABLE_WORD_DURATION_S) {
      continue
    }

    let nextContentIndex = firstContentIndex + 1
    while (nextContentIndex < fixed.length && fixed[nextContentIndex].text.trim() === "" && fixed[nextContentIndex].text !== "\n") {
      nextContentIndex += 1
    }

    const adjustedStart = nextContentIndex < fixed.length && fixed[nextContentIndex].text !== "\n"
      ? Math.max(0, fixed[nextContentIndex].start - TYPICAL_SHORT_WORD_DURATION_S - GAP_BEFORE_WORD_S)
      : Math.max(0, first.end - TYPICAL_SHORT_WORD_DURATION_S)
    if (first.start < adjustedStart - 1) {
      first.start = adjustedStart
    }
  }

  return fixed
}

function buildTimedLyricsDoc(input: {
  lyrics: string
  lyricsSha256: string
  words: ElevenLabsWord[]
  loss: number | null
}): SongTimedLyricsDoc {
  const lines = input.lyrics.split(/\r?\n/)
  const parsedLines = parseAlignedLines(fixIntroStretchedWords(input.words))
  const timedLines: SongTimedLyricsLine[] = lines.map((text, index) => {
    const parsed = parsedLines[index]
    const words: SongTimedLyricsWord[] = (parsed?.words || [])
      .filter((word) => word.text.trim().length > 0)
      .map((word) => ({
        text: word.text,
        start_ms: Math.round(word.start * 1000),
        end_ms: Math.round(word.end * 1000),
        loss: Number.isFinite(word.loss) ? Number(word.loss) : null,
      }))
    return {
      id: `line-${index + 1}`,
      index,
      text,
      start_ms: parsed?.startMs ?? null,
      end_ms: parsed?.endMs ?? null,
      words: words.length > 0 ? words : null,
    }
  })

  return {
    kind: "lyrics.timed.v1",
    version: 1,
    timing: "aligned",
    created_at: nowIso(),
    text_sha256: input.lyricsSha256,
    source: {
      provider: "elevenlabs",
      version: "elevenlabs-forced-alignment-v1",
      loss: input.loss,
    },
    lines: timedLines,
  }
}

async function runElevenLabsAlignment(input: {
  env: Env
  lyrics: string
  audioBytes: Uint8Array
}): Promise<{ words: ElevenLabsWord[]; loss: number | null }> {
  const apiKey = String(input.env.ELEVENLABS_API_KEY || "").trim()
  if (!apiKey) {
    throw new Error("ELEVENLABS_API_KEY missing")
  }
  if (input.audioBytes.byteLength === 0) {
    throw new Error("song_audio_empty")
  }

  const form = new FormData()
  const uploadBytes = new Uint8Array(input.audioBytes.byteLength)
  uploadBytes.set(input.audioBytes)
  form.append("file", new File([uploadBytes.buffer], "audio.bin", { type: "application/octet-stream" }))
  form.append("text", input.lyrics)
  const response = await fetchWithTimeout(
    ELEVENLABS_API_URL,
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
      },
      body: form,
    },
    ELEVENLABS_TIMEOUT_MS,
    "elevenlabs_timeout",
  )
  if (!response.ok) {
    const body = await response.text().catch(() => "")
    throw new Error(`elevenlabs_failed:${response.status}:${body.slice(0, 300)}`)
  }

  const data = await response.json() as ElevenLabsResponse
  const words = Array.isArray(data.words) ? data.words : []
  if (words.length <= 0) {
    throw new Error("elevenlabs_missing_words")
  }

  return {
    words,
    loss: Number.isFinite(data.loss) ? Number(data.loss) : null,
  }
}

async function alignSongLyrics(input: {
  env: Env
  bundle: SongArtifactBundle
}): Promise<SongTimedLyricsDoc> {
  const audioStorageRef = input.bundle.vocal_audio?.storage_ref || input.bundle.primary_audio.storage_ref
  const audioBytes = await readStoredSongArtifactBytes(input.env, audioStorageRef)
  const aligned = await runElevenLabsAlignment({
    env: input.env,
    lyrics: input.bundle.lyrics,
    audioBytes,
  })
  return buildTimedLyricsDoc({
    lyrics: input.bundle.lyrics,
    lyricsSha256: input.bundle.lyrics_sha256,
    words: aligned.words,
    loss: aligned.loss,
  })
}

async function markEnrichmentFailure(input: {
  repository: SongArtifactBundleRepository
  bundleId: string
  key: "translation" | "alignment" | "moderation"
  error: string
}): Promise<void> {
  const updatedAt = nowIso()
  if (input.key === "translation") {
    await input.repository.updateSongArtifactBundleTranslation({
      bundleId: input.bundleId,
      status: "failed",
      error: input.error,
      ref: null,
      translatedLyrics: null,
      updatedAt,
    })
    return
  }
  if (input.key === "alignment") {
    await input.repository.updateSongArtifactBundleAlignment({
      bundleId: input.bundleId,
      status: "failed",
      error: input.error,
      ref: null,
      timedLyrics: null,
      updatedAt,
    })
    return
  }
  await input.repository.updateSongArtifactBundleModeration({
    bundleId: input.bundleId,
    status: "failed",
    error: input.error,
    ref: null,
    moderationResult: null,
    updatedAt,
  })
}

function derivePostModerationState(result: SongModerationResultDoc): {
  status: "draft" | "published" | "hidden" | "removed" | "deleted"
  analysisState: "pending" | "allow" | "allow_with_required_reference" | "review_required" | "blocked"
  contentSafetyState: "pending" | "safe" | "sensitive" | "adult"
  ageGatePolicy: "none" | "18_plus"
} {
  const hasAdultSexualContent = result.sexual_minors || result.sexual_content === "adult" || result.sexual_content === "graphic"
    || result.cover_art_sexual_minors
    || result.cover_art_sexual_content === "adult"
    || result.cover_art_sexual_content === "graphic"
  const hasSensitiveContent = hasAdultSexualContent
    || result.sexual_content === "mild"
    || result.cover_art_sexual_content === "mild"
    || result.self_harm
    || result.violence
    || result.hate_or_harassment
  const contentSafetyState = hasAdultSexualContent
    ? "adult"
    : hasSensitiveContent
      ? "sensitive"
      : "safe"
  const ageGatePolicy = hasAdultSexualContent ? "18_plus" : "none"

  if (result.blocked || result.sexual_minors || result.cover_art_blocked || result.cover_art_sexual_minors) {
    return {
      status: "hidden",
      analysisState: "blocked",
      contentSafetyState,
      ageGatePolicy,
    }
  }

  if (result.review_required || result.cover_art_review_required) {
    return {
      status: "hidden",
      analysisState: "review_required",
      contentSafetyState,
      ageGatePolicy,
    }
  }

  return {
    status: "published",
    analysisState: "allow",
    contentSafetyState,
    ageGatePolicy,
  }
}

async function applyModerationToPublishedSongPost(input: {
  communityRepository: CommunityRepository
  bundle: SongArtifactBundle
  moderationResult: SongModerationResultDoc
  moderationResultRef: string
}): Promise<void> {
  const db = await openCommunityDb(input.communityRepository, input.bundle.community_id)
  try {
    const currentPost = await getPostBySongArtifactBundleId(db.client, input.bundle.song_artifact_bundle_id)
    if (!currentPost) {
      return
    }
    const derived = derivePostModerationState(input.moderationResult)
    const existingAnalysis = currentPost.analysis_result_ref
      ? await getMediaAnalysisResultById({
          client: db.client,
          analysisResultId: currentPost.analysis_result_ref,
        })
      : null
    const hasAcrcloudMatch = mediaAnalysisHasAcrcloudMatch(existingAnalysis)
    const analysisState = hasAcrcloudMatch && derived.analysisState === "allow"
      ? "allow_with_required_reference" as const
      : derived.analysisState
    const status = analysisState === "allow_with_required_reference" ? "draft" as const : derived.status
    const analysisOutcome = analysisState === "allow_with_required_reference"
      ? "allow_with_required_reference" as const
      : analysisState === "blocked"
        ? "blocked" as const
        : analysisState === "review_required"
          ? "review_required" as const
          : "allow" as const

    const writeTx = await db.client.transaction("write")
    let updatedPost = currentPost
    let analysisResultRef = currentPost.analysis_result_ref
    try {
      const txNow = nowIso()
      if (analysisResultRef) {
        await updateMediaAnalysisResultSafety({
          client: writeTx,
          analysisResultId: analysisResultRef,
          outcome: analysisOutcome,
          contentSafetyState: derived.contentSafetyState,
          ageGatePolicy: derived.ageGatePolicy,
          moderationResult: input.moderationResult,
          updatedAt: txNow,
        })
      } else {
        analysisResultRef = await createMediaAnalysisResultFromModeration({
          client: writeTx,
          communityId: input.bundle.community_id,
          sourcePostId: currentPost.post_id,
          sourceAssetId: currentPost.asset_id ?? null,
          outcome: analysisOutcome,
          contentSafetyState: derived.contentSafetyState,
          ageGatePolicy: derived.ageGatePolicy,
          moderationResult: input.moderationResult,
          createdAt: txNow,
        })
        await updatePostAnalysisResultRef({
          client: writeTx,
          postId: currentPost.post_id,
          analysisResultRef,
          updatedAt: txNow,
        })
      }

      const moderationUpdate = await updateSongPostModerationByBundleId({
        client: writeTx,
        bundleId: input.bundle.song_artifact_bundle_id,
        status,
        analysisState,
        contentSafetyState: derived.contentSafetyState,
        ageGatePolicy: derived.ageGatePolicy,
        updatedAt: txNow,
        forceOverwrite: true,
      })
      if (!moderationUpdate.post || !moderationUpdate.updated) {
        await writeTx.commit()
        return
      }
      updatedPost = moderationUpdate.post

      if (analysisResultRef) {
        await attachSongModerationSignalsAndCase({
          client: writeTx,
          communityId: input.bundle.community_id,
          postId: updatedPost.post_id,
          analysisResultRef,
          moderationResult: input.moderationResult,
          createdAt: txNow,
        })
      }

      if (hasAcrcloudMatch && updatedPost.asset_id) {
        await createRightsReviewCase({
          client: writeTx,
          communityId: input.bundle.community_id,
          subjectType: "asset",
          subjectId: updatedPost.asset_id,
          triggerSource: "acrcloud_match",
          analysisResultRef,
          createdAt: txNow,
        })
      }

      await writeTx.commit()
    } catch (error) {
      try {
        await writeTx.rollback()
      } catch {}
      throw error
    } finally {
      writeTx.close()
    }

    const projectionUpdatedAt = nowIso()
    const projectedPayloadJson = JSON.stringify(updatedPost)
    let updateError: unknown = null

    try {
      const updatedProjection = await input.communityRepository.updateCommunityPostProjection({
        sourcePostId: updatedPost.post_id,
        status: updatedPost.status,
        projectedPayloadJson,
        updatedAt: projectionUpdatedAt,
      })
      if (updatedProjection) {
        return
      }
    } catch (error) {
      updateError = error
    }

    try {
      await input.communityRepository.reconcileCommunityPostProjection({
        communityId: updatedPost.community_id,
        sourcePostId: updatedPost.post_id,
        authorUserId: updatedPost.author_user_id ?? null,
        identityMode: updatedPost.identity_mode,
        postType: updatedPost.post_type,
        status: updatedPost.status,
        sourceCreatedAt: updatedPost.created_at,
        projectedPayloadJson,
        updatedAt: projectionUpdatedAt,
      })
    } catch (reconcileError) {
      throw updateError ?? reconcileError
    }
  } finally {
    db.close()
  }
}

export async function drainPendingSongArtifactEnrichments(input: {
  env: Env
  limit: number
  songArtifactRepository: SongArtifactBundleRepository
  communityRepository: CommunityRepository
}): Promise<{
  scanned_count: number
  claimed_count: number
  processed_count: number
  translation_completed_count: number
  translation_failed_count: number
  alignment_completed_count: number
  alignment_failed_count: number
  moderation_completed_count: number
  moderation_failed_count: number
}> {
  const staleBefore = isoBeforeSeconds(parseSongEnrichmentStaleAfterSeconds(input.env))
  const pending = await input.songArtifactRepository.listSongArtifactBundlesPendingEnrichment(input.limit, staleBefore)
  const counts = {
    scanned_count: pending.length,
    claimed_count: 0,
    processed_count: 0,
    translation_completed_count: 0,
    translation_failed_count: 0,
    alignment_completed_count: 0,
    alignment_failed_count: 0,
    moderation_completed_count: 0,
    moderation_failed_count: 0,
  }

  for (const candidate of pending) {
    const claimed = await input.songArtifactRepository.claimSongArtifactBundlePendingEnrichment({
      bundleId: candidate.song_artifact_bundle_id,
      staleBefore,
      updatedAt: nowIso(),
    })
    if (!claimed) {
      continue
    }
    counts.claimed_count += 1

    const needsLyricsLlm = claimed.translation_status === "processing" || claimed.moderation_status === "processing"
    if (needsLyricsLlm) {
      try {
          const result = await translateAndModerateLyrics({
            env: input.env,
            bundle: claimed,
          })

        if (claimed.translation_status === "processing") {
          await input.songArtifactRepository.updateSongArtifactBundleTranslation({
            bundleId: claimed.song_artifact_bundle_id,
            status: "completed",
            error: null,
            ref: buildPseudoRef(claimed.song_artifact_bundle_id, "translated-lyrics"),
            translatedLyrics: result.translatedLyrics,
            updatedAt: nowIso(),
          })
          counts.translation_completed_count += 1
        }
        if (claimed.moderation_status === "processing") {
          const moderationResultRef = buildPseudoRef(claimed.song_artifact_bundle_id, "moderation")
          await input.songArtifactRepository.updateSongArtifactBundleModeration({
            bundleId: claimed.song_artifact_bundle_id,
            status: "completed",
            error: null,
            ref: moderationResultRef,
            moderationResult: result.moderationResult,
            updatedAt: nowIso(),
          })
          await applyModerationToPublishedSongPost({
            communityRepository: input.communityRepository,
            bundle: claimed,
            moderationResult: result.moderationResult,
            moderationResultRef,
          })
          counts.moderation_completed_count += 1
        }
      } catch (error) {
        const summary = summarizeError(error)
        if (claimed.translation_status === "processing") {
          await markEnrichmentFailure({
            repository: input.songArtifactRepository,
            bundleId: claimed.song_artifact_bundle_id,
            key: "translation",
            error: summary,
          })
          counts.translation_failed_count += 1
        }
        if (claimed.moderation_status === "processing") {
          await markEnrichmentFailure({
            repository: input.songArtifactRepository,
            bundleId: claimed.song_artifact_bundle_id,
            key: "moderation",
            error: summary,
          })
          counts.moderation_failed_count += 1
        }
      }
    }

    if (claimed.alignment_status === "processing") {
      try {
        const timedLyrics = await alignSongLyrics({
          env: input.env,
          bundle: claimed,
        })
        await input.songArtifactRepository.updateSongArtifactBundleAlignment({
          bundleId: claimed.song_artifact_bundle_id,
          status: "completed",
          error: null,
          ref: buildPseudoRef(claimed.song_artifact_bundle_id, "timed-lyrics"),
          timedLyrics,
          updatedAt: nowIso(),
        })
        counts.alignment_completed_count += 1
      } catch (error) {
        await markEnrichmentFailure({
          repository: input.songArtifactRepository,
          bundleId: claimed.song_artifact_bundle_id,
          key: "alignment",
          error: summarizeError(error),
        })
        counts.alignment_failed_count += 1
      }
    }

    counts.processed_count += 1
  }

  return counts
}

export function parseSongEnrichmentDrainLimit(value: string | null | undefined, env: Env): number {
  const parsed = Number(String(value ?? env.SONG_ENRICHMENT_DRAIN_LIMIT ?? "").trim())
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 10
  }
  return Math.max(1, Math.trunc(parsed))
}
