import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeId } from "../helpers"
import type { Env, MediaDescriptor, SongPreviewWindow } from "../../types"
import { persistSongArtifactUpload } from "./local-song-artifact-upload-storage"
import { readStoredSongArtifactBytes } from "./song-artifact-storage"

const execFileAsync = promisify(execFile)

function secondsFromMs(value: number): string {
  return (value / 1000).toFixed(3)
}

export async function deriveSongPreviewAudio(input: {
  env: Env
  primaryAudio: MediaDescriptor
  previewWindow: SongPreviewWindow
}): Promise<MediaDescriptor> {
  const sourceBytes = await readStoredSongArtifactBytes(input.env, input.primaryAudio.storage_ref)
  const tempRoot = await mkdtemp(join(tmpdir(), "pirate-song-preview-"))
  const primaryMimeType = input.primaryAudio.mime_type?.toLowerCase() ?? ""
  const sourcePath = join(tempRoot, primaryMimeType.includes("wav") ? "source.wav" : "source.bin")
  const outputPath = join(tempRoot, "preview.mp3")

  try {
    await writeFile(sourcePath, sourceBytes)
    await execFileAsync("ffmpeg", [
      "-y",
      "-ss",
      secondsFromMs(input.previewWindow.start_ms),
      "-t",
      secondsFromMs(input.previewWindow.duration_ms),
      "-i",
      sourcePath,
      "-vn",
      "-ar",
      "44100",
      "-ac",
      "2",
      "-b:a",
      "128k",
      outputPath,
    ])
    const bytesToPersist = new Uint8Array(await readFile(outputPath))

    const persisted = await persistSongArtifactUpload({
      env: input.env,
      uploadId: makeId("spv"),
      bytes: bytesToPersist,
      artifactKind: "preview_audio",
      mimeType: "audio/mpeg",
    })

    return {
      storage_ref: persisted.storageRef,
      mime_type: "audio/mpeg",
      size_bytes: persisted.sizeBytes,
      content_hash: persisted.contentHash,
      duration_ms: input.previewWindow.duration_ms,
      clip_start_ms: input.previewWindow.start_ms,
      clip_duration_ms: input.previewWindow.duration_ms,
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => {})
  }
}
