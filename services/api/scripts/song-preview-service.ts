import { timingSafeEqual } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { generateSongPreviewForBundle } from "../src/lib/song-artifacts/song-artifact-preview-service"
import { permanentPreviewFailure } from "../src/lib/song-artifacts/song-preview-failure"
import { extractVideoAudioSampleForObject } from "../src/lib/song-artifacts/video-audio-sample"
import { getSongArtifactBundle } from "../src/lib/song-artifacts/song-artifact-repository"
import { findUploadedSongArtifactByStorageRef } from "../src/lib/song-artifacts/song-artifact-upload-repository"
import { fetchSongArtifactBytes } from "../src/lib/song-artifacts/song-artifact-storage"
import type { Env } from "../src/env"
import { withStandaloneControlPlaneClient } from "../src/lib/runtime-deps"

const DEFAULT_PORT = 8795
const DEFAULT_MAX_BODY_BYTES = 64 * 1024

type SongPreviewRequestBody = {
  community_id: string
  song_artifact_bundle: string
  primary_audio_content_hash?: string | null
}

type SongPreviewRequestContext = {
  requestId: string
  startedAt: number
}

function trimEnv(name: string): string {
  return process.env[name]?.trim() ?? ""
}

function numberEnv(name: string, fallback: number): number {
  const value = Number(trimEnv(name))
  return Number.isInteger(value) && value > 0 ? value : fallback
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  })
}

function makeRequestId(): string {
  return `spv_${crypto.randomUUID().replace(/-/gu, "")}`
}

function logSongPreviewEvent(event: string, details: Record<string, unknown>): void {
  console.log(JSON.stringify({
    event,
    service: "song-preview",
    ...details,
  }))
}

function logSongPreviewWarning(event: string, details: Record<string, unknown>): void {
  console.warn(JSON.stringify({
    event,
    service: "song-preview",
    ...details,
  }))
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  if (leftBuffer.length !== rightBuffer.length) return false
  return timingSafeEqual(leftBuffer, rightBuffer)
}

function bearerToken(request: Request): string {
  const header = request.headers.get("authorization") ?? ""
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : ""
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value)
}

function readSongPreviewRequestBody(value: unknown): SongPreviewRequestBody | null {
  if (!isRecord(value)) return null
  if (typeof value.community_id !== "string" || !value.community_id.trim()) return null
  if (typeof value.song_artifact_bundle !== "string" || !value.song_artifact_bundle.trim()) return null
  if (
    value.primary_audio_content_hash !== undefined
    && value.primary_audio_content_hash !== null
    && typeof value.primary_audio_content_hash !== "string"
  ) {
    return null
  }

  return {
    community_id: value.community_id.trim(),
    song_artifact_bundle: value.song_artifact_bundle.trim(),
    primary_audio_content_hash: typeof value.primary_audio_content_hash === "string"
      ? value.primary_audio_content_hash.trim() || null
      : null,
  }
}

async function handlePreview(request: Request, context: SongPreviewRequestContext): Promise<Response> {
  const sharedSecret = trimEnv("SONG_PREVIEW_SHARED_SECRET")
  if (!sharedSecret || !constantTimeEqual(bearerToken(request), sharedSecret)) {
    logSongPreviewWarning("song_preview.preview.rejected", {
      request_id: context.requestId,
      reason: sharedSecret ? "unauthorized" : "not_configured",
      latency_ms: Date.now() - context.startedAt,
    })
    return jsonResponse(
      sharedSecret
        ? { code: "unauthorized", message: "Unauthorized" }
        : { code: "not_configured", message: "Song preview shared secret is not configured" },
      sharedSecret ? 401 : 503,
    )
  }

  const contentLength = Number(request.headers.get("content-length") ?? "0")
  const maxBodyBytes = numberEnv("SONG_PREVIEW_MAX_BODY_BYTES", DEFAULT_MAX_BODY_BYTES)
  if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
    logSongPreviewWarning("song_preview.preview.rejected", {
      request_id: context.requestId,
      reason: "payload_too_large",
      content_length: contentLength,
      latency_ms: Date.now() - context.startedAt,
    })
    return jsonResponse({ code: "payload_too_large", message: "Request body is too large" }, 413)
  }

  const body = readSongPreviewRequestBody(await request.json().catch(() => null))
  if (!body) {
    logSongPreviewWarning("song_preview.preview.rejected", {
      request_id: context.requestId,
      reason: "bad_request",
      latency_ms: Date.now() - context.startedAt,
    })
    return jsonResponse({ code: "bad_request", message: "Invalid song preview request" }, 400)
  }

  logSongPreviewEvent("song_preview.preview.started", {
    request_id: context.requestId,
    community_id: body.community_id,
    song_artifact_bundle: body.song_artifact_bundle,
    has_expected_hash: Boolean(body.primary_audio_content_hash),
    content_length: Number.isFinite(contentLength) ? contentLength : null,
  })

  const env = process.env as Env
  const storageRef = await withStandaloneControlPlaneClient(env, (client) => generateSongPreviewForBundle({
    env,
    client,
    communityId: body.community_id,
    songArtifactBundleId: body.song_artifact_bundle,
    expectedPrimaryAudioContentHash: body.primary_audio_content_hash ?? null,
  }))

  logSongPreviewEvent("song_preview.preview.completed", {
    request_id: context.requestId,
    community_id: body.community_id,
    song_artifact_bundle: body.song_artifact_bundle,
    has_storage_ref: Boolean(storageRef),
    latency_ms: Date.now() - context.startedAt,
  })

  return jsonResponse({ storage_ref: storageRef })
}

async function probeDurationMs(bytes: Uint8Array): Promise<number | null> {
  const process = Bun.spawn([
    "ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", "pipe:0",
  ], { stdin: new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer]), stdout: "pipe", stderr: "pipe" })
  const timeout = setTimeout(() => process.kill(), 30_000)
  try {
    const [exitCode, output] = await Promise.all([process.exited, new Response(process.stdout).text()])
    if (exitCode !== 0) return null
    const parsed = JSON.parse(output) as { format?: { duration?: unknown } }
    const seconds = Number(parsed.format?.duration)
    return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null
  } finally {
    clearTimeout(timeout)
  }
}

async function handleDuration(request: Request, context: SongPreviewRequestContext): Promise<Response> {
  const sharedSecret = trimEnv("SONG_PREVIEW_SHARED_SECRET")
  if (!sharedSecret || !constantTimeEqual(bearerToken(request), sharedSecret)) {
    return jsonResponse(sharedSecret ? { code: "unauthorized", message: "Unauthorized" } : { code: "not_configured", message: "Song preview shared secret is not configured" }, sharedSecret ? 401 : 503)
  }
  const body = readSongPreviewRequestBody(await request.json().catch(() => null))
  if (!body) return jsonResponse({ code: "bad_request", message: "Invalid duration request" }, 400)

  const env = process.env as Env
  const durationMs = await withStandaloneControlPlaneClient(env, async (client) => {
    const bundle = await getSongArtifactBundle(client, body.community_id, body.song_artifact_bundle)
    if (!bundle) return null
    if (bundle.primary_audio.duration_ms && bundle.primary_audio.duration_ms > 0) {
      return bundle.primary_audio.duration_ms
    }
    const upload = await findUploadedSongArtifactByStorageRef({
      client,
      communityId: body.community_id,
      storageRef: bundle.primary_audio.storage_ref,
      artifactKind: "primary_audio",
    })
    if (!upload?.storage_object_key) return null
    const response = await fetchSongArtifactBytes({ env, objectKey: upload.storage_object_key })
    return probeDurationMs(new Uint8Array(await response.arrayBuffer()))
  })
  logSongPreviewEvent("song_duration.probed", {
    request_id: context.requestId,
    community_id: body.community_id,
    song_artifact_bundle: body.song_artifact_bundle,
    duration_ms: durationMs,
    latency_ms: Date.now() - context.startedAt,
  })
  return durationMs ? jsonResponse({ duration_ms: durationMs }) : jsonResponse({ code: "duration_unavailable", message: "Could not determine audio duration" }, 422)
}

type ExtractAudioSampleRequestBody = {
  object_key: string
  start_ms: number
  duration_ms: number
}

function readExtractAudioSampleRequestBody(value: unknown): ExtractAudioSampleRequestBody | null {
  if (!isRecord(value)) return null
  if (typeof value.object_key !== "string" || !value.object_key.trim()) return null
  const startMs = Number(value.start_ms)
  const durationMs = Number(value.duration_ms)
  if (!Number.isInteger(startMs) || startMs < 0) return null
  if (!Number.isInteger(durationMs) || durationMs <= 0 || durationMs > 120_000) return null
  return {
    object_key: value.object_key.trim(),
    start_ms: startMs,
    duration_ms: durationMs,
  }
}

async function handleExtractAudioSample(request: Request, context: SongPreviewRequestContext): Promise<Response> {
  const sharedSecret = trimEnv("SONG_PREVIEW_SHARED_SECRET")
  if (!sharedSecret || !constantTimeEqual(bearerToken(request), sharedSecret)) {
    logSongPreviewWarning("video_audio_sample.rejected", {
      request_id: context.requestId,
      reason: sharedSecret ? "unauthorized" : "not_configured",
      latency_ms: Date.now() - context.startedAt,
    })
    return jsonResponse(
      sharedSecret
        ? { code: "unauthorized", message: "Unauthorized" }
        : { code: "not_configured", message: "Song preview shared secret is not configured" },
      sharedSecret ? 401 : 503,
    )
  }

  const body = readExtractAudioSampleRequestBody(await request.json().catch(() => null))
  if (!body) {
    logSongPreviewWarning("video_audio_sample.rejected", {
      request_id: context.requestId,
      reason: "bad_request",
      latency_ms: Date.now() - context.startedAt,
    })
    return jsonResponse({ code: "bad_request", message: "Invalid audio sample request" }, 400)
  }

  logSongPreviewEvent("video_audio_sample.started", {
    request_id: context.requestId,
    object_key: body.object_key,
    start_ms: body.start_ms,
    duration_ms: body.duration_ms,
  })

  const result = await extractVideoAudioSampleForObject({
    env: process.env as Env,
    objectKey: body.object_key,
    window: { start_ms: body.start_ms, duration_ms: body.duration_ms },
  })

  logSongPreviewEvent("video_audio_sample.completed", {
    request_id: context.requestId,
    object_key: body.object_key,
    kind: result.kind,
    sample_bytes: result.kind === "sample" ? result.bytes.byteLength : 0,
    latency_ms: Date.now() - context.startedAt,
  })

  if (result.kind === "sample") {
    return jsonResponse({
      kind: "sample",
      sample_base64: Buffer.from(result.bytes).toString("base64"),
      sample_mime_type: result.mimeType,
      byte_length: result.bytes.byteLength,
    })
  }
  return jsonResponse(result.kind === "skipped" ? { kind: "skipped", reason: result.reason } : { kind: result.kind })
}

const port = numberEnv("SONG_PREVIEW_PORT", numberEnv("PORT", DEFAULT_PORT))
const hostname = trimEnv("HOST") || "127.0.0.1"

async function readRequestBody(req: IncomingMessage): Promise<Uint8Array | null> {
  const chunks: Uint8Array[] = []
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
  }
  return chunks.length > 0 ? Buffer.concat(chunks) : null
}

async function toRequest(req: IncomingMessage): Promise<Request> {
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item)
      }
    } else if (value != null) {
      headers.set(key, value)
    }
  }

  const rawBody = req.method === "GET" || req.method === "HEAD"
    ? null
    : await readRequestBody(req)
  const body: BodyInit | undefined = rawBody ? new ReadableStream({
    start(controller) {
      controller.enqueue(rawBody)
      controller.close()
    },
  }) : undefined

  return new Request(`http://${req.headers.host || `${hostname}:${port}`}${req.url || "/"}`, {
    method: req.method,
    headers,
    body,
  })
}

async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status
  response.headers.forEach((value, key) => {
    res.setHeader(key, value)
  })
  res.end(Buffer.from(await response.arrayBuffer()))
}

async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url)
  if (request.method === "GET" && url.pathname === "/health") {
    return jsonResponse({ ok: true })
  }
  if (request.method === "POST" && url.pathname === "/preview") {
    const context = {
      requestId: makeRequestId(),
      startedAt: Date.now(),
    }
    return handlePreview(request, context).catch((error) => {
      const permanent = permanentPreviewFailure(error)
      logSongPreviewWarning("song_preview.preview.failed", {
        request_id: context.requestId,
        error: error instanceof Error ? error.message : String(error),
        code: permanent?.code ?? null,
        permanent: Boolean(permanent),
        latency_ms: Date.now() - context.startedAt,
      })
      if (permanent) {
        return jsonResponse({
          code: permanent.code,
          message: permanent.message,
          details: permanent.details,
        }, permanent.status)
      }
      return jsonResponse({
        code: "preview_generation_failed",
        message: error instanceof Error ? error.message : "Song preview generation failed",
      }, 502)
    })
  }
  if (request.method === "POST" && url.pathname === "/duration") {
    const context = { requestId: makeRequestId(), startedAt: Date.now() }
    return handleDuration(request, context).catch((error) => jsonResponse({
      code: "duration_probe_failed",
      message: error instanceof Error ? error.message : "Duration probe failed",
    }, 502))
  }
  if (request.method === "POST" && url.pathname === "/extract-audio-sample") {
    const context = {
      requestId: makeRequestId(),
      startedAt: Date.now(),
    }
    return handleExtractAudioSample(request, context).catch((error) => {
      logSongPreviewWarning("video_audio_sample.failed", {
        request_id: context.requestId,
        error: error instanceof Error ? error.message : String(error),
        latency_ms: Date.now() - context.startedAt,
      })
      return jsonResponse({
        code: "audio_sample_extraction_failed",
        message: error instanceof Error ? error.message : "Video audio sample extraction failed",
      }, 502)
    })
  }
  return jsonResponse({ code: "not_found", message: "Not found" }, 404)
}

const server = createServer(async (req, res) => {
  const maxBodyBytes = numberEnv("SONG_PREVIEW_MAX_BODY_BYTES", DEFAULT_MAX_BODY_BYTES)
  const contentLength = Number(req.headers["content-length"] ?? "0")
  if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
    await writeResponse(res, jsonResponse({ code: "payload_too_large", message: "Request body is too large" }, 413))
    return
  }

  try {
    await writeResponse(res, await handleRequest(await toRequest(req)))
  } catch (error) {
    await writeResponse(res, jsonResponse({
      code: "internal_error",
      message: error instanceof Error ? error.message : "Internal server error",
    }, 500))
  }
})

server.listen(port, hostname, () => {
  console.log(`song preview service listening on http://${hostname}:${port}`)
})
