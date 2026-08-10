import type { Env } from "../../env"
import { openCommunityReadClient } from "../communities/community-read-access"
import { getCommunityRepository } from "../communities/db-community-repository"
import { nowIso } from "../helpers"
import { rowValue, stringOrNull } from "../sql-row"
import type { ReadClient } from "../sql-client"
import { withBackgroundControlPlaneClients } from "../runtime-deps"
import type { RewardQualificationOutboxCandidate } from "./reward-qualification-outbox"

export const REWARD_QUALIFICATION_WAKEUP_SCHEMA_VERSION = 1 as const

export type RewardQualificationWakeup = {
  schema_version: typeof REWARD_QUALIFICATION_WAKEUP_SCHEMA_VERSION
  community_id: string
  event_id: string
  activity: "study" | "karaoke"
  qualified_at: string
  enqueued_at: string
}

export type RewardQualificationWakeupEnqueueOutcome =
  | "accepted"
  | "disabled"
  | "not_allowlisted"
  | "binding_missing"
  | "not_committed"
  | "failed"

function literalTrue(value: string | undefined): boolean {
  return String(value ?? "").trim().toLowerCase() === "true"
}

function canaryCommunityIds(env: Pick<Env, "REWARD_QUALIFICATION_WAKEUP_COMMUNITY_IDS">): Set<string> {
  return new Set(String(env.REWARD_QUALIFICATION_WAKEUP_COMMUNITY_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean))
}

export function isRewardQualificationWakeupCommunityAllowed(
  env: Pick<Env, "REWARD_QUALIFICATION_WAKEUP_COMMUNITY_IDS">,
  communityId: string,
): boolean {
  return canaryCommunityIds(env).has(communityId)
}

export function parseRewardQualificationWakeup(value: unknown): RewardQualificationWakeup | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown>
  if (candidate.schema_version !== REWARD_QUALIFICATION_WAKEUP_SCHEMA_VERSION) return null
  if (typeof candidate.community_id !== "string" || !candidate.community_id.trim()) return null
  if (typeof candidate.event_id !== "string" || !candidate.event_id.trim()) return null
  if (candidate.activity !== "study" && candidate.activity !== "karaoke") return null
  if (typeof candidate.qualified_at !== "string" || !Number.isFinite(Date.parse(candidate.qualified_at))) return null
  if (typeof candidate.enqueued_at !== "string" || !Number.isFinite(Date.parse(candidate.enqueued_at))) return null
  return {
    schema_version: REWARD_QUALIFICATION_WAKEUP_SCHEMA_VERSION,
    community_id: candidate.community_id,
    event_id: candidate.event_id,
    activity: candidate.activity,
    qualified_at: candidate.qualified_at,
    enqueued_at: candidate.enqueued_at,
  }
}

export async function isRewardQualificationOutboxCandidateCommitted(input: {
  client: Pick<ReadClient, "execute">
  event: RewardQualificationOutboxCandidate
}): Promise<boolean> {
  const result = await input.client.execute({
    sql: `
      SELECT event_id, qualified_at
      FROM reward_qualification_outbox
      WHERE user_id = ?1 AND post_id = ?2 AND activity = ?3 AND reward_period_key = ?4
      LIMIT 1
    `,
    args: [
      input.event.userId,
      input.event.postId,
      input.event.activity,
      input.event.rewardPeriodKey,
    ],
  })
  const row = result.rows[0]
  return stringOrNull(rowValue(row, "event_id")) === input.event.eventId
    && stringOrNull(rowValue(row, "qualified_at")) === input.event.qualifiedAt
}

export async function confirmRewardQualificationOutboxCandidate(input: {
  env: Env
  event: RewardQualificationOutboxCandidate
}): Promise<boolean> {
  return withBackgroundControlPlaneClients(async () => {
    const communityRepository = getCommunityRepository(input.env)
    let db: Awaited<ReturnType<typeof openCommunityReadClient>> | null = null
    try {
      db = await openCommunityReadClient(input.env, communityRepository, input.event.communityId)
      return await isRewardQualificationOutboxCandidateCommitted({
        client: db.client,
        event: input.event,
      })
    } finally {
      await db?.close()
      await communityRepository.close?.()
    }
  })
}

export async function confirmAndEnqueueRewardQualificationWakeup(input: {
  confirm?: (env: Env, event: RewardQualificationOutboxCandidate) => Promise<boolean>
  env: Env
  event: RewardQualificationOutboxCandidate
  enqueuedAt?: string
}): Promise<RewardQualificationWakeupEnqueueOutcome> {
  if (!literalTrue(input.env.REWARD_QUALIFICATION_WAKEUP_ENQUEUE_ENABLED)) return "disabled"
  if (!isRewardQualificationWakeupCommunityAllowed(input.env, input.event.communityId)) {
    return "not_allowlisted"
  }
  const queue = input.env.REWARD_QUALIFICATION_WAKEUPS
  if (!queue) {
    console.error(JSON.stringify({
      component: "reward_qualification_wakeup",
      operation: "enqueue",
      outcome: "binding_missing",
      community_id: input.event.communityId,
      event_id: input.event.eventId,
    }))
    return "binding_missing"
  }
  try {
    const committed = await (input.confirm ?? ((env, event) =>
      confirmRewardQualificationOutboxCandidate({ env, event })))(input.env, input.event)
    if (!committed) {
      console.info(JSON.stringify({
        component: "reward_qualification_wakeup",
        operation: "enqueue",
        outcome: "not_committed",
        community_id: input.event.communityId,
        event_id: input.event.eventId,
      }))
      return "not_committed"
    }
  } catch (error) {
    console.error(JSON.stringify({
      component: "reward_qualification_wakeup",
      operation: "confirm",
      outcome: "failed",
      community_id: input.event.communityId,
      event_id: input.event.eventId,
      error: error instanceof Error ? error.message : String(error),
    }))
    return "failed"
  }
  const message: RewardQualificationWakeup = {
    schema_version: REWARD_QUALIFICATION_WAKEUP_SCHEMA_VERSION,
    community_id: input.event.communityId,
    event_id: input.event.eventId,
    activity: input.event.activity,
    qualified_at: input.event.qualifiedAt,
    enqueued_at: input.enqueuedAt ?? nowIso(),
  }
  try {
    const accepted = await queue.send(message, { contentType: "json" })
    console.info(JSON.stringify({
      component: "reward_qualification_wakeup",
      operation: "enqueue",
      outcome: "accepted",
      community_id: message.community_id,
      event_id: message.event_id,
      qualified_at: message.qualified_at,
      enqueued_at: message.enqueued_at,
      backlog_count: accepted.metadata.metrics.backlogCount,
      backlog_bytes: accepted.metadata.metrics.backlogBytes,
    }))
    return "accepted"
  } catch (error) {
    console.error(JSON.stringify({
      component: "reward_qualification_wakeup",
      operation: "enqueue",
      outcome: "failed",
      community_id: message.community_id,
      event_id: message.event_id,
      error: error instanceof Error ? error.message : String(error),
    }))
    return "failed"
  }
}

export function deferRewardQualificationWakeup(input: {
  defer?: (task: Promise<unknown>) => void
  env: Env
  event: RewardQualificationOutboxCandidate
}): void {
  if (!input.defer) return
  try {
    input.defer(confirmAndEnqueueRewardQualificationWakeup({ env: input.env, event: input.event }))
  } catch (error) {
    console.error(JSON.stringify({
      component: "reward_qualification_wakeup",
      operation: "register",
      outcome: "failed",
      community_id: input.event.communityId,
      event_id: input.event.eventId,
      error: error instanceof Error ? error.message : String(error),
    }))
  }
}
