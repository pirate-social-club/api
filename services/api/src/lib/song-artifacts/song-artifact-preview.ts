import { badRequestError, providerUnavailable } from "../errors"
import { trimEnv } from "../env-strings"
import type { Env } from "../../env"
import type { CreateSongArtifactBundleRequest } from "../../types"

export type SongPreviewWindow = NonNullable<CreateSongArtifactBundleRequest["preview_window"]>

const DEFAULT_FFMPEG_BIN = "ffmpeg"
const FFMPEG_TIMEOUT_MS = 60_000

type BunPipe = {
  write: (chunk: Uint8Array) => void
  end: () => void
}

type BunSubprocess = {
  stdin: BunPipe | null
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  exited: Promise<number>
  kill: (signal?: string) => void
}

type BunRuntime = {
  spawn: (
    command: string[],
    options: {
      stdin: "pipe"
      stdout: "pipe"
      stderr: "pipe"
    }
  ) => BunSubprocess
}

export function parseSongPreviewWindow(input: CreateSongArtifactBundleRequest["preview_window"]): SongPreviewWindow | null {
  if (!input) {
    return null
  }
  const startMs = Math.max(0, Math.trunc(Number(input.start_ms)))
  const durationMs = Math.max(1, Math.trunc(Number(input.duration_ms)))
  if (!Number.isFinite(startMs) || !Number.isFinite(durationMs)) {
    throw badRequestError("preview_window must include numeric start_ms and duration_ms")
  }
  return {
    start_ms: startMs,
    duration_ms: Math.min(durationMs, 30_000),
  }
}

function estimateWavDurationMs(bytes: Uint8Array): number | null {
  if (
    bytes.byteLength < 44
    || bytes[0] !== 0x52
    || bytes[1] !== 0x49
    || bytes[2] !== 0x46
    || bytes[3] !== 0x46
    || bytes[8] !== 0x57
    || bytes[9] !== 0x41
    || bytes[10] !== 0x56
    || bytes[11] !== 0x45
  ) {
    return null
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const byteRate = view.getUint32(28, true)
  const dataSize = view.getUint32(40, true)
  if (!byteRate || !dataSize) {
    return null
  }
  return Math.max(1, Math.round((dataSize / byteRate) * 1000))
}

function getBunRuntime(): BunRuntime | null {
  const runtime = (globalThis as typeof globalThis & { Bun?: BunRuntime }).Bun
  return runtime && typeof runtime.spawn === "function" ? runtime : null
}

function secondsFromMs(ms: number): string {
  return (Math.max(0, ms) / 1000).toFixed(3)
}

function cleanFfmpegError(stderr: string, fallback: string): string {
  const message = stderr.trim().replace(/\s+/g, " ")
  return message ? message.slice(0, 500) : fallback
}

async function cropAudioPreviewWithBunFfmpeg(input: {
  ffmpegBin: string
  sourceBytes: Uint8Array
  previewWindow: SongPreviewWindow
}): Promise<Uint8Array> {
  const runtime = getBunRuntime()
  if (!runtime) {
    throw providerUnavailable("Song preview cropping requires a Node-only ffmpeg worker")
  }

  let process: BunSubprocess
  try {
    process = runtime.spawn([
      input.ffmpegBin,
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "pipe:0",
      "-ss",
      secondsFromMs(input.previewWindow.start_ms),
      "-t",
      secondsFromMs(input.previewWindow.duration_ms),
      "-map",
      "0:a:0",
      "-vn",
      "-codec:a",
      "libmp3lame",
      "-b:a",
      "128k",
      "-f",
      "mp3",
      "pipe:1",
    ], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw providerUnavailable(`Song preview cropping requires ffmpeg: ${message}`)
  }

  const stdoutPromise = new Response(process.stdout).arrayBuffer()
  const stderrPromise = new Response(process.stderr).text()

  if (!process.stdin) {
    process.kill("SIGKILL")
    throw providerUnavailable("Song preview cropping could not open ffmpeg stdin")
  }
  process.stdin.write(input.sourceBytes)
  process.stdin.end()

  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      try {
        process.kill("SIGKILL")
      } catch {
        // The process may have exited between the timeout and kill attempt.
      }
      reject(providerUnavailable("Song preview cropping timed out"))
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
    throw providerUnavailable(`Song preview cropping failed: ${cleanFfmpegError(stderr, `ffmpeg exited with code ${exitCode}`)}`)
  }
  if (stdout.byteLength === 0) {
    throw providerUnavailable(`Song preview cropping failed: ${cleanFfmpegError(stderr, "ffmpeg produced an empty preview")}`)
  }

  return new Uint8Array(stdout)
}

export async function cropAudioPreviewWithFfmpeg(input: {
  env: Env
  sourceBytes: Uint8Array
  sourceMimeType: string
  previewWindow: SongPreviewWindow
}): Promise<{ bytes: Uint8Array; durationMs: number | null }> {
  if (trimEnv(input.env.SONG_PREVIEW_FFMPEG_BIN) === "__test_passthrough__") {
    const durationMs = estimateWavDurationMs(input.sourceBytes)
    return {
      bytes: input.sourceBytes,
      durationMs: durationMs == null
        ? input.previewWindow.duration_ms
        : Math.min(durationMs, input.previewWindow.duration_ms),
    }
  }

  void input.sourceMimeType
  const ffmpegBin = trimEnv(input.env.SONG_PREVIEW_FFMPEG_BIN) || DEFAULT_FFMPEG_BIN
  const bytes = await cropAudioPreviewWithBunFfmpeg({
    ffmpegBin,
    sourceBytes: input.sourceBytes,
    previewWindow: input.previewWindow,
  })
  return {
    bytes,
    durationMs: input.previewWindow.duration_ms,
  }
}
