import type { Client } from "../sql-client"
import { internalError } from "../errors"
import { makeId } from "../helpers"
import {
  getCommunityRegistryAttemptRowById,
  getCommunityRowById,
  getJobRowById,
  getLatestCommunityRegistryPublicationJobRow,
  listActiveWalletAttachmentRows,
} from "../auth/auth-db-queries"
import type {
  CommunityRegistryAttemptRow,
  CommunityRow,
  JobRow,
} from "../auth/auth-db-rows"

async function resolveRegistryAttemptWalletSnapshot(
  client: Client,
  actorUserId: string,
  actorPrimaryWalletSnapshot: string | null | undefined,
): Promise<string | null> {
  if (actorPrimaryWalletSnapshot !== undefined) {
    return actorPrimaryWalletSnapshot
  }

  const walletRows = await listActiveWalletAttachmentRows(client, actorUserId)
  const primaryWallet = walletRows.find((row) => row.is_primary === 1) ?? walletRows[0] ?? null
  return primaryWallet?.wallet_address_display ?? null
}

export async function createCommunityRegistryAttempt(
  client: Client,
  input: {
    registryAttemptId: string
    actorUserId: string
    actorPrimaryWalletSnapshot: string | null
    actorGovernanceAddressSnapshot: string | null
    namespaceVerificationId: string
    normalizedRootLabel: string
    createdAt: string
  },
): Promise<CommunityRegistryAttemptRow> {
  const actorPrimaryWalletSnapshot = await resolveRegistryAttemptWalletSnapshot(
    client,
    input.actorUserId,
    input.actorPrimaryWalletSnapshot,
  )

  await client.execute({
    sql: `
      INSERT INTO community_registry_attempts (
        registry_attempt_id, actor_user_id, actor_primary_wallet_snapshot, actor_governance_address_snapshot,
        namespace_verification_id, normalized_root_label, community_id, attempt_status, failure_code,
        created_at, updated_at
      ) VALUES (
        ?1, ?2, ?3, ?4,
        ?5, ?6, NULL, 'in_progress', NULL,
        ?7, ?7
      )
    `,
    args: [
      input.registryAttemptId,
      input.actorUserId,
      actorPrimaryWalletSnapshot,
      input.actorGovernanceAddressSnapshot,
      input.namespaceVerificationId,
      input.normalizedRootLabel,
      input.createdAt,
    ],
  })

  const row = await getCommunityRegistryAttemptRowById(client, input.registryAttemptId)
  if (!row) {
    throw internalError("Community registry attempt row is missing after insert")
  }
  return row
}

export async function markCommunityRegistryAttemptFailed(
  client: Client,
  input: {
    registryAttemptId: string
    failureCode: string
    updatedAt: string
  },
): Promise<void> {
  await client.execute({
    sql: `
      UPDATE community_registry_attempts
      SET attempt_status = 'failed',
          failure_code = ?2,
          updated_at = ?3
      WHERE registry_attempt_id = ?1
    `,
    args: [input.registryAttemptId, input.failureCode, input.updatedAt],
  })
}

export async function createCommunityRegistryPublicationRequest(
  client: Client,
  input: {
    communityId: string
    registryAttemptId: string
    jobId: string
    createdAt: string
  },
): Promise<JobRow> {
  const tx = await client.transaction("write")

  try {
    const latestJob = await getLatestCommunityRegistryPublicationJobRow(tx, input.communityId)
    const attemptCount = (latestJob?.attempt_count ?? 0) + 1

    await tx.execute({
      sql: `
        UPDATE communities
        SET registry_publication_state = 'pending_seed',
            registry_publication_job_id = ?2,
            registry_error_code = NULL,
            updated_at = ?3
        WHERE community_id = ?1
      `,
      args: [input.communityId, input.jobId, input.createdAt],
    })

    await tx.execute({
      sql: `
        INSERT INTO jobs (
          job_id, job_type, job_scope, community_id, subject_type, subject_id, status, payload_json,
          result_ref, error_code, attempt_count, available_at, created_at, updated_at
        ) VALUES (
          ?1, 'community_registry_publication', 'platform', ?2, 'community', ?2, 'running', ?3,
          NULL, NULL, ?4, ?5, ?5, ?5
        )
      `,
      args: [
        input.jobId,
        input.communityId,
        JSON.stringify({
          registry_attempt_id: input.registryAttemptId,
          mode: "local_stub",
        }),
        attemptCount,
        input.createdAt,
      ],
    })

    const jobRow = await getJobRowById(tx, input.jobId)
    if (!jobRow) {
      throw internalError("Community registry publication job is missing after insert")
    }

    await tx.commit()
    return jobRow
  } catch (error) {
    try {
      await tx.rollback()
    } catch {}
    throw error
  } finally {
    tx.close()
  }
}

export async function markCommunityRegistryPublicationSucceeded(
  client: Client,
  input: {
    communityId: string
    registryAttemptId: string
    jobId: string
    actorUserId: string
    resultRef: string | null
    createdAt: string
    metadata: Record<string, unknown>
  },
): Promise<{
    community: CommunityRow
    job: JobRow
  }> {
  const tx = await client.transaction("write")
  const auditEventId = makeId("aud")

  try {
    await tx.batch([
      {
        sql: `
          UPDATE communities
          SET registry_publication_state = 'published',
              registry_published_at = ?2,
              registry_publication_job_id = ?3,
              registry_error_code = NULL,
              updated_at = ?2
          WHERE community_id = ?1
        `,
        args: [input.communityId, input.createdAt, input.jobId],
      },
      {
        sql: `
          UPDATE community_registry_attempts
          SET community_id = ?2,
              attempt_status = 'succeeded',
              failure_code = NULL,
              updated_at = ?3
          WHERE registry_attempt_id = ?1
        `,
        args: [input.registryAttemptId, input.communityId, input.createdAt],
      },
      {
        sql: `
          UPDATE jobs
          SET status = 'succeeded',
              result_ref = ?2,
              error_code = NULL,
              updated_at = ?3
          WHERE job_id = ?1
        `,
        args: [input.jobId, input.resultRef, input.createdAt],
      },
      {
        sql: `
          INSERT INTO audit_log (
            audit_event_id, actor_type, actor_id, action, target_type, target_id, community_id, metadata_json, created_at
          ) VALUES (
            ?1, 'user', ?2, 'community.registry_publication_succeeded', 'community', ?3, ?3, ?4, ?5
          )
        `,
        args: [auditEventId, input.actorUserId, input.communityId, JSON.stringify(input.metadata), input.createdAt],
      },
    ])

    const communityRow = await getCommunityRowById(tx, input.communityId)
    const jobRow = await getJobRowById(tx, input.jobId)
    if (!communityRow || !jobRow) {
      throw internalError("Registry publication success rows are missing after update")
    }

    await tx.commit()
    return { community: communityRow, job: jobRow }
  } catch (error) {
    try {
      await tx.rollback()
    } catch {}
    throw error
  } finally {
    tx.close()
  }
}

export async function markCommunityRegistryPublicationFailed(
  client: Client,
  input: {
    communityId: string
    registryAttemptId: string
    jobId: string | null
    actorUserId: string
    errorCode: string
    createdAt: string
    metadata: Record<string, unknown>
  },
): Promise<void> {
  const tx = await client.transaction("write")
  const auditEventId = makeId("aud")

  try {
    await tx.execute({
      sql: `
        UPDATE communities
        SET registry_publication_state = 'publication_error',
            registry_publication_job_id = ?2,
            registry_error_code = ?3,
            updated_at = ?4
        WHERE community_id = ?1
      `,
      args: [input.communityId, input.jobId, input.errorCode, input.createdAt],
    })

    await tx.execute({
      sql: `
        UPDATE community_registry_attempts
        SET community_id = ?2,
            attempt_status = 'failed',
            failure_code = ?3,
            updated_at = ?4
        WHERE registry_attempt_id = ?1
      `,
      args: [input.registryAttemptId, input.communityId, input.errorCode, input.createdAt],
    })

    if (input.jobId) {
      await tx.execute({
        sql: `
          UPDATE jobs
          SET status = 'failed',
              error_code = ?2,
              updated_at = ?3
          WHERE job_id = ?1
        `,
        args: [input.jobId, input.errorCode, input.createdAt],
      })
    }

    await tx.execute({
      sql: `
        INSERT INTO audit_log (
          audit_event_id, actor_type, actor_id, action, target_type, target_id, community_id, metadata_json, created_at
        ) VALUES (
          ?1, 'user', ?2, 'community.registry_publication_failed', 'community', ?3, ?3, ?4, ?5
        )
      `,
      args: [auditEventId, input.actorUserId, input.communityId, JSON.stringify(input.metadata), input.createdAt],
    })

    await tx.commit()
  } catch (error) {
    try {
      await tx.rollback()
    } catch {}
    throw error
  } finally {
    tx.close()
  }
}
