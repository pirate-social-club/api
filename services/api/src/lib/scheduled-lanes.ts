/**
 * Scheduler lane split.
 *
 * Community jobs are foreground delivery work — the retry engine behind every
 * community job, including Telegram channel publishing. EFP scans and follow
 * reconciliation have a separate freshness contract: the product fails closed
 * when any expected chain is more than 15 minutes old. Maintenance (reward
 * reconciles, monitors, observers) is slower and cares only about eventually
 * running. Sharing one lease let the slow side gate both user-visible lanes.
 *
 * The split is by name rather than by a flag on each task so there is exactly
 * one place that decides what counts as foreground work.
 */

export const COMMUNITY_JOB_LANE_TASK = "process_community_jobs"
export const EFP_LANE_TASKS = [
  "scan_efp_base",
  "scan_efp_optimism",
  "scan_efp_ethereum",
  "reconcile_efp_follow_writes",
] as const

const EFP_LANE_TASK_NAMES = new Set<string>(EFP_LANE_TASKS)

export type LaneTask = { name: string }

export type ScheduledLanes<T extends LaneTask> = {
  /** Foreground delivery work. Gets its own lease and deadline. */
  community: T[]
  /** Follow-graph freshness and confirmed-write reconciliation. */
  efp: T[]
  /** Everything else. May defer freely without blocking the community lane. */
  maintenance: T[]
}

export function splitScheduledLanes<T extends LaneTask>(tasks: T[]): ScheduledLanes<T> {
  const community: T[] = []
  const efp: T[] = []
  const maintenance: T[] = []
  for (const task of tasks) {
    if (task.name === COMMUNITY_JOB_LANE_TASK) {
      community.push(task)
    } else if (EFP_LANE_TASK_NAMES.has(task.name)) {
      efp.push(task)
    } else {
      maintenance.push(task)
    }
  }
  return { community, efp, maintenance }
}
