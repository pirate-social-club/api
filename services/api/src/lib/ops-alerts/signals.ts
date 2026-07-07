import type { ReadClient } from "../sql-client"
import type { CommunityPublishAlertSignals, PublishFailureCount } from "./types"
import { OPS_ACTIONABLE_FAILURE_CODES } from "./types"

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

  return {
    community_id: input.communityId,
    failure_codes,
    terminal_failed_finalize_jobs: Number(deadJobsResult.rows[0]?.count ?? 0),
  }
}
