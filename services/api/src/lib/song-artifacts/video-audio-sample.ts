import { providerUnavailable } from "../errors"
import { trimEnv } from "../env-strings"
import type { Env } from "../../env"
import { fetchSongArtifactBytes } from "./song-artifact-storage"

const DEFAULT_FFMPEG_BIN = "ffmpeg"
const FFMPEG_TIMEOUT_MS = 120_000
const SOURCE_DOWNLOAD_TIMEOUT_MS = 60_000
// Full-resolution source is only needed long enough to demux one short audio
// sample; refuse to pull absurd sources into the container.
const DEFAULT_MAX_SOURCE_BYTES = 512 * 1024 * 1024

export type VideoAudioSampleWindow = {
  start_ms: number
  duration_ms: number
}

export type VideoAudioSampleResult =
  | { kind: "sample"; bytes: Uint8Array; mimeType: "audio/wav" }
  | { kind: "no_audio_track" }
  | { kind: "skipped"; reason: "source_too_large" | "extraction_unavailable" }

type BunSubprocess = {
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  exited: Promise<number>
  kill: (signal?: string) => void
}

type BunRuntime = {
  spawn: (
    command: string[],
    options: { stdin: "ignore"; stdout: "pipe"; stderr: "pipe" }
  ) => BunSubprocess
  file: (path: string) => { size: number }
}

function getBunRuntime(): BunRuntime | null {
  const runtime = (globalThis as typeof globalThis & { Bun?: BunRuntime }).Bun
  return runtime && typeof runtime.spawn === "function" ? runtime : null
}

function secondsFromMs(ms: number): string {
  return (Math.max(0, ms) / 1000).toFixed(3)
}

function maxSourceBytes(env: Env): number {
  const configured = Number(trimEnv(env.VIDEO_ANALYSIS_MAX_SOURCE_BYTES))
  return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_MAX_SOURCE_BYTES
}

async function readResponseBytesWithCap(input: {
  response: Response
  maxBytes: number
  timeoutMs: number
}): Promise<Uint8Array | "source_too_large"> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(providerUnavailable("Video source download timed out"))
    }, input.timeoutMs)
  })
  const chunks: Uint8Array[] = []
  let total = 0

  try {
    const reader = input.response.body?.getReader()
    if (!reader) {
      const bytes = new Uint8Array(await Promise.race([input.response.arrayBuffer(), timeoutPromise]))
      return bytes.byteLength > input.maxBytes ? "source_too_large" : bytes
    }

    while (true) {
      const { done, value } = await Promise.race([reader.read(), timeoutPromise])
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > input.maxBytes) {
        await reader.cancel().catch(() => {})
        return "source_too_large"
      }
      chunks.push(value)
    }
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId)
    }
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

// Runs inside the song-preview container (Bun + native ffmpeg + Filebase
// creds). Unlike audio preview cropping, the source is written to a temp file:
// user MP4s routinely carry the moov atom at the end, which ffmpeg cannot seek
// on a stdin pipe.
export async function extractVideoAudioSampleForObject(input: {
  env: Env
  objectKey: string
  window: VideoAudioSampleWindow
}): Promise<VideoAudioSampleResult> {
  const runtime = getBunRuntime()
  if (!runtime) {
    throw providerUnavailable("Video audio extraction requires the Bun ffmpeg container")
  }

  const response = await fetchSongArtifactBytes({ env: input.env, objectKey: input.objectKey })
  const declaredLength = Number(response.headers.get("content-length") ?? "0")
  const cap = maxSourceBytes(input.env)
  if (Number.isFinite(declaredLength) && declaredLength > cap) {
    return { kind: "skipped", reason: "source_too_large" }
  }

  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const { unlink, writeFile } = await import("node:fs/promises")
  const sourcePath = join(tmpdir(), `video-analysis-${crypto.randomUUID()}.bin`)

  try {
    const sourceBytes = await readResponseBytesWithCap({
      response,
      maxBytes: cap,
      timeoutMs: SOURCE_DOWNLOAD_TIMEOUT_MS,
    })
    if (sourceBytes === "source_too_large") {
      return { kind: "skipped", reason: "source_too_large" }
    }
    await writeFile(sourcePath, sourceBytes)

    const ffmpegBin = trimEnv(input.env.SONG_PREVIEW_FFMPEG_BIN) || DEFAULT_FFMPEG_BIN
    const process = runtime.spawn([
      ffmpegBin,
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      secondsFromMs(input.window.start_ms),
      "-i",
      sourcePath,
      "-t",
      secondsFromMs(input.window.duration_ms),
      "-map",
      "0:a:0",
      "-vn",
      "-ac",
      "1",
      "-ar",
      "8000",
      "-c:a",
      "pcm_s16le",
      "-f",
      "wav",
      "pipe:1",
    ], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })

    const stdoutPromise = new Response(process.stdout).arrayBuffer()
    const stderrPromise = new Response(process.stderr).text()

    let timeoutId: ReturnType<typeof setTimeout> | undefined
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        try {
          process.kill("SIGKILL")
        } catch {
          // The process may have exited between the timeout and kill attempt.
        }
        reject(providerUnavailable("Video audio extraction timed out"))
      }, FFMPEG_TIMEOUT_MS)
    })

    let exitCode: number
    try {
      exitCode = await Promise.race([process.exited, timeoutPromise])
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId)
      }
    }

    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise])
    if (exitCode !== 0) {
      const message = stderr.trim().replace(/\s+/g, " ").slice(0, 500)
      // "does not contain any stream" / "Stream map '0:a:0' matches no streams"
      // = video without an audio track, which is a normal outcome, not a failure.
      if (/matches no streams|does not contain any stream/i.test(message)) {
        return { kind: "no_audio_track" }
      }
      throw providerUnavailable(`Video audio extraction failed: ${message || `ffmpeg exited with code ${exitCode}`}`)
    }
    if (stdout.byteLength <= 44) {
      return { kind: "no_audio_track" }
    }
    return { kind: "sample", bytes: new Uint8Array(stdout), mimeType: "audio/wav" }
  } finally {
    await unlink(sourcePath).catch(() => {})
  }
}

// Worker-side client: asks the song-preview container (which owns native
// ffmpeg) for the sample. Shares the service binding / URL + shared secret
// with the preview flow; only the path differs. Staging and prod reach the
// container through the SONG_PREVIEW_SERVICE binding, so a configured URL is
// optional — the internal hostname is only a routing placeholder then.
export async function requestVideoAudioSampleFromService(input: {
  env: Env
  serviceUrl: string | null
  objectKey: string
  window: VideoAudioSampleWindow
  timeoutMs: number
}): Promise<VideoAudioSampleResult> {
  let url: URL
  if (input.serviceUrl) {
    url = new URL(input.serviceUrl)
    url.pathname = "/extract-audio-sample"
  } else {
    url = new URL("https://song-preview-service.internal/extract-audio-sample")
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), input.timeoutMs)
  let response: Response
  try {
    const request = new Request(url.toString(), {
      method: "POST",
      headers: {
        authorization: `Bearer ${trimEnv(input.env.SONG_PREVIEW_SHARED_SECRET)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        object_key: input.objectKey,
        start_ms: input.window.start_ms,
        duration_ms: input.window.duration_ms,
      }),
      signal: controller.signal,
    })
    response = input.env.SONG_PREVIEW_SERVICE
      ? await input.env.SONG_PREVIEW_SERVICE.fetch(request)
      : await fetch(request)
  } catch (error) {
    throw providerUnavailable(
      `Video audio extraction service unreachable: ${error instanceof Error ? error.message : String(error)}`,
    )
  } finally {
    clearTimeout(timer)
  }

  const body = await response.json().catch(() => null) as {
    kind?: string
    reason?: string
    sample_base64?: string
  } | null
  if (!response.ok || !body || typeof body.kind !== "string") {
    throw providerUnavailable(`Video audio extraction service failed with status ${response.status}`)
  }
  if (body.kind === "no_audio_track") {
    return { kind: "no_audio_track" }
  }
  if (body.kind === "skipped" && (body.reason === "source_too_large" || body.reason === "extraction_unavailable")) {
    return { kind: "skipped", reason: body.reason }
  }
  if (body.kind === "sample" && typeof body.sample_base64 === "string" && body.sample_base64) {
    return {
      kind: "sample",
      bytes: Uint8Array.from(atob(body.sample_base64), (char) => char.charCodeAt(0)),
      mimeType: "audio/wav",
    }
  }
  throw providerUnavailable("Video audio extraction service returned an invalid response")
}
