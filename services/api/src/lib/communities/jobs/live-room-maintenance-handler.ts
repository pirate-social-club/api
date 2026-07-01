import { openCommunityWriteClient } from "../community-read-access"
import {
  failLiveRoomRecordingAndReplay,
  ingestCapturedLiveRoomRecording,
} from "../live-rooms/service"
import { getHydratedLiveRoom } from "../live-rooms/store"
import { pruneStaleLiveRoomViewerSessions } from "../live-rooms/viewer-sessions"
import type { CommunityJobHandlerInput } from "./handler-types"
import { parseJobPayload } from "./payload"
import { COMMUNITY_JOB_MAX_ATTEMPTS } from "./runner-types"

type LiveRoomViewerSessionsPrunePayload = {
  older_than?: string | null
  max_age_days?: number | null
  limit?: number | null
}

type LiveRoomRecordingIngestPayload = {
  agora_stop_response?: Record<string, unknown> | null
}

function normalizeAgoraStopResponse(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null
  }
  return value as Record<string, unknown>
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

export async function runLiveRoomRecordingIngest(input: CommunityJobHandlerInput): Promise<string | null> {
  const payload = parseJobPayload<LiveRoomRecordingIngestPayload>(input.job.payload_json)
  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.job.community_id)
  try {
    const room = await getHydratedLiveRoom(db.client, input.job.community_id, input.job.subject_id)
    try {
      await ingestCapturedLiveRoomRecording({
        env: input.env,
        client: db.client,
        communityId: input.job.community_id,
        room,
        agoraStopResponse: normalizeAgoraStopResponse(payload?.agora_stop_response),
      })
      return `live_room_recording_ingested:${input.job.subject_id}`
    } catch (error) {
      if (input.job.attempt_count >= COMMUNITY_JOB_MAX_ATTEMPTS) {
        await failLiveRoomRecordingAndReplay({
          client: db.client,
          communityId: input.job.community_id,
          liveRoomId: input.job.subject_id,
          reason: error instanceof Error ? error.message : String(error),
        })
        return `failed:live_room_recording_ingest:${input.job.subject_id}`
      }
      throw error
    }
  } finally {
    db.close()
  }
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
