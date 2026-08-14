import type { Env } from "../../env"
import { nowIso } from "../helpers"
import { sha256Hex } from "../crypto"
import type { DbExecutor } from "../db-helpers"
import type { Post } from "../../types"
import { requestLyricsLanguageDetection } from "./lyrics-language-detection-provider"

export const DEFAULT_LYRICS_LANGUAGE_MIN_CHARS = 24
export const DEFAULT_LYRICS_LANGUAGE_MIN_WORDS = 5
export const LYRICS_LANGUAGE_MIN_LENGTH_DETECTOR = "policy:lyrics_min_length_v1"

const LYRICS_LANGUAGE_COLUMNS = [
  "lyrics_language",
  "lyrics_language_confidence",
  "lyrics_language_reliable",
  "lyrics_language_detector",
  "lyrics_language_detected_at",
  "lyrics_language_source_hash",
] as const

export type LyricsLanguageMaterializationResult =
  | "updated"
  | "cached"
  | "skipped:not_song"
  | "skipped:no_lyrics"
  | "skipped:too_short"
  | "skipped:missing_columns"
  | "skipped:stale"

async function hasLyricsLanguageColumns(client: Pick<DbExecutor, "execute">): Promise<boolean> {
  const result = await client.execute({ sql: "PRAGMA table_info(posts)" })
  const names = new Set(result.rows.map((row) => String((row as Record<string, unknown>).name ?? "")))
  return LYRICS_LANGUAGE_COLUMNS.every((column) => names.has(column))
}

async function lyricsSourceHash(lyrics: string): Promise<string> {
  const canonical = normalizeLyricsForDetection(lyrics)
  return `0x${await sha256Hex(JSON.stringify({ lyrics: canonical }))}`
}

export function normalizeLyricsForDetection(lyrics: string): string {
  return lyrics.normalize("NFKC").replace(/\r\n?/gu, "\n").trim()
}

export function lyricsLanguageInputStats(lyrics: string): { chars: number; words: number } {
  const canonical = normalizeLyricsForDetection(lyrics)
  return {
    chars: [...canonical].length,
    words: canonical ? canonical.split(/\s+/u).filter(Boolean).length : 0,
  }
}

export function hasSufficientLyricsForLanguageDetection(lyrics: string, env: Env): boolean {
  const stats = lyricsLanguageInputStats(lyrics)
  const configuredChars = Number.parseInt(env.OPENROUTER_LANGUAGE_DETECTION_MIN_CHARS ?? "", 10)
  const configuredWords = Number.parseInt(env.OPENROUTER_LANGUAGE_DETECTION_MIN_WORDS ?? "", 10)
  const minChars = Number.isSafeInteger(configuredChars) && configuredChars > 0
    ? configuredChars
    : DEFAULT_LYRICS_LANGUAGE_MIN_CHARS
  const minWords = Number.isSafeInteger(configuredWords) && configuredWords > 0
    ? configuredWords
    : DEFAULT_LYRICS_LANGUAGE_MIN_WORDS
  return stats.chars >= minChars && stats.words >= minWords
}

export async function materializePostLyricsLanguageDetection(input: {
  client: DbExecutor
  env: Env
  post: Pick<Post, "post_id" | "post_type" | "lyrics" | "lyrics_language_source_hash" | "lyrics_language_detector">
    & Pick<Post, "lyrics_language_reliable">
}): Promise<LyricsLanguageMaterializationResult> {
  if (input.post.post_type !== "song") return "skipped:not_song"
  const lyrics = input.post.lyrics?.trim() ?? ""
  if (!lyrics) return "skipped:no_lyrics"
  if (!await hasLyricsLanguageColumns(input.client)) return "skipped:missing_columns"

  const sourceHash = await lyricsSourceHash(lyrics)
  const sufficient = hasSufficientLyricsForLanguageDetection(lyrics, input.env)
  const shortPolicyApplied = input.post.lyrics_language_detector === LYRICS_LANGUAGE_MIN_LENGTH_DETECTOR
  if (input.post.lyrics_language_source_hash === sourceHash && input.post.lyrics_language_detector
    && (sufficient || shortPolicyApplied)) {
    return "cached"
  }

  if (!sufficient) {
    const update = await input.client.execute({
      sql: `
        UPDATE posts
        SET lyrics_language = NULL,
            lyrics_language_confidence = NULL,
            lyrics_language_reliable = 0,
            lyrics_language_detector = ?3,
            lyrics_language_detected_at = ?1,
            lyrics_language_source_hash = ?2
        WHERE post_id = ?4
          AND lyrics IS ?5
      `,
      args: [nowIso(), sourceHash, LYRICS_LANGUAGE_MIN_LENGTH_DETECTOR, input.post.post_id, input.post.lyrics ?? null],
    })
    return Number(update.rowsAffected ?? 0) > 0 ? "skipped:too_short" : "skipped:stale"
  }

  const detected = await requestLyricsLanguageDetection({ env: input.env, lyrics })
  const detector = `${detected.provider}:${detected.model}`
  const detectedAt = nowIso()
  const update = await input.client.execute({
    sql: `
      UPDATE posts
      SET lyrics_language = ?1,
          lyrics_language_confidence = ?2,
          lyrics_language_reliable = ?3,
          lyrics_language_detector = ?4,
          lyrics_language_detected_at = ?5,
          lyrics_language_source_hash = ?6
      WHERE post_id = ?7
        AND lyrics IS ?8
    `,
    args: [
      detected.language,
      detected.confidence,
      detected.reliable ? 1 : 0,
      detector,
      detectedAt,
      sourceHash,
      input.post.post_id,
      input.post.lyrics ?? null,
    ],
  })
  return Number(update.rowsAffected ?? 0) > 0 ? "updated" : "skipped:stale"
}

export async function computeLyricsLanguageSourceHash(lyrics: string | null | undefined): Promise<string | null> {
  const trimmed = lyrics?.trim() ?? ""
  return trimmed ? await lyricsSourceHash(trimmed) : null
}
