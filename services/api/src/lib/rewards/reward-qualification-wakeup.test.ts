import { describe, expect, test } from "bun:test"
import type { Env } from "../../env"
import type { RewardCampaignReconciliationSummary } from "./reward-campaign-reconciler"
import {
  consumeRewardQualificationWakeups,
} from "./reward-qualification-wakeup-consumer"
import {
  confirmAndEnqueueRewardQualificationWakeup,
  deferRewardQualificationWakeup,
  parseRewardQualificationWakeup,
  type RewardQualificationWakeup,
} from "./reward-qualification-wakeup"
import { runWithRewardReconciliationLock } from "./reward-reconciliation-lock"
import type { ScheduledCronLockDO } from "../scheduled-cron-lock"

const EVENT = {
  activity: "study" as const,
  communityId: "cmt_1",
  eventId: "rqo_1",
  postId: "pst_1",
  qualifiedAt: "2026-08-10T18:00:00.000Z",
  rewardPeriodKey: "2026-08-10",
  userId: "usr_1",
}

function enabledEnv(overrides: Partial<Env> = {}): Env {
  return {
    REWARD_QUALIFICATION_WAKEUP_COMMUNITY_IDS: "cmt_1",
    REWARD_QUALIFICATION_WAKEUP_CONSUMER_ENABLED: "true",
    REWARD_QUALIFICATION_WAKEUP_ENQUEUE_ENABLED: "true",
    ...overrides,
  }
}

function wakeup(overrides: Partial<RewardQualificationWakeup> = {}): RewardQualificationWakeup {
  return {
    schema_version: 1,
    community_id: "cmt_1",
    event_id: "rqo_1",
    activity: "study",
    qualified_at: "2026-08-10T18:00:00.000Z",
    enqueued_at: "2026-08-10T18:00:00.100Z",
    ...overrides,
  }
}

function summary(overrides: Partial<RewardCampaignReconciliationSummary> = {}): RewardCampaignReconciliationSummary {
  return {
    enabled: true,
    scanned_communities: 1,
    ingested_qualifications: 1,
    duplicate_qualifications: 0,
    scanned_qualifications: 1,
    credited_events: 1,
    credited_cents: 100,
    activated_campaigns: 0,
    canceled_draft_campaigns: 0,
    canceled_retired_funding_campaigns: 0,
    audited_retired_funding_effects: 0,
    retirement_policy_anomalies: 0,
    ended_campaigns: 0,
    skipped_identity: 0,
    pending_verification: 0,
    expired_pending: 0,
    skipped_expired: 0,
    skipped_owner_blocked: 0,
    skipped_no_campaign: 0,
    skipped_budget: 0,
    deferred_funding: 0,
    skipped_cap: 0,
    skipped_score: 0,
    failed_communities: 0,
    errors: 0,
    ...overrides,
  }
}

function message(body: RewardQualificationWakeup | Record<string, unknown>, attempts = 1) {
  let action: "ack" | "retry" | null = null
  const value: Message<RewardQualificationWakeup> = {
    id: `msg_${body.event_id ?? "invalid"}`,
    timestamp: new Date("2026-08-10T18:00:00.200Z"),
    body: body as RewardQualificationWakeup,
    attempts,
    ack: () => { action = "ack" },
    retry: () => { action = "retry" },
  }
  return { action: () => action, value }
}

function batch(messages: Message<RewardQualificationWakeup>[]) {
  let acknowledged = false
  const value: MessageBatch<RewardQualificationWakeup> = {
    queue: "reward-wakeups",
    messages,
    metadata: { metrics: { backlogCount: messages.length, backlogBytes: 100 } },
    ackAll: () => { acknowledged = true },
    retryAll: () => undefined,
  }
  return { acknowledged: () => acknowledged, value }
}

describe("reward qualification wake-up producer", () => {
  test("validates the versioned message contract", () => {
    expect(parseRewardQualificationWakeup(wakeup())).toEqual(wakeup())
    expect(parseRewardQualificationWakeup({ ...wakeup(), schema_version: 2 })).toBeNull()
    expect(parseRewardQualificationWakeup({ ...wakeup(), qualified_at: "invalid" })).toBeNull()
  })

  test("is disabled and allowlisted independently of the Queue binding", async () => {
    expect(await confirmAndEnqueueRewardQualificationWakeup({ env: {}, event: EVENT })).toBe("disabled")
    expect(await confirmAndEnqueueRewardQualificationWakeup({
      env: enabledEnv({ REWARD_QUALIFICATION_WAKEUP_COMMUNITY_IDS: "cmt_2" }),
      event: EVENT,
    })).toBe("not_allowlisted")
    expect(await confirmAndEnqueueRewardQualificationWakeup({ env: enabledEnv(), event: EVENT }))
      .toBe("binding_missing")
  })

  test("sends the event reference and absorbs Queue failures", async () => {
    const sent: RewardQualificationWakeup[] = []
    const queue: Queue<RewardQualificationWakeup> = {
      metrics: async () => ({ backlogCount: 0, backlogBytes: 0 }),
      send: async (value) => {
        sent.push(value)
        return { metadata: { metrics: { backlogCount: 1, backlogBytes: 100 } } }
      },
      sendBatch: async () => ({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } }),
    }
    expect(await confirmAndEnqueueRewardQualificationWakeup({
      confirm: async () => true,
      env: enabledEnv({ REWARD_QUALIFICATION_WAKEUPS: queue }),
      event: EVENT,
      enqueuedAt: "2026-08-10T18:00:00.100Z",
    })).toBe("accepted")
    expect(sent).toEqual([wakeup()])

    const failingQueue: Queue<RewardQualificationWakeup> = {
      ...queue,
      send: async () => { throw new Error("queue unavailable") },
    }
    expect(await confirmAndEnqueueRewardQualificationWakeup({
      confirm: async () => true,
      env: enabledEnv({ REWARD_QUALIFICATION_WAKEUPS: failingQueue }),
      event: EVENT,
    })).toBe("failed")
  })

  test("does not send on an authoritative mismatch or confirmation failure", async () => {
    let sends = 0
    const queue: Queue<RewardQualificationWakeup> = {
      metrics: async () => ({ backlogCount: 0, backlogBytes: 0 }),
      send: async () => {
        sends += 1
        return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } }
      },
      sendBatch: async () => ({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } }),
    }
    const env = enabledEnv({ REWARD_QUALIFICATION_WAKEUPS: queue })
    expect(await confirmAndEnqueueRewardQualificationWakeup({
      confirm: async () => false,
      env,
      event: EVENT,
    })).toBe("not_committed")
    expect(await confirmAndEnqueueRewardQualificationWakeup({
      confirm: async () => { throw new Error("read failed") },
      env,
      event: EVENT,
    })).toBe("failed")
    expect(sends).toBe(0)
  })

  test("registers background delivery without surfacing registration failure", () => {
    expect(() => deferRewardQualificationWakeup({
      defer: () => { throw new Error("execution context unavailable") },
      env: enabledEnv(),
      event: EVENT,
    })).not.toThrow()
  })
})

describe("reward qualification wake-up consumer", () => {
  test("acknowledges telemetry-only delivery while consumption is disabled", async () => {
    const item = message(wakeup())
    const delivery = batch([item.value])
    await consumeRewardQualificationWakeups({
      batch: delivery.value,
      env: enabledEnv({ REWARD_QUALIFICATION_WAKEUP_CONSUMER_ENABLED: "false" }),
      runTargeted: async () => { throw new Error("must not run") },
    })
    expect(delivery.acknowledged()).toBe(true)
  })

  test("deduplicates hints into one targeted reconciliation", async () => {
    const first = message(wakeup())
    const duplicate = message(wakeup())
    const delivery = batch([first.value, duplicate.value])
    const calls: string[][] = []
    await consumeRewardQualificationWakeups({
      batch: delivery.value,
      env: enabledEnv(),
      runTargeted: async (_env, wakeups) => {
        calls.push(wakeups.map((item) => item.community_id))
        return { outcome: "completed", leaseLost: false, reachedEventIds: ["rqo_1"], summary: summary() }
      },
    })
    expect(calls).toEqual([["cmt_1"]])
    expect(first.action()).toBe("ack")
    expect(duplicate.action()).toBe("ack")
  })

  test("acknowledges only events confirmed in the control plane", async () => {
    const reached = message(wakeup({ event_id: "rqo_reached" }))
    const pending = message(wakeup({ event_id: "rqo_pending" }))
    await consumeRewardQualificationWakeups({
      batch: batch([reached.value, pending.value]).value,
      env: enabledEnv(),
      runTargeted: async () => ({
        outcome: "completed",
        leaseLost: false,
        reachedEventIds: ["rqo_reached"],
        summary: summary({ credited_events: 0, credited_cents: 0 }),
      }),
    })
    expect(reached.action()).toBe("ack")
    expect(pending.action()).toBe("retry")
  })

  test("does not acknowledge one event reference under two communities", async () => {
    const authoritative = message(wakeup())
    const conflicting = message(wakeup({ community_id: "cmt_2" }))
    let targeted: RewardQualificationWakeup[] = []
    await consumeRewardQualificationWakeups({
      batch: batch([authoritative.value, conflicting.value]).value,
      env: enabledEnv({ REWARD_QUALIFICATION_WAKEUP_COMMUNITY_IDS: "cmt_1,cmt_2" }),
      runTargeted: async (_env, wakeups) => {
        targeted = wakeups
        return {
          outcome: "completed",
          leaseLost: false,
          reachedEventIds: ["rqo_1"],
          summary: summary(),
        }
      },
    })
    expect(targeted).toEqual([wakeup()])
    expect(authoritative.action()).toBe("ack")
    expect(conflicting.action()).toBe("retry")
  })

  test("retries poison messages and lease contention without reconciliation side effects", async () => {
    const invalid = message({ schema_version: 2 })
    const valid = message(wakeup())
    const delivery = batch([invalid.value, valid.value])
    await consumeRewardQualificationWakeups({
      batch: delivery.value,
      env: enabledEnv(),
      runTargeted: async () => ({ outcome: "held" }),
    })
    expect(invalid.action()).toBe("retry")
    expect(valid.action()).toBe("retry")
  })

  test("retries successful work if errors or lease loss make completion uncertain", async () => {
    const failed = message(wakeup())
    await consumeRewardQualificationWakeups({
      batch: batch([failed.value]).value,
      env: enabledEnv(),
      runTargeted: async () => ({
        outcome: "completed",
        leaseLost: true,
        reachedEventIds: ["rqo_1"],
        summary: summary({ errors: 1 }),
      }),
    })
    expect(failed.action()).toBe("retry")
  })
})

describe("reward reconciliation load-coordination lease", () => {
  function namespace(acquisitions: boolean[], calls: string[]) {
    const stub = {
      tryAcquire: async () => {
        calls.push("acquire")
        return acquisitions.shift() ?? true
      },
      release: async () => { calls.push("release") },
    }
    return {
      getByName: () => stub,
    } as unknown as DurableObjectNamespace<ScheduledCronLockDO>
  }

  test("renews while work is running and releases under the same owner", async () => {
    const calls: string[] = []
    const result = await runWithRewardReconciliationLock({
      namespace: namespace([true, true, true], calls),
      heartbeatMs: 5,
      leaseTtlMs: 20,
      owner: "owner_1",
      run: async (lease) => {
        await new Promise((resolve) => setTimeout(resolve, 14))
        expect(lease.isValid()).toBe(true)
        return "done"
      },
    })
    expect(result).toEqual({ acquired: true, leaseLost: false, value: "done" })
    expect(calls.filter((call) => call === "acquire").length).toBeGreaterThanOrEqual(2)
    expect(calls.at(-1)).toBe("release")
  })

  test("reports renewal loss so the consumer cannot acknowledge uncertain work", async () => {
    const calls: string[] = []
    const result = await runWithRewardReconciliationLock({
      namespace: namespace([true, false], calls),
      heartbeatMs: 5,
      leaseTtlMs: 20,
      owner: "owner_1",
      run: async (lease) => {
        await new Promise((resolve) => setTimeout(resolve, 9))
        expect(lease.isValid()).toBe(false)
        return "done"
      },
    })
    expect(result).toEqual({ acquired: true, leaseLost: true, value: "done" })
  })

  test("invalidates locally at expiry even when no renewal callback has completed", async () => {
    let clock = 0
    const result = await runWithRewardReconciliationLock({
      namespace: namespace([true], []),
      heartbeatMs: 100,
      leaseTtlMs: 20,
      now: () => clock,
      owner: "owner_1",
      run: async (lease) => {
        expect(lease.isValid()).toBe(true)
        clock = 20
        expect(lease.isValid()).toBe(false)
        return "done"
      },
    })
    expect(result).toEqual({ acquired: true, leaseLost: true, value: "done" })
  })

  test("reports expiry after work returns without another explicit lease check", async () => {
    let clock = 0
    const result = await runWithRewardReconciliationLock({
      namespace: namespace([true], []),
      heartbeatMs: 100,
      leaseTtlMs: 20,
      now: () => clock,
      owner: "owner_1",
      run: async () => {
        clock = 20
        return "done"
      },
    })
    expect(result).toEqual({ acquired: true, leaseLost: true, value: "done" })
  })

  test("discards a renewal that returns after its proposed lease already expired", async () => {
    let clock = 0
    let acquisitions = 0
    let releases = 0
    let finishRenewal!: () => void
    const renewalGate = new Promise<void>((resolve) => { finishRenewal = resolve })
    const stub = {
      tryAcquire: async () => {
        acquisitions += 1
        if (acquisitions > 1) await renewalGate
        return true
      },
      release: async () => { releases += 1 },
    }
    const resultPromise = runWithRewardReconciliationLock({
      namespace: { getByName: () => stub } as unknown as DurableObjectNamespace<ScheduledCronLockDO>,
      heartbeatMs: 5,
      leaseTtlMs: 20,
      now: () => clock,
      owner: "owner_1",
      run: async (lease) => {
        clock = 5
        await new Promise((resolve) => setTimeout(resolve, 7))
        clock = 25
        finishRenewal()
        await new Promise((resolve) => setTimeout(resolve, 1))
        expect(lease.isValid()).toBe(false)
        return "done"
      },
    })
    expect(await resultPromise).toEqual({ acquired: true, leaseLost: true, value: "done" })
    expect(acquisitions).toBe(2)
    expect(releases).toBe(2)
  })

  test("does not start work when another reconciler holds the lease", async () => {
    let ran = false
    const result = await runWithRewardReconciliationLock({
      namespace: namespace([false], []),
      heartbeatMs: 5,
      leaseTtlMs: 20,
      owner: "owner_1",
      run: async () => {
        ran = true
      },
    })
    expect(result).toEqual({ acquired: false })
    expect(ran).toBe(false)
  })
})
