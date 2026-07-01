import type { ActorContext, AdminActorContext } from "../../auth-middleware"
import { badRequestError, providerUnavailable } from "../../errors"
import { parsePositiveIntegerEnv } from "../../openrouter-client"
import type { CommunityAssistantRepository } from "./access"
import { decryptActiveCommunityElevenLabsKey } from "./credential-service"
import {
  getCommunityAssistantRuntimePolicy,
  getCommunityAssistantRuntimePolicyForCommunity,
  type CommunityAssistantPolicy,
} from "./service"
import type { Env } from "../../../env"

const DEFAULT_ELEVENLABS_TIMEOUT_MS = 120_000
const DEFAULT_ELEVENLABS_STT_MODEL = "scribe_v2"
const DEFAULT_ELEVENLABS_TTS_MODEL = "eleven_flash_v2_5"
const DEFAULT_ELEVENLABS_TTS_OUTPUT_FORMAT = "mp3_44100_128"
export const TELEGRAM_ELEVENLABS_TTS_OUTPUT_FORMAT = "opus_48000_32"
const ELEVENLABS_STT_URL = "https://api.elevenlabs.io/v1/speech-to-text"
const ELEVENLABS_TTS_URL = "https://api.elevenlabs.io/v1/text-to-speech"
export const COMMUNITY_ASSISTANT_MAX_TRANSCRIPTION_AUDIO_BYTES = 20 * 1024 * 1024
const MAX_TTS_TEXT_LENGTH = 2000

const SUPPORTED_TRANSCRIPTION_MIME_TYPES = new Set([
  "audio/aac",
  "audio/flac",
  "audio/m4a",
  "audio/mp3",
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
  "audio/x-m4a",
  "audio/x-wav",
  "video/mp4",
  "video/webm",
])

export type CommunityAssistantTranscriptionResponse = {
  object: "community_assistant_transcription"
  provider: "elevenlabs"
  model: string
  text: string
  confidence: number | null
  language_code: string | null
  language_probability: number | null
  duration_seconds: number | null
}

export type CommunityAudioTranscriptionResponse = Omit<CommunityAssistantTranscriptionResponse, "object"> & {
  object: "community_audio_transcription"
}

export type CommunityAssistantSpeechBody = {
  text?: unknown
}

export type CommunityAssistantSpeechResponse = {
  audio: ArrayBuffer
  characterCount: string | null
  contentType: string
  model: string
  provider: "elevenlabs"
  requestId: string | null
  voiceId: string
}

function elevenLabsTimeoutMs(env: Env): number {
  return parsePositiveIntegerEnv(env.ELEVENLABS_TIMEOUT_MS) ?? DEFAULT_ELEVENLABS_TIMEOUT_MS
}

function normalizeAudioMimeType(file: File): string {
  // Strip any codec/parameter suffix (e.g. "audio/webm;codecs=opus" from
  // MediaRecorder) so the base type matches SUPPORTED_TRANSCRIPTION_MIME_TYPES.
  return String(file.type || "application/octet-stream").split(";")[0].trim().toLowerCase()
}

function assertTranscriptionPolicy(policy: CommunityAssistantPolicy): void {
  if (policy.voiceMode === "off") {
    throw badRequestError("Assistant voice is disabled for this community")
  }
  if (policy.sttProvider !== "elevenlabs") {
    throw badRequestError("Assistant speech-to-text provider is not ElevenLabs")
  }
}

function assertSpeechPolicy(policy: CommunityAssistantPolicy): void {
  if (policy.voiceMode !== "voice_replies" && policy.voiceMode !== "text_and_voice_replies") {
    throw badRequestError("Assistant voice replies are disabled for this community")
  }
  if (policy.ttsProvider !== "elevenlabs") {
    throw badRequestError("Assistant text-to-speech provider is not ElevenLabs")
  }
  if (!policy.ttsVoice.trim()) {
    throw badRequestError("Assistant text-to-speech voice is not configured")
  }
}

function normalizeSpeechText(value: unknown): string {
  if (typeof value !== "string") {
    throw badRequestError("text is required")
  }
  const trimmed = value.trim()
  if (!trimmed) {
    throw badRequestError("text is required")
  }
  if (trimmed.length > MAX_TTS_TEXT_LENGTH) {
    throw badRequestError(`text must be at most ${MAX_TTS_TEXT_LENGTH} characters`)
  }
  return trimmed
}

function normalizeTtsOutputFormat(value: string | null | undefined): string {
  const trimmed = value?.trim()
  return trimmed || DEFAULT_ELEVENLABS_TTS_OUTPUT_FORMAT
}

function numberField(body: Record<string, unknown>, key: string): number | null {
  const value = body[key]
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function stringField(body: Record<string, unknown>, key: string): string | null {
  const value = body[key]
  return typeof value === "string" && value.trim() ? value : null
}

function parseTranscriptionBody(body: unknown, model: string): CommunityAssistantTranscriptionResponse {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw providerUnavailable("ElevenLabs transcription response was not valid JSON")
  }
  const record = body as Record<string, unknown>
  const text = stringField(record, "text")
  if (!text) {
    throw providerUnavailable("ElevenLabs transcription response did not include text")
  }
  return {
    object: "community_assistant_transcription",
    provider: "elevenlabs",
    model,
    text,
    confidence: numberField(record, "confidence"),
    language_code: stringField(record, "language_code"),
    language_probability: numberField(record, "language_probability"),
    duration_seconds: numberField(record, "duration_seconds") ?? numberField(record, "duration"),
  }
}

async function fetchWithTimeout(input: {
  init: RequestInit
  timeoutMs: number
  url: string
}): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs)
  try {
    return await fetch(input.url, {
      ...input.init,
      signal: controller.signal,
    })
  } catch (error) {
    throw providerUnavailable(error instanceof Error && error.name === "AbortError"
      ? "ElevenLabs request timed out"
      : "ElevenLabs request failed")
  } finally {
    clearTimeout(timeout)
  }
}

export async function transcribeCommunityAssistantAudio(input: {
  env: Env
  communityRepository: CommunityAssistantRepository
  communityId: string
  actor: ActorContext | AdminActorContext
  file: File
}): Promise<CommunityAssistantTranscriptionResponse> {
  const policy = await getCommunityAssistantRuntimePolicy(input)
  return transcribeCommunityAssistantAudioWithPolicy({
    communityId: input.communityId,
    env: input.env,
    file: input.file,
    policy,
  })
}

export async function transcribeCommunityAssistantAudioForCommunity(input: {
  env: Env
  communityRepository: CommunityAssistantRepository
  communityId: string
  file: File
}): Promise<CommunityAssistantTranscriptionResponse> {
  const policy = await getCommunityAssistantRuntimePolicyForCommunity({
    env: input.env,
    communityRepository: input.communityRepository,
    communityId: input.communityId,
  })
  return transcribeCommunityAssistantAudioWithPolicy({
    communityId: input.communityId,
    env: input.env,
    file: input.file,
    policy,
  })
}

export async function transcribeCommunityAudioWithElevenLabs(input: {
  communityId: string
  env: Env
  file: File
  model?: string | null
}): Promise<CommunityAudioTranscriptionResponse> {
  return {
    ...await transcribeCommunityAudioWithElevenLabsInternal({
      communityId: input.communityId,
      env: input.env,
      file: input.file,
      model: input.model,
    }),
    object: "community_audio_transcription",
  }
}

async function transcribeCommunityAssistantAudioWithPolicy(input: {
  communityId: string
  env: Env
  file: File
  policy: CommunityAssistantPolicy
}): Promise<CommunityAssistantTranscriptionResponse> {
  assertTranscriptionPolicy(input.policy)

  return {
    ...await transcribeCommunityAudioWithElevenLabsInternal({
      communityId: input.communityId,
      env: input.env,
      file: input.file,
      model: input.policy.sttModel,
    }),
    object: "community_assistant_transcription",
  }
}

async function transcribeCommunityAudioWithElevenLabsInternal(input: {
  communityId: string
  env: Env
  file: File
  model?: string | null
}): Promise<Omit<CommunityAssistantTranscriptionResponse, "object">> {
  const mimeType = normalizeAudioMimeType(input.file)
  if (!SUPPORTED_TRANSCRIPTION_MIME_TYPES.has(mimeType)) {
    throw badRequestError("audio file type is not supported")
  }
  if (input.file.size <= 0) {
    throw badRequestError("audio file is required")
  }
  if (input.file.size > COMMUNITY_ASSISTANT_MAX_TRANSCRIPTION_AUDIO_BYTES) {
    throw badRequestError("audio file must be at most 20MB")
  }

  const model = input.model?.trim() || DEFAULT_ELEVENLABS_STT_MODEL
  const form = new FormData()
  form.set("file", input.file)
  form.set("model_id", model)
  const apiKey = await decryptActiveCommunityElevenLabsKey({
    env: input.env,
    communityId: input.communityId,
  })

  const response = await fetchWithTimeout({
    url: ELEVENLABS_STT_URL,
    timeoutMs: elevenLabsTimeoutMs(input.env),
    init: {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
      },
      body: form,
    },
  })
  if (!response.ok) {
    throw providerUnavailable(`ElevenLabs transcription failed with http_${response.status}`)
  }
  const parsed = parseTranscriptionBody(await response.json().catch(() => null), model)
  return {
    provider: parsed.provider,
    model: parsed.model,
    text: parsed.text,
    confidence: parsed.confidence,
    language_code: parsed.language_code,
    language_probability: parsed.language_probability,
    duration_seconds: parsed.duration_seconds,
  }
}

export async function synthesizeCommunityAssistantSpeech(input: {
  env: Env
  communityRepository: CommunityAssistantRepository
  communityId: string
  actor: ActorContext | AdminActorContext
  body: CommunityAssistantSpeechBody | null
}): Promise<CommunityAssistantSpeechResponse> {
  const policy = await getCommunityAssistantRuntimePolicy(input)
  return synthesizeCommunityAssistantSpeechWithPolicy({
    communityId: input.communityId,
    env: input.env,
    policy,
    text: normalizeSpeechText(input.body?.text),
  })
}

export async function synthesizeCommunityAssistantSpeechForCommunity(input: {
  env: Env
  communityRepository: CommunityAssistantRepository
  communityId: string
  outputFormat?: string | null
  text: string
}): Promise<CommunityAssistantSpeechResponse> {
  const policy = await getCommunityAssistantRuntimePolicyForCommunity({
    env: input.env,
    communityRepository: input.communityRepository,
    communityId: input.communityId,
  })
  return synthesizeCommunityAssistantSpeechWithPolicy({
    communityId: input.communityId,
    env: input.env,
    outputFormat: input.outputFormat,
    policy,
    text: normalizeSpeechText(input.text),
  })
}

async function synthesizeCommunityAssistantSpeechWithPolicy(input: {
  communityId: string
  env: Env
  outputFormat?: string | null
  policy: CommunityAssistantPolicy
  text: string
}): Promise<CommunityAssistantSpeechResponse> {
  assertSpeechPolicy(input.policy)

  const voiceId = input.policy.ttsVoice.trim()
  const model = DEFAULT_ELEVENLABS_TTS_MODEL
  const outputFormat = normalizeTtsOutputFormat(input.outputFormat)
  const url = `${ELEVENLABS_TTS_URL}/${encodeURIComponent(voiceId)}?output_format=${encodeURIComponent(outputFormat)}`
  const apiKey = await decryptActiveCommunityElevenLabsKey({
    env: input.env,
    communityId: input.communityId,
  })
  const response = await fetchWithTimeout({
    url,
    timeoutMs: elevenLabsTimeoutMs(input.env),
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "xi-api-key": apiKey,
      },
      body: JSON.stringify({
        text: input.text,
        model_id: model,
      }),
    },
  })
  if (!response.ok) {
    throw providerUnavailable(`ElevenLabs speech synthesis failed with http_${response.status}`)
  }
  const audio = await response.arrayBuffer()
  if (audio.byteLength === 0) {
    throw providerUnavailable("ElevenLabs speech synthesis returned empty audio")
  }
  return {
    audio,
    characterCount: response.headers.get("x-character-count"),
    contentType: response.headers.get("content-type") || "audio/mpeg",
    model,
    provider: "elevenlabs",
    requestId: response.headers.get("request-id"),
    voiceId,
  }
}
