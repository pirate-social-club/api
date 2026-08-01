import { executeFirst } from "../db-helpers"
import { stringOrNull } from "../sql-row"
import type { Client, ReadClient } from "../sql-client"
import {
  endOfGraceUtcInstant,
  isValidIanaTimezone,
  resolveStreakPin,
  STREAK_TIMEZONE_CHANGE_MIN_INTERVAL_MS,
  studyActivityDate,
  STUDY_FALLBACK_TIMEZONE,
} from "./post-study-streak-time"

async function upsertCompletedStudySessionDay(input: {
  activityDate: string
  activityTimezone: string
  client: ReadClient
  communityId: string
  completedExerciseCount: number
  firstPassCorrectCount: number
  now: string
  postId: string
  qualified: boolean
  requiredCorrectCount: number
  userId: string
}): Promise<void> {
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
      input.activityDate,
      input.completedExerciseCount,
      input.firstPassCorrectCount,
      input.requiredCorrectCount,
      input.qualified ? 1 : 0,
      input.now,
      input.activityTimezone,
    ],
  })
}

async function materializeStudyStreak(input: {
  activityDate: string
  client: ReadClient
  now: string
  postId: string
  userId: string
}): Promise<void> {
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
    args: [input.userId, input.postId, input.activityDate, input.now],
  })
}

export type StreakWritePreparation = {
  activityDate: string
  activeUntilAt: string
  timezone: string
}

// Establishes the pinned timezone for a (user, post) streak as one atomic,
// self-contained statement — a genuine compare-and-swap. The INSERT plants the
// pin for a first qualifier; the conditional UPDATE adopts a new zone only
// when none is pinned or the 7-day window has elapsed. D1 serializes batch
// commits, so when two first qualifications race (e.g. study vs karaoke with
// different device timezones), the FIRST COMMITTED claim wins and the loser
// can never overwrite it: the loser's prepareStreakWrite (always called after
// its claim) re-reads the committed winner and prepares dates/expiry under it.
// MUST be called (and committed) BEFORE prepareStreakWrite whenever the write
// will qualify the day. Placeholder values in the INSERT are overwritten by
// materialization in the main write tx; reads treat the placeholder as
// inactive (active_until_at stays NULL).
export async function claimStreakTimezonePin(input: {
  client: Client | ReadClient
  communityId: string
  now: string
  postId: string
  timezoneCandidate?: string | null
  userId: string
}): Promise<void> {
  const candidate = isValidIanaTimezone(input.timezoneCandidate) ? input.timezoneCandidate : STUDY_FALLBACK_TIMEZONE
  const nowMs = Date.parse(input.now)
  const changeCutoff = Number.isFinite(nowMs)
    ? new Date(nowMs - STREAK_TIMEZONE_CHANGE_MIN_INTERVAL_MS).toISOString()
    : input.now
  await input.client.execute({
    sql: `
      INSERT INTO song_streaks (
        user_id, post_id, community_id, current_streak, best_streak,
        last_qualified_date, streak_started_date, total_qualified_days,
        created_at, updated_at, timezone, timezone_updated_at
      )
      VALUES (?1, ?2, ?3, 0, 0, '', '', 0, ?4, ?4, ?5, ?6)
      ON CONFLICT(user_id, post_id) DO UPDATE SET
        timezone = CASE
          WHEN song_streaks.timezone IS NULL OR song_streaks.timezone_updated_at <= ?7
            THEN excluded.timezone
          ELSE song_streaks.timezone
        END,
        timezone_updated_at = CASE
          WHEN song_streaks.timezone IS NULL OR song_streaks.timezone_updated_at <= ?7
            THEN excluded.timezone_updated_at
          ELSE song_streaks.timezone_updated_at
        END
    `,
    args: [input.userId, input.postId, input.communityId, input.now, candidate, input.now, changeCutoff],
  })
}

// Resolves everything the qualification write needs that depends on existing
// state. MUST be called on a plain client BEFORE opening the write
// transaction: the D1 backend buffers write txs (in-tx reads return empty
// results), so this read cannot happen inside them — same constraint the
// karaoke attemptKnownAbsent pre-read honors. When the day qualifies, the
// caller MUST commit claimStreakTimezonePin first so this read observes the
// winning pin even under concurrent first qualifications. Reading immediately
// before the tx keeps the remaining race window negligible.
export async function prepareStreakWrite(input: {
  activityInstant: string
  client: Client | ReadClient
  now: string
  postId: string
  qualified: boolean
  timezoneCandidate?: string | null
  userId: string
}): Promise<StreakWritePreparation> {
  const pinRow = await executeFirst(input.client, {
    sql: `
      SELECT timezone, last_qualified_date
      FROM song_streaks
      WHERE user_id = ?1 AND post_id = ?2
    `,
    args: [input.userId, input.postId],
  }) as Record<string, unknown> | null
  const pin = resolveStreakPin({
    candidateTimezone: input.timezoneCandidate,
    now: input.now,
    pinnedTimezone: stringOrNull(pinRow?.timezone),
    pinnedTimezoneUpdatedAt: null,
  })
  const activityDate = studyActivityDate(input.activityInstant, pin.timezone)
  // Materialization stores MAX(stored last_qualified_date, activityDate) when
  // qualified; mirror that here so the grace expiry matches the row exactly.
  // Unqualified days never extend the expiry: the base stays the stored date.
  const storedLastQualified = stringOrNull(pinRow?.last_qualified_date)
  const expiryBase = input.qualified
    ? (storedLastQualified && storedLastQualified > activityDate ? storedLastQualified : activityDate)
    : (storedLastQualified ?? activityDate)
  return {
    activityDate,
    activeUntilAt: endOfGraceUtcInstant(expiryBase, pin.timezone),
    timezone: pin.timezone,
  }
}

// Applies the prepared grace expiry. Pure write — safe inside a buffered D1
// write transaction. The expiry only moves forward: a same-day writer that
// prepared before a concurrent qualifier committed must not shorten the grace
// window the other writer just stored. (An accepted timezone change therefore
// cannot pull the expiry earlier either — the residual sub-day skew is
// harmless and self-heals on the next qualification.)
export async function applyStreakActivityExpiry(input: {
  activeUntilAt: string
  client: ReadClient
  postId: string
  userId: string
}): Promise<void> {
  await input.client.execute({
    sql: `
      UPDATE song_streaks
      SET active_until_at = MAX(COALESCE(active_until_at, ''), ?3)
      WHERE user_id = ?1 AND post_id = ?2
    `,
    args: [input.userId, input.postId, input.activeUntilAt],
  })
}

// Records a completed study session's engagement day and materializes the
// streak atomically in the caller's write transaction, using the pin/expiry
// resolved by prepareStreakWrite before the tx was opened (and pinned by
// claimStreakTimezonePin when the day qualifies). The materialization is
// idempotent by construction: the INSERT ... WHERE qualified = 1 is a no-op
// for unqualified days, and reprocessing the same day never moves the streak
// (excluded.last_qualified_date <= last_qualified_date). The expiry is only
// applied when the day qualified — an unqualified session must not extend
// the grace window.
export async function recordCompletedSessionStreak(input: {
  client: Client | ReadClient
  communityId: string
  completedExerciseCount: number
  firstPassCorrectCount: number
  now: string
  postId: string
  preparation: StreakWritePreparation
  qualified: boolean
  requiredCorrectCount: number
  userId: string
}): Promise<void> {
  await upsertCompletedStudySessionDay({
    activityDate: input.preparation.activityDate,
    activityTimezone: input.preparation.timezone,
    client: input.client,
    communityId: input.communityId,
    completedExerciseCount: input.completedExerciseCount,
    firstPassCorrectCount: input.firstPassCorrectCount,
    now: input.now,
    postId: input.postId,
    qualified: input.qualified,
    requiredCorrectCount: input.requiredCorrectCount,
    userId: input.userId,
  })
  await materializeStudyStreak({
    activityDate: input.preparation.activityDate,
    client: input.client,
    now: input.now,
    postId: input.postId,
    userId: input.userId,
  })
  if (input.qualified) {
    await applyStreakActivityExpiry({
      activeUntilAt: input.preparation.activeUntilAt,
      client: input.client,
      postId: input.postId,
      userId: input.userId,
    })
  }
}
