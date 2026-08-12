import type { Env } from "../../env"
import { captureScheduledError, captureScheduledWarning } from "../ops-alerts/scheduled"
import { resolveStoryCoordinatorDirectSigner } from "./story-direct-signer"
import { resolveStoryChainId } from "./story-runtime-config"
import {
  storySettlementCoordinatorName,
  type StorySettlementCoordinatorHealth,
} from "./story-settlement-wallet-coordinator-do"

const TASK = "story_settlement_coordinator_watchdog"
const DEFAULT_BACKLOG_ALERT_MS = 10 * 60_000
const DEFAULT_RECONCILIATION_ALERT_MS = 5 * 60_000

export type StorySettlementCoordinatorAlert = {
  key: string
  title: string
  urgency: "high" | "normal"
  details: Record<string, unknown>
}

function positiveMs(raw: string | undefined, fallback: number): number {
  const value = Number(String(raw ?? "").trim())
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

export function classifyStorySettlementCoordinatorHealth(
  health: StorySettlementCoordinatorHealth,
  thresholds: { backlogMs: number; reconciliationMs: number },
): StorySettlementCoordinatorAlert[] {
  const common = {
    chainId: health.chainId,
    signerAddress: health.signerAddress,
    latestNonce: health.latestNonce,
    pendingNonce: health.pendingNonce,
    nextAllocatedNonce: health.nextAllocatedNonce,
  }
  const alerts: StorySettlementCoordinatorAlert[] = []
  if (health.failedPlans > 0 || health.revertedSteps > 0) alerts.push({
    key: "failed_plans",
    title: "Story settlement coordinator has terminal failed plans",
    urgency: "high",
    details: { ...common, failedPlans: health.failedPlans, revertedSteps: health.revertedSteps },
  })
  if (health.oldestBacklogAgeMs >= thresholds.backlogMs) alerts.push({
    key: "backlog_age",
    title: "Story settlement coordinator backlog is stale",
    urgency: "high",
    details: { ...common, pendingPlans: health.pendingPlans, oldestBacklogAgeMs: health.oldestBacklogAgeMs },
  })
  if (health.nonceGap) alerts.push({
    key: "nonce_gap",
    title: "Story settlement coordinator signer nonce ownership gap detected",
    urgency: "high",
    details: common,
  })
  if (health.replacedSteps > 0) alerts.push({
    key: "replaced_steps",
    title: "Story settlement coordinator has replaced steps requiring review",
    urgency: "high",
    details: { ...common, replacedSteps: health.replacedSteps },
  })
  if (health.oldestReconciliationAgeMs >= thresholds.reconciliationMs) alerts.push({
    key: "reconciliation_age",
    title: "Story settlement coordinator reconciliation is stale",
    urgency: "high",
    details: {
      ...common,
      reconciliationRequiredSteps: health.reconciliationRequiredSteps,
      oldestReconciliationAgeMs: health.oldestReconciliationAgeMs,
    },
  })
  if (BigInt(health.nativeBalanceWei) < BigInt(health.nativeRequiredWei)) alerts.push({
    key: "native_insolvency",
    title: "Story settlement coordinator native IP reserve is insufficient",
    urgency: "high",
    details: { ...common, nativeBalanceWei: health.nativeBalanceWei, nativeRequiredWei: health.nativeRequiredWei },
  })
  if (BigInt(health.wipBalanceWei) < BigInt(health.wipObligationWei)) alerts.push({
    key: "wip_insolvency",
    title: "Story settlement coordinator WIP balance is below pending obligations",
    urgency: "high",
    details: { ...common, wipBalanceWei: health.wipBalanceWei, wipObligationWei: health.wipObligationWei },
  })
  if (BigInt(health.surplusWipWei) > 0n) alerts.push({
    key: "surplus_wip",
    title: "Story settlement coordinator has surplus WIP requiring treasury review",
    urgency: "normal",
    details: { ...common, surplusWipWei: health.surplusWipWei, wipObligationWei: health.wipObligationWei },
  })
  return alerts
}

export async function runStorySettlementCoordinatorWatchdog(env: Env): Promise<{ ran: boolean; alerts: number }> {
  const binding = env.STORY_SETTLEMENT_WALLET_COORDINATOR
  const signer = resolveStoryCoordinatorDirectSigner(env)
  if (!binding || !signer.ok || !signer.value) return { ran: false, alerts: 0 }
  try {
    const chainId = resolveStoryChainId(env)
    const coordinator = binding.getByName(storySettlementCoordinatorName(chainId, signer.value.address))
    const health = await coordinator.health()
    if (!health) return { ran: true, alerts: 0 }
    const alerts = classifyStorySettlementCoordinatorHealth(health, {
      backlogMs: positiveMs(env.STORY_COORDINATOR_BACKLOG_ALERT_MS, DEFAULT_BACKLOG_ALERT_MS),
      reconciliationMs: positiveMs(env.STORY_COORDINATOR_RECONCILIATION_ALERT_MS, DEFAULT_RECONCILIATION_ALERT_MS),
    })
    for (const alert of alerts) {
      await captureScheduledWarning(env, alert.title, `${TASK}:${alert.key}`, alert.details, { urgency: alert.urgency })
    }
    return { ran: true, alerts: alerts.length }
  } catch (error) {
    await captureScheduledError(env, error, TASK)
    return { ran: false, alerts: 0 }
  }
}
