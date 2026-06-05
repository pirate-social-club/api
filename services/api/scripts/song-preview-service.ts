import { timingSafeEqual } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { generateSongPreviewForBundle } from "../src/lib/song-artifacts/song-artifact-preview-service"
import type { Env } from "../src/env"

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

  const storageRef = await generateSongPreviewForBundle({
    env: process.env as Env,
    communityId: body.community_id,
    songArtifactBundleId: body.song_artifact_bundle,
    expectedPrimaryAudioContentHash: body.primary_audio_content_hash ?? null,
  })

  logSongPreviewEvent("song_preview.preview.completed", {
    request_id: context.requestId,
    community_id: body.community_id,
    song_artifact_bundle: body.song_artifact_bundle,
    has_storage_ref: Boolean(storageRef),
    latency_ms: Date.now() - context.startedAt,
  })

  return jsonResponse({ storage_ref: storageRef })
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
      logSongPreviewWarning("song_preview.preview.failed", {
        request_id: context.requestId,
        error: error instanceof Error ? error.message : String(error),
        latency_ms: Date.now() - context.startedAt,
      })
      return jsonResponse({
        code: "preview_generation_failed",
        message: error instanceof Error ? error.message : "Song preview generation failed",
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
