import type { ActorContext, AdminActorContext } from "../auth-middleware"
import type { Env } from "../../env"
import { badRequestError, conflictError, HttpError, notFoundError } from "../errors"
import { executeFirst } from "../db-helpers"
import { makeId, nowIso } from "../helpers"
import type { Client, ReadClient } from "../sql-client"
import { getActiveEntitlementForBuyer } from "../communities/commerce/shared"
import { isCommunityStudyEnabled } from "../communities/community-study-policy-service"
import type { CommunityDatabaseBindingRepository } from "../communities/community-repository-types"
import { openCommunityWriteClient } from "../communities/community-read-access"
import { transcribeCommunityAudioWithElevenLabs } from "../communities/assistant-policy/speech-service"
import { canGenerateStudyTranslations, requestStudyPackGeneration, type StudyGeneratedLine } from "./post-study-generation-provider"
import { canReadNonPublishedPost, isPubliclyReadablePost, requireMemberAccess } from "./post-access"
import { publicCommunityId, publicPostId } from "../public-ids"
import { withTransaction } from "../transactions"

type StudyAccess = "ready" | "locked" | "processing" | "unavailable"
type ExerciseType = "say_it_back" | "translation_choice"
type AttemptOutcome = "correct" | "incorrect" | "revealed"
type FsrsRating = "again" | "hard" | "good" | "easy"

const STUDY_UNIT_GENERATION_VERSION = 1
const STUDY_LOCALIZATION_GENERATION_VERSION = 1
const FSRS_PARAMS_VERSION = 1

type StudyPost = {
  access_mode: "public" | "locked" | null
  asset_id: string | null
  author_user_id: string | null
  community_id: string
  lyrics: string | null
  post_id: string
  post_type: string
  song_cover_art_ref: string | null
  song_title: string | null
  source_language: string | null
  status: string
  title: string | null
  visibility: string
}

type StudyPack = {
  generated_at: string | null
  source_language: string | null
  status: "ready" | "processing" | "unavailable"
  study_pack_version: number
  target_language: string
  unavailable_reason: "not_song" | "no_lyrics" | "unsupported_language" | "generation_failed" | null
}

type StudyExerciseRow = {
  correct_option_id: string | null
  exercise_type: ExerciseType
  id: string
  line_id: string
  line_index: number
  max_attempts: number
  options_json: string | null
  prompt_text: string
  question: string | null
  reference_text: string | null
  review_language: string
  study_pack_version: number
  translation_text: string | null
}

type StudyUnitRow = {
  id: string
  line_id: string
  line_index: number
  max_attempts: number
  prompt_text: string
  reference_text: string
  say_it_back_status: "ready" | "unavailable"
  source_language: string | null
  unit_version: number
}

type StudyAttemptRow = {
  attempt_number: number
  exercise_id: string
  feedback_json: string | null
  fsrs_rating: FsrsRating | null
  outcome: AttemptOutcome
  selected_option_id: string | null
  transcript: string | null
  type: ExerciseType
}

export type SongStudyExercise =
  | {
      id: string
      line_id: string
      line_index: number
      max_attempts: number
      prompt_text: string
      reference_text: string
      translation_text?: string | null
      type: "say_it_back"
    }
  | {
      id: string
      line_id: string
      line_index: number
      max_attempts: number
      options: Array<{ id: string; text: string }>
      prompt_text: string
      question: string
      type: "translation_choice"
    }

export type SongStudyPayload = {
  access: StudyAccess
  artist_name?: string | null
  artwork_src?: string | null
  community_id: string
  exercise_count: number
  exercises: SongStudyExercise[]
  generated_at?: number
  locked_reason?: "purchase_required" | "membership_required" | "age_required"
  object: "song_study_payload"
  post_id: string
  source_language?: string | null
  study_pack_version?: number
  target_language?: string | null
  title: string
  unavailable_reason?: "not_song" | "no_lyrics" | "unsupported_language" | "generation_failed"
}

export type SongStudyAttemptRequest = {
  attempt_number?: unknown
  exercise_id?: unknown
  idempotency_key?: unknown
  selected_option_id?: unknown
  transcript?: unknown
  type?: unknown
}

export type SongStudyAttemptResult = {
  attempts_remaining: number
  correct_option_id?: string
  exercise_id: string
  feedback?: {
    matched: string[]
    missing: string[]
    extra: string[]
  }
  next_review_hint?: FsrsRating
  object: "song_study_attempt_result"
  outcome: AttemptOutcome
}

export type SongStudyTranscriptionResponse = {
  confidence: number | null
  duration_seconds: number | null
  language_code: string | null
  language_probability: number | null
  model: string
  object: "song_study_transcription"
  provider: "elevenlabs"
  text: string
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed || null
}

function readRequiredString(value: unknown, field: string): string {
  const trimmed = readString(value)
  if (!trimmed) throw badRequestError(`${field} is required`)
  return trimmed
}

function readAttemptNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw badRequestError("attempt_number must be a positive integer")
  }
  return value
}

function publicTitle(post: StudyPost): string {
  return post.song_title || post.title || "Untitled song"
}

function toUnixSeconds(value: string | null): number | undefined {
  if (!value) return undefined
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined
}

async function getStudyPostById(client: ReadClient, postId: string): Promise<StudyPost | null> {
  const row = await executeFirst(client, {
    sql: `
      SELECT post_id, community_id, author_user_id, post_type, status, visibility,
             lyrics,
             title, song_title, song_cover_art_ref, source_language, access_mode, asset_id
      FROM posts
      WHERE post_id = ?1
      LIMIT 1
    `,
    args: [postId],
  }) as Record<string, unknown> | null
  if (!row) return null
  return {
    access_mode: readString(row.access_mode) as StudyPost["access_mode"],
    asset_id: readString(row.asset_id),
    author_user_id: readString(row.author_user_id),
    community_id: readString(row.community_id) ?? "",
    lyrics: readString(row.lyrics),
    post_id: readString(row.post_id) ?? "",
    post_type: readString(row.post_type) ?? "",
    song_cover_art_ref: readString(row.song_cover_art_ref),
    song_title: readString(row.song_title),
    source_language: readString(row.source_language),
    status: readString(row.status) ?? "",
    title: readString(row.title),
    visibility: readString(row.visibility) ?? "public",
  }
}

async function canReadPostForStudy(input: {
  actor: ActorContext | AdminActorContext
  client: ReadClient
  post: StudyPost
}): Promise<boolean> {
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

async function canStudyPost(input: {
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

async function getLatestPack(input: {
  client: ReadClient
  postId: string
  targetLanguage: string
}): Promise<StudyPack | null> {
  const unitSummary = await executeFirst(input.client, {
    sql: `
      SELECT COUNT(*) AS unit_count,
             MAX(source_language) AS source_language,
             MAX(unit_version) AS unit_version
      FROM song_study_unit
      WHERE post_id = ?1
    `,
    args: [input.postId],
  }) as Record<string, unknown> | null
  const unitCount = Number(unitSummary?.unit_count ?? 0)
  if (unitCount <= 0) return null
  const localizationSummary = await executeFirst(input.client, {
    sql: `
      SELECT COUNT(*) AS localization_count,
             MAX(generated_at) AS generated_at,
             MIN(localization_version) AS min_localization_version,
             MAX(localization_version) AS max_localization_version,
             SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) AS ready_count,
             SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing_count
      FROM song_study_unit_localization
      WHERE target_language = ?1
        AND unit_id IN (
          SELECT id FROM song_study_unit WHERE post_id = ?2
        )
    `,
    args: [input.targetLanguage, input.postId],
  }) as Record<string, unknown> | null
  const localizationCount = Number(localizationSummary?.localization_count ?? 0)
  const minLocalizationVersion = Number(localizationSummary?.min_localization_version ?? 0)
  if (localizationCount < unitCount || minLocalizationVersion < STUDY_LOCALIZATION_GENERATION_VERSION) {
    return null
  }
  const processingCount = Number(localizationSummary?.processing_count ?? 0)
  return {
    generated_at: readString(localizationSummary?.generated_at),
    source_language: readString(unitSummary?.source_language),
    status: processingCount > 0 ? "processing" : "ready",
    study_pack_version: Math.max(
      Number(unitSummary?.unit_version ?? STUDY_UNIT_GENERATION_VERSION),
      Number(localizationSummary?.max_localization_version ?? STUDY_LOCALIZATION_GENERATION_VERSION),
    ),
    target_language: input.targetLanguage,
    unavailable_reason: null,
  }
}

function parseOptions(raw: string | null): Array<{ id: string; text: string }> {
  if (!raw) return []
  const parsed = JSON.parse(raw) as unknown
  if (!Array.isArray(parsed)) return []
  return parsed.flatMap((option) => {
    if (!option || typeof option !== "object") return []
    const record = option as Record<string, unknown>
    const id = readString(record.id)
    const text = readString(record.text)
    return id && text ? [{ id, text }] : []
  })
}

function stableHash(value: string): number {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function orderOptionsForLearner(options: Array<{ id: string; text: string }>, seed: string): Array<{ id: string; text: string }> {
  return [...options].sort((left, right) => {
    const leftRank = stableHash(`${seed}:${left.id}`)
    const rightRank = stableHash(`${seed}:${right.id}`)
    return leftRank - rightRank || left.id.localeCompare(right.id)
  })
}

function toExercise(row: StudyExerciseRow, learnerSeed: string): SongStudyExercise {
  if (row.exercise_type === "translation_choice") {
    return {
      id: row.id,
      line_id: row.line_id,
      line_index: row.line_index,
      max_attempts: row.max_attempts,
      options: orderOptionsForLearner(parseOptions(row.options_json), `${learnerSeed}:${row.id}`),
      prompt_text: row.prompt_text,
      question: row.question || "Choose the best translation.",
      type: "translation_choice",
    }
  }
  return {
    id: row.id,
    line_id: row.line_id,
    line_index: row.line_index,
    max_attempts: row.max_attempts,
    prompt_text: row.prompt_text,
    reference_text: row.reference_text || row.prompt_text,
    translation_text: row.translation_text,
    type: "say_it_back",
  }
}

async function listExercises(input: {
  client: ReadClient
  postId: string
  targetLanguage: string
}): Promise<StudyExerciseRow[]> {
  const result = await input.client.execute({
    sql: `
      SELECT ('stu:' || id || ':say_it_back:' || COALESCE(source_language, 'source')) AS id,
             line_id, line_index, 'say_it_back' AS exercise_type, prompt_text,
             NULL AS question, reference_text, NULL AS translation_text,
             NULL AS options_json, NULL AS correct_option_id, max_attempts,
             COALESCE(source_language, 'source') AS review_language, unit_version AS study_pack_version,
             0 AS sort_order
      FROM song_study_unit
      WHERE post_id = ?1
        AND say_it_back_status = 'ready'
      UNION ALL
      SELECT ('stu:' || u.id || ':translation_choice:' || l.target_language) AS id,
             u.line_id, u.line_index, 'translation_choice' AS exercise_type,
             u.prompt_text, l.question, NULL AS reference_text, l.translation_text,
             l.options_json, l.correct_option_id, l.max_attempts,
             l.target_language AS review_language, l.localization_version AS study_pack_version,
             1 AS sort_order
      FROM song_study_unit u
      JOIN song_study_unit_localization l ON l.unit_id = u.id
      WHERE u.post_id = ?1
        AND l.target_language = ?2
        AND l.status = 'ready'
        AND l.translation_text IS NOT NULL
        AND l.options_json IS NOT NULL
        AND l.correct_option_id IS NOT NULL
      ORDER BY line_index ASC, sort_order ASC, id ASC
    `,
    args: [input.postId, input.targetLanguage],
  })
  return result.rows.map((row) => ({
    correct_option_id: readString(row.correct_option_id),
    exercise_type: (readString(row.exercise_type) ?? "say_it_back") as ExerciseType,
    id: readString(row.id) ?? "",
    line_id: readString(row.line_id) ?? "",
    line_index: Number(row.line_index ?? 0),
    max_attempts: Number(row.max_attempts ?? 1),
    options_json: readString(row.options_json),
    prompt_text: readString(row.prompt_text) ?? "",
    question: readString(row.question),
    reference_text: readString(row.reference_text),
    review_language: readString(row.review_language) ?? input.targetLanguage,
    study_pack_version: Number(row.study_pack_version ?? 1),
    translation_text: readString(row.translation_text),
  }))
}

function studyLineId(index: number): string {
  return `line_${String(index + 1).padStart(3, "0")}`
}

function isPureAdLib(line: string): boolean {
  return /^\s*\([^)]+\)\s*$/u.test(line)
}

function stripTrailingAdLibs(line: string): string {
  return line.replace(/\s*\([^)]*\)\s*$/u, "").trim()
}

function wordCount(line: string): number {
  return line.split(/\s+/u).filter(Boolean).length
}

function splitLyricsForStudy(lyrics: string | null): Array<{ lineId: string; lineIndex: number; text: string }> {
  const seen = new Set<string>()
  const units: Array<{ lineId: string; lineIndex: number; text: string }> = []
  String(lyrics ?? "")
    .split(/\r?\n/u)
    .map((line) => line.replace(/\s+/gu, " ").trim())
    .filter(Boolean)
    .filter((line) => !/^\[[^\]]+\]$/u.test(line))
    .forEach((line, index) => {
      if (isPureAdLib(line)) return
      const text = stripTrailingAdLibs(line)
      if (wordCount(text) < 2) return
      const normalized = normalizeForStudy(text)
      if (seen.has(normalized)) return
      seen.add(normalized)
      units.push({ lineId: studyLineId(index), lineIndex: index, text })
    })
  return units
}

function optionId(lineIndex: number, optionIndex: number): string {
  return `line_${String(lineIndex + 1).padStart(3, "0")}_opt_${optionIndex + 1}`
}

function orderedTranslationOptions(input: {
  generated: StudyGeneratedLine
  lineIndex: number
}): { correctOptionId: string; options: Array<{ id: string; text: string }> } {
  const values = [
    input.generated.translation,
    ...input.generated.distractors.filter((distractor) => distractor !== input.generated.translation),
  ].slice(0, 4)
  const rotation = input.lineIndex % values.length
  const rotated = [...values.slice(rotation), ...values.slice(0, rotation)]
  const options = rotated.map((text, index) => ({
    id: optionId(input.lineIndex, index),
    text,
  }))
  const correctOptionId = options.find((option) => option.text === input.generated.translation)?.id
    ?? options[0]?.id
    ?? optionId(input.lineIndex, 0)
  return { correctOptionId, options }
}

async function ensureStudyUnits(client: Client, post: StudyPost): Promise<StudyUnitRow[]> {
  const existing = await client.execute({
    sql: `
      SELECT id, line_id, line_index, source_language, prompt_text, reference_text,
             say_it_back_status, unit_version, max_attempts
      FROM song_study_unit
      WHERE post_id = ?1
      ORDER BY line_index ASC
    `,
    args: [post.post_id],
  })
  if (existing.rows.length > 0) {
    return existing.rows.map((row) => ({
      id: readString(row.id) ?? "",
      line_id: readString(row.line_id) ?? "",
      line_index: Number(row.line_index ?? 0),
      max_attempts: Number(row.max_attempts ?? 2),
      prompt_text: readString(row.prompt_text) ?? "",
      reference_text: readString(row.reference_text) ?? readString(row.prompt_text) ?? "",
      say_it_back_status: (readString(row.say_it_back_status) ?? "ready") as StudyUnitRow["say_it_back_status"],
      source_language: readString(row.source_language),
      unit_version: Number(row.unit_version ?? 1),
    }))
  }

  const lines = splitLyricsForStudy(post.lyrics)
  if (lines.length === 0) return []
  const now = nowIso()
  for (const line of lines) {
    await client.execute({
      sql: `
        INSERT INTO song_study_unit (
          id, post_id, line_id, line_index, source_language, prompt_text,
          reference_text, say_it_back_status, unit_version, max_attempts,
          created_at, updated_at
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, 'ready', ?7, 2, ?8, ?8)
      `,
      args: [
        makeId("stu"),
        post.post_id,
        line.lineId,
        line.lineIndex,
        post.source_language,
        line.text,
        STUDY_UNIT_GENERATION_VERSION,
        now,
      ],
    })
  }
  return ensureStudyUnits(client, post)
}

async function createReadyStudyPack(input: {
  client: Client
  env: Env
  post: StudyPost
  targetLanguage: string
}): Promise<StudyPack | null> {
  const units = await ensureStudyUnits(input.client, input.post)
  if (units.length === 0) return null

  const generatedLines = new Map<string, StudyGeneratedLine>()
  if (canGenerateStudyTranslations(input.env)) {
    try {
      const generated = await requestStudyPackGeneration({
        env: input.env,
        lines: units.filter((unit) => wordCount(unit.prompt_text) >= 3).map((unit) => {
          const previous = units.find((candidate) => candidate.line_index === unit.line_index - 1)
          const next = units.find((candidate) => candidate.line_index === unit.line_index + 1)
          return {
            lineId: unit.line_id,
            next: next?.prompt_text ?? null,
            previous: previous?.prompt_text ?? null,
            text: unit.prompt_text,
          }
        }),
        sourceLanguage: input.post.source_language,
        targetLanguage: input.targetLanguage,
      })
      for (const line of generated.lines) {
        generatedLines.set(line.lineId, line)
      }
    } catch {
      // Keep the route usable for say-it-back when generation is unavailable.
      // Translation-choice exercises are only created from validated provider output.
    }
  }

  const now = nowIso()
  const existingLocalizationRows = await input.client.execute({
    sql: `
      SELECT unit_id, localization_version, status
      FROM song_study_unit_localization
      WHERE target_language = ?1
        AND unit_id IN (${units.map(() => "?").join(", ")})
    `,
    args: [input.targetLanguage, ...units.map((unit) => unit.id)],
  })
  const existingLocalizations = new Map(existingLocalizationRows.rows.map((row) => [
    readString(row.unit_id) ?? "",
    {
      localization_version: Number(row.localization_version ?? 0),
      status: readString(row.status),
    },
  ]))
  for (const unit of units) {
    const generatedLine = generatedLines.get(unit.line_id)
    if (!generatedLine || generatedLine.distractors.length < 3) {
      const existing = existingLocalizations.get(unit.id)
      if (existing?.status === "ready") {
        continue
      }
      await input.client.execute({
        sql: `
          INSERT INTO song_study_unit_localization (
            id, unit_id, target_language, localization_version, status,
            max_attempts, created_at, updated_at
          )
          VALUES (?1, ?2, ?3, ?4, 'unavailable', 1, ?5, ?5)
          ON CONFLICT(unit_id, target_language) DO UPDATE SET
            localization_version = excluded.localization_version,
            status = 'unavailable',
            question = NULL,
            translation_text = NULL,
            options_json = NULL,
            correct_option_id = NULL,
            explanation_text = NULL,
            max_attempts = excluded.max_attempts,
            generated_at = NULL,
            updated_at = excluded.updated_at
        `,
        args: [makeId("sul"), unit.id, input.targetLanguage, STUDY_LOCALIZATION_GENERATION_VERSION, now],
      })
      continue
    }
    const { correctOptionId, options } = orderedTranslationOptions({
      generated: generatedLine,
      lineIndex: unit.line_index,
    })
    await input.client.execute({
      sql: `
        INSERT INTO song_study_unit_localization (
          id, unit_id, target_language, localization_version, status,
          question, translation_text, options_json, correct_option_id,
          explanation_text, max_attempts, generated_at, created_at, updated_at
        )
        VALUES (?1, ?2, ?3, ?4, 'ready', 'Choose the best translation.', ?5, ?6, ?7, ?8, 1, ?9, ?9, ?9)
        ON CONFLICT(unit_id, target_language) DO UPDATE SET
          localization_version = excluded.localization_version,
          status = 'ready',
          question = excluded.question,
          translation_text = excluded.translation_text,
          options_json = excluded.options_json,
          correct_option_id = excluded.correct_option_id,
          explanation_text = excluded.explanation_text,
          max_attempts = excluded.max_attempts,
          generated_at = excluded.generated_at,
          updated_at = excluded.updated_at
      `,
      args: [
        makeId("sul"),
        unit.id,
        input.targetLanguage,
        STUDY_LOCALIZATION_GENERATION_VERSION,
        generatedLine.translation,
        JSON.stringify(options),
        correctOptionId,
        generatedLine.explanation ?? null,
        now,
      ],
    })
  }

  return {
    generated_at: now,
    source_language: input.post.source_language,
    status: "ready",
    study_pack_version: Math.max(STUDY_UNIT_GENERATION_VERSION, STUDY_LOCALIZATION_GENERATION_VERSION),
    target_language: input.targetLanguage,
    unavailable_reason: null,
  }
}

function basePayload(input: {
  access: StudyAccess
  post: StudyPost
  targetLanguage: string
}): SongStudyPayload {
  return {
    access: input.access,
    artwork_src: input.post.song_cover_art_ref,
    community_id: publicCommunityId(input.post.community_id),
    exercise_count: 0,
    exercises: [],
    object: "song_study_payload",
    post_id: publicPostId(input.post.post_id),
    source_language: input.post.source_language,
    target_language: input.targetLanguage,
    title: publicTitle(input.post),
  }
}

export async function getPostStudyPayload(input: {
  actor: ActorContext | AdminActorContext
  communityId: string
  communityRepository: CommunityDatabaseBindingRepository
  env: Env
  postId: string
  targetLanguage?: string | null
}): Promise<SongStudyPayload> {
  const targetLanguage = readString(input.targetLanguage) ?? "en"
  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.communityId)
  try {
    const post = await getStudyPostById(db.client, input.postId)
    if (!post || post.community_id !== input.communityId) throw notFoundError("Post not found")
    if (!await canReadPostForStudy({ actor: input.actor, client: db.client, post })) {
      throw notFoundError("Post not found")
    }
    if (!await isCommunityStudyEnabled({ executor: db.client, communityId: input.communityId })) {
      return basePayload({ access: "unavailable", post, targetLanguage })
    }
    if (post.post_type !== "song") {
      return {
        ...basePayload({ access: "unavailable", post, targetLanguage }),
        unavailable_reason: "not_song",
      }
    }
    if (!await canStudyPost({ actor: input.actor, client: db.client, communityId: input.communityId, post })) {
      return {
        ...basePayload({ access: "locked", post, targetLanguage }),
        locked_reason: "purchase_required",
      }
    }

    let pack = await getLatestPack({ client: db.client, postId: input.postId, targetLanguage })
    if (!pack) {
      pack = await createReadyStudyPack({ client: db.client, env: input.env, post, targetLanguage })
    }
    if (!pack) {
      return {
        ...basePayload({ access: "unavailable", post, targetLanguage }),
        unavailable_reason: "no_lyrics",
      }
    }
    if (pack.status === "processing") {
      return basePayload({ access: "processing", post, targetLanguage: pack.target_language })
    }
    if (pack.status === "unavailable") {
      return {
        ...basePayload({ access: "unavailable", post, targetLanguage: pack.target_language }),
        source_language: pack.source_language ?? post.source_language,
        unavailable_reason: pack.unavailable_reason ?? "generation_failed",
      }
    }

    const exercises = (await listExercises({
      client: db.client,
      postId: input.postId,
      targetLanguage: pack.target_language,
    })).map((row) => toExercise(row, input.actor.userId))
    if (exercises.length === 0) {
      return {
        ...basePayload({ access: "unavailable", post, targetLanguage: pack.target_language }),
        source_language: pack.source_language ?? post.source_language,
        unavailable_reason: "no_lyrics",
      }
    }
    return {
      ...basePayload({ access: "ready", post, targetLanguage: pack.target_language }),
      exercise_count: exercises.length,
      exercises,
      generated_at: toUnixSeconds(pack.generated_at),
      source_language: pack.source_language ?? post.source_language,
      study_pack_version: pack.study_pack_version,
    }
  } finally {
    await db.close()
  }
}

async function getExerciseForAttempt(client: ReadClient, exerciseId: string): Promise<(StudyExerciseRow & {
  post_id: string
  source_language: string | null
  status: StudyPack["status"]
  study_pack_version: number
  target_language: string
}) | null> {
  const sayItBackMatch = /^stu:([^:]+):say_it_back:([^:]+)$/u.exec(exerciseId)
  if (sayItBackMatch) {
    const unitId = sayItBackMatch[1]!
    const row = await executeFirst(client, {
      sql: `
        SELECT id, post_id, line_id, line_index, source_language, prompt_text,
               reference_text, say_it_back_status, unit_version, max_attempts
        FROM song_study_unit
        WHERE id = ?1
        LIMIT 1
      `,
      args: [unitId],
    }) as Record<string, unknown> | null
    if (!row) return null
    const sourceLanguage = readString(row.source_language) ?? "source"
    return {
      correct_option_id: null,
      exercise_type: "say_it_back",
      id: exerciseId,
      line_id: readString(row.line_id) ?? "",
      line_index: Number(row.line_index ?? 0),
      max_attempts: Number(row.max_attempts ?? 2),
      options_json: null,
      post_id: readString(row.post_id) ?? "",
      prompt_text: readString(row.prompt_text) ?? "",
      question: null,
      reference_text: readString(row.reference_text),
      review_language: sourceLanguage,
      source_language: sourceLanguage,
      status: (readString(row.say_it_back_status) === "ready" ? "ready" : "unavailable"),
      study_pack_version: Number(row.unit_version ?? 1),
      target_language: sourceLanguage,
      translation_text: null,
    }
  }

  const translationMatch = /^stu:([^:]+):translation_choice:(.+)$/u.exec(exerciseId)
  if (translationMatch) {
    const unitId = translationMatch[1]!
    const targetLanguage = translationMatch[2]!
    const row = await executeFirst(client, {
      sql: `
        SELECT u.id, u.post_id, u.line_id, u.line_index, u.source_language,
               u.prompt_text, l.question, l.translation_text, l.options_json,
               l.correct_option_id, l.max_attempts, l.status, l.localization_version,
               l.target_language
        FROM song_study_unit u
        JOIN song_study_unit_localization l ON l.unit_id = u.id
        WHERE u.id = ?1
          AND l.target_language = ?2
        LIMIT 1
      `,
      args: [unitId, targetLanguage],
    }) as Record<string, unknown> | null
    if (!row) return null
    return {
      correct_option_id: readString(row.correct_option_id),
      exercise_type: "translation_choice",
      id: exerciseId,
      line_id: readString(row.line_id) ?? "",
      line_index: Number(row.line_index ?? 0),
      max_attempts: Number(row.max_attempts ?? 1),
      options_json: readString(row.options_json),
      post_id: readString(row.post_id) ?? "",
      prompt_text: readString(row.prompt_text) ?? "",
      question: readString(row.question),
      reference_text: null,
      review_language: readString(row.target_language) ?? targetLanguage,
      source_language: readString(row.source_language),
      status: (readString(row.status) ?? "processing") as StudyPack["status"],
      study_pack_version: Number(row.localization_version ?? 1),
      target_language: readString(row.target_language) ?? targetLanguage,
      translation_text: readString(row.translation_text),
    }
  }

  return null
}

function normalizeForStudy(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s']/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
}

const IGNORED_RECALL_TOKENS = new Set(["a", "an", "the"])

function expandEnglishContractions(value: string): string {
  return value
    .replace(/\b(can)'t\b/giu, "$1 not")
    .replace(/\b(won)'t\b/giu, "will not")
    .replace(/\b(i)'m\b/giu, "$1 am")
    .replace(/\b([a-z]+)'re\b/giu, "$1 are")
    .replace(/\b([a-z]+)'ve\b/giu, "$1 have")
    .replace(/\b([a-z]+)'ll\b/giu, "$1 will")
    .replace(/\b([a-z]+)'d\b/giu, "$1 would")
    .replace(/\b([a-z]+)'s\b/giu, "$1 is")
}

function normalizeRecallToken(token: string): string {
  const compact = token.replace(/'/gu, "")
  if (compact.length > 4 && compact.endsWith("ies")) return `${compact.slice(0, -3)}y`
  if (compact.length > 4 && /(ches|shes|xes|zes|ses)$/u.test(compact)) return compact.slice(0, -2)
  if (compact.length > 3 && compact.endsWith("s")) return compact.slice(0, -1)
  return compact
}

function recallTokens(value: string): string[] {
  return normalizeForStudy(expandEnglishContractions(value))
    .split(" ")
    .map(normalizeRecallToken)
    .filter((token) => token && !IGNORED_RECALL_TOKENS.has(token))
}

function languageAgnosticRecallTokens(value: string): string[] {
  return normalizeForStudy(value).split(" ").filter(Boolean)
}

function recallTokensForSourceLanguage(value: string, sourceLanguage: string | null | undefined): string[] {
  return String(sourceLanguage ?? "").toLowerCase().startsWith("en")
    ? recallTokens(value)
    : languageAgnosticRecallTokens(value)
}

function tokenDiff(reference: string, transcript: string, sourceLanguage: string | null | undefined): { matched: string[]; missing: string[]; extra: string[] } {
  const referenceTokens = recallTokensForSourceLanguage(reference, sourceLanguage)
  const transcriptTokens = recallTokensForSourceLanguage(transcript, sourceLanguage)
  const remaining = [...transcriptTokens]
  const matched: string[] = []
  const missing: string[] = []
  for (const token of referenceTokens) {
    const index = remaining.indexOf(token)
    if (index >= 0) {
      matched.push(token)
      remaining.splice(index, 1)
    } else {
      missing.push(token)
    }
  }
  return { matched, missing, extra: remaining }
}

function tokenEditDistance(left: string[], right: string[]): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = previous[0]
    previous[0] = leftIndex
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const old = previous[rightIndex]
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1
      previous[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + 1,
        diagonal + cost,
      )
      diagonal = old
    }
  }
  return previous[right.length] ?? 0
}

function gradeSayItBack(input: {
  attemptNumber: number
  reference: string
  sourceLanguage: string | null | undefined
  transcript: string
}): { correct: boolean; feedback: { matched: string[]; missing: string[]; extra: string[] }; rating: FsrsRating } {
  const referenceTokens = recallTokensForSourceLanguage(input.reference, input.sourceLanguage)
  const transcriptTokens = recallTokensForSourceLanguage(input.transcript, input.sourceLanguage)
  const distance = tokenEditDistance(referenceTokens, transcriptTokens)
  const maxLength = Math.max(referenceTokens.length, transcriptTokens.length, 1)
  const nearMiss = distance > 0 && distance <= Math.max(1, Math.floor(maxLength * 0.25))
  const correct = distance === 0
  return {
    correct,
    feedback: tokenDiff(input.reference, input.transcript, input.sourceLanguage),
    rating: correct ? fsrsRatingFor("correct", input.attemptNumber) : nearMiss ? "hard" : "again",
  }
}

function fsrsRatingFor(outcome: AttemptOutcome, attemptNumber: number): FsrsRating {
  if (outcome === "revealed") return "again"
  if (outcome === "correct" && attemptNumber <= 1) return "good"
  if (outcome === "correct") return "hard"
  return "again"
}

function resultFromAttempt(row: StudyAttemptRow, exercise: { correct_option_id: string | null; exercise_type: ExerciseType; max_attempts: number }): SongStudyAttemptResult {
  const feedback = row.feedback_json ? JSON.parse(row.feedback_json) as SongStudyAttemptResult["feedback"] : undefined
  return {
    attempts_remaining: Math.max(0, exercise.max_attempts - row.attempt_number),
    ...(exercise.exercise_type === "translation_choice"
      && (row.outcome === "correct" || row.outcome === "revealed")
      && exercise.correct_option_id
      ? { correct_option_id: exercise.correct_option_id }
      : {}),
    exercise_id: row.exercise_id,
    ...(feedback ? { feedback } : {}),
    ...(row.fsrs_rating ? { next_review_hint: row.fsrs_rating } : {}),
    object: "song_study_attempt_result",
    outcome: row.outcome,
  }
}

async function getAttemptByIdempotencyKey(client: ReadClient, userId: string, idempotencyKey: string): Promise<StudyAttemptRow | null> {
  const row = await executeFirst(client, {
    sql: `
      SELECT exercise_id, exercise_type, attempt_number, selected_option_id,
             transcript, outcome, feedback_json, fsrs_rating
      FROM song_study_attempt
      WHERE user_id = ?1
        AND idempotency_key = ?2
      LIMIT 1
    `,
    args: [userId, idempotencyKey],
  }) as Record<string, unknown> | null
  return row
    ? {
        attempt_number: Number(row.attempt_number ?? 1),
        exercise_id: readString(row.exercise_id) ?? "",
        feedback_json: readString(row.feedback_json),
        fsrs_rating: readString(row.fsrs_rating) as FsrsRating | null,
        outcome: (readString(row.outcome) ?? "incorrect") as AttemptOutcome,
        selected_option_id: readString(row.selected_option_id),
        transcript: readString(row.transcript),
        type: (readString(row.exercise_type) ?? "say_it_back") as ExerciseType,
      }
    : null
}

function assertEquivalentIdempotentRetry(input: {
  attemptNumber: number
  body: SongStudyAttemptRequest
  existing: StudyAttemptRow
  exerciseId: string
  type: ExerciseType
}): void {
  const selectedOptionId = readString(input.body.selected_option_id)
  const transcript = readString(input.body.transcript)
  const same = input.existing.exercise_id === input.exerciseId
    && input.existing.type === input.type
    && input.existing.attempt_number === input.attemptNumber
    && input.existing.selected_option_id === selectedOptionId
    && input.existing.transcript === transcript
  if (!same) {
    throw conflictError("idempotency_key was reused with a different study attempt payload")
  }
}

async function hasAttemptNumber(client: ReadClient, userId: string, exerciseId: string, attemptNumber: number): Promise<boolean> {
  const row = await executeFirst(client, {
    sql: `
      SELECT id
      FROM song_study_attempt
      WHERE user_id = ?1
        AND exercise_id = ?2
        AND attempt_number = ?3
      LIMIT 1
    `,
    args: [userId, exerciseId, attemptNumber],
  })
  return Boolean(row)
}

async function upsertReviewState(input: {
  client: Pick<ReadClient, "execute">
  exercise: Awaited<ReturnType<typeof getExerciseForAttempt>> & {}
  now: string
  rating: FsrsRating
  userId: string
}): Promise<FsrsRating> {
  const rating = input.rating
  const remembered = rating !== "again"
  const stability = rating === "again" ? 0.5 : rating === "hard" ? 1 : rating === "easy" ? 3 : 2
  const difficulty = rating === "again" ? 8 : rating === "hard" ? 6 : rating === "easy" ? 3 : 4
  const state = remembered ? "review" : "learning"
  await input.client.execute({
    sql: `
      INSERT INTO song_study_review_state (
        user_id, post_id, line_id, exercise_type, target_language,
        state, stability, difficulty, due_at, last_reviewed_at,
        reps, lapses, fsrs_params_version, updated_at
      )
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 1, ?11, ?12, ?13)
      ON CONFLICT(user_id, post_id, line_id, exercise_type, target_language)
      DO UPDATE SET
        state = excluded.state,
        stability = excluded.stability,
        difficulty = excluded.difficulty,
        due_at = excluded.due_at,
        last_reviewed_at = excluded.last_reviewed_at,
        reps = song_study_review_state.reps + 1,
        lapses = song_study_review_state.lapses + excluded.lapses,
        fsrs_params_version = excluded.fsrs_params_version,
        updated_at = excluded.updated_at
    `,
    args: [
      input.userId,
      input.exercise.post_id,
      input.exercise.line_id,
      input.exercise.exercise_type,
      input.exercise.review_language,
      state,
      stability,
      difficulty,
      input.now,
      input.now,
      remembered ? 0 : 1,
      FSRS_PARAMS_VERSION,
      input.now,
    ],
  })
  return rating
}

export async function submitPostStudyAttempt(input: {
  actor: ActorContext | AdminActorContext
  body: SongStudyAttemptRequest
  communityId: string
  communityRepository: CommunityDatabaseBindingRepository
  env: Env
  postId: string
}): Promise<SongStudyAttemptResult> {
  const idempotencyKey = readRequiredString(input.body.idempotency_key, "idempotency_key")
  const exerciseId = readRequiredString(input.body.exercise_id, "exercise_id")
  const type = readRequiredString(input.body.type, "type") as ExerciseType
  if (type !== "say_it_back" && type !== "translation_choice") {
    throw badRequestError("type must be say_it_back or translation_choice")
  }
  const attemptNumber = readAttemptNumber(input.body.attempt_number)

  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.communityId)
  try {
    if (!await isCommunityStudyEnabled({ executor: db.client, communityId: input.communityId })) {
      throw new HttpError(403, "forbidden", "Study is disabled for this community")
    }

    const existing = await getAttemptByIdempotencyKey(db.client, input.actor.userId, idempotencyKey)
    const existingExercise = existing ? await getExerciseForAttempt(db.client, existing.exercise_id) : null
    if (existing && existingExercise) {
      assertEquivalentIdempotentRetry({
        attemptNumber,
        body: input.body,
        existing,
        exerciseId,
        type,
      })
      return resultFromAttempt(existing, existingExercise)
    }

    const exercise = await getExerciseForAttempt(db.client, exerciseId)
    if (!exercise || exercise.post_id !== input.postId || exercise.status !== "ready") {
      throw notFoundError("Study exercise not found")
    }
    if (exercise.exercise_type !== type) {
      throw badRequestError("type does not match exercise")
    }
    if (attemptNumber > exercise.max_attempts) {
      throw badRequestError("attempt_number exceeds max_attempts")
    }
    if (await hasAttemptNumber(db.client, input.actor.userId, exerciseId, attemptNumber)) {
      throw conflictError("attempt_number has already been recorded for this exercise")
    }

    const post = await getStudyPostById(db.client, input.postId)
    if (!post || post.community_id !== input.communityId) throw notFoundError("Post not found")
    if (!await canReadPostForStudy({ actor: input.actor, client: db.client, post })) {
      throw notFoundError("Post not found")
    }
    if (!await canStudyPost({ actor: input.actor, client: db.client, communityId: input.communityId, post })) {
      throw new HttpError(403, "forbidden", "Caller is not entitled to study this post")
    }

    let correct = false
    let selectedOptionId: string | null = null
    let transcript: string | null = null
    let feedback: SongStudyAttemptResult["feedback"] | undefined
    let rating: FsrsRating | null = null
    if (type === "translation_choice") {
      selectedOptionId = readRequiredString(input.body.selected_option_id, "selected_option_id")
      if (readString(input.body.transcript)) throw badRequestError("transcript is only valid for say_it_back")
      correct = Boolean(exercise.correct_option_id && selectedOptionId === exercise.correct_option_id)
    } else {
      transcript = readRequiredString(input.body.transcript, "transcript")
      if (readString(input.body.selected_option_id)) throw badRequestError("selected_option_id is only valid for translation_choice")
      const reference = exercise.reference_text || exercise.prompt_text
      const grade = gradeSayItBack({
        attemptNumber,
        reference,
        sourceLanguage: exercise.source_language,
        transcript,
      })
      correct = grade.correct
      feedback = grade.feedback
      rating = grade.rating
    }
    const outcome: AttemptOutcome = correct
      ? "correct"
      : attemptNumber >= exercise.max_attempts ? "revealed" : "incorrect"
    rating ??= fsrsRatingFor(outcome, attemptNumber)
    const attemptsRemaining = Math.max(0, exercise.max_attempts - attemptNumber)
    const now = nowIso()
    const fsrsRating = await withTransaction(db.client, "write", async (tx) => {
      const reviewRating = await upsertReviewState({
        client: tx,
        exercise,
        now,
        rating,
        userId: input.actor.userId,
      })
      await tx.execute({
        sql: `
          INSERT INTO song_study_attempt (
            id, user_id, post_id, exercise_id, line_id, exercise_type,
            target_language, study_pack_version, attempt_number, idempotency_key,
            selected_option_id, transcript, outcome, feedback_json, fsrs_rating, created_at
          )
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
        `,
        args: [
          makeId("sta"),
          input.actor.userId,
          input.postId,
          exercise.id,
          exercise.line_id,
          exercise.exercise_type,
          exercise.review_language,
          exercise.study_pack_version,
          attemptNumber,
          idempotencyKey,
          selectedOptionId,
          transcript,
          outcome,
          feedback ? JSON.stringify(feedback) : null,
          reviewRating,
          now,
        ],
      })
      return reviewRating
    })
    return {
      attempts_remaining: attemptsRemaining,
      ...(type === "translation_choice" && (outcome === "correct" || outcome === "revealed") && exercise.correct_option_id
        ? { correct_option_id: exercise.correct_option_id }
        : {}),
      exercise_id: exercise.id,
      ...(feedback ? { feedback } : {}),
      next_review_hint: fsrsRating,
      object: "song_study_attempt_result",
      outcome,
    }
  } finally {
    await db.close()
  }
}

export async function transcribePostStudyAudio(input: {
  actor: ActorContext | AdminActorContext
  communityId: string
  communityRepository: CommunityDatabaseBindingRepository
  env: Env
  file: File
  postId: string
}): Promise<SongStudyTranscriptionResponse> {
  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.communityId)
  try {
    if (!await isCommunityStudyEnabled({ executor: db.client, communityId: input.communityId })) {
      throw new HttpError(403, "forbidden", "Study is disabled for this community")
    }

    const post = await getStudyPostById(db.client, input.postId)
    if (!post || post.community_id !== input.communityId) throw notFoundError("Post not found")
    if (!await canReadPostForStudy({ actor: input.actor, client: db.client, post })) {
      throw notFoundError("Post not found")
    }
    if (post.post_type !== "song") {
      throw notFoundError("Study is not available")
    }
    if (!await canStudyPost({ actor: input.actor, client: db.client, communityId: input.communityId, post })) {
      throw new HttpError(403, "forbidden", "Caller is not entitled to study this post")
    }
  } finally {
    await db.close()
  }

  const transcription = await transcribeCommunityAudioWithElevenLabs({
    communityId: input.communityId,
    env: input.env,
    file: input.file,
  })
  return {
    confidence: transcription.confidence,
    duration_seconds: transcription.duration_seconds,
    language_code: transcription.language_code,
    language_probability: transcription.language_probability,
    model: transcription.model,
    object: "song_study_transcription",
    provider: transcription.provider,
    text: transcription.text,
  }
}
