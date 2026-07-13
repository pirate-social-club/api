import type { Profile } from "../../types"
import type { ProfileRepository } from "../auth/repositories"
import { executeFirst } from "../db-helpers"
import { nowIso } from "../helpers"
import { rowValue } from "../sql-row"
import type { Client } from "../sql-client"

export const STUDY_FALLBACK_TIMEZONE = "UTC"
export const STREAK_MIN_STUDY_ATTEMPTS = 10

const STREAK_LEADERBOARD_DEFAULT_LIMIT = 50
const STREAK_LEADERBOARD_MAX_LIMIT = 100
const STREAK_LEADERBOARD_OVERFETCH = 25

type SongStreakLeaderboardIdentity = {
  avatar_ref?: string | null
  display_name?: string | null
  handle?: string | null
  user_id: string
}

export type SongStreakLeaderboardEntry = {
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
  alive: boolean
  best_streak: number
  current_streak: number
  karaoke_passed_today: boolean
  qualified_today: boolean
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
  best_streak: unknown
  current_streak: unknown
  last_qualified_date: unknown
  streak_started_date: unknown
  total_qualified_days: unknown
  user_id: unknown
}

type SongStreakDayRow = {
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

function addUtcDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00.000Z`)
  parsed.setUTCDate(parsed.getUTCDate() + days)
  return parsed.toISOString().slice(0, 10)
}

function placeholders(count: number, startIndex = 1): string {
  return Array.from({ length: count }, (_, index) => `?${startIndex + index}`).join(", ")
}

export function studyActivityDate(nowIsoValue: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: timezone,
    year: "numeric",
  }).format(new Date(nowIsoValue))
}

export function clampStreakLeaderboardLimit(value?: number | null): number {
  if (value == null || !Number.isFinite(value)) return STREAK_LEADERBOARD_DEFAULT_LIMIT
  return Math.min(STREAK_LEADERBOARD_MAX_LIMIT, Math.max(1, Math.trunc(value)))
}

function profileIdentity(userId: string, profile: Profile | null | undefined): SongStreakLeaderboardIdentity | null {
  if (!profile) return null
  return {
    avatar_ref: profile.avatar_ref ?? null,
    display_name: profile.display_name ?? null,
    handle: profile.primary_public_handle?.label ?? profile.global_handle?.label ?? null,
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
    const identity = profileIdentity(userId, profiles.get(userId))
    if (identity) identities.set(userId, identity)
  }
  return identities
}

function viewerStanding(input: {
  day: SongStreakDayRow | null
  row: SongStreakRow | null
  yesterday: string
}): SongStreakViewerStanding {
  const lastQualifiedDate = readString(input.row?.last_qualified_date)
  return {
    alive: Boolean(lastQualifiedDate && lastQualifiedDate >= input.yesterday),
    best_streak: Number(input.row?.best_streak ?? 0),
    current_streak: Number(input.row?.current_streak ?? 0),
    karaoke_passed_today: Number(input.day?.karaoke_pass_count ?? 0) > 0,
    qualified_today: Number(input.day?.qualified ?? 0) === 1,
    study_attempts_today: Number(input.day?.study_attempt_count ?? 0),
    study_target_today: Number(input.day?.study_target_count ?? STREAK_MIN_STUDY_ATTEMPTS),
    total_qualified_days: Number(input.row?.total_qualified_days ?? 0),
  }
}

export async function readSongStreakSummary(input: {
  client: Client
  limit: number
  postId: string
  profileRepository: ProfileRepository
  studyTimezone?: string
  userId: string
}): Promise<{ date: string; summary: SongStreakSummary }> {
  const today = studyActivityDate(nowIso(), input.studyTimezone ?? STUDY_FALLBACK_TIMEZONE)
  const yesterday = addUtcDays(today, -1)
  const [boardResult, totalActiveRow, viewerRow, viewerDay] = await Promise.all([
    input.client.execute({
      sql: `
        SELECT user_id, current_streak, best_streak, streak_started_date, total_qualified_days, last_qualified_date
        FROM song_streaks
        WHERE post_id = ?1
          AND last_qualified_date >= ?2
        ORDER BY current_streak DESC, best_streak DESC, streak_started_date ASC, user_id ASC
        LIMIT ?3
      `,
      args: [input.postId, yesterday, input.limit + STREAK_LEADERBOARD_OVERFETCH],
    }),
    executeFirst(input.client, {
      sql: `SELECT COUNT(*) AS active_count FROM song_streaks WHERE post_id = ?1 AND last_qualified_date >= ?2`,
      args: [input.postId, yesterday],
    }) as Promise<Record<string, unknown> | null>,
    executeFirst(input.client, {
      sql: `
        SELECT user_id, current_streak, best_streak, streak_started_date, total_qualified_days, last_qualified_date
        FROM song_streaks WHERE user_id = ?1 AND post_id = ?2
      `,
      args: [input.userId, input.postId],
    }) as Promise<SongStreakRow | null>,
    executeFirst(input.client, {
      sql: `
        SELECT qualified, study_attempt_count, study_target_count, karaoke_pass_count
        FROM song_engagement_days WHERE user_id = ?1 AND post_id = ?2 AND activity_date = ?3
      `,
      args: [input.userId, input.postId, today],
    }) as Promise<SongStreakDayRow | null>,
  ])

  const rows = boardResult.rows as SongStreakRow[]
  const identities = await resolveLeaderboardIdentities(input.profileRepository, rows.map((row) => readString(row.user_id) ?? ""))
  const entries: SongStreakLeaderboardEntry[] = []
  for (const row of rows) {
    const userId = readString(row.user_id)
    if (!userId) continue
    const identity = identities.get(userId)
    if (!identity) continue
    entries.push({
      best_streak: Number(row.best_streak ?? 0),
      current_streak: Number(row.current_streak ?? 0),
      identity,
      is_viewer: userId === input.userId,
      last_qualified_date: readString(row.last_qualified_date) ?? today,
      rank: entries.length + 1,
      streak_started_date: readString(row.streak_started_date) ?? today,
      total_qualified_days: Number(row.total_qualified_days ?? 0),
    })
    if (entries.length >= input.limit) break
  }

  return {
    date: today,
    summary: {
      entries,
      total_active_streaks: Number(totalActiveRow?.active_count ?? 0),
      viewer: viewerStanding({ day: viewerDay, row: viewerRow, yesterday }),
    },
  }
}

export async function listPostStreakSummaries(input: {
  client: Client
  limit?: number | null
  postIds: string[]
  profileRepository: ProfileRepository
  studyTimezone?: string
  userId: string
}): Promise<Map<string, SongStreakSummary>> {
  const postIds = Array.from(new Set(input.postIds.map((postId) => postId.trim()).filter(Boolean)))
  if (postIds.length === 0) return new Map()

  const limit = clampStreakLeaderboardLimit(input.limit ?? 3)
  const today = studyActivityDate(nowIso(), input.studyTimezone ?? STUDY_FALLBACK_TIMEZONE)
  const yesterday = addUtcDays(today, -1)
  const postIdPlaceholders = placeholders(postIds.length)
  const activeDateIndex = postIds.length + 1
  const rowLimitIndex = postIds.length + 2

  const [boardResult, totalActiveResult, viewerResult, viewerDayResult] = await Promise.all([
    input.client.execute({
      sql: `
        SELECT post_id, user_id, current_streak, best_streak, streak_started_date,
               total_qualified_days, last_qualified_date, board_rank
        FROM (
          SELECT post_id, user_id, current_streak, best_streak, streak_started_date,
                 total_qualified_days, last_qualified_date,
                 ROW_NUMBER() OVER (
                   PARTITION BY post_id
                   ORDER BY current_streak DESC, best_streak DESC, streak_started_date ASC, user_id ASC
                 ) AS board_rank
          FROM song_streaks
          WHERE post_id IN (${postIdPlaceholders})
            AND last_qualified_date >= ?${activeDateIndex}
        )
        WHERE board_rank <= ?${rowLimitIndex}
        ORDER BY post_id ASC, board_rank ASC
      `,
      args: [...postIds, yesterday, limit + STREAK_LEADERBOARD_OVERFETCH],
    }),
    input.client.execute({
      sql: `
        SELECT post_id, COUNT(*) AS active_count FROM song_streaks
        WHERE post_id IN (${postIdPlaceholders}) AND last_qualified_date >= ?${activeDateIndex}
        GROUP BY post_id
      `,
      args: [...postIds, yesterday],
    }),
    input.client.execute({
      sql: `
        SELECT post_id, user_id, current_streak, best_streak, streak_started_date,
               total_qualified_days, last_qualified_date
        FROM song_streaks WHERE user_id = ?1 AND post_id IN (${placeholders(postIds.length, 2)})
      `,
      args: [input.userId, ...postIds],
    }),
    input.client.execute({
      sql: `
        SELECT post_id, qualified, study_attempt_count, study_target_count, karaoke_pass_count
        FROM song_engagement_days
        WHERE user_id = ?1 AND post_id IN (${placeholders(postIds.length, 2)}) AND activity_date = ?${postIds.length + 2}
      `,
      args: [input.userId, ...postIds, today],
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

  const viewerDaysByPostId = new Map<string, SongStreakDayRow>()
  for (const row of viewerDayResult.rows as SongStreakDayRow[]) {
    const postId = readString(rowValue(row, "post_id"))
    if (postId) viewerDaysByPostId.set(postId, row)
  }

  const identityUserIds = Array.from(new Set([...boardRowsByPostId.values()].flat().map((row) => readString(row.user_id) ?? "").filter(Boolean)))
  const identities = await resolveLeaderboardIdentities(input.profileRepository, identityUserIds)
  const summaries = new Map<string, SongStreakSummary>()
  for (const postId of postIds) {
    const entries: SongStreakLeaderboardEntry[] = []
    for (const row of boardRowsByPostId.get(postId) ?? []) {
      const userId = readString(row.user_id)
      if (!userId) continue
      const identity = identities.get(userId)
      if (!identity) continue
      entries.push({
        best_streak: Number(row.best_streak ?? 0),
        current_streak: Number(row.current_streak ?? 0),
        identity,
        is_viewer: userId === input.userId,
        last_qualified_date: readString(row.last_qualified_date) ?? today,
        rank: entries.length + 1,
        streak_started_date: readString(row.streak_started_date) ?? today,
        total_qualified_days: Number(row.total_qualified_days ?? 0),
      })
      if (entries.length >= limit) break
    }
    summaries.set(postId, {
      entries,
      total_active_streaks: totalActiveByPostId.get(postId) ?? 0,
      viewer: viewerStanding({
        day: viewerDaysByPostId.get(postId) ?? null,
        row: viewerRowsByPostId.get(postId) ?? null,
        yesterday,
      }),
    })
  }
  return summaries
}
