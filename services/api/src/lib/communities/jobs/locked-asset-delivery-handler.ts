import { getUserRepository } from "../../auth/repositories"
import { nowIso } from "../../helpers"
import { logPipelineError } from "../../observability/pipeline-log"
import { requiredString } from "../../sql-row"
import { prepareRequestedLockedAssetDelivery } from "../commerce/service"
import { openCommunityWriteClient } from "../community-read-access"
import type { CommunityJobHandlerInput } from "./handler-types"
import { COMMUNITY_JOB_MAX_ATTEMPTS, type CommunityJobRepository } from "./runner-types"
import { enqueueCommunityJob } from "./store"

type LockedAssetDeliveryReconcileCommunitySummary = {
  community_id: string
  enqueued_jobs: number
}

type LockedAssetDeliveryReconcileCommunityFailureSummary = {
  community_id: string
  error: string
}

type LockedAssetDeliveryReconcileSummary = {
  checked_communities: number
  enqueued_jobs: number
  communities: LockedAssetDeliveryReconcileCommunitySummary[]
  failed_communities: LockedAssetDeliveryReconcileCommunityFailureSummary[]
}

export async function runLockedAssetDeliveryPrepare(input: CommunityJobHandlerInput): Promise<string | null> {
  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.job.community_id)
  try {
    const assetId = input.job.subject_id
    await prepareRequestedLockedAssetDelivery({
      env: input.env,
      client: db.client,
      communityId: input.job.community_id,
      assetId,
      userRepository: getUserRepository(input.env),
      markFailureAsTerminal: input.job.attempt_count >= COMMUNITY_JOB_MAX_ATTEMPTS,
    })
    return assetId
  } finally {
    db.close()
  }
}

export async function reconcileRequestedLockedAssetDeliveryJobs(input: {
  env: CommunityJobHandlerInput["env"]
  communityRepository: CommunityJobRepository
  communityIds?: string[] | null
  maxCommunities?: number
  maxAssetsPerCommunity?: number
}): Promise<LockedAssetDeliveryReconcileSummary> {
  const communityIds = (input.communityIds?.length
    ? input.communityIds
    : (await input.communityRepository.listActiveCommunities({ requireReadyRouting: true })).map((community) => community.community_id))
    .slice(0, Math.max(1, Math.trunc(input.maxCommunities ?? 100)))
  const maxAssetsPerCommunity = Math.max(1, Math.trunc(input.maxAssetsPerCommunity ?? 25))
  const communities: LockedAssetDeliveryReconcileCommunitySummary[] = []
  const failedCommunities: LockedAssetDeliveryReconcileCommunityFailureSummary[] = []

  for (const communityId of communityIds) {
    let db: Awaited<ReturnType<typeof openCommunityWriteClient>> | null = null
    try {
      db = await openCommunityWriteClient(input.env, input.communityRepository, communityId)
      const missingJobs = await db.client.execute({
        sql: `
          SELECT asset_id, source_post_id
          FROM assets
          WHERE access_mode = 'locked'
            AND locked_delivery_status = 'requested'
            AND NOT EXISTS (
              SELECT 1
              FROM community_jobs
              WHERE community_jobs.job_type = 'locked_asset_delivery_prepare'
                AND community_jobs.subject_type = 'asset'
                AND community_jobs.subject_id = assets.asset_id
                AND (
                  community_jobs.status IN ('queued', 'running')
                  OR (
                    community_jobs.status = 'failed'
                    AND community_jobs.attempt_count < ?2
                  )
                )
            )
          ORDER BY created_at ASC, asset_id ASC
          LIMIT ?1
        `,
        args: [maxAssetsPerCommunity, COMMUNITY_JOB_MAX_ATTEMPTS],
      })
      let enqueuedJobs = 0
      for (const row of missingJobs.rows) {
        const assetId = requiredString(row, "asset_id")
        const postId = requiredString(row, "source_post_id")
        await enqueueCommunityJob({
          client: db.client,
          communityId,
          jobType: "locked_asset_delivery_prepare",
          subjectType: "asset",
          subjectId: assetId,
          payloadJson: JSON.stringify({ post_id: postId }),
          createdAt: nowIso(),
        })
        enqueuedJobs += 1
      }
      if (enqueuedJobs > 0) {
        communities.push({
          community_id: communityId,
          enqueued_jobs: enqueuedJobs,
        })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failedCommunities.push({ community_id: communityId, error: message })
      logPipelineError("[community-job] failed to reconcile locked delivery jobs for community", {
        community_id: communityId,
        error: message,
      })
      continue
    } finally {
      await db?.close()
    }
  }

  return {
    checked_communities: communityIds.length,
    enqueued_jobs: communities.reduce((sum, community) => sum + community.enqueued_jobs, 0),
    communities,
    failed_communities: failedCommunities,
  }
}
