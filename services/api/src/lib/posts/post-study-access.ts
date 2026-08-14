import type { ActorContext, AdminActorContext } from "../auth-middleware"
import { getActiveEntitlementForBuyer } from "../communities/commerce/shared"
import { executeFirst } from "../db-helpers"
import {
  normalizeLatinTokenCyrillicLookalikes,
  resolveStoredSourceLanguage,
} from "../localization/content-locale"
import type { Client, ReadClient } from "../sql-client"
import { canReadNonPublishedPost, isPubliclyReadablePost, requireMemberAccess } from "./post-access"
import { readString } from "./post-study-attempt-store"

export type StudyPost = {
  access_mode: "public" | "locked" | null
  age_gate_policy: "none" | "18_plus"
  asset_id: string | null
  author_user_id: string | null
  community_id: string
  lyrics: string | null
  post_id: string
  post_type: string
  song_cover_art_ref: string | null
  song_artifact_bundle_id?: string | null
  song_title: string | null
  source_language: string | null
  source_language_reliable: boolean
  lyrics_language?: string | null
  lyrics_language_reliable?: boolean
  lyrics_language_detector?: string | null
  lyrics_language_detected_at?: string | null
  lyrics_language_source_hash?: string | null
  stored_source_language?: string | null
  status: string
  title: string | null
  visibility: string
}

export async function getStudyPostById(client: ReadClient, postId: string): Promise<StudyPost | null> {
  // 1143 is transitional on shards during rollout. Keep Study reads fail-closed
  // when the lyrics-language family is not present instead of preparing a query
  // that names missing columns.
  const schema = await client.execute({ sql: "PRAGMA table_info(posts)" })
  const columns = new Set(schema.rows.map((row) => String((row as Record<string, unknown>).name ?? "")))
  const lyricsLanguageProjection = [
    "lyrics_language",
    "lyrics_language_reliable",
    "lyrics_language_detector",
    "lyrics_language_detected_at",
    "lyrics_language_source_hash",
  ].every((column) => columns.has(column))
    ? "lyrics_language, lyrics_language_reliable, lyrics_language_detector, lyrics_language_detected_at, lyrics_language_source_hash"
    : "NULL AS lyrics_language, 0 AS lyrics_language_reliable, NULL AS lyrics_language_detector, NULL AS lyrics_language_detected_at, NULL AS lyrics_language_source_hash"
  const row = await executeFirst(client, {
    sql: `
      SELECT post_id, community_id, author_user_id, post_type, status, visibility,
             lyrics,
             title, song_title, song_cover_art_ref, song_artifact_bundle_id,
             source_language, source_language_reliable,
             ${lyricsLanguageProjection},
             access_mode, age_gate_policy, asset_id
      FROM posts
      WHERE post_id = ?1
      LIMIT 1
    `,
    args: [postId],
  }) as Record<string, unknown> | null
  if (!row) return null
  const lyrics = readString(row.lyrics)
  const storedSourceLanguage = readString(row.source_language)
  return {
    access_mode: readString(row.access_mode) as StudyPost["access_mode"],
    age_gate_policy: readString(row.age_gate_policy) as StudyPost["age_gate_policy"],
    asset_id: readString(row.asset_id),
    author_user_id: readString(row.author_user_id),
    community_id: readString(row.community_id) ?? "",
    lyrics,
    post_id: readString(row.post_id) ?? "",
    post_type: readString(row.post_type) ?? "",
    song_cover_art_ref: readString(row.song_cover_art_ref),
    song_artifact_bundle_id: readString(row.song_artifact_bundle_id),
    song_title: readString(row.song_title),
    source_language: resolveStoredSourceLanguage(storedSourceLanguage, [
      readString(row.song_title),
      readString(row.title),
      lyrics,
    ]),
    source_language_reliable: Number(row.source_language_reliable ?? 0) === 1,
    lyrics_language: readString(row.lyrics_language),
    lyrics_language_reliable: Number(row.lyrics_language_reliable ?? 0) === 1,
    lyrics_language_detector: readString(row.lyrics_language_detector),
    lyrics_language_detected_at: readString(row.lyrics_language_detected_at),
    lyrics_language_source_hash: readString(row.lyrics_language_source_hash),
    stored_source_language: storedSourceLanguage,
    status: readString(row.status) ?? "",
    title: readString(row.title),
    visibility: readString(row.visibility) ?? "public",
  }
}

type RepairableStudyPost = {
  lyrics?: string | null
  post_id: string
  song_title?: string | null
  source_language?: string | null
  stored_source_language?: string | null
  title?: string | null
}

export async function repairStudyPostMetadata<T extends RepairableStudyPost>(client: Client, post: T): Promise<T> {
  const storedLyrics = post.lyrics ?? null
  const storedSourceLanguage = post.stored_source_language ?? post.source_language ?? null
  const lyrics = storedLyrics == null ? null : normalizeLatinTokenCyrillicLookalikes(storedLyrics)
  const sourceLanguage = resolveStoredSourceLanguage(storedSourceLanguage, [post.song_title, post.title, storedLyrics])
  if (lyrics !== storedLyrics) {
    // Compare-and-swap keeps a concurrent edit authoritative. This repair changes
    // only mixed-token homoglyphs and the language value they previously poisoned.
    // Preserve say-it-back scheduling under the corrected language; historical
    // attempts remain immutable audit records. A pre-existing destination state
    // wins rather than being overwritten.
    await client.batch([{
      sql: `
          UPDATE posts
          SET lyrics = ?1, source_language = ?2
          WHERE post_id = ?3
            AND lyrics IS ?4
            AND source_language IS ?5
        `,
      args: [lyrics, sourceLanguage, post.post_id, storedLyrics, storedSourceLanguage],
    }, {
      sql: `
          UPDATE song_study_review_state
          SET target_language = ?1
          WHERE post_id = ?2
            AND exercise_type = 'say_it_back'
            AND target_language IS ?3
            AND EXISTS (
              SELECT 1
              FROM posts
              WHERE posts.post_id = ?2
                AND posts.lyrics IS ?4
                AND posts.source_language IS ?1
            )
            AND NOT EXISTS (
              SELECT 1
              FROM song_study_review_state AS destination
              WHERE destination.user_id = song_study_review_state.user_id
                AND destination.post_id = song_study_review_state.post_id
                AND destination.line_id = song_study_review_state.line_id
                AND destination.exercise_type = song_study_review_state.exercise_type
                AND destination.target_language = ?1
            )
        `,
      args: [sourceLanguage, post.post_id, storedSourceLanguage, lyrics],
    }], "write")
    // The CAS may lose to a concurrent post edit. Re-read after the one-time
    // repair so unit regeneration always follows the database winner.
    const current = await getStudyPostById(client, post.post_id)
    if (current) {
      return {
        ...post,
        lyrics: current.lyrics,
        source_language: current.source_language,
        stored_source_language: current.stored_source_language,
      }
    }
  }
  return {
    ...post,
    lyrics,
    source_language: sourceLanguage,
    stored_source_language: sourceLanguage,
  }
}

export async function canReadPostForStudy(input: {
  actor: ActorContext | AdminActorContext
  client: ReadClient
  post: StudyPost
}): Promise<boolean> {
  if (isPubliclyReadablePost({
    status: input.post.status as "draft" | "published" | "hidden" | "removed" | "deleted",
    visibility: input.post.visibility as "public" | "members_only",
  })) {
    return true
  }
  try {
    const membership = await requireMemberAccess(input.client as Client, input.post.community_id, input.actor.userId)
    return input.post.status === "published"
      || canReadNonPublishedPost({ author_user_id: input.post.author_user_id }, membership, input.actor.userId)
  } catch {
    return isPubliclyReadablePost({
      status: input.post.status as "draft" | "published" | "hidden" | "removed" | "deleted",
      visibility: input.post.visibility as "public" | "members_only",
    })
  }
}

export async function canStudyPost(input: {
  actor: ActorContext | AdminActorContext
  client: ReadClient
  communityId: string
  post: StudyPost
}): Promise<boolean> {
  if (input.post.access_mode !== "locked") return true
  if (input.post.author_user_id === input.actor.userId) return true
  if (!input.post.asset_id) return false
  const entitlement = await getActiveEntitlementForBuyer(
    input.client,
    input.communityId,
    input.actor.userId,
    input.post.asset_id,
    "asset_access",
  )
  return Boolean(entitlement)
}
