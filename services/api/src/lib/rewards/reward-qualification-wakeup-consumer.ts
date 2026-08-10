import type { Env } from "../../env"
import { getCommunityRepository } from "../communities/db-community-repository"
import { getControlPlaneClient } from "../runtime-deps"
import type { ScheduledCronLockDO } from "../scheduled-cron-lock"
import { rowValue, stringOrNull } from "../sql-row"
import {
  reconcileRewardCampaigns,
  type RewardCampaignReconciliationSummary,
} from "./reward-campaign-reconciler"
import {
  isRewardQualificationWakeupCommunityAllowed,
  parseRewardQualificationWakeup,
  type RewardQualificationWakeup,
} from "./reward-qualification-wakeup"
import { runWithRewardReconciliationLock } from "./reward-reconciliation-lock"

const TRIGGERED_MAX_COMMUNITIES = 5
const TRIGGERED_MAX_CREDITS = 25
const TRIGGERED_MAX_EVENTS = 25
const TRIGGERED_MAX_ELAPSED_MS = 20_000
const TRIGGERED_OUTBOX_BATCH_SIZE = 100

type TargetedRunResult =
  | { outcome: "held" }
  | {
      outcome: "completed"
      leaseLost: boolean
      reachedEventIds: string[]
      summary: RewardCampaignReconciliationSummary
    }

function literalTrue(value: string | undefined): boolean {
  return String(value ?? "").trim().toLowerCase() === "true"
}

function retryDelaySeconds(attempts: number): number {
  return Math.min(300, 5 * (2 ** Math.max(0, Math.min(attempts - 1, 6))))
}

async function runTargetedReconciliation(
  env: Env,
  wakeups: RewardQualificationWakeup[],
): Promise<TargetedRunResult> {
  const namespace = env.SCHEDULED_CRON_LOCK as DurableObjectNamespace<ScheduledCronLockDO> | undefined
  if (!namespace) throw new Error("SCHEDULED_CRON_LOCK binding is required for reward wake-up consumption")
  const locked = await runWithRewardReconciliationLock({
    namespace,
    run: async (lease) => {
      const communityRepository = getCommunityRepository(env)
      try {
        const controlPlaneClient = getControlPlaneClient(env)
        const communityIds = [...new Set(wakeups.map((wakeup) => wakeup.community_id))]
        const eventIds = [...new Set(wakeups.map((wakeup) => wakeup.event_id))]
        const summary = await reconcileRewardCampaigns({
          env,
          communityRepository,
          controlPlaneClient,
          communityIds,
          eventIds,
          mode: "hint",
          maxCommunities: TRIGGERED_MAX_COMMUNITIES,
          maxCredits: TRIGGERED_MAX_CREDITS,
          maxElapsedMs: TRIGGERED_MAX_ELAPSED_MS,
          maxScannedQualifications: TRIGGERED_MAX_EVENTS,
          outboxBatchSize: TRIGGERED_OUTBOX_BATCH_SIZE,
          shouldContinue: lease.isValid,
        })
        if (!lease.isValid()) return { reachedEventIds: [], summary }
        const expectedCommunities = new Map(wakeups.map((wakeup) => [wakeup.event_id, wakeup.community_id]))
        const reached = await controlPlaneClient.execute({
          sql: `SELECT reward_qualification_event_id, community_id
            FROM reward_qualification_events
            WHERE reward_qualification_event_id IN (${eventIds.map((_, index) => `?${index + 1}`).join(", ")})`,
          args: eventIds,
        })
        return {
          reachedEventIds: reached.rows
            .map((row) => {
              const eventId = stringOrNull(rowValue(row, "reward_qualification_event_id"))
              const communityId = stringOrNull(rowValue(row, "community_id"))
              return eventId && expectedCommunities.get(eventId) === communityId ? eventId : null
            })
            .filter((eventId): eventId is string => eventId != null),
          summary,
        }
      } finally {
        await communityRepository.close?.()
      }
    },
  })
  if (!locked.acquired) return { outcome: "held" }
  return {
    outcome: "completed",
    leaseLost: locked.leaseLost,
    reachedEventIds: locked.value.reachedEventIds,
    summary: locked.value.summary,
  }
}

export async function consumeRewardQualificationWakeups(input: {
  batch: MessageBatch<RewardQualificationWakeup>
  env: Env
  runTargeted?: (env: Env, wakeups: RewardQualificationWakeup[]) => Promise<TargetedRunResult>
}): Promise<void> {
  if (!literalTrue(input.env.REWARD_QUALIFICATION_WAKEUP_CONSUMER_ENABLED)) {
    input.batch.ackAll()
    console.info(JSON.stringify({
      component: "reward_qualification_wakeup",
      operation: "consume",
      outcome: "telemetry_only",
      messages: input.batch.messages.length,
      backlog_count: input.batch.metadata.metrics.backlogCount,
      backlog_bytes: input.batch.metadata.metrics.backlogBytes,
    }))
    return
  }

  const admitted: Array<{ message: Message<RewardQualificationWakeup>; wakeup: RewardQualificationWakeup }> = []
  for (const message of input.batch.messages) {
    const wakeup = parseRewardQualificationWakeup(message.body)
    if (!wakeup) {
      message.retry({ delaySeconds: retryDelaySeconds(message.attempts) })
      console.error(JSON.stringify({
        component: "reward_qualification_wakeup",
        operation: "consume",
        outcome: "invalid_message",
        message_id: message.id,
        attempts: message.attempts,
      }))
      continue
    }
    if (!isRewardQualificationWakeupCommunityAllowed(input.env, wakeup.community_id)) {
      message.ack()
      console.info(JSON.stringify({
        component: "reward_qualification_wakeup",
        operation: "consume",
        outcome: "not_allowlisted",
        community_id: wakeup.community_id,
        event_id: wakeup.event_id,
      }))
      continue
    }
    admitted.push({ message, wakeup })
  }
  if (admitted.length === 0) return

  const communityIds = [...new Set(admitted.map(({ wakeup }) => wakeup.community_id))]
    .slice(0, TRIGGERED_MAX_COMMUNITIES)
  const deferredCommunityIds = new Set(admitted
    .map(({ wakeup }) => wakeup.community_id)
    .filter((communityId) => !communityIds.includes(communityId)))
  for (const item of admitted) {
    if (deferredCommunityIds.has(item.wakeup.community_id)) {
      item.message.retry({ delaySeconds: retryDelaySeconds(item.message.attempts) })
    }
  }
  const admittedCommunities = admitted.filter(({ wakeup }) => !deferredCommunityIds.has(wakeup.community_id))
  const selectedEventIds = [...new Set(admittedCommunities.map(({ wakeup }) => wakeup.event_id))]
    .slice(0, TRIGGERED_MAX_EVENTS)
  const selectedEventIdSet = new Set(selectedEventIds)
  const selectedWakeupByEvent = new Map(selectedEventIds.map((eventId) => [
    eventId,
    admittedCommunities.find(({ wakeup }) => wakeup.event_id === eventId)?.wakeup,
  ]))
  const processing = admittedCommunities.filter(({ wakeup }) => {
    const selected = selectedWakeupByEvent.get(wakeup.event_id)
    return selected?.community_id === wakeup.community_id
  })
  for (const item of admittedCommunities) {
    const selected = selectedWakeupByEvent.get(item.wakeup.event_id)
    if (!selectedEventIdSet.has(item.wakeup.event_id)
      || selected?.community_id !== item.wakeup.community_id) {
      item.message.retry({ delaySeconds: retryDelaySeconds(item.message.attempts) })
    }
  }
  if (processing.length === 0) return
  const targetedWakeups = selectedEventIds.map((eventId) => selectedWakeupByEvent.get(eventId))
    .filter((wakeup): wakeup is RewardQualificationWakeup => wakeup != null)

  const qualifiedTimes = processing
    .map(({ wakeup }) => Date.parse(wakeup.qualified_at))
    .filter(Number.isFinite)
  const startedAt = Date.now()
  let result: TargetedRunResult
  try {
    result = await (input.runTargeted ?? runTargetedReconciliation)(input.env, targetedWakeups)
  } catch (error) {
    for (const { message } of processing) {
      message.retry({ delaySeconds: retryDelaySeconds(message.attempts) })
    }
    console.error(JSON.stringify({
      component: "reward_qualification_wakeup",
      operation: "consume",
      outcome: "failed",
      communities: communityIds.length,
      messages: processing.length,
      error: error instanceof Error ? error.message : String(error),
    }))
    return
  }

  if (result.outcome === "held") {
    for (const { message } of processing) {
      message.retry({ delaySeconds: retryDelaySeconds(message.attempts) })
    }
    console.info(JSON.stringify({
      component: "reward_qualification_wakeup",
      operation: "consume",
      outcome: "lease_contended",
      communities: communityIds.length,
      messages: processing.length,
    }))
    return
  }

  const mustRetry = result.leaseLost
    || result.summary.failed_communities > 0
    || result.summary.errors > 0
  const reachedEventIds = new Set(result.reachedEventIds)
  for (const { message, wakeup } of processing) {
    if (mustRetry || !reachedEventIds.has(wakeup.event_id)) {
      message.retry({ delaySeconds: retryDelaySeconds(message.attempts) })
    }
    else message.ack()
  }
  console.info(JSON.stringify({
    component: "reward_qualification_wakeup",
    operation: "consume",
    outcome: mustRetry ? "retry" : "completed",
    communities: communityIds.length,
    messages: processing.length,
    attempts_max: Math.max(...processing.map(({ message }) => message.attempts)),
    consumer_ms: Date.now() - startedAt,
    qualified_to_consumer_ms_max: qualifiedTimes.length > 0
      ? startedAt - Math.min(...qualifiedTimes)
      : null,
    lease_lost: result.leaseLost,
    reached_events: reachedEventIds.size,
    summary: result.summary,
  }))
}
