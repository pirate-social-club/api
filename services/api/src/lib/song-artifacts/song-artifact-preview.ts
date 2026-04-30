import { badRequestError } from "../errors"
import type { Env } from "../../env"
import type { CreateSongArtifactBundleRequest } from "../../types"

export type SongPreviewWindow = NonNullable<CreateSongArtifactBundleRequest["preview_window"]>

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

export async function cropAudioPreviewWithFfmpeg(input: {
  env: Env
  sourceBytes: Uint8Array
  sourceMimeType: string
  previewWindow: SongPreviewWindow
}): Promise<{ bytes: Uint8Array; durationMs: number | null }> {
  if (String(input.env.SONG_PREVIEW_FFMPEG_BIN || "").trim() === "__test_passthrough__") {
    const durationMs = estimateWavDurationMs(input.sourceBytes)
    return {
      bytes: input.sourceBytes,
      durationMs: durationMs == null
        ? input.previewWindow.duration_ms
        : Math.min(durationMs, input.previewWindow.duration_ms),
    }
  }

  const [
    childProcess,
    fs,
    os,
    path,
  ] = await Promise.all([
    import("node:child_process"),
    import("node:fs/promises"),
    import("node:os"),
    import("node:path"),
  ])
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pirate-song-preview-"))
  const inputPath = path.join(tempDir, `input.${input.sourceMimeType.includes("wav") ? "wav" : "audio"}`)
  const outputPath = path.join(tempDir, "preview.mp3")
  const ffmpegBin = String(input.env.SONG_PREVIEW_FFMPEG_BIN || "ffmpeg").trim() || "ffmpeg"
  const ffprobeBin = String(input.env.SONG_PREVIEW_FFPROBE_BIN || "ffprobe").trim() || "ffprobe"
  const startSeconds = String(input.previewWindow.start_ms / 1000)
  const durationSeconds = String(input.previewWindow.duration_ms / 1000)

  try {
    await fs.writeFile(inputPath, input.sourceBytes)
    await new Promise<void>((resolve, reject) => {
      const child = childProcess.spawn(ffmpegBin, [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-ss",
        startSeconds,
        "-t",
        durationSeconds,
        "-i",
        inputPath,
        "-vn",
        "-codec:a",
        "libmp3lame",
        "-b:a",
        "192k",
        "-f",
        "mp3",
        outputPath,
      ], { stdio: ["ignore", "ignore", "pipe"] })
      let stderr = ""
      child.stderr?.setEncoding("utf8")
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk)
      })
      child.on("error", reject)
      child.on("close", (code) => {
        if (code === 0) {
          resolve()
          return
        }
        reject(new Error(`ffmpeg exited with code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`))
      })
    })
    const probeOutput = await new Promise<string>((resolve, reject) => {
      const child = childProcess.spawn(ffprobeBin, [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        outputPath,
      ], { stdio: ["ignore", "pipe", "pipe"] })
      let stdout = ""
      let stderr = ""
      child.stdout?.setEncoding("utf8")
      child.stderr?.setEncoding("utf8")
      child.stdout?.on("data", (chunk) => {
        stdout += String(chunk)
      })
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk)
      })
      child.on("error", reject)
      child.on("close", (code) => {
        if (code === 0) {
          resolve(stdout)
          return
        }
        reject(new Error(`ffprobe exited with code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`))
      })
    })
    const durationSecondsParsed = Number.parseFloat(probeOutput.trim())
    const durationMs = Number.isFinite(durationSecondsParsed)
      ? Math.max(1, Math.round(durationSecondsParsed * 1000))
      : null
    return {
      bytes: new Uint8Array(await fs.readFile(outputPath)),
      durationMs,
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  }
}
