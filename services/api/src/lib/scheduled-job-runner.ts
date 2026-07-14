/**
 * Runs named async tasks with a bounded concurrency limit and an optional batch
 * deadline.
 *
 * Used by the scheduled (cron) handler to cap how many control-plane connections
 * the per-minute job fan-out opens at once: each job opens its own connection, so
 * firing all of them concurrently can burst the control-plane Postgres primary's
 * small `max_connections`.
 *
 * - `limit`: at most this many tasks run concurrently (peak connections per
 *   invocation ≤ limit).
 * - `deadlineMs`: stop STARTING new tasks once this much wall-time has elapsed;
 *   already-running tasks (≤ limit) finish. Bounds when new connections stop
 *   opening. NOTE: this does NOT cancel an in-flight task — a task that already
 *   started may still run past the deadline (and past the next cron boundary).
 *   It is a connection-burst mitigation, not a hard overlap guard.
 * - `minimumStartsBeforeDeadline`: ordered prefix that must start even after the
 *   deadline. Use sparingly for recovery paths that cannot safely be deferred.
 *
 * Tasks are named so logs/metrics are stable across the handler's per-minute
 * rotation. A task that rejects does NOT abort the others; its error is routed to
 * `onError(error, name)`. Returns the names started vs. skipped (skipped =
 * deferred past the deadline; they run on a later invocation).
 */
export interface NamedTask {
  name: string
  run: () => Promise<unknown>
}

export interface RunWithConcurrencyOptions {
  onError?: (error: unknown, name: string) => void
  deadlineMs?: number
  minimumStartsBeforeDeadline?: number
  now?: () => number
}

export interface RunResult {
  started: string[]
  skipped: string[]
}

export async function runWithConcurrencyLimit(
  tasks: ReadonlyArray<NamedTask>,
  limit: number,
  options: RunWithConcurrencyOptions = {},
): Promise<RunResult> {
  if (tasks.length === 0) return { skipped: [], started: [] }

  const {
    onError,
    deadlineMs,
    minimumStartsBeforeDeadline = 0,
    now = () => Date.now(),
  } = options
  const protectedStartCount = Math.max(0, Math.min(tasks.length, Math.trunc(minimumStartsBeforeDeadline)))
  const start = now()
  const pastDeadline = (): boolean => deadlineMs != null && now() - start >= deadlineMs

  let next = 0
  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      if (next >= protectedStartCount && pastDeadline()) return
      const task = tasks[next]!
      next += 1
      try {
        await task.run()
      } catch (error) {
        onError?.(error, task.name)
      }
    }
  }

  const workerCount = Math.max(1, Math.min(Math.floor(limit) || 1, tasks.length))
  await Promise.all(Array.from({ length: workerCount }, () => worker()))

  // Tasks are pulled in order from the shared cursor, so [0, next) started and
  // [next, end) were deferred past the deadline.
  return {
    skipped: tasks.slice(next).map((task) => task.name),
    started: tasks.slice(0, next).map((task) => task.name),
  }
}

/**
 * Cross-invocation lease used to guarantee only ONE cron batch runs at a time
 * (backed by a Durable Object in production). `tryAcquire` returns false when the
 * lease is already held by a different owner and not yet expired.
 */
export interface CronLock {
  tryAcquire: (ttlMs: number, owner: string, now: number) => Promise<boolean>
  release: (owner: string) => Promise<void>
}

export interface RunScheduledBatchInput {
  lock: CronLock
  owner: string
  leaseTtlMs: number
  tasks: ReadonlyArray<NamedTask>
  limit: number
  deadlineMs?: number
  minimumStartsBeforeDeadline?: number
  now?: () => number
  onError?: (error: unknown, name: string) => void
  onSkipped?: (skipped: string[]) => void
  onLeaseHeld?: () => void
}

/**
 * Acquires the cron lease, runs the bounded batch, then releases — guaranteeing a
 * single batch cluster-wide. If the lease is already held (a prior invocation is
 * still in flight), this STARTS ZERO JOBS and returns `{ acquired: false }`,
 * preventing overlapping invocations from stacking control-plane connections.
 */
export async function runScheduledBatch(input: RunScheduledBatchInput): Promise<{ acquired: boolean; result: RunResult | null }> {
  const now = input.now ?? (() => Date.now())
  const acquired = await input.lock.tryAcquire(input.leaseTtlMs, input.owner, now())
  if (!acquired) {
    input.onLeaseHeld?.()
    return { acquired: false, result: null }
  }
  try {
    const result = await runWithConcurrencyLimit(input.tasks, input.limit, {
      deadlineMs: input.deadlineMs,
      minimumStartsBeforeDeadline: input.minimumStartsBeforeDeadline,
      now: input.now,
      onError: input.onError,
    })
    if (result.skipped.length > 0) input.onSkipped?.(result.skipped)
    return { acquired: true, result }
  } finally {
    await input.lock.release(input.owner)
  }
}
