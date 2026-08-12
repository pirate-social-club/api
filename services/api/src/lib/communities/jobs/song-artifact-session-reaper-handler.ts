import { nowIso } from "../../helpers"
import { logPipelineError } from "../../observability/pipeline-log"
import { getControlPlaneClient } from "../../runtime-deps"
import { requiredString } from "../../sql-row"
import { reapStaleMultipartSongArtifactUploads } from "../../song-artifacts/song-artifact-upload-session-service"
import { openCommunityWriteClient } from "../community-read-access"
import type { CommunityJobHandlerInput } from "./handler-types"
import { rotateCommunityJobTickIds } from "./tick-rotation"
import type { CommunityJobRepository } from "./runner-types"
import { enqueueCommunityJob } from "./store"

type SongArtifactSessionReaperReconcileSummary = {
  checked_communities: number
  /** Selected communities left unscanned because the prelude deadline passed. */
  deferred_communities: number
  enqueued_jobs: number
  /** Wall time spent scanning communities. */
  reconcile_ms: number
  communities: Array<{ community_id: string; stale_sessions: number }>
  failed_communities: Array<{ community_id: string; error: string }>
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
  deadlineAtMs?: number | null
  nowMs?: () => number
}): Promise<SongArtifactSessionReaperReconcileSummary> {
  const maxCommunities = Math.max(1, Math.trunc(input.maxCommunities ?? 100))
  const nowMs = input.nowMs ?? (() => Date.now())
  const startedAtMs = nowMs()
  const control = getControlPlaneClient(input.env)
  try {
    const result = await control.execute({
      sql: `
        SELECT s.community_id, COUNT(*) AS stale_sessions
        FROM song_artifact_upload_sessions s
        INNER JOIN communities c
          ON c.community_id = s.community_id
         AND c.status = 'active'
         AND c.provisioning_state = 'active'
        INNER JOIN community_database_routing r
          ON r.community_id = s.community_id
         AND r.provisioning_state = 'ready'
         AND r.decommissioned_at IS NULL
        WHERE s.status IN ('created', 'parts_uploading', 'completing', 'head_verifying', 'aborting')
          AND s.expires_at < ?1
        GROUP BY s.community_id
        ORDER BY MIN(s.expires_at) ASC
        LIMIT ?2
      `,
      args: [nowIso(), maxCommunities],
    })

    const rowsByCommunityId = new Map(
      result.rows.map((row) => [requiredString(row, "community_id"), row] as const),
    )
    // Rotate the fixed stalest-first order so a deadline-truncated tick resumes
    // where the last one stopped instead of starving the same tail.
    const communityIds = rotateCommunityJobTickIds([...rowsByCommunityId.keys()], startedAtMs)
    const communities: Array<{ community_id: string; stale_sessions: number }> = []
    const failedCommunities: Array<{ community_id: string; error: string }> = []
    let enqueuedJobs = 0
    let checkedCommunities = 0
    for (const communityId of communityIds) {
      // The prelude deadline stops this tick from scanning more communities; it
      // never interrupts one already open.
      if (input.deadlineAtMs != null && nowMs() >= input.deadlineAtMs) {
        console.warn("[community-job] song artifact session reaper deadline reached", JSON.stringify({
          checked_communities: checkedCommunities,
          deferred_communities: communityIds.length - checkedCommunities,
        }))
        break
      }
      checkedCommunities += 1
      const row = rowsByCommunityId.get(communityId)!
      const staleSessions = Number(row.stale_sessions ?? 0)
      // Sessions live in the control plane, but execution stays on the per-community
      // job queue so retries and scheduling match the rest of the community jobs.
      let db: Awaited<ReturnType<typeof openCommunityWriteClient>> | null = null
      try {
        db = await openCommunityWriteClient(input.env, input.communityRepository, communityId)
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
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        failedCommunities.push({ community_id: communityId, error: message })
        logPipelineError("[community-job] failed to reconcile stale song artifact sessions for community", {
          community_id: communityId,
          error: message,
        })
        continue
      } finally {
        await db?.close()
      }
    }

    return {
      checked_communities: checkedCommunities,
      deferred_communities: communityIds.length - checkedCommunities,
      enqueued_jobs: enqueuedJobs,
      reconcile_ms: Math.max(0, nowMs() - startedAtMs),
      communities,
      failed_communities: failedCommunities,
    }
  } finally {
    control.close?.()
  }
}
