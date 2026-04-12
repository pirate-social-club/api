import { requireControlPlaneDbUrl } from "../auth/control-plane-auth-queries"
import { createControlPlaneDbClient, type ControlPlaneDbClient } from "../control-plane-db"
import { internalError } from "../errors"
import { makeId } from "../helpers"
import type {
  CreateSongArtifactBundleRequest,
  Env,
  SongArtifactBundle,
  SongArtifactEnrichmentStatus,
  SongLyricsTranslationDoc,
  SongModerationResultDoc,
  SongTimedLyricsDoc,
} from "../../types"

type SongArtifactBundleStatus = SongArtifactBundle["status"]

type SongArtifactBundleRow = {
  song_artifact_bundle_id: string
  community_id: string
  creator_user_id: string
  status: SongArtifactBundle["status"]
  primary_audio_json: string
  lyrics_text: string
  lyrics_sha256: string
  cover_art_json: string | null
  preview_audio_json: string | null
  preview_window_json: string | null
  preview_status: SongArtifactEnrichmentStatus
  preview_error: string | null
  canvas_video_json: string | null
  instrumental_audio_json: string | null
  vocal_audio_json: string | null
  translation_status: SongArtifactEnrichmentStatus
  translation_error: string | null
  translated_lyrics_ref: string | null
  translated_lyrics_json: string | null
  alignment_status: SongArtifactEnrichmentStatus
  alignment_error: string | null
  timed_lyrics_ref: string | null
  timed_lyrics_json: string | null
  moderation_status: SongArtifactEnrichmentStatus
  moderation_error: string | null
  moderation_result_ref: string | null
  moderation_result_json: string | null
  created_at: string
  updated_at: string
}

function parseJson<T>(value: string | null): T | null {
  if (!value) return null
  return JSON.parse(value) as T
}

function serializeBundle(row: SongArtifactBundleRow): SongArtifactBundle {
  const primaryAudio = JSON.parse(row.primary_audio_json) as SongArtifactBundle["primary_audio"]
  return {
    song_artifact_bundle_id: row.song_artifact_bundle_id,
    community_id: row.community_id,
    creator_user_id: row.creator_user_id,
    status: row.status,
    primary_audio: primaryAudio,
    media_refs: [primaryAudio],
    lyrics: row.lyrics_text,
    lyrics_sha256: row.lyrics_sha256,
    cover_art: parseJson<SongArtifactBundle["cover_art"]>(row.cover_art_json),
    preview_audio: parseJson<SongArtifactBundle["preview_audio"]>(row.preview_audio_json),
    preview_window: parseJson<SongArtifactBundle["preview_window"]>(row.preview_window_json),
    preview_status: row.preview_status,
    preview_error: row.preview_error,
    canvas_video: parseJson<SongArtifactBundle["canvas_video"]>(row.canvas_video_json),
    instrumental_audio: parseJson<SongArtifactBundle["instrumental_audio"]>(row.instrumental_audio_json),
    vocal_audio: parseJson<SongArtifactBundle["vocal_audio"]>(row.vocal_audio_json),
    translation_status: row.translation_status,
    translation_error: row.translation_error,
    translated_lyrics_ref: row.translated_lyrics_ref,
    translated_lyrics: parseJson<SongLyricsTranslationDoc>(row.translated_lyrics_json),
    alignment_status: row.alignment_status,
    alignment_error: row.alignment_error,
    timed_lyrics_ref: row.timed_lyrics_ref,
    timed_lyrics: parseJson<SongTimedLyricsDoc>(row.timed_lyrics_json),
    moderation_status: row.moderation_status,
    moderation_error: row.moderation_error,
    moderation_result_ref: row.moderation_result_ref,
    moderation_result: parseJson<SongModerationResultDoc>(row.moderation_result_json),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function toRow(row: unknown): SongArtifactBundleRow {
  if (!row || typeof row !== "object") {
    throw internalError("Song artifact bundle row is invalid")
  }
  const value = row as Record<string, unknown>
  return {
    song_artifact_bundle_id: String(value.song_artifact_bundle_id || ""),
    community_id: String(value.community_id || ""),
    creator_user_id: String(value.creator_user_id || ""),
    status: String(value.status || "") as SongArtifactBundle["status"],
    primary_audio_json: String(value.primary_audio_json || ""),
    lyrics_text: String(value.lyrics_text || ""),
    lyrics_sha256: String(value.lyrics_sha256 || ""),
    cover_art_json: value.cover_art_json == null ? null : String(value.cover_art_json),
    preview_audio_json: value.preview_audio_json == null ? null : String(value.preview_audio_json),
    preview_window_json: value.preview_window_json == null ? null : String(value.preview_window_json),
    preview_status: String(value.preview_status || "") as SongArtifactEnrichmentStatus,
    preview_error: value.preview_error == null ? null : String(value.preview_error),
    canvas_video_json: value.canvas_video_json == null ? null : String(value.canvas_video_json),
    instrumental_audio_json: value.instrumental_audio_json == null ? null : String(value.instrumental_audio_json),
    vocal_audio_json: value.vocal_audio_json == null ? null : String(value.vocal_audio_json),
    translation_status: String(value.translation_status || "") as SongArtifactEnrichmentStatus,
    translation_error: value.translation_error == null ? null : String(value.translation_error),
    translated_lyrics_ref: value.translated_lyrics_ref == null ? null : String(value.translated_lyrics_ref),
    translated_lyrics_json: value.translated_lyrics_json == null ? null : String(value.translated_lyrics_json),
    alignment_status: String(value.alignment_status || "") as SongArtifactEnrichmentStatus,
    alignment_error: value.alignment_error == null ? null : String(value.alignment_error),
    timed_lyrics_ref: value.timed_lyrics_ref == null ? null : String(value.timed_lyrics_ref),
    timed_lyrics_json: value.timed_lyrics_json == null ? null : String(value.timed_lyrics_json),
    moderation_status: String(value.moderation_status || "") as SongArtifactEnrichmentStatus,
    moderation_error: value.moderation_error == null ? null : String(value.moderation_error),
    moderation_result_ref: value.moderation_result_ref == null ? null : String(value.moderation_result_ref),
    moderation_result_json: value.moderation_result_json == null ? null : String(value.moderation_result_json),
    created_at: String(value.created_at || ""),
    updated_at: String(value.updated_at || ""),
  }
}

export interface SongArtifactBundleRepository {
  createSongArtifactBundle(input: {
    communityId: string
    creatorUserId: string
    body: CreateSongArtifactBundleRequest
    lyricsSha256: string
    createdAt: string
  }): Promise<SongArtifactBundle>
  transitionSongArtifactBundleStatus(input: {
    bundleId: string
    fromStatuses: SongArtifactBundleStatus[]
    toStatus: SongArtifactBundleStatus
    updatedAt: string
  }): Promise<SongArtifactBundle | null>
  listSongArtifactBundlesPendingEnrichment(limit: number, staleBefore?: string | null): Promise<SongArtifactBundle[]>
  claimSongArtifactBundlePendingEnrichment(input: {
    bundleId: string
    staleBefore?: string | null
    updatedAt: string
  }): Promise<SongArtifactBundle | null>
  listSongArtifactBundlesPendingPreview(limit: number, staleBefore?: string | null): Promise<SongArtifactBundle[]>
  claimSongArtifactBundlePendingPreview(input: {
    bundleId: string
    staleBefore?: string | null
    updatedAt: string
  }): Promise<SongArtifactBundle | null>
  updateSongArtifactBundlePreview(input: {
    bundleId: string
    status: SongArtifactEnrichmentStatus
    error: string | null
    previewAudio: SongArtifactBundle["preview_audio"]
    updatedAt: string
  }): Promise<SongArtifactBundle | null>
  updateSongArtifactBundleTranslation(input: {
    bundleId: string
    status: SongArtifactEnrichmentStatus
    error: string | null
    ref: string | null
    translatedLyrics: SongLyricsTranslationDoc | null
    updatedAt: string
  }): Promise<SongArtifactBundle | null>
  updateSongArtifactBundleAlignment(input: {
    bundleId: string
    status: SongArtifactEnrichmentStatus
    error: string | null
    ref: string | null
    timedLyrics: SongTimedLyricsDoc | null
    updatedAt: string
  }): Promise<SongArtifactBundle | null>
  updateSongArtifactBundleModeration(input: {
    bundleId: string
    status: SongArtifactEnrichmentStatus
    error: string | null
    ref: string | null
    moderationResult: SongModerationResultDoc | null
    updatedAt: string
  }): Promise<SongArtifactBundle | null>
  updateSongArtifactBundlePreviewAudio(input: {
    bundleId: string
    previewAudio: SongArtifactBundle["preview_audio"]
    updatedAt: string
  }): Promise<SongArtifactBundle | null>
  getSongArtifactBundleById(bundleId: string): Promise<SongArtifactBundle | null>
}

class ControlPlaneSongArtifactBundleRepository implements SongArtifactBundleRepository {
  constructor(private readonly client: ControlPlaneDbClient) {}

  async createSongArtifactBundle(input: {
    communityId: string
    creatorUserId: string
    body: CreateSongArtifactBundleRequest
    lyricsSha256: string
    createdAt: string
  }): Promise<SongArtifactBundle> {
    const bundleId = makeId("sab")
    const previewStatus: SongArtifactEnrichmentStatus = input.body.preview_audio
      ? "completed"
      : (
          input.body.preview_window
          || (
            Number.isInteger(input.body.primary_audio.duration_ms)
            && Number(input.body.primary_audio.duration_ms) > 0
            && Number(input.body.primary_audio.duration_ms) <= 30_000
          )
        )
        ? "pending"
        : "completed"
    await this.client.execute({
      sql: `
        INSERT INTO song_artifact_bundles (
          song_artifact_bundle_id, community_id, creator_user_id, status, primary_audio_json,
          lyrics_text, lyrics_sha256, cover_art_json, preview_audio_json, preview_window_json, preview_status, preview_error, canvas_video_json,
          instrumental_audio_json, vocal_audio_json,
          translation_status, translation_error, translated_lyrics_ref, translated_lyrics_json,
          alignment_status, alignment_error, timed_lyrics_ref, timed_lyrics_json,
          moderation_status, moderation_error, moderation_result_ref, moderation_result_json,
          created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, 'draft', ?4,
          ?5, ?6, ?7, ?8, ?9, ?10, NULL, ?11,
          ?12, ?13,
          'pending', NULL, NULL, NULL,
          'pending', NULL, NULL, NULL,
          'pending', NULL, NULL, NULL,
          ?14, ?14
        )
      `,
      args: [
        bundleId,
        input.communityId,
        input.creatorUserId,
        JSON.stringify(input.body.primary_audio),
        input.body.lyrics,
        input.lyricsSha256,
        input.body.cover_art ? JSON.stringify(input.body.cover_art) : null,
        input.body.preview_audio ? JSON.stringify(input.body.preview_audio) : null,
        input.body.preview_window ? JSON.stringify(input.body.preview_window) : null,
        previewStatus,
        input.body.canvas_video ? JSON.stringify(input.body.canvas_video) : null,
        input.body.instrumental_audio ? JSON.stringify(input.body.instrumental_audio) : null,
        input.body.vocal_audio ? JSON.stringify(input.body.vocal_audio) : null,
        input.createdAt,
      ],
    })

    const created = await this.getSongArtifactBundleById(bundleId)
    if (!created) {
      throw internalError("Song artifact bundle row is missing after insert")
    }
    return created
  }

  async transitionSongArtifactBundleStatus(input: {
    bundleId: string
    fromStatuses: SongArtifactBundleStatus[]
    toStatus: SongArtifactBundleStatus
    updatedAt: string
  }): Promise<SongArtifactBundle | null> {
    const placeholders = input.fromStatuses.map((_, index) => `?${index + 4}`).join(", ")
    const result = await this.client.execute({
      sql: `
        UPDATE song_artifact_bundles
        SET status = ?2,
            updated_at = ?3
        WHERE song_artifact_bundle_id = ?1
          AND status IN (${placeholders})
      `,
      args: [input.bundleId, input.toStatus, input.updatedAt, ...input.fromStatuses],
    })
    if (result.rowsAffected === 0) {
      return null
    }

    return this.getSongArtifactBundleById(input.bundleId)
  }

  async listSongArtifactBundlesPendingEnrichment(limit: number, staleBefore?: string | null): Promise<SongArtifactBundle[]> {
    const result = await this.client.execute({
      sql: `
        SELECT song_artifact_bundle_id, community_id, creator_user_id, status, primary_audio_json,
               lyrics_text, lyrics_sha256, cover_art_json, preview_audio_json, preview_window_json, preview_status, preview_error, canvas_video_json,
               instrumental_audio_json, vocal_audio_json,
               translation_status, translation_error, translated_lyrics_ref, translated_lyrics_json,
               alignment_status, alignment_error, timed_lyrics_ref, timed_lyrics_json,
               moderation_status, moderation_error, moderation_result_ref, moderation_result_json,
               created_at, updated_at
        FROM song_artifact_bundles
        WHERE status IN ('ready', 'consuming', 'consumed')
          AND (
            translation_status IN ('pending', 'failed')
            OR alignment_status IN ('pending', 'failed')
            OR moderation_status IN ('pending', 'failed')
            OR (
              ?2 IS NOT NULL
              AND updated_at <= ?2
              AND (
                translation_status = 'processing'
                OR alignment_status = 'processing'
                OR moderation_status = 'processing'
              )
            )
          )
        ORDER BY created_at ASC
        LIMIT ?1
      `,
      args: [Math.max(1, Math.trunc(limit)), staleBefore ?? null],
    })
    return result.rows.map((row) => serializeBundle(toRow(row)))
  }

  async listSongArtifactBundlesPendingPreview(limit: number, staleBefore?: string | null): Promise<SongArtifactBundle[]> {
    const result = await this.client.execute({
      sql: `
        SELECT song_artifact_bundle_id, community_id, creator_user_id, status, primary_audio_json,
               lyrics_text, lyrics_sha256, cover_art_json, preview_audio_json, preview_window_json, preview_status, preview_error, canvas_video_json,
               instrumental_audio_json, vocal_audio_json,
               translation_status, translation_error, translated_lyrics_ref, translated_lyrics_json,
               alignment_status, alignment_error, timed_lyrics_ref, timed_lyrics_json,
               moderation_status, moderation_error, moderation_result_ref, moderation_result_json,
               created_at, updated_at
        FROM song_artifact_bundles
        WHERE status IN ('ready', 'consuming', 'consumed')
          AND (
            preview_status IN ('pending', 'failed')
            OR (
              ?2 IS NOT NULL
              AND updated_at <= ?2
              AND preview_status = 'processing'
            )
          )
        ORDER BY created_at ASC
        LIMIT ?1
      `,
      args: [Math.max(1, Math.trunc(limit)), staleBefore ?? null],
    })
    return result.rows.map((row) => serializeBundle(toRow(row)))
  }

  async claimSongArtifactBundlePendingPreview(input: {
    bundleId: string
    staleBefore?: string | null
    updatedAt: string
  }): Promise<SongArtifactBundle | null> {
    const result = await this.client.execute({
      sql: `
        UPDATE song_artifact_bundles
        SET preview_status = CASE
              WHEN preview_status IN ('pending', 'failed') THEN 'processing'
              WHEN ?3 IS NOT NULL AND preview_status = 'processing' AND updated_at <= ?3 THEN 'processing'
              ELSE preview_status
            END,
            preview_error = CASE
              WHEN preview_status IN ('pending', 'failed') THEN NULL
              WHEN ?3 IS NOT NULL AND preview_status = 'processing' AND updated_at <= ?3 THEN NULL
              ELSE preview_error
            END,
            updated_at = ?2
        WHERE song_artifact_bundle_id = ?1
          AND status IN ('ready', 'consuming', 'consumed')
          AND (
            preview_status IN ('pending', 'failed')
            OR (
              ?3 IS NOT NULL
              AND updated_at <= ?3
              AND preview_status = 'processing'
            )
          )
      `,
      args: [input.bundleId, input.updatedAt, input.staleBefore ?? null],
    })
    if (result.rowsAffected === 0) {
      return null
    }
    return this.getSongArtifactBundleById(input.bundleId)
  }

  async claimSongArtifactBundlePendingEnrichment(input: {
    bundleId: string
    staleBefore?: string | null
    updatedAt: string
  }): Promise<SongArtifactBundle | null> {
    const result = await this.client.execute({
      sql: `
        UPDATE song_artifact_bundles
        SET translation_status = CASE
              WHEN translation_status IN ('pending', 'failed') THEN 'processing'
              WHEN ?3 IS NOT NULL AND translation_status = 'processing' AND updated_at <= ?3 THEN 'processing'
              ELSE translation_status
            END,
            translation_error = CASE
              WHEN translation_status IN ('pending', 'failed') THEN NULL
              WHEN ?3 IS NOT NULL AND translation_status = 'processing' AND updated_at <= ?3 THEN NULL
              ELSE translation_error
            END,
            alignment_status = CASE
              WHEN alignment_status IN ('pending', 'failed') THEN 'processing'
              WHEN ?3 IS NOT NULL AND alignment_status = 'processing' AND updated_at <= ?3 THEN 'processing'
              ELSE alignment_status
            END,
            alignment_error = CASE
              WHEN alignment_status IN ('pending', 'failed') THEN NULL
              WHEN ?3 IS NOT NULL AND alignment_status = 'processing' AND updated_at <= ?3 THEN NULL
              ELSE alignment_error
            END,
            moderation_status = CASE
              WHEN moderation_status IN ('pending', 'failed') THEN 'processing'
              WHEN ?3 IS NOT NULL AND moderation_status = 'processing' AND updated_at <= ?3 THEN 'processing'
              ELSE moderation_status
            END,
            moderation_error = CASE
              WHEN moderation_status IN ('pending', 'failed') THEN NULL
              WHEN ?3 IS NOT NULL AND moderation_status = 'processing' AND updated_at <= ?3 THEN NULL
              ELSE moderation_error
            END,
            updated_at = ?2
        WHERE song_artifact_bundle_id = ?1
          AND status IN ('ready', 'consuming', 'consumed')
          AND (
            translation_status IN ('pending', 'failed')
            OR alignment_status IN ('pending', 'failed')
            OR moderation_status IN ('pending', 'failed')
            OR (
              ?3 IS NOT NULL
              AND updated_at <= ?3
              AND (
                translation_status = 'processing'
                OR alignment_status = 'processing'
                OR moderation_status = 'processing'
              )
            )
          )
      `,
      args: [input.bundleId, input.updatedAt, input.staleBefore ?? null],
    })
    if (result.rowsAffected === 0) {
      return null
    }
    return this.getSongArtifactBundleById(input.bundleId)
  }

  async updateSongArtifactBundleTranslation(input: {
    bundleId: string
    status: SongArtifactEnrichmentStatus
    error: string | null
    ref: string | null
    translatedLyrics: SongLyricsTranslationDoc | null
    updatedAt: string
  }): Promise<SongArtifactBundle | null> {
    const result = await this.client.execute({
      sql: `
        UPDATE song_artifact_bundles
        SET translation_status = ?2,
            translation_error = ?3,
            translated_lyrics_ref = ?4,
            translated_lyrics_json = ?5,
            updated_at = ?6
        WHERE song_artifact_bundle_id = ?1
      `,
      args: [
        input.bundleId,
        input.status,
        input.error,
        input.ref,
        input.translatedLyrics ? JSON.stringify(input.translatedLyrics) : null,
        input.updatedAt,
      ],
    })
    if (result.rowsAffected === 0) {
      return null
    }
    return this.getSongArtifactBundleById(input.bundleId)
  }

  async updateSongArtifactBundleAlignment(input: {
    bundleId: string
    status: SongArtifactEnrichmentStatus
    error: string | null
    ref: string | null
    timedLyrics: SongTimedLyricsDoc | null
    updatedAt: string
  }): Promise<SongArtifactBundle | null> {
    const result = await this.client.execute({
      sql: `
        UPDATE song_artifact_bundles
        SET alignment_status = ?2,
            alignment_error = ?3,
            timed_lyrics_ref = ?4,
            timed_lyrics_json = ?5,
            updated_at = ?6
        WHERE song_artifact_bundle_id = ?1
      `,
      args: [
        input.bundleId,
        input.status,
        input.error,
        input.ref,
        input.timedLyrics ? JSON.stringify(input.timedLyrics) : null,
        input.updatedAt,
      ],
    })
    if (result.rowsAffected === 0) {
      return null
    }
    return this.getSongArtifactBundleById(input.bundleId)
  }

  async updateSongArtifactBundleModeration(input: {
    bundleId: string
    status: SongArtifactEnrichmentStatus
    error: string | null
    ref: string | null
    moderationResult: SongModerationResultDoc | null
    updatedAt: string
  }): Promise<SongArtifactBundle | null> {
    const result = await this.client.execute({
      sql: `
        UPDATE song_artifact_bundles
        SET moderation_status = ?2,
            moderation_error = ?3,
            moderation_result_ref = ?4,
            moderation_result_json = ?5,
            updated_at = ?6
        WHERE song_artifact_bundle_id = ?1
      `,
      args: [
        input.bundleId,
        input.status,
        input.error,
        input.ref,
        input.moderationResult ? JSON.stringify(input.moderationResult) : null,
        input.updatedAt,
      ],
    })
    if (result.rowsAffected === 0) {
      return null
    }
    return this.getSongArtifactBundleById(input.bundleId)
  }

  async updateSongArtifactBundlePreviewAudio(input: {
    bundleId: string
    previewAudio: SongArtifactBundle["preview_audio"]
    updatedAt: string
  }): Promise<SongArtifactBundle | null> {
    const result = await this.client.execute({
      sql: `
        UPDATE song_artifact_bundles
        SET preview_audio_json = ?2,
            updated_at = ?3
        WHERE song_artifact_bundle_id = ?1
      `,
      args: [input.bundleId, input.previewAudio ? JSON.stringify(input.previewAudio) : null, input.updatedAt],
    })
    if (result.rowsAffected === 0) {
      return null
    }
    return this.getSongArtifactBundleById(input.bundleId)
  }

  async updateSongArtifactBundlePreview(input: {
    bundleId: string
    status: SongArtifactEnrichmentStatus
    error: string | null
    previewAudio: SongArtifactBundle["preview_audio"]
    updatedAt: string
  }): Promise<SongArtifactBundle | null> {
    const result = await this.client.execute({
      sql: `
        UPDATE song_artifact_bundles
        SET preview_status = ?2,
            preview_error = ?3,
            preview_audio_json = ?4,
            updated_at = ?5
        WHERE song_artifact_bundle_id = ?1
      `,
      args: [
        input.bundleId,
        input.status,
        input.error,
        input.previewAudio ? JSON.stringify(input.previewAudio) : null,
        input.updatedAt,
      ],
    })
    if (result.rowsAffected === 0) {
      return null
    }
    return this.getSongArtifactBundleById(input.bundleId)
  }

  async getSongArtifactBundleById(bundleId: string): Promise<SongArtifactBundle | null> {
    const result = await this.client.execute({
      sql: `
        SELECT song_artifact_bundle_id, community_id, creator_user_id, status, primary_audio_json,
               lyrics_text, lyrics_sha256, cover_art_json, preview_audio_json, preview_window_json, preview_status, preview_error, canvas_video_json,
               instrumental_audio_json, vocal_audio_json,
               translation_status, translation_error, translated_lyrics_ref, translated_lyrics_json,
               alignment_status, alignment_error, timed_lyrics_ref, timed_lyrics_json,
               moderation_status, moderation_error, moderation_result_ref, moderation_result_json,
               created_at, updated_at
        FROM song_artifact_bundles
        WHERE song_artifact_bundle_id = ?1
        LIMIT 1
      `,
      args: [bundleId],
    })

    const row = result.rows[0]
    return row ? serializeBundle(toRow(row)) : null
  }
}

const globalScope = globalThis as typeof globalThis & {
  __pirateSongArtifactBundleRepository?: SongArtifactBundleRepository
  __pirateSongArtifactBundleRepositoryKey?: string
}

export function getControlPlaneSongArtifactBundleRepository(env: Env): SongArtifactBundleRepository {
  const cacheKey = requireControlPlaneDbUrl(env)

  if (
    globalScope.__pirateSongArtifactBundleRepository
    && globalScope.__pirateSongArtifactBundleRepositoryKey === cacheKey
  ) {
    return globalScope.__pirateSongArtifactBundleRepository
  }

  const repository = new ControlPlaneSongArtifactBundleRepository(createControlPlaneDbClient(env))
  globalScope.__pirateSongArtifactBundleRepository = repository
  globalScope.__pirateSongArtifactBundleRepositoryKey = cacheKey
  return repository
}
