/**
 * Scheduler lane split.
 *
 * Community jobs are foreground delivery work — the retry engine behind every
 * community job, including Telegram channel publishing. Maintenance (reward
 * reconciles, monitors, observers) is slow and cares only about eventually
 * running. Sharing one lease let the slow side gate the fast one: a maintenance
 * batch overrunning the 60s cron interval left later ticks skipping outright, so
 * ready community jobs waited tens of minutes behind work nobody awaited.
 *
 * The split is by name rather than by a flag on each task so there is exactly
 * one place that decides what counts as foreground work.
 */

export const COMMUNITY_JOB_LANE_TASK = "process_community_jobs"

export type LaneTask = { name: string }

export type ScheduledLanes<T extends LaneTask> = {
  /** Foreground delivery work. Gets its own lease and deadline. */
  community: T[]
  /** Everything else. May defer freely without blocking the community lane. */
  maintenance: T[]
}

export function splitScheduledLanes<T extends LaneTask>(tasks: T[]): ScheduledLanes<T> {
  const community: T[] = []
  const maintenance: T[] = []
  for (const task of tasks) {
    if (task.name === COMMUNITY_JOB_LANE_TASK) {
      community.push(task)
    } else {
      maintenance.push(task)
    }
  }
  return { community, maintenance }
}
