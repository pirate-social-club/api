import { getUserRepository } from "../../auth/repositories"
import { nowIso } from "../../helpers"
import { logPipelineError } from "../../observability/pipeline-log"
import { requiredString } from "../../sql-row"
import { prepareRequestedLockedAssetDelivery } from "../commerce/service"
import { openCommunityDb } from "../community-db-factory"
import type { CommunityJobHandlerInput } from "./handler-types"
import { COMMUNITY_JOB_MAX_ATTEMPTS, type CommunityJobRepository } from "./runner-types"
import { enqueueCommunityJob, resetStaleRunningCommunityJobs } from "./store"

const LOCKED_DELIVERY_STALE_RUNNING_JOB_TIMEOUT_MS = 15 * 60 * 1000

type LockedAssetDeliveryReconcileCommunitySummary = {
  community_id: string
  enqueued_jobs: number
  stale_running_jobs: number
}

type LockedAssetDeliveryReconcileCommunityFailureSummary = {
  community_id: string
  error: string
}

type LockedAssetDeliveryReconcileSummary = {
  checked_communities: number
  enqueued_jobs: number
  stale_running_jobs: number
  communities: LockedAssetDeliveryReconcileCommunitySummary[]
  failed_communities: LockedAssetDeliveryReconcileCommunityFailureSummary[]
}

function formatLockedAssetDeliveryReconcileError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function createdAtMs(community: { created_at?: string | null }): number {
  const parsed = Date.parse(community.created_at ?? "")
  return Number.isFinite(parsed) ? parsed : 0
}

function selectLockedDeliveryReconcileCommunityIds(
  communities: Array<{ community_id: string; created_at?: string | null }>,
  maxCommunities: number,
): string[] {
  if (communities.length <= maxCommunities) {
    return communities.map((community) => community.community_id)
  }

  const recentCount = Math.max(1, Math.min(maxCommunities, Math.ceil(maxCommunities / 4)))
  const newest = communities
    .slice()
    .sort((left, right) => {
      const createdDiff = createdAtMs(right) - createdAtMs(left)
      return createdDiff !== 0 ? createdDiff : right.community_id.localeCompare(left.community_id)
    })
    .slice(0, recentCount)

  const selected = new Set(newest.map((community) => community.community_id))
  const remaining = communities.filter((community) => !selected.has(community.community_id))
  const rotatingCount = maxCommunities - selected.size
  if (rotatingCount <= 0 || remaining.length === 0) {
    return Array.from(selected)
  }

  const minuteBucket = Math.floor(Date.now() / 60_000)
  const start = (minuteBucket * rotatingCount) % remaining.length
  for (let index = 0; index < rotatingCount && index < remaining.length; index += 1) {
    selected.add(remaining[(start + index) % remaining.length]!.community_id)
  }

  return Array.from(selected)
}

export async function runLockedAssetDeliveryPrepare(input: CommunityJobHandlerInput): Promise<string | null> {
  const db = await openCommunityDb(input.env, input.communityRepository, input.job.community_id)
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
  const maxCommunities = Math.max(1, Math.trunc(input.maxCommunities ?? 100))
  const communityIds = input.communityIds?.length
    ? input.communityIds
    : selectLockedDeliveryReconcileCommunityIds(
      await input.communityRepository.listActiveCommunities(),
      maxCommunities,
    )
  const scopedCommunityIds = communityIds.slice(0, maxCommunities)
  const maxAssetsPerCommunity = Math.max(1, Math.trunc(input.maxAssetsPerCommunity ?? 25))
  const communities: LockedAssetDeliveryReconcileCommunitySummary[] = []
  const failedCommunities: LockedAssetDeliveryReconcileCommunityFailureSummary[] = []

  for (const communityId of scopedCommunityIds) {
    let db: Awaited<ReturnType<typeof openCommunityDb>> | null = null
    try {
      db = await openCommunityDb(input.env, input.communityRepository, communityId)
      const now = nowIso()
      const staleRunningJobs = await resetStaleRunningCommunityJobs({
        client: db.client,
        communityId,
        now,
        staleBefore: new Date(Date.parse(now) - LOCKED_DELIVERY_STALE_RUNNING_JOB_TIMEOUT_MS).toISOString(),
      })
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
      if (enqueuedJobs > 0 || staleRunningJobs > 0) {
        communities.push({
          community_id: communityId,
          enqueued_jobs: enqueuedJobs,
          stale_running_jobs: staleRunningJobs,
        })
      }
    } catch (error) {
      const message = formatLockedAssetDeliveryReconcileError(error)
      failedCommunities.push({
        community_id: communityId,
        error: message,
      })
      logPipelineError("[community-jobs] locked delivery reconciliation community failed", {
        community_id: communityId,
        error: message,
      })
    } finally {
      db?.close()
    }
  }

  return {
    checked_communities: scopedCommunityIds.length,
    enqueued_jobs: communities.reduce((sum, community) => sum + community.enqueued_jobs, 0),
    stale_running_jobs: communities.reduce((sum, community) => sum + community.stale_running_jobs, 0),
    communities,
    failed_communities: failedCommunities,
  }
}
