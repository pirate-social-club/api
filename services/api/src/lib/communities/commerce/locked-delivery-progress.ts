import type { Env } from "../../../types"
import type { CommunityJobCheckpoint } from "../jobs/store"

export type LockedDeliveryProgressReporter = (
  checkpoint: CommunityJobCheckpoint,
  details?: Record<string, unknown> | null,
) => Promise<void>

function resolveLockedDeliveryHeartbeatIntervalMs(
  env: Pick<Env, "COMMUNITY_JOB_HEARTBEAT_INTERVAL_MS">,
): number {
  const raw = String(env.COMMUNITY_JOB_HEARTBEAT_INTERVAL_MS || "").trim()
  const parsed = raw ? Number(raw) : 30_000
  return Number.isInteger(parsed) && parsed >= 5_000 && parsed <= 120_000 ? parsed : 30_000
}

export async function recordLockedDeliveryProgress(
  progress: LockedDeliveryProgressReporter | null | undefined,
  checkpoint: CommunityJobCheckpoint,
  details?: Record<string, unknown> | null,
): Promise<void> {
  await progress?.(checkpoint, details ?? null)
}

export async function withLockedDeliveryProgressHeartbeat<T>(input: {
  env: Env
  progress?: LockedDeliveryProgressReporter | null
  checkpoint: CommunityJobCheckpoint
  heartbeatCheckpoint?: CommunityJobCheckpoint
  details?: Record<string, unknown> | null
  operation: () => Promise<T>
}): Promise<T> {
  await recordLockedDeliveryProgress(input.progress, input.checkpoint, input.details ?? null)
  const intervalMs = resolveLockedDeliveryHeartbeatIntervalMs(input.env)
  let timer: ReturnType<typeof setInterval> | null = null
  if (input.progress) {
    timer = setInterval(() => {
      void recordLockedDeliveryProgress(
        input.progress,
        input.heartbeatCheckpoint ?? input.checkpoint,
        input.details ?? null,
      ).catch((error) => {
        console.warn("[community-job] locked delivery heartbeat failed", {
          checkpoint: input.heartbeatCheckpoint ?? input.checkpoint,
          error: error instanceof Error ? error.message : String(error),
        })
      })
    }, intervalMs)
  }
  try {
    return await input.operation()
  } finally {
    if (timer) clearInterval(timer)
  }
}
