import { beforeEach, describe, expect, mock, test } from "bun:test"

import type { Env } from "../../env"
import type { Client, InStatement, QueryResult, Transaction } from "../sql-client"
import { reconcileSongPracticeRewards, resolveRewardConfig } from "./song-practice-reconciler"

type QualifiedDay = {
  activity_date: string
  community_id: string
  post_id: string
  user_id: string
}

type Streak = {
  community_id: string
  current_streak: number
  last_qualified_date: string
  post_id: string
  streak_started_date: string
  user_id: string
}

type RewardEvent = {
  activity_date: string
  amount_cents: number
  community_id: string
  post_id: string
  reward_kind: string
  user_id: string
}

const shardState: {
  qualifiedDays: QualifiedDay[]
  streaks: Streak[]
} = {
  qualifiedDays: [],
  streaks: [],
}

mock.module("../communities/community-read-access", () => ({
  openCommunityWriteClient: mock(async () => ({
    client: {
      execute: mock(async (statement: InStatement | string): Promise<QueryResult> => {
        const sql = typeof statement === "string" ? statement : statement.sql
        if (sql.includes("FROM song_engagement_days")) {
          return { rows: shardState.qualifiedDays }
        }
        if (sql.includes("FROM song_streaks")) {
          return { rows: shardState.streaks }
        }
        return { rows: [] }
      }),
    },
    close: mock(() => {}),
  })),
}))

function statementSql(statement: InStatement | string): string {
  return typeof statement === "string" ? statement : statement.sql
}

function statementArgs(statement: InStatement | string): unknown[] {
  return typeof statement === "string" ? [] : statement.args ?? []
}

function dayKey(userId: string, activityDate: string): string {
  return `${userId}:${activityDate}`
}

function dailyEventKey(input: {
  activityDate: string
  communityId: string
  postId: string
  rewardKind: string
  userId: string
}): string {
  return `${input.userId}:${input.communityId}:${input.postId}:${input.activityDate}:${input.rewardKind}`
}

function milestoneEventKey(input: {
  communityId: string
  postId: string
  rewardKind: string
  userId: string
}): string {
  return `${input.userId}:${input.communityId}:${input.postId}:${input.rewardKind}`
}

function createControlPlaneClient() {
  const userDays = new Map<string, number>()
  const dailyEvents = new Set<string>()
  const milestoneEvents = new Set<string>()
  const events: RewardEvent[] = []
  let transactionCount = 0
  let closedTransactionCount = 0

  function executeStatement(statement: InStatement | string): QueryResult {
    const sql = statementSql(statement)
    const args = statementArgs(statement)

    if (sql.includes("FROM reward_events") && sql.includes("reward_kind = 'study_streak_day'") && sql.includes("activity_date >=")) {
      const [communityId, sinceDate] = args as [string, string]
      return {
        rows: events
          .filter((event) => event.community_id === communityId && event.reward_kind === "study_streak_day" && event.activity_date >= sinceDate)
          .map((event) => ({
            user_id: event.user_id,
            community_id: event.community_id,
            post_id: event.post_id,
            activity_date: event.activity_date,
          })),
      }
    }

    if (sql.includes("FROM reward_events") && sql.includes("reward_kind IN")) {
      const [communityId] = args as [string]
      return {
        rows: events
          .filter((event) => event.community_id === communityId && event.reward_kind.startsWith("study_streak_milestone_"))
          .map((event) => ({
            user_id: event.user_id,
            community_id: event.community_id,
            post_id: event.post_id,
            reward_kind: event.reward_kind,
          })),
      }
    }

    if (sql.includes("INSERT INTO reward_user_days")) {
      const [userId, activityDate] = args as [string, string]
      const key = dayKey(userId, activityDate)
      if (!userDays.has(key)) {
        userDays.set(key, 0)
      }
      return { rows: [], rowsAffected: 1 }
    }

    if (sql.includes("SELECT credited_cents") && sql.includes("FROM reward_user_days")) {
      const [userId, activityDate] = args as [string, string]
      return { rows: [{ credited_cents: userDays.get(dayKey(userId, activityDate)) ?? 0 }] }
    }

    if (sql.includes("SELECT reward_event_id") && sql.includes("activity_date")) {
      const [userId, communityId, postId, activityDate, rewardKind] = args as [string, string, string, string, string]
      const key = dailyEventKey({ userId, communityId, postId, activityDate, rewardKind })
      return { rows: dailyEvents.has(key) ? [{ reward_event_id: "rew_existing" }] : [] }
    }

    if (sql.includes("SELECT reward_event_id")) {
      const [userId, communityId, postId, rewardKind] = args as [string, string, string, string]
      const key = milestoneEventKey({ userId, communityId, postId, rewardKind })
      return { rows: milestoneEvents.has(key) ? [{ reward_event_id: "rew_existing" }] : [] }
    }

    if (sql.includes("UPDATE reward_user_days")) {
      const [userId, activityDate, creditedCents] = args as [string, string, number]
      const key = dayKey(userId, activityDate)
      userDays.set(key, (userDays.get(key) ?? 0) + creditedCents)
      return { rows: [], rowsAffected: 1 }
    }

    if (sql.includes("INSERT INTO reward_events") && sql.includes("'study_streak_day'")) {
      const [, userId, communityId, postId, activityDate, amountCents] = args as [string, string, string, string, string, number]
      const rewardKind = "study_streak_day"
      const key = dailyEventKey({ userId, communityId, postId, activityDate, rewardKind })
      if (dailyEvents.has(key)) {
        return { rows: [] }
      }
      dailyEvents.add(key)
      events.push({ user_id: userId, community_id: communityId, post_id: postId, activity_date: activityDate, reward_kind: rewardKind, amount_cents: amountCents })
      return { rows: [{ reward_event_id: "rew_inserted" }], rowsAffected: 1 }
    }

    if (sql.includes("INSERT INTO reward_events")) {
      const [, userId, communityId, postId, activityDate, rewardKind, amountCents] = args as [string, string, string, string, string, string, number]
      const key = milestoneEventKey({ userId, communityId, postId, rewardKind })
      if (milestoneEvents.has(key)) {
        return { rows: [] }
      }
      milestoneEvents.add(key)
      events.push({ user_id: userId, community_id: communityId, post_id: postId, activity_date: activityDate, reward_kind: rewardKind, amount_cents: amountCents })
      return { rows: [{ reward_event_id: "rew_inserted" }], rowsAffected: 1 }
    }

    return { rows: [] }
  }

  const client: Client = {
    batch: async () => [],
    close: () => {},
    execute: async (statement) => executeStatement(statement),
    transaction: async (): Promise<Transaction> => ({
      batch: async () => [],
      close: () => { closedTransactionCount += 1 },
      commit: async () => {},
      execute: async (statement) => executeStatement(statement),
      rollback: async () => {},
    }),
  }

  const originalTransaction = client.transaction
  client.transaction = async (mode) => {
    transactionCount += 1
    return await originalTransaction(mode)
  }

  return {
    client,
    get closedTransactionCount() { return closedTransactionCount },
    events,
    get transactionCount() { return transactionCount },
    userDays,
  }
}

function repository() {
  return {
    listActiveCommunities: async () => [{ community_id: "cmty_rewards" }],
  }
}

function env(overrides: Partial<Env> = {}): Env {
  return {
    REWARDS_ACCRUAL_ENABLED: "true",
    REWARDS_DAILY_STREAK_CENTS: "10",
    REWARDS_DAILY_USER_CAP_CENTS: "25",
    REWARDS_STREAK_MILESTONE_7_CENTS: "50",
    REWARDS_STREAK_MILESTONE_30_CENTS: "200",
    ...overrides,
  } as Env
}

beforeEach(() => {
  shardState.qualifiedDays = []
  shardState.streaks = []
})

describe("song practice rewards reconciler", () => {
  test("fails closed when rewards are not enabled", () => {
    const config = resolveRewardConfig({
      REWARDS_DAILY_STREAK_CENTS: "10",
      REWARDS_DAILY_USER_CAP_CENTS: "30",
      REWARDS_STREAK_MILESTONE_7_CENTS: "50",
      REWARDS_STREAK_MILESTONE_30_CENTS: "200",
    })

    expect(config).toEqual({
      enabled: false,
      dailyCents: 10,
      dailyUserCapCents: 30,
      milestone7Cents: 50,
      milestone30Cents: 200,
    })
  })

  test("invalid money knobs resolve to zero credits", () => {
    const config = resolveRewardConfig({
      REWARDS_ACCRUAL_ENABLED: "true",
      REWARDS_DAILY_STREAK_CENTS: "0.10",
      REWARDS_DAILY_USER_CAP_CENTS: "-30",
      REWARDS_STREAK_MILESTONE_7_CENTS: "fifty",
      REWARDS_STREAK_MILESTONE_30_CENTS: "",
    })

    expect(config).toEqual({
      enabled: true,
      dailyCents: 0,
      dailyUserCapCents: 0,
      milestone7Cents: 0,
      milestone30Cents: 0,
    })
  })

  test("disabled reconciliation does not enumerate communities", async () => {
    let listed = false
    const summary = await reconcileSongPracticeRewards({
      env: {} as Env,
      communityRepository: {
        listActiveCommunities: async () => {
          listed = true
          return []
        },
      } as never,
      controlPlaneClient: {} as never,
    })

    expect(listed).toBe(false)
    expect(summary).toEqual({
      enabled: false,
      scanned_communities: 0,
      scanned_qualified_days: 0,
      scanned_streaks: 0,
      credited_events: 0,
      credited_cents: 0,
      skipped_cap_cents: 0,
      duplicate_events: 0,
      failed_communities: 0,
    })
  })

  test("credits daily rewards atomically against the per-user daily cap and replays as no-op", async () => {
    shardState.qualifiedDays = ["post_a", "post_b", "post_c"].map((postId) => ({
      activity_date: "2026-07-09",
      community_id: "cmty_rewards",
      post_id: postId,
      user_id: "usr_rewards",
    }))
    const controlPlane = createControlPlaneClient()

    const summary = await reconcileSongPracticeRewards({
      env: env(),
      communityRepository: repository() as never,
      controlPlaneClient: controlPlane.client,
    })

    expect(summary.credited_events).toBe(3)
    expect(summary.credited_cents).toBe(25)
    expect(summary.skipped_cap_cents).toBe(5)
    expect(controlPlane.userDays.get("usr_rewards:2026-07-09")).toBe(25)
    expect(controlPlane.events.map((event) => event.amount_cents)).toEqual([10, 10, 5])
    expect(controlPlane.transactionCount).toBe(3)
    expect(controlPlane.closedTransactionCount).toBe(3)

    const replay = await reconcileSongPracticeRewards({
      env: env(),
      communityRepository: repository() as never,
      controlPlaneClient: controlPlane.client,
    })

    expect(replay.credited_events).toBe(0)
    expect(replay.credited_cents).toBe(0)
    expect(replay.duplicate_events).toBe(3)
    expect(controlPlane.events).toHaveLength(3)
    expect(controlPlane.transactionCount).toBe(3)
    expect(controlPlane.closedTransactionCount).toBe(3)
  })

  test("credits milestone rewards once ever per song and exempts them from the daily cap", async () => {
    shardState.streaks = [{
      community_id: "cmty_rewards",
      current_streak: 30,
      last_qualified_date: "2026-07-30",
      post_id: "post_rewards",
      streak_started_date: "2026-07-01",
      user_id: "usr_rewards",
    }]
    const controlPlane = createControlPlaneClient()

    const summary = await reconcileSongPracticeRewards({
      env: env({ REWARDS_DAILY_USER_CAP_CENTS: "0" }),
      communityRepository: repository() as never,
      controlPlaneClient: controlPlane.client,
    })

    expect(summary.credited_events).toBe(2)
    expect(summary.credited_cents).toBe(250)
    expect(summary.skipped_cap_cents).toBe(0)
    expect(controlPlane.events.map((event) => [event.reward_kind, event.activity_date, event.amount_cents])).toEqual([
      ["study_streak_milestone_7", "2026-07-07", 50],
      ["study_streak_milestone_30", "2026-07-30", 200],
    ])
    expect(controlPlane.userDays.size).toBe(0)

    shardState.streaks = [{
      community_id: "cmty_rewards",
      current_streak: 7,
      last_qualified_date: "2026-08-16",
      post_id: "post_rewards",
      streak_started_date: "2026-08-10",
      user_id: "usr_rewards",
    }]
    const replayAfterRebuild = await reconcileSongPracticeRewards({
      env: env({ REWARDS_DAILY_USER_CAP_CENTS: "0" }),
      communityRepository: repository() as never,
      controlPlaneClient: controlPlane.client,
    })

    expect(replayAfterRebuild.credited_events).toBe(0)
    expect(replayAfterRebuild.duplicate_events).toBe(1)
    expect(controlPlane.events).toHaveLength(2)
    expect(controlPlane.transactionCount).toBe(2)
    expect(controlPlane.closedTransactionCount).toBe(2)
  })
})
