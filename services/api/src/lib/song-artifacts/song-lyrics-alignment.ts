import type { Env } from "../../env"
import type { SongArtifactUpload } from "../../types"
import { fetchSongArtifactBytes } from "./song-artifact-storage"
import { trimEnv, type AlignmentOutcome } from "./song-artifact-analysis-types"

async function alignLyricsWithElevenLabs(input: {
  env: Env
  lyrics: string
  primaryAudioUpload: SongArtifactUpload
}): Promise<Record<string, unknown> | null> {
  const apiKey = trimEnv(input.env.ELEVENLABS_API_KEY)
  const url = trimEnv(input.env.ELEVENLABS_FORCE_ALIGNMENT_URL) || "https://api.elevenlabs.io/v1/forced-alignment"
  if (!apiKey || !url) {
    return {
      provider: "elevenlabs",
      error: "missing_configuration",
    }
  }

  const timeoutMs = Number.parseInt(trimEnv(input.env.ELEVENLABS_TIMEOUT_MS) || "", 10)
  const controller = new AbortController()
  const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null

  try {
    if (!input.primaryAudioUpload.storage_object_key) {
      return {
        provider: "elevenlabs",
        error: "missing_audio_object",
      }
    }

    const audioResponse = await fetchSongArtifactBytes({
      env: input.env,
      objectKey: input.primaryAudioUpload.storage_object_key,
    })
    const audioBytes = await audioResponse.arrayBuffer()
    const form = new FormData()
    form.set(
      "file",
      new File(
        [audioBytes],
        input.primaryAudioUpload.filename || "alignment-audio.bin",
        { type: input.primaryAudioUpload.mime_type || "application/octet-stream" },
      ),
    )
    form.set("text", input.lyrics)

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
      },
      body: form,
      signal: controller.signal,
    })
    if (!response.ok) {
      return {
        provider: "elevenlabs",
        error: `http_${response.status}`,
      }
    }
    const parsed = await response.json().catch(() => null)
    if (!parsed || typeof parsed !== "object") {
      return {
        provider: "elevenlabs",
        error: "invalid_response",
      }
    }
    return parsed as Record<string, unknown>
  } catch (error) {
    return {
      provider: "elevenlabs",
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

function normalizeTimedLyrics(result: Record<string, unknown>): Record<string, unknown> {
  if (Array.isArray(result.segments)) {
    return result
  }

  const words = Array.isArray(result.words) ? result.words : []
  return {
    provider: "elevenlabs",
    segments: words
      .map((word) => {
        if (!word || typeof word !== "object") {
          return null
        }
        const text = "text" in word && typeof word.text === "string" ? word.text : null
        const start = "start" in word && typeof word.start === "number" ? word.start : null
        const end = "end" in word && typeof word.end === "number" ? word.end : null
        if (!text || start === null || end === null) {
          return null
        }
        return {
          start_ms: Math.round(start * 1000),
          end_ms: Math.round(end * 1000),
          text,
          loss: "loss" in word && typeof word.loss === "number" ? word.loss : null,
        }
      })
      .filter((segment): segment is { start_ms: number; end_ms: number; text: string; loss: number | null } => Boolean(segment)),
    provider_result: result,
  }
}

export async function evaluateAlignment(input: {
  env: Env
  lyrics: string
  primaryAudioUpload: SongArtifactUpload
}): Promise<AlignmentOutcome> {
  const providerResult = await alignLyricsWithElevenLabs(input)
  if (providerResult && typeof providerResult.error === "string") {
    return {
      alignmentStatus: "failed",
      alignmentError: String(providerResult.error),
      timedLyrics: null,
    }
  }

  return {
    alignmentStatus: "completed",
    alignmentError: null,
    timedLyrics: normalizeTimedLyrics(providerResult ?? {}),
  }
}
