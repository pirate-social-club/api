import type { ReadClient } from "../sql-client"
import type {
  CommunityPublishAlertSignals,
  PublishFailureCount,
  RetriedLockedDeliveryJobSample,
  StaleLockedDeliveryAssetSample,
  StuckRoyaltyProjectionSample,
} from "./types"
import { OPS_ACTIONABLE_FAILURE_CODES } from "./types"

const SAMPLE_LIMIT = 5

export async function collectCommunityPublishAlertSignals(input: {
  client: ReadClient
  communityId: string
  since: string
}): Promise<CommunityPublishAlertSignals> {
  const failuresResult = await input.client.execute({
    sql: `
      SELECT publish_failure_code AS code, COUNT(*) AS count
      FROM posts
      WHERE status = 'failed'
        AND publish_failed_at IS NOT NULL
        AND publish_failed_at >= ?1
        AND publish_failure_code IS NOT NULL
      GROUP BY publish_failure_code
    `,
    args: [input.since],
  })

  const failure_codes: PublishFailureCount[] = failuresResult.rows
    .map((row) => ({ code: String(row.code ?? ""), count: Number(row.count ?? 0) }))
    .filter((row) => row.count > 0 && OPS_ACTIONABLE_FAILURE_CODES.has(row.code))

  const deadJobsResult = await input.client.execute({
    sql: `
      SELECT COUNT(*) AS count
      FROM community_jobs
      WHERE job_type = 'post_publish_finalize'
        AND status = 'failed'
        AND available_at IS NULL
        AND updated_at >= ?1
    `,
    args: [input.since],
  })

  const stuckRoyaltyProjectionResult = await input.client.execute({
    sql: `
      SELECT COUNT(*) AS count
      FROM assets
      WHERE royalty_allocation_status = 'verified'
        AND royalty_allocation_projection_synced = 0
        AND updated_at <= ?1
    `,
    args: [input.since],
  })
  const stuckRoyaltyProjectionSamplesResult = await input.client.execute({
    sql: `
      SELECT asset_id, royalty_allocation_status, updated_at
      FROM assets
      WHERE royalty_allocation_status = 'verified'
        AND royalty_allocation_projection_synced = 0
        AND updated_at <= ?1
      ORDER BY updated_at ASC
      LIMIT ${SAMPLE_LIMIT}
    `,
    args: [input.since],
  })
  const stuck_royalty_allocation_projection_samples: StuckRoyaltyProjectionSample[] =
    stuckRoyaltyProjectionSamplesResult.rows.map((row) => ({
      asset_id: String(row.asset_id ?? ""),
      royalty_allocation_status: String(row.royalty_allocation_status ?? ""),
      updated_at: typeof row.updated_at === "string" ? row.updated_at : null,
    }))

  const staleLockedDeliveryResult = await input.client.execute({
    sql: `
      SELECT COUNT(*) AS count
      FROM assets
      WHERE locked_delivery_status = 'requested'
        AND updated_at <= ?1
    `,
    args: [input.since],
  })
  const staleLockedDeliverySamplesResult = await input.client.execute({
    sql: `
      SELECT asset_id, locked_delivery_status, updated_at
      FROM assets
      WHERE locked_delivery_status = 'requested'
        AND updated_at <= ?1
      ORDER BY updated_at ASC
      LIMIT ${SAMPLE_LIMIT}
    `,
    args: [input.since],
  })
  const stale_locked_delivery_asset_samples: StaleLockedDeliveryAssetSample[] =
    staleLockedDeliverySamplesResult.rows.map((row) => ({
      asset_id: String(row.asset_id ?? ""),
      locked_delivery_status: String(row.locked_delivery_status ?? ""),
      updated_at: typeof row.updated_at === "string" ? row.updated_at : null,
    }))

  const retriedLockedDeliveryJobsResult = await input.client.execute({
    sql: `
      SELECT COUNT(*) AS count
      FROM community_jobs
      WHERE job_type = 'locked_asset_delivery_prepare'
        AND attempt_count > 1
        AND updated_at >= ?1
    `,
    args: [input.since],
  })
  const retriedLockedDeliveryJobSamplesResult = await input.client.execute({
    sql: `
      SELECT job_id, subject_id, status, attempt_count, last_checkpoint, updated_at
      FROM community_jobs
      WHERE job_type = 'locked_asset_delivery_prepare'
        AND attempt_count > 1
        AND updated_at >= ?1
      ORDER BY updated_at DESC
      LIMIT ${SAMPLE_LIMIT}
    `,
    args: [input.since],
  })
  const retried_locked_delivery_job_samples: RetriedLockedDeliveryJobSample[] =
    retriedLockedDeliveryJobSamplesResult.rows.map((row) => ({
      job_id: String(row.job_id ?? ""),
      asset_id: String(row.subject_id ?? ""),
      status: String(row.status ?? ""),
      attempt_count: Number(row.attempt_count ?? 0),
      last_checkpoint: typeof row.last_checkpoint === "string" ? row.last_checkpoint : null,
      updated_at: typeof row.updated_at === "string" ? row.updated_at : null,
    }))

  return {
    community_id: input.communityId,
    failure_codes,
    terminal_failed_finalize_jobs: Number(deadJobsResult.rows[0]?.count ?? 0),
    stuck_royalty_allocation_projections: Number(stuckRoyaltyProjectionResult.rows[0]?.count ?? 0),
    stuck_royalty_allocation_projection_samples,
    stale_locked_delivery_assets: Number(staleLockedDeliveryResult.rows[0]?.count ?? 0),
    stale_locked_delivery_asset_samples,
    retried_locked_delivery_jobs: Number(retriedLockedDeliveryJobsResult.rows[0]?.count ?? 0),
    retried_locked_delivery_job_samples,
  }
}
