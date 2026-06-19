import { openCommunityWriteClient } from "../community-read-access"
import { pruneStaleLiveRoomViewerSessions } from "../live-rooms/viewer-sessions"
import type { CommunityJobHandlerInput } from "./handler-types"
import { parseJobPayload } from "./payload"

type LiveRoomViewerSessionsPrunePayload = {
  older_than?: string | null
  max_age_days?: number | null
  limit?: number | null
}

function normalizeLiveRoomViewerSessionPruneLimit(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return 1000
  }
  return Math.min(parsed, 10_000)
}

function resolveLiveRoomViewerSessionPruneCutoff(payload: LiveRoomViewerSessionsPrunePayload | null): string {
  if (payload?.older_than) {
    const olderThanMillis = Date.parse(payload.older_than)
    if (Number.isFinite(olderThanMillis)) {
      return new Date(olderThanMillis).toISOString()
    }
  }
  const parsedDays = Number(payload?.max_age_days ?? 30)
  const maxAgeDays = Number.isInteger(parsedDays) && parsedDays > 0 ? Math.min(parsedDays, 365) : 30
  return new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString()
}

export async function runLiveRoomViewerSessionsPrune(input: CommunityJobHandlerInput): Promise<string | null> {
  const payload = parseJobPayload<LiveRoomViewerSessionsPrunePayload>(input.job.payload_json)
  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.job.community_id)
  try {
    const prunedCount = await pruneStaleLiveRoomViewerSessions(db.client, {
      communityId: input.job.community_id,
      olderThanIso: resolveLiveRoomViewerSessionPruneCutoff(payload),
      limit: normalizeLiveRoomViewerSessionPruneLimit(payload?.limit),
    })
    return `pruned:${prunedCount}`
  } finally {
    db.close()
  }
}
