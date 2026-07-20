import type { Env } from "../../env"
import { openCommunityWriteClient } from "../communities/community-read-access"
import type { CommunityDatabaseBindingRepository } from "../communities/community-repository-types"
import type { ReadClient } from "../sql-client"
import { withTransaction } from "../transactions"
import {
  studyActivityDate,
  STUDY_FALLBACK_TIMEZONE,
} from "./post-study-streak-read-service"

export async function upsertStudyEngagementDay(input: {
  client: ReadClient
  communityId: string
  isCorrect: boolean
  now: string
  postId: string
  studyTargetCount: number
  studyTimezone?: string
  userId: string
}): Promise<void> {
  const activityTimezone = input.studyTimezone ?? STUDY_FALLBACK_TIMEZONE
  const today = studyActivityDate(input.now, activityTimezone)
  const isCorrect = input.isCorrect ? 1 : 0
  await input.client.execute({
    sql: `
      INSERT INTO song_engagement_days (
        user_id, post_id, community_id, activity_date, activity_timezone,
        study_attempt_count, study_correct_count, study_target_count,
        karaoke_pass_count, qualified, created_at, updated_at
      )
      VALUES (?1, ?2, ?3, ?4, ?8, 1, ?5, ?6, 0, CASE WHEN ?5 >= ?6 THEN 1 ELSE 0 END, ?7, ?7)
      ON CONFLICT(user_id, post_id, activity_date) DO UPDATE SET
        activity_timezone = excluded.activity_timezone,
        study_attempt_count = song_engagement_days.study_attempt_count + 1,
        study_correct_count = song_engagement_days.study_correct_count + ?5,
        qualified = CASE
          WHEN song_engagement_days.study_correct_count + ?5 >= song_engagement_days.study_target_count THEN 1
          WHEN song_engagement_days.karaoke_pass_count > 0 THEN 1
          ELSE song_engagement_days.qualified
        END,
        updated_at = ?7
    `,
    args: [
      input.userId,
      input.postId,
      input.communityId,
      today,
      isCorrect,
      input.studyTargetCount,
      input.now,
      activityTimezone,
    ],
  })
}

export async function upsertCompletedStudySessionDay(input: {
  client: ReadClient
  communityId: string
  completedExerciseCount: number
  firstPassCorrectCount: number
  now: string
  postId: string
  qualified: boolean
  requiredCorrectCount: number
  studyTimezone?: string
  userId: string
}): Promise<void> {
  const activityTimezone = input.studyTimezone ?? STUDY_FALLBACK_TIMEZONE
  const today = studyActivityDate(input.now, activityTimezone)
  await input.client.execute({
    sql: `
      INSERT INTO song_engagement_days (
        user_id, post_id, community_id, activity_date, activity_timezone,
        study_attempt_count, study_correct_count, study_target_count,
        karaoke_pass_count, qualified, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?10, ?5, ?6, ?7, 0, ?8, ?9, ?9)
      ON CONFLICT(user_id, post_id, activity_date) DO UPDATE SET
        activity_timezone = excluded.activity_timezone,
        study_attempt_count = MAX(song_engagement_days.study_attempt_count, excluded.study_attempt_count),
        study_correct_count = MAX(song_engagement_days.study_correct_count, excluded.study_correct_count),
        study_target_count = excluded.study_target_count,
        qualified = CASE
          WHEN excluded.qualified = 1 OR song_engagement_days.karaoke_pass_count > 0
            THEN 1
          ELSE song_engagement_days.qualified
        END,
        updated_at = excluded.updated_at
    `,
    args: [
      input.userId,
      input.postId,
      input.communityId,
      today,
      input.completedExerciseCount,
      input.firstPassCorrectCount,
      input.requiredCorrectCount,
      input.qualified ? 1 : 0,
      input.now,
      activityTimezone,
    ],
  })
}

async function materializeStudyStreak(input: {
  activityDate?: string
  client: ReadClient
  now: string
  postId: string
  studyTimezone?: string
  userId: string
}): Promise<void> {
  const today = input.activityDate ?? studyActivityDate(input.now, input.studyTimezone ?? STUDY_FALLBACK_TIMEZONE)
  await input.client.execute({
    sql: `
      INSERT INTO song_streaks (
        user_id, post_id, community_id, current_streak, best_streak,
        last_qualified_date, streak_started_date, total_qualified_days,
        created_at, updated_at
      )
      SELECT d.user_id, d.post_id, d.community_id, 1, 1,
             d.activity_date, d.activity_date, 1, ?4, ?4
      FROM song_engagement_days d
      WHERE d.user_id = ?1
        AND d.post_id = ?2
        AND d.activity_date = ?3
        AND d.qualified = 1
      ON CONFLICT(user_id, post_id) DO UPDATE SET
        current_streak = CASE
          WHEN excluded.last_qualified_date <= song_streaks.last_qualified_date
            THEN song_streaks.current_streak
          WHEN song_streaks.last_qualified_date = date(excluded.last_qualified_date, '-1 day')
            THEN song_streaks.current_streak + 1
          ELSE 1
        END,
        best_streak = MAX(song_streaks.best_streak, CASE
          WHEN excluded.last_qualified_date <= song_streaks.last_qualified_date THEN song_streaks.current_streak
          WHEN song_streaks.last_qualified_date = date(excluded.last_qualified_date, '-1 day') THEN song_streaks.current_streak + 1
          ELSE 1
        END),
        streak_started_date = CASE
          WHEN excluded.last_qualified_date <= song_streaks.last_qualified_date THEN song_streaks.streak_started_date
          WHEN song_streaks.last_qualified_date = date(excluded.last_qualified_date, '-1 day') THEN song_streaks.streak_started_date
          ELSE excluded.last_qualified_date
        END,
        total_qualified_days = song_streaks.total_qualified_days + CASE
          WHEN excluded.last_qualified_date <= song_streaks.last_qualified_date THEN 0
          ELSE 1
        END,
        last_qualified_date = MAX(song_streaks.last_qualified_date, excluded.last_qualified_date),
        updated_at = ?4
    `,
    args: [input.userId, input.postId, today, input.now],
  })
}

export async function upsertStudyStreakProgress(input: {
  client: ReadClient
  communityId: string
  isCorrect: boolean
  now: string
  postId: string
  studyTargetCount: number
  studyTimezone?: string
  userId: string
}): Promise<void> {
  await upsertStudyEngagementDay(input)
  await materializeStudyStreak(input)
}

export async function recordStudyStreakMaterialization(input: {
  communityId: string
  communityRepository: CommunityDatabaseBindingRepository
  env: Env
  now: string
  postId: string
  studyTimezone?: string
  userId: string
}): Promise<void> {
  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.communityId)
  try {
    await withTransaction(db.client, "write", async (tx) => {
      await materializeStudyStreak({
        client: tx,
        now: input.now,
        postId: input.postId,
        studyTimezone: input.studyTimezone,
        userId: input.userId,
      })
    })
  } finally {
    await db.close()
  }
}
