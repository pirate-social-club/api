import { nowIso } from "../../helpers"
import { getControlPlaneClient } from "../../runtime-deps"
import { requiredString } from "../../sql-row"
import { reapStaleMultipartSongArtifactUploads } from "../../song-artifacts/song-artifact-upload-session-service"
import { openCommunityWriteClient } from "../community-read-access"
import type { CommunityJobHandlerInput } from "./handler-types"
import type { CommunityJobRepository } from "./runner-types"
import { enqueueCommunityJob } from "./store"

type SongArtifactSessionReaperReconcileSummary = {
  checked_communities: number
  enqueued_jobs: number
  communities: Array<{ community_id: string; stale_sessions: number }>
}

export async function runSongArtifactSessionReaper(input: CommunityJobHandlerInput): Promise<string | null> {
  const summary = await reapStaleMultipartSongArtifactUploads({
    env: input.env,
    communityId: input.job.community_id,
    limit: 50,
  })
  return `aborted:${summary.aborted}`
}

export async function reconcileStaleSongArtifactUploadSessionJobs(input: {
  env: CommunityJobHandlerInput["env"]
  communityRepository: CommunityJobRepository
  maxCommunities?: number
}): Promise<SongArtifactSessionReaperReconcileSummary> {
  const maxCommunities = Math.max(1, Math.trunc(input.maxCommunities ?? 100))
  const control = getControlPlaneClient(input.env)
  try {
    const result = await control.execute({
      sql: `
        SELECT community_id, COUNT(*) AS stale_sessions
        FROM song_artifact_upload_sessions
        WHERE status IN ('created', 'parts_uploading', 'completing', 'head_verifying', 'aborting')
          AND expires_at < ?1
        GROUP BY community_id
        ORDER BY MIN(expires_at) ASC
        LIMIT ?2
      `,
      args: [nowIso(), maxCommunities],
    })

    const communities: Array<{ community_id: string; stale_sessions: number }> = []
    let enqueuedJobs = 0
    for (const row of result.rows) {
      const communityId = requiredString(row, "community_id")
      const staleSessions = Number(row.stale_sessions ?? 0)
      // Sessions live in the control plane, but execution stays on the per-community
      // job queue so retries and scheduling match the rest of the community jobs.
      const db = await openCommunityWriteClient(input.env, input.communityRepository, communityId)
      try {
        await enqueueCommunityJob({
          client: db.client,
          communityId,
          jobType: "song_artifact_session_reaper",
          subjectType: "song_artifact_upload_sessions",
          subjectId: communityId,
          payloadJson: JSON.stringify({ stale_sessions: staleSessions }),
          createdAt: nowIso(),
        })
        enqueuedJobs += 1
        communities.push({
          community_id: communityId,
          stale_sessions: staleSessions,
        })
      } finally {
        db.close()
      }
    }

    return {
      checked_communities: result.rows.length,
      enqueued_jobs: enqueuedJobs,
      communities,
    }
  } finally {
    control.close?.()
  }
}
