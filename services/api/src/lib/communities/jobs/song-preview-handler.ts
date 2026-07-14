import { trimEnv } from "../../env-strings"
import { openCommunityWriteClient } from "../community-read-access"
import { generateSongPreviewForBundle } from "../../song-artifacts/song-artifact-preview-service"
import { getSongArtifactBundle, updateSongArtifactBundlePreview } from "../../song-artifacts/song-artifact-repository"
import { permanentPreviewFailureCode } from "../../song-artifacts/song-preview-failure"
import { syncLockedSongPreviewMediaRefsForBundle } from "../../posts/community-post-mutation-store"
import { HttpError, providerUnavailable, SONG_CONTENT_HASH_MISMATCH_CODE } from "../../errors"
import { nowIso } from "../../helpers"
import { getControlPlaneClient } from "../../runtime-deps"
import { captureScheduledWarning } from "../../ops-alerts/scheduled"
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

type SongPreviewFailureUpdater = typeof updateSongArtifactBundlePreview
type CompletedPreviewPostSyncer = typeof syncCompletedPreviewToLockedSongPosts

type BunRuntime = {
  spawn?: unknown
}

let songPreviewFailureUpdater: SongPreviewFailureUpdater = updateSongArtifactBundlePreview
let completedPreviewPostSyncer: CompletedPreviewPostSyncer = syncCompletedPreviewToLockedSongPosts

export function setSongPreviewFailureUpdaterForTests(updater: SongPreviewFailureUpdater | null): void {
  songPreviewFailureUpdater = updater ?? updateSongArtifactBundlePreview
}

export function setCompletedPreviewPostSyncerForTests(syncer: CompletedPreviewPostSyncer | null): void {
  completedPreviewPostSyncer = syncer ?? syncCompletedPreviewToLockedSongPosts
}

function positiveIntegerEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(trimEnv(value))
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function isLocalServiceHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
}

function songPreviewServiceEndpoint(input: CommunityJobHandlerInput): string | null {
  const configured = trimEnv(input.env.SONG_PREVIEW_SERVICE_URL)
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
  if (trimEnv(input.env.SONG_PREVIEW_FFMPEG_BIN) === "__test_passthrough__") {
    return true
  }
  const runtime = (globalThis as typeof globalThis & { Bun?: BunRuntime }).Bun
  return Boolean(runtime && typeof runtime.spawn === "function")
}

async function readErrorBody(response: Response): Promise<string | null> {
  const text = await response.text().catch(() => "")
  return text.trim() ? text.trim().slice(0, 500) : null
}

function previewFailureMessage(error: unknown): string {
  if (error instanceof HttpError && error.details) {
    const details = error.details as { body?: unknown; status?: unknown }
    const status = typeof details.status === "number" ? `status=${details.status}` : null
    const body = typeof details.body === "string" && details.body.trim()
      ? `body=${details.body.trim()}`
      : null
    const suffix = [status, body].filter(Boolean).join(" ")
    return suffix ? `${error.message} (${suffix})` : error.message
  }
  const message = error instanceof Error ? error.message : String(error)
  return message || "preview_generation_failed"
}

function previewServiceFailureCode(body: string | null): string {
  if (!body) return "song_preview_rejected"
  try {
    const parsed = JSON.parse(body) as { code?: unknown }
    return typeof parsed.code === "string" && parsed.code.trim()
      ? parsed.code.trim()
      : "song_preview_rejected"
  } catch {
    return "song_preview_rejected"
  }
}

// A structured log alone reaches nobody. Route the mismatch through ops-alerts so a
// disagreement between stored bytes and the uploader's declared hash actually pages.
// urgency=high on purpose: the real mismatch rate is unmeasured, so the first
// occurrence is the signal we are waiting for. The ops-alert deduper collapses these
// per bucket, so this cannot turn into a flood. Dial down once the rate is known.
async function reportSongContentHashMismatch(
  input: CommunityJobHandlerInput,
  songArtifactBundleId: string,
  error: unknown,
): Promise<void> {
  const details = error instanceof HttpError ? error.details : null
  console.error(JSON.stringify({
    event: "song_preview.content_hash_mismatch",
    community_id: input.job.community_id,
    details,
    job_id: input.job.job_id,
    service: "api",
    song_artifact_bundle: songArtifactBundleId,
  }))
  const hashes = (details ?? {}) as {
    source_content_hash?: unknown
    upload_content_hash?: unknown
  }
  try {
    await captureScheduledWarning(
      input.env,
      `Song primary audio content hash does not match stored bytes (${SONG_CONTENT_HASH_MISMATCH_CODE})`,
      "song_preview_generate",
      {
        // The sink renders only a fixed whitelist of scalar keys plus
        // failed_communities[{community_id, error}], and counts communities from that
        // same array. Anything else never reaches whoever is paged, so put the
        // actionable facts in here rather than in loose keys.
        failed_communities: [{
          community_id: input.job.community_id,
          error: `${songArtifactBundleId}: declared ${String(hashes.upload_content_hash ?? "unknown")}`
            + ` != stored ${String(hashes.source_content_hash ?? "unknown")}`,
        }],
      },
      { urgency: "high", song_preview_failure: SONG_CONTENT_HASH_MISMATCH_CODE },
    )
  } catch (alertError) {
    // Never let a failing alert sink turn a terminal job into a retried one.
    console.warn(JSON.stringify({
      event: "song_preview.content_hash_mismatch_alert_failed",
      error: alertError instanceof Error ? alertError.message : String(alertError),
      service: "api",
    }))
  }
}

async function markRemoteSongPreviewFailed(
  input: CommunityJobHandlerInput,
  songArtifactBundleId: string,
  error: unknown,
): Promise<void> {
  await songPreviewFailureUpdater({
    client: getControlPlaneClient(input.env),
    communityId: input.job.community_id,
    songArtifactBundleId,
    previewAudio: null,
    previewStatus: "failed",
    previewError: previewFailureMessage(error),
    updatedAt: nowIso(),
  })
}

async function runRemoteSongPreviewGenerate(
  input: CommunityJobHandlerInput,
  endpoint: string | null,
  payload: SongPreviewGeneratePayload | null,
): Promise<string | null> {
  const sharedSecret = trimEnv(input.env.SONG_PREVIEW_SHARED_SECRET)
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
    const body = await readErrorBody(response)
    // A 4xx is a deterministic fault in the bundle itself. Wrapping it as
    // providerUnavailable would mark it retryable and burn every attempt
    // re-downloading bytes that will never hash differently.
    if (response.status >= 400 && response.status < 500) {
      throw new HttpError(
        response.status,
        previewServiceFailureCode(body),
        "Song preview service rejected the bundle",
        false,
        { body, status: response.status },
      )
    }
    throw providerUnavailable("Song preview service rejected the request", {
      status: response.status,
      body,
    })
  }

  const body = await response.json().catch(() => null) as SongPreviewServiceResponse | null
  if (!body || (body.storage_ref != null && typeof body.storage_ref !== "string")) {
    throw providerUnavailable("Song preview service returned an invalid response")
  }
  return body.storage_ref ?? null
}

async function syncCompletedPreviewToLockedSongPosts(input: CommunityJobHandlerInput, songArtifactBundleId: string): Promise<void> {
  const controlClient = getControlPlaneClient(input.env)
  const bundle = await getSongArtifactBundle(controlClient, input.job.community_id, songArtifactBundleId)
  if (!bundle?.preview_audio || bundle.preview_status !== "completed") {
    return
  }

  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.job.community_id)
  try {
    const updatedAt = nowIso()
    const posts = await syncLockedSongPreviewMediaRefsForBundle({
      executor: db.client,
      songArtifactBundleId,
      previewAudio: bundle.preview_audio,
      now: updatedAt,
    })
    for (const post of posts) {
      await input.communityRepository.updateCommunityPostProjectionPayload({
        postId: post.post_id,
        projectedPayloadJson: JSON.stringify(post),
        updatedAt,
      })
    }
  } finally {
    db.close()
  }
}

export async function runSongPreviewGenerate(input: CommunityJobHandlerInput): Promise<string | null> {
  const payload = parseJobPayload<SongPreviewGeneratePayload>(input.job.payload_json)
  const songArtifactBundleId = payload?.song_artifact_bundle ?? input.job.subject_id
  const endpoint = songPreviewServiceEndpoint(input)
  if (endpoint || input.env.SONG_PREVIEW_SERVICE) {
    try {
      const result = await runRemoteSongPreviewGenerate(input, endpoint, payload)
      await completedPreviewPostSyncer(input, songArtifactBundleId)
      return result
    } catch (error) {
      const permanentCode = permanentPreviewFailureCode(error)
      if (error instanceof HttpError && error.details) {
        console.warn(JSON.stringify({
          event: "song_preview.remote.failed",
          community_id: input.job.community_id,
          details: error.details,
          error: error.message,
          job_id: input.job.job_id,
          service: "api",
          song_artifact_bundle: songArtifactBundleId,
        }))
      }
      if (permanentCode === SONG_CONTENT_HASH_MISMATCH_CODE) {
        await reportSongContentHashMismatch(input, songArtifactBundleId, error)
      }
      await markRemoteSongPreviewFailed(input, songArtifactBundleId, error)
      if (permanentCode) {
        // Terminal: completing with a failed result stops the retry loop. Throwing here
        // would retry a fault that cannot succeed.
        return `failed:${permanentCode}`
      }
      throw error
    }
  }

  if (!canRunLocalFfmpegWorker(input)) {
    throw providerUnavailable("Song preview cropping requires a Node-only ffmpeg worker", {
      reason: "song_preview_worker_not_configured",
    })
  }

  let result: string | null
  try {
    result = await generateSongPreviewForBundle({
      env: input.env,
      communityId: input.job.community_id,
      songArtifactBundleId,
      expectedPrimaryAudioContentHash: payload?.primary_audio_content_hash ?? null,
    })
  } catch (error) {
    const permanentCode = permanentPreviewFailureCode(error)
    if (permanentCode === SONG_CONTENT_HASH_MISMATCH_CODE) {
      await reportSongContentHashMismatch(input, songArtifactBundleId, error)
    }
    if (permanentCode) {
      await markRemoteSongPreviewFailed(input, songArtifactBundleId, error)
      return `failed:${permanentCode}`
    }
    throw error
  }
  await completedPreviewPostSyncer(input, songArtifactBundleId)
  return result
}
