import { sha256Hex } from "../crypto"
import type { SongArtifactBundle } from "../../types"

type JsonPrimitive = boolean | number | string | null
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

function normalizeJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return value
  }
  if (Array.isArray(value)) {
    return value.map(normalizeJsonValue)
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>
    const normalized: { [key: string]: JsonValue } = {}
    for (const key of Object.keys(record).sort()) {
      const entry = record[key]
      if (typeof entry !== "undefined") {
        normalized[key] = normalizeJsonValue(entry)
      }
    }
    return normalized
  }
  return null
}

export async function deriveKaraokeRevisionId(input: {
  instrumentalAudio: SongArtifactBundle["instrumental_audio"]
  timedLyrics: Record<string, unknown> | null
}): Promise<string | null> {
  if (!input.instrumentalAudio || !input.timedLyrics) {
    return null
  }

  const payload = normalizeJsonValue({
    instrumental_audio: input.instrumentalAudio,
    timed_lyrics: input.timedLyrics,
  })
  return `krv_${await sha256Hex(JSON.stringify(payload))}`
}
