import { openControlPlaneDatabase } from "./control-plane-db";
import { nowIso, requirePositiveInt, requireText } from "./helpers";
import type {
  ReapStaleCommunityProvisioningInput,
  ReapStaleCommunityProvisioningResult,
  ReapedCommunityProvisioningJob,
} from "./types";

export async function reapStaleCommunityProvisioningJobs(
  input: ReapStaleCommunityProvisioningInput,
): Promise<ReapStaleCommunityProvisioningResult> {
  const controlPlaneDatabaseUrl = requireText(input.controlPlaneDatabaseUrl, "controlPlaneDatabaseUrl");
  const controlPlaneAuthToken = input.controlPlaneAuthToken?.trim() || null;
  const staleAfterMs = requirePositiveInt(input.staleAfterMs ?? 15 * 60 * 1000, "staleAfterMs");
  const cutoff = nowIso(new Date((input.now ?? new Date()).getTime() - staleAfterMs));
  const reapedAt = nowIso(input.now ?? new Date());
  const db = openControlPlaneDatabase({
    url: controlPlaneDatabaseUrl,
    authToken: controlPlaneAuthToken,
  });

  try {
    const staleRows = await db.sql<Array<{
      job_id: string;
      community_id: string;
      updated_at: string;
    }>>`
      SELECT j.job_id, j.community_id, j.updated_at
      FROM jobs AS j
      WHERE j.job_type = 'community_provisioning'
        AND j.status = 'running'
        AND j.updated_at < ${cutoff}
        AND NOT EXISTS (
          SELECT 1
          FROM community_database_bindings AS cdb
          INNER JOIN community_db_credentials AS cdc
            ON cdc.community_database_binding_id = cdb.community_database_binding_id
           AND cdc.status = 'active'
          WHERE cdb.community_id = j.community_id
            AND cdb.binding_role = 'primary'
            AND cdb.status = 'active'
          LIMIT 1
        )
      ORDER BY j.updated_at ASC
    `;

    const reapedJobs: ReapedCommunityProvisioningJob[] = [];
    await db.begin(async (tx) => {
      for (const row of staleRows) {
        await tx.sql`
          UPDATE jobs
          SET status = 'failed',
              error_code = 'job_stale_timeout',
              result_ref = NULL,
              updated_at = ${reapedAt}
          WHERE job_id = ${row.job_id}
            AND status = 'running'
        `;
        await tx.sql`
          UPDATE communities
          SET provisioning_state = 'error',
              updated_at = ${reapedAt}
          WHERE community_id = ${row.community_id}
            AND provisioning_state = 'provisioning'
            AND NOT EXISTS (
              SELECT 1
              FROM community_database_bindings AS cdb
              INNER JOIN community_db_credentials AS cdc
                ON cdc.community_database_binding_id = cdb.community_database_binding_id
               AND cdc.status = 'active'
              WHERE cdb.community_id = ${row.community_id}
                AND cdb.binding_role = 'primary'
                AND cdb.status = 'active'
              LIMIT 1
            )
        `;
        reapedJobs.push({
          jobId: row.job_id,
          communityId: row.community_id,
          updatedAt: row.updated_at,
        });
      }
    });

    for (const job of reapedJobs) {
      console.warn("[community-provision] reaped stale job", JSON.stringify({
        job_id: job.jobId,
        community_id: job.communityId,
        updated_at: job.updatedAt,
        cutoff,
      }));
    }

    return {
      cutoff,
      staleAfterMs,
      reapedJobs,
      reapedJobCount: reapedJobs.length,
    };
  } finally {
    await db.close();
  }
}
