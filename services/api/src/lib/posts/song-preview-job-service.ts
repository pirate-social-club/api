import { nowIso } from "../helpers"
import type { Env } from "../../types"
import type { SongArtifactBundleRepository } from "./control-plane-song-artifact-repository"
import { deriveSongPreviewAudio } from "./song-preview-service"

function summarizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.trim().slice(0, 500) || "unknown_error"
}

function parsePositiveInt(value: string | null | undefined, fallback: number): number {
  const parsed = Number(String(value ?? "").trim())
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback
  }
  return Math.max(1, Math.trunc(parsed))
}

function isoBeforeSeconds(seconds: number): string | null {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return null
  }
  return new Date(Date.now() - (seconds * 1000)).toISOString()
}

function parseSongPreviewStaleAfterSeconds(env: Env): number {
  return parsePositiveInt(env.SONG_PREVIEW_STALE_AFTER_SECONDS, 900)
}

function resolvePreviewWindow(input: {
  previewWindow: { start_ms: number; duration_ms: number } | null | undefined
  durationMs: number | null | undefined
}): { start_ms: number; duration_ms: number } | null {
  if (input.previewWindow) {
    return input.previewWindow
  }
  if (!Number.isInteger(input.durationMs) || Number(input.durationMs) <= 0) {
    return null
  }
  return {
    start_ms: 0,
    duration_ms: Math.min(Number(input.durationMs), 30_000),
  }
}

export function parseSongPreviewDrainLimit(value: string | null | undefined, env: Env): number {
  return parsePositiveInt(value ?? env.SONG_PREVIEW_DRAIN_LIMIT, 10)
}

export async function drainPendingSongArtifactPreviews(input: {
  env: Env
  limit: number
  songArtifactRepository: SongArtifactBundleRepository
}): Promise<{
  scanned_count: number
  claimed_count: number
  processed_count: number
  preview_completed_count: number
  preview_failed_count: number
}> {
  const staleBefore = isoBeforeSeconds(parseSongPreviewStaleAfterSeconds(input.env))
  const pending = await input.songArtifactRepository.listSongArtifactBundlesPendingPreview(input.limit, staleBefore)
  const counts = {
    scanned_count: pending.length,
    claimed_count: 0,
    processed_count: 0,
    preview_completed_count: 0,
    preview_failed_count: 0,
  }

  for (const candidate of pending) {
    const claimed = await input.songArtifactRepository.claimSongArtifactBundlePendingPreview({
      bundleId: candidate.song_artifact_bundle_id,
      staleBefore,
      updatedAt: nowIso(),
    })
    if (!claimed) {
      continue
    }
    counts.claimed_count += 1

    const previewWindow = resolvePreviewWindow({
      previewWindow: claimed.preview_window,
      durationMs: claimed.primary_audio.duration_ms,
    })
    if (!previewWindow) {
      await input.songArtifactRepository.updateSongArtifactBundlePreview({
        bundleId: claimed.song_artifact_bundle_id,
        status: "failed",
        error: "preview_window_missing",
        previewAudio: claimed.preview_audio ?? null,
        updatedAt: nowIso(),
      })
      counts.preview_failed_count += 1
      counts.processed_count += 1
      continue
    }

    try {
      const previewAudio = await deriveSongPreviewAudio({
        env: input.env,
        primaryAudio: claimed.primary_audio,
        previewWindow,
      })
      await input.songArtifactRepository.updateSongArtifactBundlePreview({
        bundleId: claimed.song_artifact_bundle_id,
        status: "completed",
        error: null,
        previewAudio,
        updatedAt: nowIso(),
      })
      counts.preview_completed_count += 1
    } catch (error) {
      await input.songArtifactRepository.updateSongArtifactBundlePreview({
        bundleId: claimed.song_artifact_bundle_id,
        status: "failed",
        error: summarizeError(error),
        previewAudio: claimed.preview_audio ?? null,
        updatedAt: nowIso(),
      })
      counts.preview_failed_count += 1
    }

    counts.processed_count += 1
  }

  return counts
}
