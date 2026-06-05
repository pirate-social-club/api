import { generateSongPreviewForBundle } from "../../song-artifacts/song-artifact-preview-service"
import { providerUnavailable } from "../../errors"
import type { CommunityJobHandlerInput } from "./handler-types"
import { parseJobPayload } from "./payload"

const DEFAULT_SONG_PREVIEW_SERVICE_TIMEOUT_MS = 120_000

type SongPreviewGeneratePayload = {
  song_artifact_bundle?: string | null
  primary_audio_content_hash?: string | null
  preview_window?: {
    start_ms: number
    duration_ms: number
  } | null
}

type SongPreviewServiceResponse = {
  storage_ref?: string | null
}

type BunRuntime = {
  spawn?: unknown
}

function trimEnvValue(value: string | undefined): string {
  return String(value ?? "").trim()
}

function positiveIntegerEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(trimEnvValue(value))
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function isLocalServiceHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
}

function songPreviewServiceEndpoint(input: CommunityJobHandlerInput): string | null {
  const configured = trimEnvValue(input.env.SONG_PREVIEW_SERVICE_URL)
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
  if (url.pathname === "" || url.pathname === "/") {
    url.pathname = "/preview"
  }
  return url.toString()
}

function songPreviewServiceTimeoutMs(input: CommunityJobHandlerInput): number {
  return positiveIntegerEnv(input.env.SONG_PREVIEW_SERVICE_TIMEOUT_MS, DEFAULT_SONG_PREVIEW_SERVICE_TIMEOUT_MS)
}

function canRunLocalFfmpegWorker(input: CommunityJobHandlerInput): boolean {
  if (trimEnvValue(input.env.SONG_PREVIEW_FFMPEG_BIN) === "__test_passthrough__") {
    return true
  }
  const runtime = (globalThis as typeof globalThis & { Bun?: BunRuntime }).Bun
  return Boolean(runtime && typeof runtime.spawn === "function")
}

async function readErrorBody(response: Response): Promise<string | null> {
  const text = await response.text().catch(() => "")
  return text.trim() ? text.trim().slice(0, 500) : null
}

async function runRemoteSongPreviewGenerate(
  input: CommunityJobHandlerInput,
  endpoint: string | null,
  payload: SongPreviewGeneratePayload | null,
): Promise<string | null> {
  const sharedSecret = trimEnvValue(input.env.SONG_PREVIEW_SHARED_SECRET)
  if (!sharedSecret) {
    throw providerUnavailable("Song preview service shared secret is not configured", {
      reason: "song_preview_service_secret_missing",
    })
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), songPreviewServiceTimeoutMs(input))
  let response: Response
  try {
    const request = new Request(endpoint ?? "https://song-preview-service.internal/preview", {
      method: "POST",
      headers: {
        "authorization": `Bearer ${sharedSecret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        community_id: input.job.community_id,
        song_artifact_bundle: payload?.song_artifact_bundle ?? input.job.subject_id,
        primary_audio_content_hash: payload?.primary_audio_content_hash ?? null,
      }),
      signal: controller.signal,
    })
    response = input.env.SONG_PREVIEW_SERVICE
      ? await input.env.SONG_PREVIEW_SERVICE.fetch(request)
      : await fetch(request)
  } catch (error) {
    throw providerUnavailable(error instanceof Error && error.name === "AbortError"
      ? "Song preview service request timed out"
      : "Song preview service request failed", {
        reason: error instanceof Error ? error.message : String(error),
      })
  } finally {
    clearTimeout(timeoutId)
  }

  if (!response.ok) {
    throw providerUnavailable("Song preview service rejected the request", {
      status: response.status,
      body: await readErrorBody(response),
    })
  }

  const body = await response.json().catch(() => null) as SongPreviewServiceResponse | null
  if (!body || (body.storage_ref != null && typeof body.storage_ref !== "string")) {
    throw providerUnavailable("Song preview service returned an invalid response")
  }
  return body.storage_ref ?? null
}

export async function runSongPreviewGenerate(input: CommunityJobHandlerInput): Promise<string | null> {
  const payload = parseJobPayload<SongPreviewGeneratePayload>(input.job.payload_json)
  const endpoint = songPreviewServiceEndpoint(input)
  if (endpoint || input.env.SONG_PREVIEW_SERVICE) {
    return await runRemoteSongPreviewGenerate(input, endpoint, payload)
  }

  if (!canRunLocalFfmpegWorker(input)) {
    throw providerUnavailable("Song preview cropping requires a Node-only ffmpeg worker", {
      reason: "song_preview_worker_not_configured",
    })
  }

  return await generateSongPreviewForBundle({
    env: input.env,
    communityId: input.job.community_id,
    songArtifactBundleId: payload?.song_artifact_bundle ?? input.job.subject_id,
    expectedPrimaryAudioContentHash: payload?.primary_audio_content_hash ?? null,
  })
}
