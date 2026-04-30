import { badRequestError, providerUnavailable } from "../errors"
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

  void input.sourceMimeType
  throw providerUnavailable("Song preview cropping requires a Node-only ffmpeg worker")
}
