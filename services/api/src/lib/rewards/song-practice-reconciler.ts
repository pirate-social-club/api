import type { Env } from "../../env"
import type { Client, QueryResultRow, Transaction } from "../sql-client"
import { executeFirst } from "../db-helpers"
import { makeId, nowIso } from "../helpers"
import { requiredNumber, requiredString, rowValue } from "../sql-row"
import { openCommunityWriteClient } from "../communities/community-read-access"
import type { CommunityJobRepository } from "../communities/jobs/runner-types"
import { selectScheduledCommunityJobPollIds } from "../communities/jobs/runner"
import { withTransaction } from "../transactions"

export type RewardKind =
  | "study_streak_day"
  | "study_streak_milestone_7"
  | "study_streak_milestone_30"

type RewardConfig = {
  enabled: boolean
  dailyCents: number
  dailyUserCapCents: number
  milestone7Cents: number
  milestone30Cents: number
}

type QualifiedDayRow = {
  userId: string
  communityId: string
  postId: string
  activityDate: string
}

type StreakRow = {
  userId: string
  communityId: string
  postId: string
  currentStreak: number
  streakStartedDate: string
  lastQualifiedDate: string
}

export type SongPracticeRewardsReconciliationSummary = {
  enabled: boolean
  scanned_communities: number
  scanned_qualified_days: number
  scanned_streaks: number
  credited_events: number
  credited_cents: number
  skipped_cap_cents: number
  duplicate_events: number
  failed_communities: number
}

function parseCents(raw: string | undefined): number {
  const trimmed = String(raw ?? "").trim()
  if (!trimmed) return 0
  const parsed = Number(trimmed)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0
}

export function resolveRewardConfig(env: Pick<
  Env,
  | "REWARDS_ACCRUAL_ENABLED"
  | "REWARDS_DAILY_STREAK_CENTS"
  | "REWARDS_DAILY_USER_CAP_CENTS"
  | "REWARDS_STREAK_MILESTONE_7_CENTS"
  | "REWARDS_STREAK_MILESTONE_30_CENTS"
>): RewardConfig {
  return {
    enabled: String(env.REWARDS_ACCRUAL_ENABLED ?? "").trim().toLowerCase() === "true",
    dailyCents: parseCents(env.REWARDS_DAILY_STREAK_CENTS),
    dailyUserCapCents: parseCents(env.REWARDS_DAILY_USER_CAP_CENTS),
    milestone7Cents: parseCents(env.REWARDS_STREAK_MILESTONE_7_CENTS),
    milestone30Cents: parseCents(env.REWARDS_STREAK_MILESTONE_30_CENTS),
  }
}

function emptySummary(enabled: boolean): SongPracticeRewardsReconciliationSummary {
  return {
    enabled,
    scanned_communities: 0,
    scanned_qualified_days: 0,
    scanned_streaks: 0,
    credited_events: 0,
    credited_cents: 0,
    skipped_cap_cents: 0,
    duplicate_events: 0,
    failed_communities: 0,
  }
}

function rowToQualifiedDay(row: QueryResultRow): QualifiedDayRow {
  return {
    userId: requiredString(row, "user_id"),
    communityId: requiredString(row, "community_id"),
    postId: requiredString(row, "post_id"),
    activityDate: requiredString(row, "activity_date"),
  }
}

function rowToStreak(row: QueryResultRow): StreakRow {
  return {
    userId: requiredString(row, "user_id"),
    communityId: requiredString(row, "community_id"),
    postId: requiredString(row, "post_id"),
    currentStreak: requiredNumber(row, "current_streak"),
    streakStartedDate: requiredString(row, "streak_started_date"),
    lastQualifiedDate: requiredString(row, "last_qualified_date"),
  }
}

function addDays(date: string, days: number): string | null {
  const parsed = Date.parse(`${date}T00:00:00.000Z`)
  if (!Number.isFinite(parsed)) return null
  return new Date(parsed + days * 86_400_000).toISOString().slice(0, 10)
}

function reachedMilestoneDate(streak: StreakRow, threshold: number): string | null {
  if (streak.currentStreak < threshold) return null
  const milestoneDate = addDays(streak.streakStartedDate, threshold - 1)
  if (!milestoneDate || milestoneDate > streak.lastQualifiedDate) return null
  return milestoneDate
}

function dailyKey(day: QualifiedDayRow): string {
  return `${day.userId}\u0000${day.communityId}\u0000${day.postId}\u0000${day.activityDate}`
}

function milestoneKey(streak: StreakRow, rewardKind: RewardKind): string {
  return `${streak.userId}\u0000${streak.communityId}\u0000${streak.postId}\u0000${rewardKind}`
}

async function existingDailyKeys(input: {
  client: Client
  communityId: string
  sinceDate: string
}): Promise<Set<string>> {
  const result = await input.client.execute({
    sql: `
      SELECT user_id, community_id, post_id, activity_date
      FROM reward_events
      WHERE community_id = ?1
        AND reward_kind = 'study_streak_day'
        AND activity_date >= ?2
    `,
    args: [input.communityId, input.sinceDate],
  })
  return new Set(result.rows.map((row) => dailyKey(rowToQualifiedDay(row))))
}

async function existingMilestoneKeys(input: {
  client: Client
  communityId: string
}): Promise<Set<string>> {
  const result = await input.client.execute({
    sql: `
      SELECT user_id, community_id, post_id, reward_kind
      FROM reward_events
      WHERE community_id = ?1
        AND reward_kind IN ('study_streak_milestone_7', 'study_streak_milestone_30')
    `,
    args: [input.communityId],
  })
  return new Set(result.rows.map((row) => `${requiredString(row, "user_id")}\u0000${requiredString(row, "community_id")}\u0000${requiredString(row, "post_id")}\u0000${requiredString(row, "reward_kind")}`))
}

async function rewardEventExists(
  tx: Transaction,
  input: {
    userId: string
    communityId: string
    postId: string
    activityDate?: string
    rewardKind: RewardKind
  },
): Promise<boolean> {
  const row = await executeFirst(tx, {
    sql: input.activityDate
      ? `
        SELECT reward_event_id
        FROM reward_events
        WHERE user_id = ?1
          AND community_id = ?2
          AND post_id = ?3
          AND activity_date = ?4
          AND reward_kind = ?5
        LIMIT 1
      `
      : `
        SELECT reward_event_id
        FROM reward_events
        WHERE user_id = ?1
          AND community_id = ?2
          AND post_id = ?3
          AND reward_kind = ?4
        LIMIT 1
      `,
    args: input.activityDate
      ? [input.userId, input.communityId, input.postId, input.activityDate, input.rewardKind]
      : [input.userId, input.communityId, input.postId, input.rewardKind],
  })
  return Boolean(row)
}

async function creditDailyReward(input: {
  client: Client
  day: QualifiedDayRow
  amountCents: number
  dailyCapCents: number
  now: string
}): Promise<{ creditedCents: number; duplicate: boolean; skippedCapCents: number }> {
  if (input.amountCents <= 0 || input.dailyCapCents <= 0) {
    return { creditedCents: 0, duplicate: false, skippedCapCents: input.amountCents }
  }

  return await withTransaction(input.client, "write", async (tx) => {
    await tx.execute({
      sql: `
        INSERT INTO reward_user_days (user_id, activity_date, credited_cents, updated_at)
        VALUES (?1, ?2, 0, ?3)
        ON CONFLICT (user_id, activity_date) DO NOTHING
      `,
      args: [input.day.userId, input.day.activityDate, input.now],
    })

    const budgetRow = await executeFirst(tx, {
      sql: `
        SELECT credited_cents
        FROM reward_user_days
        WHERE user_id = ?1 AND activity_date = ?2
        FOR UPDATE
      `,
      args: [input.day.userId, input.day.activityDate],
    })

    if (await rewardEventExists(tx, {
      userId: input.day.userId,
      communityId: input.day.communityId,
      postId: input.day.postId,
      activityDate: input.day.activityDate,
      rewardKind: "study_streak_day",
    })) {
      return { creditedCents: 0, duplicate: true, skippedCapCents: 0 }
    }

    const creditedToday = Number(rowValue(budgetRow, "credited_cents") ?? 0)
    const remaining = Math.max(0, input.dailyCapCents - creditedToday)
    const creditedCents = Math.min(input.amountCents, remaining)
    if (creditedCents <= 0) {
      return { creditedCents: 0, duplicate: false, skippedCapCents: input.amountCents }
    }

    await tx.execute({
      sql: `
        UPDATE reward_user_days
        SET credited_cents = credited_cents + ?3,
            updated_at = ?4
        WHERE user_id = ?1 AND activity_date = ?2
      `,
      args: [input.day.userId, input.day.activityDate, creditedCents, input.now],
    })

    await tx.execute({
      sql: `
        INSERT INTO reward_events (
          reward_event_id, user_id, community_id, post_id, activity_date,
          reward_kind, amount_cents, source, created_at
        )
        VALUES (?1, ?2, ?3, ?4, ?5, 'study_streak_day', ?6, 'song_engagement_reconciler', ?7)
        ON CONFLICT DO NOTHING
      `,
      args: [
        makeId("rew"),
        input.day.userId,
        input.day.communityId,
        input.day.postId,
        input.day.activityDate,
        creditedCents,
        input.now,
      ],
    })

    return {
      creditedCents,
      duplicate: false,
      skippedCapCents: input.amountCents - creditedCents,
    }
  })
}

async function creditMilestoneReward(input: {
  client: Client
  streak: StreakRow
  activityDate: string
  amountCents: number
  rewardKind: Extract<RewardKind, "study_streak_milestone_7" | "study_streak_milestone_30">
  now: string
}): Promise<{ creditedCents: number; duplicate: boolean }> {
  if (input.amountCents <= 0) return { creditedCents: 0, duplicate: false }

  return await withTransaction(input.client, "write", async (tx) => {
    if (await rewardEventExists(tx, {
      userId: input.streak.userId,
      communityId: input.streak.communityId,
      postId: input.streak.postId,
      rewardKind: input.rewardKind,
    })) {
      return { creditedCents: 0, duplicate: true }
    }

    const inserted = await tx.execute({
      sql: `
        INSERT INTO reward_events (
          reward_event_id, user_id, community_id, post_id, activity_date,
          reward_kind, amount_cents, source, created_at
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'song_engagement_reconciler', ?8)
        ON CONFLICT DO NOTHING
        RETURNING reward_event_id
      `,
      args: [
        makeId("rew"),
        input.streak.userId,
        input.streak.communityId,
        input.streak.postId,
        input.activityDate,
        input.rewardKind,
        input.amountCents,
        input.now,
      ],
    })

    return inserted.rows.length > 0
      ? { creditedCents: input.amountCents, duplicate: false }
      : { creditedCents: 0, duplicate: true }
  })
}

export async function reconcileSongPracticeRewards(input: {
  env: Env
  communityRepository: CommunityJobRepository
  controlPlaneClient: Client
  maxCommunities?: number
  maxQualifiedDaysPerCommunity?: number
  lookbackDays?: number
}): Promise<SongPracticeRewardsReconciliationSummary> {
  const config = resolveRewardConfig(input.env)
  const summary = emptySummary(config.enabled)
  if (!config.enabled) return summary

  const maxCommunities = Math.max(1, Math.trunc(input.maxCommunities ?? 50))
  const maxQualifiedDays = Math.max(1, Math.trunc(input.maxQualifiedDaysPerCommunity ?? 500))
  const lookbackDays = Math.max(1, Math.trunc(input.lookbackDays ?? 45))
  const sinceDate = new Date(Date.now() - lookbackDays * 86_400_000).toISOString().slice(0, 10)
  const communities = await input.communityRepository.listActiveCommunities({ requireReadyRouting: true })
  const communityIds = selectScheduledCommunityJobPollIds(communities, maxCommunities)
  const now = nowIso()

  for (const communityId of communityIds) {
    let db: Awaited<ReturnType<typeof openCommunityWriteClient>> | null = null
    try {
      db = await openCommunityWriteClient(input.env, input.communityRepository, communityId)
      summary.scanned_communities += 1
      const creditedDailyKeys = await existingDailyKeys({
        client: input.controlPlaneClient,
        communityId,
        sinceDate,
      })

      const dayRows = await db.client.execute({
        sql: `
          SELECT user_id, community_id, post_id, activity_date
          FROM song_engagement_days
          WHERE qualified = 1
            AND activity_date >= ?1
          ORDER BY activity_date DESC, user_id ASC, post_id ASC
          LIMIT ?2
        `,
        args: [sinceDate, maxQualifiedDays],
      })

      for (const row of dayRows.rows) {
        const day = rowToQualifiedDay(row)
        summary.scanned_qualified_days += 1
        if (creditedDailyKeys.has(dailyKey(day))) {
          summary.duplicate_events += 1
          continue
        }
        const result = await creditDailyReward({
          client: input.controlPlaneClient,
          day,
          amountCents: config.dailyCents,
          dailyCapCents: config.dailyUserCapCents,
          now,
        })
        if (result.duplicate) summary.duplicate_events += 1
        if (result.creditedCents > 0) {
          summary.credited_events += 1
          summary.credited_cents += result.creditedCents
          creditedDailyKeys.add(dailyKey(day))
        }
        summary.skipped_cap_cents += result.skippedCapCents
      }
      const creditedMilestoneKeys = await existingMilestoneKeys({
        client: input.controlPlaneClient,
        communityId,
      })

      const streakRows = await db.client.execute({
        sql: `
          SELECT user_id, community_id, post_id, current_streak, streak_started_date, last_qualified_date
          FROM song_streaks
          WHERE current_streak >= 7
          ORDER BY last_qualified_date DESC, user_id ASC, post_id ASC
          LIMIT ?1
        `,
        args: [maxQualifiedDays],
      })

      for (const row of streakRows.rows) {
        const streak = rowToStreak(row)
        summary.scanned_streaks += 1

        const milestone7Date = reachedMilestoneDate(streak, 7)
        if (milestone7Date) {
          const key = milestoneKey(streak, "study_streak_milestone_7")
          if (creditedMilestoneKeys.has(key)) {
            summary.duplicate_events += 1
          } else {
          const result = await creditMilestoneReward({
            client: input.controlPlaneClient,
            streak,
            activityDate: milestone7Date,
            amountCents: config.milestone7Cents,
            rewardKind: "study_streak_milestone_7",
            now,
          })
          if (result.duplicate) summary.duplicate_events += 1
          if (result.creditedCents > 0) {
            summary.credited_events += 1
            summary.credited_cents += result.creditedCents
            creditedMilestoneKeys.add(key)
          }
          }
        }

        const milestone30Date = reachedMilestoneDate(streak, 30)
        if (milestone30Date) {
          const key = milestoneKey(streak, "study_streak_milestone_30")
          if (creditedMilestoneKeys.has(key)) {
            summary.duplicate_events += 1
          } else {
          const result = await creditMilestoneReward({
            client: input.controlPlaneClient,
            streak,
            activityDate: milestone30Date,
            amountCents: config.milestone30Cents,
            rewardKind: "study_streak_milestone_30",
            now,
          })
          if (result.duplicate) summary.duplicate_events += 1
          if (result.creditedCents > 0) {
            summary.credited_events += 1
            summary.credited_cents += result.creditedCents
            creditedMilestoneKeys.add(key)
          }
          }
        }
      }
    } catch (error) {
      summary.failed_communities += 1
      console.error("[rewards] community reconciliation failed", {
        community_id: communityId,
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      await db?.close()
    }
  }

  return summary
}
