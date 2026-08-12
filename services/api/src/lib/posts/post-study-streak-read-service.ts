import type { Profile } from "../../types"
import type { ProfileRepository } from "../auth/repositories"
import { executeFirst } from "../db-helpers"
import { nowIso } from "../helpers"
import { rowValue } from "../sql-row"
import type { Client } from "../sql-client"
import {
  addUtcDays,
  studyActivityDate,
  STUDY_FALLBACK_TIMEZONE,
} from "./post-study-streak-time"

export const STREAK_MIN_STUDY_ATTEMPTS = 10

const STREAK_LEADERBOARD_DEFAULT_LIMIT = 50
const STREAK_LEADERBOARD_MAX_LIMIT = 100

type SongStreakLeaderboardIdentity = {
  avatar_ref?: string | null
  display_name?: string | null
  handle?: string | null
  user_id: string
}

export type SongStreakLeaderboardEntry = {
  active_until_at: string
  best_streak: number
  current_streak: number
  identity: SongStreakLeaderboardIdentity
  is_viewer: boolean
  last_qualified_date: string
  rank: number
  streak_started_date: string
  total_qualified_days: number
}

export type SongStreakViewerStanding = {
  active_until_at: string | null
  alive: boolean
  best_streak: number
  current_streak: number
  karaoke_passed_today: boolean
  qualified_today: boolean
  rank: number | null
  study_attempts_today: number
  study_target_today: number
  total_qualified_days: number
}

export type SongStreakSummary = {
  entries: SongStreakLeaderboardEntry[]
  total_active_streaks: number
  viewer: SongStreakViewerStanding | null
}

type SongStreakRow = {
  active_until_at?: unknown
  best_streak: unknown
  current_streak: unknown
  last_qualified_date: unknown
  streak_started_date: unknown
  timezone?: unknown
  total_qualified_days: unknown
  user_id: unknown
}

type SongStreakDayRow = {
  activity_date?: unknown
  karaoke_pass_count?: unknown
  post_id?: unknown
  qualified?: unknown
  study_attempt_count?: unknown
  study_target_count?: unknown
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed || null
}

function placeholders(count: number, startIndex = 1): string {
  return Array.from({ length: count }, (_, index) => `?${startIndex + index}`).join(", ")
}

export function clampStreakLeaderboardLimit(value?: number | null): number {
  if (value == null || !Number.isFinite(value)) return STREAK_LEADERBOARD_DEFAULT_LIMIT
  return Math.min(STREAK_LEADERBOARD_MAX_LIMIT, Math.max(1, Math.trunc(value)))
}

function profileIdentity(userId: string, profile: Profile | null | undefined): SongStreakLeaderboardIdentity {
  return {
    avatar_ref: profile?.avatar_ref ?? null,
    display_name: profile?.display_name ?? null,
    handle: profile?.primary_public_handle?.label ?? profile?.global_handle?.label ?? null,
    user_id: userId,
  }
}

async function resolveLeaderboardIdentities(
  profileRepository: ProfileRepository,
  userIds: string[],
): Promise<Map<string, SongStreakLeaderboardIdentity>> {
  const uniqueUserIds = Array.from(new Set(userIds.map((userId) => userId.trim()).filter(Boolean)))
  const profiles = profileRepository.listProfilesByUserIds
    ? await profileRepository.listProfilesByUserIds(uniqueUserIds)
    : new Map(await Promise.all(uniqueUserIds.map(async (userId) => [userId, await profileRepository.getProfileByUserId(userId)] as const)))
  const identities = new Map<string, SongStreakLeaderboardIdentity>()
  for (const userId of uniqueUserIds) {
    identities.set(userId, profileIdentity(userId, profiles.get(userId)))
  }
  return identities
}

type StreakRankMetrics = {
  bestStreak: number
  currentStreak: number
}

function sameStreakRank(left: StreakRankMetrics | null, right: StreakRankMetrics): boolean {
  return left?.currentStreak === right.currentStreak
    && left.bestStreak === right.bestStreak
}

// A streak is active only while now < active_until_at (today + yesterday grace
// in the streak OWNER's pinned timezone, computed at qualification time — never
// from the viewing user's clock). Lapsed standings project current_streak: 0
// and rank: null; best_streak keeps the historical record. Stored rows are
// never rewritten by reads.
function viewerStanding(input: {
  alive: boolean
  day: SongStreakDayRow | null
  rank: number | null
  row: SongStreakRow | null
}): SongStreakViewerStanding {
  const alive = input.alive
  return {
    active_until_at: readString(input.row?.active_until_at),
    alive,
    best_streak: Number(input.row?.best_streak ?? 0),
    current_streak: alive ? Number(input.row?.current_streak ?? 0) : 0,
    karaoke_passed_today: Number(input.day?.karaoke_pass_count ?? 0) > 0,
    qualified_today: Number(input.day?.qualified ?? 0) === 1,
    rank: alive ? input.rank : null,
    study_attempts_today: Number(input.day?.study_attempt_count ?? 0),
    study_target_today: Number(input.day?.study_target_count ?? STREAK_MIN_STUDY_ATTEMPTS),
    total_qualified_days: Number(input.row?.total_qualified_days ?? 0),
  }
}

function streakAlive(row: SongStreakRow | null, now: string): boolean {
  const activeUntilAt = readString(row?.active_until_at)
  return Boolean(activeUntilAt && activeUntilAt > now)
}

async function countAliveAheadOfViewer(input: {
  bestStreak: number
  client: Client
  currentStreak: number
  now: string
  postId: string
}): Promise<number> {
  // Competition rank over active streaks: ties on (current_streak, best_streak)
  // share a rank, matching the entry-list ranking.
  const row = await executeFirst(input.client, {
    sql: `
      SELECT COUNT(*) AS ahead_count
      FROM song_streaks
      WHERE post_id = ?1
        AND active_until_at > ?2
        AND (
          current_streak > ?3
          OR (current_streak = ?3 AND best_streak > ?4)
        )
    `,
    args: [input.postId, input.now, input.currentStreak, input.bestStreak],
  }) as Record<string, unknown> | null
  return Number(row?.ahead_count ?? 0)
}

export async function readSongStreakSummary(input: {
  client: Client
  limit: number
  postId: string
  profileRepository: ProfileRepository
  userId: string
}): Promise<{ date: string; summary: SongStreakSummary }> {
  const now = nowIso()
  const [boardResult, totalActiveRow, viewerRow] = await Promise.all([
    input.client.execute({
      sql: `
        SELECT user_id, current_streak, best_streak, streak_started_date, total_qualified_days,
               last_qualified_date, active_until_at
        FROM song_streaks
        WHERE post_id = ?1
          AND active_until_at > ?2
        ORDER BY current_streak DESC, best_streak DESC, streak_started_date ASC, user_id ASC
        LIMIT ?3
      `,
      args: [input.postId, now, input.limit],
    }),
    executeFirst(input.client, {
      sql: `SELECT COUNT(*) AS active_count FROM song_streaks WHERE post_id = ?1 AND active_until_at > ?2`,
      args: [input.postId, now],
    }) as Promise<Record<string, unknown> | null>,
    executeFirst(input.client, {
      sql: `
        SELECT user_id, current_streak, best_streak, streak_started_date, total_qualified_days,
               last_qualified_date, active_until_at, timezone
        FROM song_streaks WHERE user_id = ?1 AND post_id = ?2
      `,
      args: [input.userId, input.postId],
    }) as Promise<SongStreakRow | null>,
  ])

  const viewerAlive = streakAlive(viewerRow, now)
  const viewerTimezone = readString(viewerRow?.timezone) ?? STUDY_FALLBACK_TIMEZONE
  const viewerToday = studyActivityDate(now, viewerTimezone)
  const [viewerDay, viewerAheadCount] = await Promise.all([
    executeFirst(input.client, {
      sql: `
        SELECT qualified, study_attempt_count, study_target_count, karaoke_pass_count
        FROM song_engagement_days WHERE user_id = ?1 AND post_id = ?2 AND activity_date = ?3
      `,
      args: [input.userId, input.postId, viewerToday],
    }) as Promise<SongStreakDayRow | null>,
    viewerAlive
      ? countAliveAheadOfViewer({
        bestStreak: Number(viewerRow?.best_streak ?? 0),
        client: input.client,
        currentStreak: Number(viewerRow?.current_streak ?? 0),
        now,
        postId: input.postId,
      })
      : Promise.resolve(0),
  ])

  const rows = boardResult.rows as SongStreakRow[]
  const identities = await resolveLeaderboardIdentities(input.profileRepository, rows.map((row) => readString(row.user_id) ?? ""))
  const entries: SongStreakLeaderboardEntry[] = []
  let previousRankMetrics: StreakRankMetrics | null = null
  let rank = 0
  for (const row of rows) {
    const userId = readString(row.user_id)
    if (!userId) continue
    const rankMetrics = {
      bestStreak: Number(row.best_streak ?? 0),
      currentStreak: Number(row.current_streak ?? 0),
    }
    if (!sameStreakRank(previousRankMetrics, rankMetrics)) {
      rank = entries.length + 1
    }
    entries.push({
      active_until_at: readString(row.active_until_at) ?? now,
      best_streak: rankMetrics.bestStreak,
      current_streak: rankMetrics.currentStreak,
      identity: identities.get(userId) ?? profileIdentity(userId, null),
      is_viewer: userId === input.userId,
      last_qualified_date: readString(row.last_qualified_date) ?? viewerToday,
      rank,
      streak_started_date: readString(row.streak_started_date) ?? viewerToday,
      total_qualified_days: Number(row.total_qualified_days ?? 0),
    })
    previousRankMetrics = rankMetrics
    if (entries.length >= input.limit) break
  }

  return {
    date: studyActivityDate(now, STUDY_FALLBACK_TIMEZONE),
    summary: {
      entries,
      total_active_streaks: Number(totalActiveRow?.active_count ?? 0),
      viewer: viewerStanding({
        alive: viewerAlive,
        day: viewerDay,
        rank: viewerAheadCount + 1,
        row: viewerRow,
      }),
    },
  }
}

export async function listPostStreakSummaries(input: {
  client: Client
  limit?: number | null
  postIds: string[]
  profileRepository: ProfileRepository
  userId: string
}): Promise<Map<string, SongStreakSummary>> {
  const postIds = Array.from(new Set(input.postIds.map((postId) => postId.trim()).filter(Boolean)))
  if (postIds.length === 0) return new Map()

  const limit = clampStreakLeaderboardLimit(input.limit ?? 3)
  const now = nowIso()
  const utcToday = studyActivityDate(now, STUDY_FALLBACK_TIMEZONE)
  const dayBefore = addUtcDays(utcToday, -1)
  const dayAfter = addUtcDays(utcToday, 1)
  const postIdPlaceholders = placeholders(postIds.length)
  const nowIndex = postIds.length + 1
  const rowLimitIndex = postIds.length + 2

  const [boardResult, totalActiveResult, viewerResult, viewerDayResult] = await Promise.all([
    input.client.execute({
      sql: `
        SELECT post_id, user_id, current_streak, best_streak, streak_started_date,
               total_qualified_days, last_qualified_date, active_until_at, board_rank
        FROM (
          SELECT post_id, user_id, current_streak, best_streak, streak_started_date,
                 total_qualified_days, last_qualified_date, active_until_at,
                 ROW_NUMBER() OVER (
                   PARTITION BY post_id
                   ORDER BY current_streak DESC, best_streak DESC, streak_started_date ASC, user_id ASC
                 ) AS board_rank
          FROM song_streaks
          WHERE post_id IN (${postIdPlaceholders})
            AND active_until_at > ?${nowIndex}
        )
        WHERE board_rank <= ?${rowLimitIndex}
        ORDER BY post_id ASC, board_rank ASC
      `,
      args: [...postIds, now, limit],
    }),
    input.client.execute({
      sql: `
        SELECT post_id, COUNT(*) AS active_count FROM song_streaks
        WHERE post_id IN (${postIdPlaceholders}) AND active_until_at > ?${nowIndex}
        GROUP BY post_id
      `,
      args: [...postIds, now],
    }),
    input.client.execute({
      sql: `
        SELECT post_id, user_id, current_streak, best_streak, streak_started_date,
               total_qualified_days, last_qualified_date, active_until_at, timezone
        FROM song_streaks WHERE user_id = ?1 AND post_id IN (${placeholders(postIds.length, 2)})
      `,
      args: [input.userId, ...postIds],
    }),
    // The viewer's "today" depends on their pinned timezone per post, so fetch
    // the three UTC-adjacent candidate dates and match per post below.
    input.client.execute({
      sql: `
        SELECT post_id, activity_date, qualified, study_attempt_count, study_target_count, karaoke_pass_count
        FROM song_engagement_days
        WHERE user_id = ?1 AND post_id IN (${placeholders(postIds.length, 2)})
          AND activity_date IN (?${postIds.length + 2}, ?${postIds.length + 3}, ?${postIds.length + 4})
      `,
      args: [input.userId, ...postIds, dayBefore, utcToday, dayAfter],
    }),
  ])

  const boardRowsByPostId = new Map<string, SongStreakRow[]>()
  for (const row of boardResult.rows as SongStreakRow[]) {
    const postId = readString(rowValue(row, "post_id"))
    if (!postId) continue
    const rows = boardRowsByPostId.get(postId) ?? []
    rows.push(row)
    boardRowsByPostId.set(postId, rows)
  }

  const totalActiveByPostId = new Map<string, number>()
  for (const row of totalActiveResult.rows ?? []) {
    const postId = readString(rowValue(row, "post_id"))
    if (postId) totalActiveByPostId.set(postId, Number(rowValue(row, "active_count") ?? 0))
  }

  const viewerRowsByPostId = new Map<string, SongStreakRow>()
  for (const row of viewerResult.rows as SongStreakRow[]) {
    const postId = readString(rowValue(row, "post_id"))
    if (postId) viewerRowsByPostId.set(postId, row)
  }

  const viewerDaysByKey = new Map<string, SongStreakDayRow>()
  for (const row of viewerDayResult.rows as SongStreakDayRow[]) {
    const postId = readString(rowValue(row, "post_id"))
    const activityDate = readString(rowValue(row, "activity_date"))
    if (postId && activityDate) viewerDaysByKey.set(`${postId}${activityDate}`, row)
  }

  const identityUserIds = Array.from(new Set([...boardRowsByPostId.values()].flat().map((row) => readString(row.user_id) ?? "").filter(Boolean)))
  const identities = await resolveLeaderboardIdentities(input.profileRepository, identityUserIds)
  const summaries = new Map<string, SongStreakSummary>()
  for (const postId of postIds) {
    const entries: SongStreakLeaderboardEntry[] = []
    let previousRankMetrics: StreakRankMetrics | null = null
    let rank = 0
    for (const row of boardRowsByPostId.get(postId) ?? []) {
      const userId = readString(row.user_id)
      if (!userId) continue
      const rankMetrics = {
        bestStreak: Number(row.best_streak ?? 0),
        currentStreak: Number(row.current_streak ?? 0),
      }
      if (!sameStreakRank(previousRankMetrics, rankMetrics)) {
        rank = entries.length + 1
      }
      entries.push({
        active_until_at: readString(row.active_until_at) ?? now,
        best_streak: rankMetrics.bestStreak,
        current_streak: rankMetrics.currentStreak,
        identity: identities.get(userId) ?? profileIdentity(userId, null),
        is_viewer: userId === input.userId,
        last_qualified_date: readString(row.last_qualified_date) ?? utcToday,
        rank,
        streak_started_date: readString(row.streak_started_date) ?? utcToday,
        total_qualified_days: Number(row.total_qualified_days ?? 0),
      })
      previousRankMetrics = rankMetrics
      if (entries.length >= limit) break
    }
    const viewerRow = viewerRowsByPostId.get(postId) ?? null
    const viewerTimezone = readString(viewerRow?.timezone) ?? STUDY_FALLBACK_TIMEZONE
    const viewerToday = studyActivityDate(now, viewerTimezone)
    summaries.set(postId, {
      entries,
      total_active_streaks: totalActiveByPostId.get(postId) ?? 0,
      // Batch summaries (feeds) skip the rank query; the single-post read
      // computes it. alive still comes from the stored expiry.
      viewer: viewerStanding({
        alive: streakAlive(viewerRow, now),
        day: viewerDaysByKey.get(`${postId}${viewerToday}`) ?? null,
        rank: null,
        row: viewerRow,
      }),
    })
  }
  return summaries
}
