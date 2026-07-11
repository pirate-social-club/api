import { makeId } from "../../helpers"
import { executeFirst } from "../../db-helpers"
import { rowValue, stringOrNull } from "../../sql-row"
import type { QueryResultRow } from "../../sql-client"
import type { LiveRoomExecutor } from "./store"

type LiveRoomRecordingStatus =
  | "starting"
  | "recording"
  | "stopping"
  | "captured"
  | "ingesting"
  | "failed"

export type LiveRoomRecordingRow = {
  recording_id: string
  community_id: string
  live_room_id: string
  provider: "agora"
  provider_resource_id: string | null
  provider_session_id: string | null
  status: LiveRoomRecordingStatus
  started_at: number | null
  stopped_at: number | null
  raw_artifact_ref: string | null
  failure_reason: string | null
  created_at: string
  updated_at: string
}

export async function recordLiveRoomRecordingStartRequested(input: {
  client: LiveRoomExecutor
  communityId: string
  liveRoomId: string
  createdAt: string
}): Promise<void> {
  await input.client.execute({
    sql: `
      INSERT OR IGNORE INTO live_room_recordings (
        recording_id, community_id, live_room_id, provider, provider_resource_id,
        provider_session_id, status, started_at, stopped_at, raw_artifact_ref,
        failure_reason, created_at, updated_at
      ) VALUES (
        ?1, ?2, ?3, 'agora', NULL,
        NULL, 'starting', NULL, NULL, NULL,
        NULL, ?4, ?4
      )
    `,
    args: [makeId("lrr"), input.communityId, input.liveRoomId, input.createdAt],
  })
}

export async function getLiveRoomRecording(input: {
  client: LiveRoomExecutor
  communityId: string
  liveRoomId: string
}): Promise<LiveRoomRecordingRow | null> {
  const row = await executeFirst(input.client, {
    sql: `
      SELECT recording_id, community_id, live_room_id, provider, provider_resource_id,
             provider_session_id, status, started_at, stopped_at, raw_artifact_ref,
             failure_reason, created_at, updated_at
      FROM live_room_recordings
      WHERE community_id = ?1
        AND live_room_id = ?2
      LIMIT 1
    `,
    args: [input.communityId, input.liveRoomId],
  })
  return row ? rowToRecording(row as QueryResultRow) : null
}

export async function markLiveRoomRecordingStarted(input: {
  client: LiveRoomExecutor
  communityId: string
  liveRoomId: string
  resourceId: string
  sessionId: string
  startedAt: number
  updatedAt: string
}): Promise<LiveRoomRecordingRow | null> {
  await input.client.execute({
    sql: `
      UPDATE live_room_recordings
      SET status = CASE WHEN status = 'starting' THEN 'recording' ELSE status END,
          provider_resource_id = ?3,
          provider_session_id = ?4,
          started_at = ?5,
          failure_reason = NULL,
          updated_at = ?6
      WHERE community_id = ?1
        AND live_room_id = ?2
        AND status IN ('starting', 'stopping')
    `,
    args: [input.communityId, input.liveRoomId, input.resourceId, input.sessionId, input.startedAt, input.updatedAt],
  })
  return await getLiveRoomRecording({
    client: input.client,
    communityId: input.communityId,
    liveRoomId: input.liveRoomId,
  })
}

export async function markLiveRoomRecordingFailed(input: {
  client: LiveRoomExecutor
  communityId: string
  liveRoomId: string
  failureReason: string
  updatedAt: string
}): Promise<void> {
  await input.client.execute({
    sql: `
      UPDATE live_room_recordings
      SET status = 'failed',
          failure_reason = ?3,
          updated_at = ?4
      WHERE community_id = ?1
        AND live_room_id = ?2
        AND status IN ('starting', 'recording', 'stopping', 'captured', 'ingesting')
    `,
    args: [input.communityId, input.liveRoomId, input.failureReason.slice(0, 512), input.updatedAt],
  })
}

export async function markLiveRoomRecordingStopRequested(input: {
  client: LiveRoomExecutor
  communityId: string
  liveRoomId: string
  stoppedAt: number
  updatedAt: string
}): Promise<void> {
  await input.client.execute({
    sql: `
      UPDATE live_room_recordings
      SET status = 'stopping',
          stopped_at = ?3,
          updated_at = ?4
      WHERE community_id = ?1
        AND live_room_id = ?2
        AND status IN ('starting', 'recording')
    `,
    args: [input.communityId, input.liveRoomId, input.stoppedAt, input.updatedAt],
  })
}

export async function markLiveRoomRecordingCaptured(input: {
  client: LiveRoomExecutor
  communityId: string
  liveRoomId: string
  stoppedAt: number
  updatedAt: string
}): Promise<void> {
  await input.client.execute({
    sql: `
      UPDATE live_room_recordings
      SET status = 'captured',
          stopped_at = ?3,
          updated_at = ?4
      WHERE community_id = ?1
        AND live_room_id = ?2
        AND status = 'stopping'
    `,
    args: [input.communityId, input.liveRoomId, input.stoppedAt, input.updatedAt],
  })
}

export async function markLiveRoomRecordingIngesting(input: {
  client: LiveRoomExecutor
  communityId: string
  liveRoomId: string
  updatedAt: string
}): Promise<void> {
  await input.client.execute({
    sql: `
      UPDATE live_room_recordings
      SET status = 'ingesting',
          updated_at = ?3
      WHERE community_id = ?1
        AND live_room_id = ?2
        AND status = 'captured'
        AND raw_artifact_ref IS NULL
    `,
    args: [input.communityId, input.liveRoomId, input.updatedAt],
  })
}

export async function markLiveRoomRecordingIngested(input: {
  client: LiveRoomExecutor
  communityId: string
  liveRoomId: string
  rawArtifactRef: string
  updatedAt: string
}): Promise<void> {
  await input.client.execute({
    sql: `
      UPDATE live_room_recordings
      SET status = 'captured',
          raw_artifact_ref = ?3,
          failure_reason = NULL,
          updated_at = ?4
      WHERE community_id = ?1
        AND live_room_id = ?2
        AND status = 'ingesting'
    `,
    args: [input.communityId, input.liveRoomId, input.rawArtifactRef, input.updatedAt],
  })
}

function rowToRecording(row: QueryResultRow): LiveRoomRecordingRow {
  return {
    recording_id: String(rowValue(row, "recording_id")),
    community_id: String(rowValue(row, "community_id")),
    live_room_id: String(rowValue(row, "live_room_id")),
    provider: "agora",
    provider_resource_id: stringOrNull(rowValue(row, "provider_resource_id")),
    provider_session_id: stringOrNull(rowValue(row, "provider_session_id")),
    status: String(rowValue(row, "status")) as LiveRoomRecordingStatus,
    started_at: numberOrNull(rowValue(row, "started_at")),
    stopped_at: numberOrNull(rowValue(row, "stopped_at")),
    raw_artifact_ref: stringOrNull(rowValue(row, "raw_artifact_ref")),
    failure_reason: stringOrNull(rowValue(row, "failure_reason")),
    created_at: String(rowValue(row, "created_at")),
    updated_at: String(rowValue(row, "updated_at")),
  }
}

function numberOrNull(value: unknown): number | null {
  if (value == null || value === "") {
    return null
  }
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}
