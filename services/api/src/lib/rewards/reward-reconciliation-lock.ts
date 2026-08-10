import { createDurableObjectCronLock, ScheduledCronLockDO } from "../scheduled-cron-lock"

export const REWARD_RECONCILIATION_LOCK_NAME = "reward-campaign-reconciliation"
export const REWARD_RECONCILIATION_LEASE_TTL_MS = 120_000
export const REWARD_RECONCILIATION_HEARTBEAT_MS = 30_000

export type RewardReconciliationLockResult<T> =
  | { acquired: false }
  | { acquired: true; leaseLost: boolean; value: T }

export interface RewardReconciliationLease {
  isValid(): boolean
}

export async function runWithRewardReconciliationLock<T>(input: {
  heartbeatMs?: number
  leaseTtlMs?: number
  namespace: DurableObjectNamespace<ScheduledCronLockDO>
  now?: () => number
  owner?: string
  run: (lease: RewardReconciliationLease) => Promise<T>
}): Promise<RewardReconciliationLockResult<T>> {
  const lock = createDurableObjectCronLock(input.namespace, REWARD_RECONCILIATION_LOCK_NAME)
  const leaseTtlMs = input.leaseTtlMs ?? REWARD_RECONCILIATION_LEASE_TTL_MS
  const heartbeatMs = input.heartbeatMs ?? REWARD_RECONCILIATION_HEARTBEAT_MS
  const now = input.now ?? Date.now
  const owner = input.owner ?? crypto.randomUUID()
  const acquiredAt = now()
  if (!await lock.tryAcquire(leaseTtlMs, owner, acquiredAt)) return { acquired: false }

  let leaseLost = false
  let validUntil = acquiredAt + leaseTtlMs
  const leaseIsValid = () => {
    if (!leaseLost && now() >= validUntil) leaseLost = true
    return !leaseLost
  }
  let renewal = Promise.resolve()
  const timer = setInterval(() => {
    renewal = renewal
      .then(async () => {
        if (!leaseIsValid()) return
        const renewalStartedAt = now()
        const renewalValidUntil = renewalStartedAt + leaseTtlMs
        const acquired = await lock.tryAcquire(leaseTtlMs, owner, renewalStartedAt)
        if (!acquired || leaseLost || now() >= renewalValidUntil) {
          leaseLost = true
          if (acquired) await lock.release(owner)
          return
        }
        validUntil = renewalValidUntil
      })
      .catch((error) => {
        leaseLost = true
        console.error(JSON.stringify({
          component: "reward_qualification_wakeup",
          operation: "lease_renewal",
          outcome: "failed",
          error: error instanceof Error ? error.message : String(error),
        }))
      })
  }, heartbeatMs)

  let value!: T
  try {
    value = await input.run({ isValid: leaseIsValid })
  } finally {
    clearInterval(timer)
    await renewal
    leaseIsValid()
    await lock.release(owner).catch((error) => {
      console.error(JSON.stringify({
        component: "reward_qualification_wakeup",
        operation: "lease_release",
        outcome: "failed",
        error: error instanceof Error ? error.message : String(error),
      }))
    })
  }
  return { acquired: true, leaseLost, value }
}
