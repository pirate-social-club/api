import type { Env } from "../../env"
import type { Client, QueryResultRow, Transaction } from "../sql-client"
import { executeFirst } from "../db-helpers"
import { makeId, nowIso } from "../helpers"
import { requiredString, rowValue, stringOrNull } from "../sql-row"
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

type MilestoneCandidateRow = {
  userId: string
  communityId: string
  postId: string
  milestone7Date: string | null
  milestone30Date: string | null
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
  | "REWARDS_LEGACY_STREAK_ACCRUAL_ENABLED"
  | "REWARDS_DAILY_STREAK_CENTS"
  | "REWARDS_DAILY_USER_CAP_CENTS"
  | "REWARDS_STREAK_MILESTONE_7_CENTS"
  | "REWARDS_STREAK_MILESTONE_30_CENTS"
>): RewardConfig {
  const dailyCents = parseCents(env.REWARDS_DAILY_STREAK_CENTS)
  const dailyUserCapCents = parseCents(env.REWARDS_DAILY_USER_CAP_CENTS)
  const milestone7Cents = parseCents(env.REWARDS_STREAK_MILESTONE_7_CENTS)
  const milestone30Cents = parseCents(env.REWARDS_STREAK_MILESTONE_30_CENTS)
  const configuredEnabled = String(env.REWARDS_ACCRUAL_ENABLED ?? "").trim().toLowerCase() === "true"
    && String(env.REWARDS_LEGACY_STREAK_ACCRUAL_ENABLED ?? "").trim().toLowerCase() === "true"
  const capCoversEveryRewardCombination = dailyUserCapCents >= dailyCents + Math.max(milestone7Cents, milestone30Cents)
  return {
    enabled: configuredEnabled && capCoversEveryRewardCombination,
    dailyCents,
    dailyUserCapCents,
    milestone7Cents,
    milestone30Cents,
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

function rowToMilestoneCandidate(row: QueryResultRow): MilestoneCandidateRow {
  return {
    userId: requiredString(row, "user_id"),
    communityId: requiredString(row, "community_id"),
    postId: requiredString(row, "post_id"),
    milestone7Date: stringOrNull(rowValue(row, "milestone_7_date")),
    milestone30Date: stringOrNull(rowValue(row, "milestone_30_date")),
  }
}

function dailyKey(day: QualifiedDayRow): string {
  return `${day.userId}\u0000${day.communityId}\u0000${day.postId}\u0000${day.activityDate}`
}

function milestoneKey(candidate: MilestoneCandidateRow, rewardKind: RewardKind): string {
  return `${candidate.userId}\u0000${candidate.communityId}\u0000${candidate.postId}\u0000${rewardKind}`
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
  candidate: MilestoneCandidateRow
  activityDate: string
  amountCents: number
  dailyCapCents: number
  rewardKind: Extract<RewardKind, "study_streak_milestone_7" | "study_streak_milestone_30">
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
      args: [input.candidate.userId, input.activityDate, input.now],
    })
    const budgetRow = await executeFirst(tx, {
      sql: `
        SELECT credited_cents
        FROM reward_user_days
        WHERE user_id = ?1 AND activity_date = ?2
        FOR UPDATE
      `,
      args: [input.candidate.userId, input.activityDate],
    })
    if (await rewardEventExists(tx, {
      userId: input.candidate.userId,
      communityId: input.candidate.communityId,
      postId: input.candidate.postId,
      rewardKind: input.rewardKind,
    })) {
      return { creditedCents: 0, duplicate: true, skippedCapCents: 0 }
    }
    const creditedToday = Number(rowValue(budgetRow, "credited_cents") ?? 0)
    if (creditedToday + input.amountCents > input.dailyCapCents) {
      return { creditedCents: 0, duplicate: false, skippedCapCents: input.amountCents }
    }

    await tx.execute({
      sql: `
        UPDATE reward_user_days
        SET credited_cents = credited_cents + ?3,
            updated_at = ?4
        WHERE user_id = ?1 AND activity_date = ?2
      `,
      args: [input.candidate.userId, input.activityDate, input.amountCents, input.now],
    })

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
        input.candidate.userId,
        input.candidate.communityId,
        input.candidate.postId,
        input.activityDate,
        input.rewardKind,
        input.amountCents,
        input.now,
      ],
    })

    return inserted.rows.length > 0
      ? { creditedCents: input.amountCents, duplicate: false, skippedCapCents: 0 }
      : { creditedCents: 0, duplicate: true, skippedCapCents: 0 }
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

      const pageSize = Math.min(500, maxQualifiedDays)
      let dayOffset = 0
      let uncreditedDaysVisited = 0
      while (uncreditedDaysVisited < maxQualifiedDays) {
        const dayRows = await db.client.execute({
          sql: `
            SELECT user_id, community_id, post_id, activity_date
            FROM song_engagement_days
            WHERE qualified = 1
              AND activity_date >= ?1
            ORDER BY activity_date ASC, user_id ASC, post_id ASC
            LIMIT ?2 OFFSET ?3
          `,
          args: [sinceDate, pageSize, dayOffset],
        })
        for (const row of dayRows.rows) {
          const day = rowToQualifiedDay(row)
          summary.scanned_qualified_days += 1
          if (creditedDailyKeys.has(dailyKey(day))) {
            summary.duplicate_events += 1
            continue
          }
          uncreditedDaysVisited += 1
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
          if (uncreditedDaysVisited >= maxQualifiedDays) break
        }
        if (dayRows.rows.length < pageSize || uncreditedDaysVisited >= maxQualifiedDays) break
        dayOffset += dayRows.rows.length
      }
      const creditedMilestoneKeys = await existingMilestoneKeys({
        client: input.controlPlaneClient,
        communityId,
      })

      let milestoneOffset = 0
      let uncreditedMilestonesVisited = 0
      while (uncreditedMilestonesVisited < maxQualifiedDays) {
        const milestoneRows = await db.client.execute({
          sql: `
            WITH ordered_days AS (
              SELECT
                user_id,
                community_id,
                post_id,
                activity_date,
                CAST(julianday(activity_date) AS INTEGER)
                  - ROW_NUMBER() OVER (PARTITION BY user_id, community_id, post_id ORDER BY activity_date) AS run_group
              FROM song_engagement_days
              WHERE qualified = 1
            ),
            runs AS (
              SELECT user_id, community_id, post_id, MIN(activity_date) AS started_date, COUNT(*) AS run_length
              FROM ordered_days
              GROUP BY user_id, community_id, post_id, run_group
            ),
            earned AS (
              SELECT
                user_id,
                community_id,
                post_id,
                MIN(CASE WHEN run_length >= 7 THEN date(started_date, '+6 days') END) AS milestone_7_date,
                MIN(CASE WHEN run_length >= 30 THEN date(started_date, '+29 days') END) AS milestone_30_date
              FROM runs
              GROUP BY user_id, community_id, post_id
            )
            SELECT user_id, community_id, post_id, milestone_7_date, milestone_30_date
            FROM earned
            WHERE milestone_7_date IS NOT NULL
            ORDER BY user_id ASC, community_id ASC, post_id ASC
            LIMIT ?1 OFFSET ?2
          `,
          args: [pageSize, milestoneOffset],
        })

        for (const row of milestoneRows.rows) {
          const candidate = rowToMilestoneCandidate(row)
          summary.scanned_streaks += 1
          let candidateHadUncreditedMilestone = false

          if (candidate.milestone7Date) {
            const key = milestoneKey(candidate, "study_streak_milestone_7")
            if (creditedMilestoneKeys.has(key)) {
              summary.duplicate_events += 1
            } else {
              candidateHadUncreditedMilestone = true
              const result = await creditMilestoneReward({
                client: input.controlPlaneClient,
                candidate,
                activityDate: candidate.milestone7Date,
                amountCents: config.milestone7Cents,
                dailyCapCents: config.dailyUserCapCents,
                rewardKind: "study_streak_milestone_7",
                now,
              })
              if (result.duplicate) summary.duplicate_events += 1
              if (result.creditedCents > 0) {
                summary.credited_events += 1
                summary.credited_cents += result.creditedCents
                creditedMilestoneKeys.add(key)
              }
              summary.skipped_cap_cents += result.skippedCapCents
            }
          }

          if (candidate.milestone30Date) {
            const key = milestoneKey(candidate, "study_streak_milestone_30")
            if (creditedMilestoneKeys.has(key)) {
              summary.duplicate_events += 1
            } else {
              candidateHadUncreditedMilestone = true
              const result = await creditMilestoneReward({
                client: input.controlPlaneClient,
                candidate,
                activityDate: candidate.milestone30Date,
                amountCents: config.milestone30Cents,
                dailyCapCents: config.dailyUserCapCents,
                rewardKind: "study_streak_milestone_30",
                now,
              })
              if (result.duplicate) summary.duplicate_events += 1
              if (result.creditedCents > 0) {
                summary.credited_events += 1
                summary.credited_cents += result.creditedCents
                creditedMilestoneKeys.add(key)
              }
              summary.skipped_cap_cents += result.skippedCapCents
            }
          }

          if (candidateHadUncreditedMilestone) uncreditedMilestonesVisited += 1
          if (uncreditedMilestonesVisited >= maxQualifiedDays) break
        }
        if (milestoneRows.rows.length < pageSize || uncreditedMilestonesVisited >= maxQualifiedDays) break
        milestoneOffset += milestoneRows.rows.length
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
