import { executeFirst, type DbExecutor } from "../db-helpers"
import type { ReadClient } from "../sql-client"
import {
  readString,
  type ExerciseType,
  type StudyExerciseRow,
} from "./post-study-attempt-store"

export async function listExercises(input: {
  client: DbExecutor
  dueReviewServing: boolean
  includeSayItBack: boolean
  includeTranslation: boolean
  now: string
  postId: string
  targetLanguage: string
  userId?: string | null
  limit?: number
}): Promise<{ rows: StudyExerciseRow[]; totalCount: number }> {
  const result = await input.client.execute({
    sql: `
      SELECT exercises.*, COUNT(*) OVER () AS total_count
      FROM (
      SELECT ('stu:' || u.id || ':say_it_back:' || COALESCE(u.source_language, 'source')) AS id,
             u.line_id, u.line_index, 'say_it_back' AS exercise_type, u.prompt_text,
             NULL AS question, u.reference_text, NULL AS translation_text,
             NULL AS options_json, NULL AS correct_option_id, u.max_attempts,
             COALESCE(u.source_language, 'source') AS review_language, u.unit_version AS study_pack_version,
             0 AS sort_order,
             CASE WHEN ?6 = 1 AND s.user_id IS NOT NULL AND s.due_at <= ?7 THEN 0 ELSE 1 END AS due_rank
      FROM song_study_unit u
      LEFT JOIN song_study_review_state s
        ON s.user_id = ?5
       AND s.post_id = u.post_id
       AND s.line_id = u.line_id
       AND s.exercise_type = 'say_it_back'
       AND s.target_language = COALESCE(u.source_language, 'source')
      WHERE u.post_id = ?1
        AND u.say_it_back_status = 'ready'
        AND ?3 = 1
        AND (
          ?5 IS NULL
          OR s.user_id IS NULL
          OR (?6 = 1 AND s.due_at <= ?7)
        )
      UNION ALL
      SELECT ('stu:' || u.id || ':translation_choice:' || l.target_language) AS id,
             u.line_id, u.line_index, 'translation_choice' AS exercise_type,
             u.prompt_text, l.question, NULL AS reference_text, l.translation_text,
             l.options_json, l.correct_option_id, l.max_attempts,
             l.target_language AS review_language,
             l.localization_version AS study_pack_version,
             1 AS sort_order,
             CASE WHEN ?6 = 1 AND s.user_id IS NOT NULL AND s.due_at <= ?7 THEN 0 ELSE 1 END AS due_rank
      FROM song_study_unit u
      JOIN song_study_unit_localization l ON l.unit_id = u.id
      LEFT JOIN song_study_review_state s
        ON s.user_id = ?5
       AND s.post_id = u.post_id
       AND s.line_id = u.line_id
       AND s.exercise_type = 'translation_choice'
       AND s.target_language = l.target_language
      WHERE u.post_id = ?1
        AND ?4 = 1
        AND l.target_language = ?2
        AND l.status = 'ready'
        AND l.translation_text IS NOT NULL
        AND l.options_json IS NOT NULL
        AND l.correct_option_id IS NOT NULL
        AND (
          ?5 IS NULL
          OR s.user_id IS NULL
          OR (?6 = 1 AND s.due_at <= ?7)
        )
      ) exercises
      ORDER BY due_rank ASC, line_index ASC, sort_order ASC, id ASC
      LIMIT ?8
    `,
    args: [
      input.postId,
      input.targetLanguage,
      input.includeSayItBack ? 1 : 0,
      input.includeTranslation ? 1 : 0,
      input.userId ?? null,
      input.dueReviewServing ? 1 : 0,
      input.now,
      input.limit ?? -1,
    ],
  })
  return {
    rows: result.rows.map((row) => ({
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
    })),
    totalCount: Number(result.rows[0]?.total_count ?? 0),
  }
}


export async function getNextDueAt(input: {
  client: ReadClient
  includeSayItBack: boolean
  includeTranslation: boolean
  now: string
  postId: string
  targetLanguage: string
  userId: string
}): Promise<string | null> {
  const row = await executeFirst(input.client, {
    sql: `
      SELECT MIN(due_at) AS next_due_at
      FROM (
        SELECT s.due_at
        FROM song_study_review_state s
        JOIN song_study_unit u
          ON u.post_id = s.post_id
         AND u.line_id = s.line_id
        WHERE s.user_id = ?1
          AND s.post_id = ?2
          AND s.exercise_type = 'say_it_back'
          AND s.target_language = COALESCE(u.source_language, 'source')
          AND s.due_at > ?4
          AND u.say_it_back_status = 'ready'
          AND ?5 = 1
        UNION ALL
        SELECT s.due_at
        FROM song_study_review_state s
        JOIN song_study_unit u
          ON u.post_id = s.post_id
         AND u.line_id = s.line_id
        JOIN song_study_unit_localization l
          ON l.unit_id = u.id
         AND l.target_language = s.target_language
        WHERE s.user_id = ?1
          AND s.post_id = ?2
          AND s.exercise_type = 'translation_choice'
          AND s.target_language = ?3
          AND s.due_at > ?4
          AND ?6 = 1
          AND l.status = 'ready'
          AND l.translation_text IS NOT NULL
          AND l.options_json IS NOT NULL
          AND l.correct_option_id IS NOT NULL
      )
    `,
    args: [
      input.userId,
      input.postId,
      input.targetLanguage,
      input.now,
      input.includeSayItBack ? 1 : 0,
      input.includeTranslation ? 1 : 0,
    ],
  }) as Record<string, unknown> | null
  return readString(row?.next_due_at)
}
