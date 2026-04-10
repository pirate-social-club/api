import { createClient } from "@libsql/client"
import type { Client } from "@libsql/client"
import { internalError } from "../errors"
import { makeId } from "../helpers"
import {
  getCommunityDatabaseBindingRowById,
  getCommunityRegistryAttemptRowById,
  getCommunityPostProjectionRowByPostId,
  getCommunityRowById,
  getCommunityRowByNamespaceVerificationId,
  getJobRowById,
  getLatestCommunityProvisioningJobRow,
  getLatestCommunityRegistryPublicationJobRow,
  listActiveWalletAttachmentRows,
  getPrimaryCommunityDatabaseBindingRow,
  requireControlPlaneDbUrl,
} from "../auth/control-plane-auth-queries"
import type {
  CommunityDatabaseBindingRow,
  CommunityRegistryAttemptRow,
  CommunityPostProjectionRow,
  CommunityRow,
  JobRow,
} from "../auth/control-plane-auth-rows"
import type { Env } from "../../types"

export async function getCommunityById(client: Client, communityId: string): Promise<CommunityRow | null> {
  return getCommunityRowById(client, communityId)
}

export async function getCommunityByNamespaceVerificationId(
  client: Client,
  namespaceVerificationId: string,
): Promise<CommunityRow | null> {
  return getCommunityRowByNamespaceVerificationId(client, namespaceVerificationId)
}

export async function getPrimaryCommunityDatabaseBinding(
  client: Client,
  communityId: string,
): Promise<CommunityDatabaseBindingRow | null> {
  return getPrimaryCommunityDatabaseBindingRow(client, communityId)
}

export async function getJobById(client: Client, jobId: string): Promise<JobRow | null> {
  return getJobRowById(client, jobId)
}

export async function getLatestCommunityProvisioningJob(
  client: Client,
  communityId: string,
): Promise<JobRow | null> {
  return getLatestCommunityProvisioningJobRow(client, communityId)
}

export async function getLatestCommunityRegistryPublicationJob(
  client: Client,
  communityId: string,
): Promise<JobRow | null> {
  return getLatestCommunityRegistryPublicationJobRow(client, communityId)
}

export async function getCommunityPostProjectionByPostId(
  client: Client,
  postId: string,
): Promise<CommunityPostProjectionRow | null> {
  return getCommunityPostProjectionRowByPostId(client, postId)
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
      input.actorPrimaryWalletSnapshot,
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

export async function recordCommunityPostProjection(
  client: Client,
  input: {
    communityId: string
    sourcePostId: string
    authorUserId: string | null
    identityMode: "public" | "anonymous"
    postType: "text" | "image" | "video" | "link" | "song"
    status: "draft" | "published" | "hidden" | "removed" | "deleted"
    sourceCreatedAt: string
    projectedPayloadJson: string
    actorUserId: string
    createdAt: string
  },
): Promise<CommunityPostProjectionRow> {
  const projectionId = makeId("cpp")
  const auditEventId = makeId("aud")
  const tx = await client.transaction("write")

  try {
    await tx.batch([
      {
        sql: `
          INSERT INTO community_post_projections (
            projection_id, community_id, source_post_id, author_user_id, identity_mode, post_type, status,
            source_created_at, projected_payload_json, projection_version, created_at, updated_at
          ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7,
            ?8, ?9, 1, ?10, ?10
          )
        `,
        args: [
          projectionId,
          input.communityId,
          input.sourcePostId,
          input.authorUserId,
          input.identityMode,
          input.postType,
          input.status,
          input.sourceCreatedAt,
          input.projectedPayloadJson,
          input.createdAt,
        ],
      },
      {
        sql: `
          INSERT INTO audit_log (
            audit_event_id, actor_type, actor_id, action, target_type, target_id, community_id, metadata_json, created_at
          ) VALUES (
            ?1, 'user', ?2, 'community.post_created', 'post', ?3, ?4, ?5, ?6
          )
        `,
        args: [
          auditEventId,
          input.actorUserId,
          input.sourcePostId,
          input.communityId,
          JSON.stringify({
            projection_id: projectionId,
            source_created_at: input.sourceCreatedAt,
          }),
          input.createdAt,
        ],
      },
    ])

    const projection = await getCommunityPostProjectionRowByPostId(tx, input.sourcePostId)
    if (!projection) {
      throw internalError("Community post projection is missing after insert")
    }

    await tx.commit()
    return projection
  } catch (error) {
    try {
      await tx.rollback()
    } catch {}
    throw error
  } finally {
    tx.close()
  }
}

export async function createCommunityProvisioningRequest(
  client: Client,
  input: {
    communityId: string
    communityDatabaseBindingId: string
    registryAttemptId: string
    jobId: string
    creatorUserId: string
    displayName: string
    namespaceVerificationId: string
    databaseUrl: string
    createdAt: string
  },
): Promise<{
  community: CommunityRow
  binding: CommunityDatabaseBindingRow
  job: JobRow
}> {
  const tx = await client.transaction("write")

  try {
    await tx.execute({
      sql: `
        INSERT INTO communities (
          community_id, creator_user_id, display_name, status, provisioning_state, transfer_state,
          route_slug, namespace_verification_id, primary_database_binding_id, registry_publication_state,
          registry_attempt_id, registry_published_at, registry_publication_job_id, registry_error_code,
          created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, 'active', 'provisioning', 'none', NULL, ?4, NULL, 'pending_create',
          ?5, NULL, NULL, NULL, ?6, ?6
        )
      `,
      args: [
        input.communityId,
        input.creatorUserId,
        input.displayName,
        input.namespaceVerificationId,
        input.registryAttemptId,
        input.createdAt,
      ],
    })

    await tx.execute({
      sql: `
        INSERT INTO community_database_bindings (
          community_database_binding_id, community_id, binding_role, organization_slug, group_name, group_id,
          database_name, database_id, database_url, location, status, transferred_at, created_at, updated_at
        ) VALUES (
          ?1, ?2, 'primary', 'local-dev', ?3, NULL, 'main', NULL, ?4, 'local', 'active', NULL, ?5, ?5
        )
      `,
      args: [input.communityDatabaseBindingId, input.communityId, `club-${input.communityId}`, input.databaseUrl, input.createdAt],
    })

    await tx.execute({
      sql: `
        UPDATE communities
        SET primary_database_binding_id = ?2,
            updated_at = ?3
        WHERE community_id = ?1
      `,
      args: [input.communityId, input.communityDatabaseBindingId, input.createdAt],
    })

    await tx.execute({
      sql: `
        INSERT INTO jobs (
          job_id, job_type, job_scope, community_id, subject_type, subject_id, status, payload_json,
          result_ref, error_code, attempt_count, available_at, created_at, updated_at
        ) VALUES (
          ?1, 'community_provisioning', 'platform', ?2, 'community', ?2, 'running', ?3,
          NULL, NULL, 1, ?4, ?4, ?4
        )
      `,
      args: [
        input.jobId,
        input.communityId,
        JSON.stringify({
          namespace_verification_id: input.namespaceVerificationId,
          mode: "local_stub",
          database_url: input.databaseUrl,
        }),
        input.createdAt,
      ],
    })

    await tx.execute({
      sql: `
        UPDATE community_registry_attempts
        SET community_id = ?2,
            updated_at = ?3
        WHERE registry_attempt_id = ?1
      `,
      args: [input.registryAttemptId, input.communityId, input.createdAt],
    })

    const communityRow = await getCommunityRowById(tx, input.communityId)
    const bindingRow = await getCommunityDatabaseBindingRowById(tx, input.communityDatabaseBindingId)
    const jobRow = await getJobRowById(tx, input.jobId)
    if (!communityRow || !bindingRow || !jobRow) {
      throw internalError("Community provisioning request rows are missing after insert")
    }

    await tx.commit()
    return { community: communityRow, binding: bindingRow, job: jobRow }
  } catch (error) {
    try {
      await tx.rollback()
    } catch {}
    throw error
  } finally {
    tx.close()
  }
}

export async function retryCommunityProvisioningRequest(
  client: Client,
  input: {
    communityId: string
    fallbackBindingId: string
    registryAttemptId: string
    jobId: string
    namespaceVerificationId: string
    databaseUrl: string
    createdAt: string
  },
): Promise<{
  community: CommunityRow
  binding: CommunityDatabaseBindingRow
  job: JobRow
}> {
  const tx = await client.transaction("write")

  try {
    const communityRow = await getCommunityRowById(tx, input.communityId)
    if (!communityRow) {
      throw internalError("Community row is missing for retry")
    }

    let bindingRow = communityRow.primary_database_binding_id
      ? await getCommunityDatabaseBindingRowById(tx, communityRow.primary_database_binding_id)
      : await getPrimaryCommunityDatabaseBindingRow(tx, input.communityId)

    if (!bindingRow) {
      await tx.execute({
        sql: `
          INSERT INTO community_database_bindings (
            community_database_binding_id, community_id, binding_role, organization_slug, group_name, group_id,
            database_name, database_id, database_url, location, status, transferred_at, created_at, updated_at
          ) VALUES (
            ?1, ?2, 'primary', 'local-dev', ?3, NULL, 'main', NULL, ?4, 'local', 'active', NULL, ?5, ?5
          )
        `,
        args: [input.fallbackBindingId, input.communityId, `club-${input.communityId}`, input.databaseUrl, input.createdAt],
      })

      await tx.execute({
        sql: `
          UPDATE communities
          SET primary_database_binding_id = ?2,
              updated_at = ?3
          WHERE community_id = ?1
        `,
        args: [input.communityId, input.fallbackBindingId, input.createdAt],
      })
      bindingRow = await getCommunityDatabaseBindingRowById(tx, input.fallbackBindingId)
    }

    const latestJob = await getLatestCommunityProvisioningJobRow(tx, input.communityId)
    const attemptCount = (latestJob?.attempt_count ?? 0) + 1

    await tx.execute({
      sql: `
        UPDATE communities
        SET provisioning_state = 'provisioning',
            registry_publication_state = 'pending_create',
            registry_attempt_id = ?2,
            registry_published_at = NULL,
            registry_publication_job_id = NULL,
            registry_error_code = NULL,
            updated_at = ?3
        WHERE community_id = ?1
      `,
      args: [input.communityId, input.registryAttemptId, input.createdAt],
    })

    await tx.execute({
      sql: `
        UPDATE community_registry_attempts
        SET community_id = ?2,
            updated_at = ?3
        WHERE registry_attempt_id = ?1
      `,
      args: [input.registryAttemptId, input.communityId, input.createdAt],
    })

    await tx.execute({
      sql: `
        INSERT INTO jobs (
          job_id, job_type, job_scope, community_id, subject_type, subject_id, status, payload_json,
          result_ref, error_code, attempt_count, available_at, created_at, updated_at
        ) VALUES (
          ?1, 'community_provisioning', 'platform', ?2, 'community', ?2, 'running', ?3,
          NULL, NULL, ?4, ?5, ?5, ?5
        )
      `,
      args: [
        input.jobId,
        input.communityId,
        JSON.stringify({
          namespace_verification_id: input.namespaceVerificationId,
          mode: "local_stub",
          database_url: bindingRow?.database_url ?? input.databaseUrl,
          retry: true,
        }),
        attemptCount,
        input.createdAt,
      ],
    })

    const refreshedCommunityRow = await getCommunityRowById(tx, input.communityId)
    const jobRow = await getJobRowById(tx, input.jobId)
    if (!refreshedCommunityRow || !bindingRow || !jobRow) {
      throw internalError("Community provisioning retry rows are missing after insert")
    }

    await tx.commit()
    return { community: refreshedCommunityRow, binding: bindingRow, job: jobRow }
  } catch (error) {
    try {
      await tx.rollback()
    } catch {}
    throw error
  } finally {
    tx.close()
  }
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

export async function markCommunityProvisioningSucceeded(
  client: Client,
  input: {
    communityId: string
    communityDatabaseBindingId: string
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
          SET status = 'active',
              provisioning_state = 'active',
              primary_database_binding_id = ?2,
              updated_at = ?3
          WHERE community_id = ?1
        `,
        args: [input.communityId, input.communityDatabaseBindingId, input.createdAt],
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
            ?1, 'user', ?2, 'community.provisioning_succeeded', 'community', ?3, ?3, ?4, ?5
          )
        `,
        args: [auditEventId, input.actorUserId, input.communityId, JSON.stringify(input.metadata), input.createdAt],
      },
    ])

    const communityRow = await getCommunityRowById(tx, input.communityId)
    const jobRow = await getJobRowById(tx, input.jobId)
    if (!communityRow || !jobRow) {
      throw internalError("Provisioning success rows are missing after update")
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

export async function markCommunityProvisioningFailed(
  client: Client,
  input: {
    communityId: string
    jobId: string
    actorUserId: string
    errorCode: string
    createdAt: string
    metadata: Record<string, unknown>
  },
): Promise<void> {
  const tx = await client.transaction("write")
  const auditEventId = makeId("aud")

  try {
    await tx.batch([
      {
        sql: `
          UPDATE communities
          SET provisioning_state = 'error',
              updated_at = ?2
          WHERE community_id = ?1
        `,
        args: [input.communityId, input.createdAt],
      },
      {
        sql: `
          UPDATE jobs
          SET status = 'failed',
              error_code = ?2,
              updated_at = ?3
          WHERE job_id = ?1
        `,
        args: [input.jobId, input.errorCode, input.createdAt],
      },
      {
        sql: `
          INSERT INTO audit_log (
            audit_event_id, actor_type, actor_id, action, target_type, target_id, community_id, metadata_json, created_at
          ) VALUES (
            ?1, 'user', ?2, 'community.provisioning_failed', 'community', ?3, ?3, ?4, ?5
          )
        `,
        args: [auditEventId, input.actorUserId, input.communityId, JSON.stringify(input.metadata), input.createdAt],
      },
    ])

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

export interface CommunityRepository {
  getCommunityById(communityId: string): Promise<CommunityRow | null>
  getCommunityByNamespaceVerificationId(namespaceVerificationId: string): Promise<CommunityRow | null>
  getPrimaryCommunityDatabaseBinding(communityId: string): Promise<CommunityDatabaseBindingRow | null>
  getJobById(jobId: string): Promise<JobRow | null>
  getLatestCommunityProvisioningJob(communityId: string): Promise<JobRow | null>
  getCommunityPostProjectionByPostId(postId: string): Promise<CommunityPostProjectionRow | null>
  createCommunityRegistryAttempt(input: {
    registryAttemptId?: string
    actorUserId: string
    namespaceVerificationId: string
    normalizedRootLabel: string
    actorPrimaryWalletSnapshot?: string | null
    actorGovernanceAddressSnapshot?: string | null
    createdAt: string
  }): Promise<CommunityRegistryAttemptRow>
  markCommunityRegistryAttemptFailed(input: {
    registryAttemptId: string
    failureCode: string
    updatedAt: string
  }): Promise<void>
  recordCommunityPostProjection(input: {
    communityId: string
    sourcePostId: string
    authorUserId: string | null
    identityMode: "public" | "anonymous"
    postType: "text" | "image" | "video" | "link" | "song"
    status: "draft" | "published" | "hidden" | "removed" | "deleted"
    sourceCreatedAt: string
    projectedPayloadJson: string
    actorUserId: string
    createdAt: string
  }): Promise<CommunityPostProjectionRow>
  createCommunityProvisioningRequest(input: {
    communityId: string
    communityDatabaseBindingId: string
    registryAttemptId: string
    jobId: string
    creatorUserId: string
    displayName: string
    namespaceVerificationId: string
    databaseUrl: string
    createdAt: string
  }): Promise<{
    community: CommunityRow
    binding: CommunityDatabaseBindingRow
    job: JobRow
  }>
  retryCommunityProvisioningRequest(input: {
    communityId: string
    fallbackBindingId: string
    registryAttemptId: string
    jobId: string
    namespaceVerificationId: string
    databaseUrl: string
    createdAt: string
  }): Promise<{
    community: CommunityRow
    binding: CommunityDatabaseBindingRow
    job: JobRow
  }>
  markCommunityProvisioningSucceeded(input: {
    communityId: string
    communityDatabaseBindingId: string
    jobId: string
    actorUserId: string
    resultRef: string | null
    createdAt: string
    metadata: Record<string, unknown>
  }): Promise<{
    community: CommunityRow
    job: JobRow
  }>
  markCommunityProvisioningFailed(input: {
    communityId: string
    jobId: string
    actorUserId: string
    errorCode: string
    createdAt: string
    metadata: Record<string, unknown>
  }): Promise<void>
  createCommunityRegistryPublicationRequest(input: {
    communityId: string
    registryAttemptId: string
    jobId: string
    createdAt: string
  }): Promise<JobRow>
  markCommunityRegistryPublicationSucceeded(input: {
    communityId: string
    registryAttemptId: string
    jobId: string
    actorUserId: string
    resultRef: string | null
    createdAt: string
    metadata: Record<string, unknown>
  }): Promise<{
    community: CommunityRow
    job: JobRow
  }>
  markCommunityRegistryPublicationFailed(input: {
    communityId: string
    registryAttemptId: string
    jobId: string | null
    actorUserId: string
    errorCode: string
    createdAt: string
    metadata: Record<string, unknown>
  }): Promise<void>
}

export class ControlPlaneCommunityRepository implements CommunityRepository {
  constructor(private readonly client: Client) {}

  async getCommunityById(communityId: string): Promise<CommunityRow | null> {
    return getCommunityById(this.client, communityId)
  }

  async getCommunityByNamespaceVerificationId(namespaceVerificationId: string): Promise<CommunityRow | null> {
    return getCommunityByNamespaceVerificationId(this.client, namespaceVerificationId)
  }

  async getPrimaryCommunityDatabaseBinding(communityId: string): Promise<CommunityDatabaseBindingRow | null> {
    return getPrimaryCommunityDatabaseBinding(this.client, communityId)
  }

  async getJobById(jobId: string): Promise<JobRow | null> {
    return getJobById(this.client, jobId)
  }

  async getLatestCommunityProvisioningJob(communityId: string): Promise<JobRow | null> {
    return getLatestCommunityProvisioningJob(this.client, communityId)
  }

  async getCommunityPostProjectionByPostId(postId: string): Promise<CommunityPostProjectionRow | null> {
    return getCommunityPostProjectionByPostId(this.client, postId)
  }

  async createCommunityRegistryAttempt(input: {
    registryAttemptId?: string
    actorUserId: string
    namespaceVerificationId: string
    normalizedRootLabel: string
    actorPrimaryWalletSnapshot?: string | null
    actorGovernanceAddressSnapshot?: string | null
    createdAt: string
  }): Promise<CommunityRegistryAttemptRow> {
    const walletRows = input.actorPrimaryWalletSnapshot === undefined
      ? await listActiveWalletAttachmentRows(this.client, input.actorUserId)
      : []
    const primaryWallet = input.actorPrimaryWalletSnapshot === undefined
      ? (walletRows.find((row) => row.is_primary === 1) ?? walletRows[0] ?? null)
      : null
    return createCommunityRegistryAttempt(this.client, {
      registryAttemptId: input.registryAttemptId ?? makeId("rga"),
      actorUserId: input.actorUserId,
      actorPrimaryWalletSnapshot: input.actorPrimaryWalletSnapshot ?? primaryWallet?.wallet_address_display ?? null,
      actorGovernanceAddressSnapshot: input.actorGovernanceAddressSnapshot ?? null,
      namespaceVerificationId: input.namespaceVerificationId,
      normalizedRootLabel: input.normalizedRootLabel,
      createdAt: input.createdAt,
    })
  }

  async markCommunityRegistryAttemptFailed(input: {
    registryAttemptId: string
    failureCode: string
    updatedAt: string
  }): Promise<void> {
    return markCommunityRegistryAttemptFailed(this.client, input)
  }

  async recordCommunityPostProjection(input: {
    communityId: string
    sourcePostId: string
    authorUserId: string | null
    identityMode: "public" | "anonymous"
    postType: "text" | "image" | "video" | "link" | "song"
    status: "draft" | "published" | "hidden" | "removed" | "deleted"
    sourceCreatedAt: string
    projectedPayloadJson: string
    actorUserId: string
    createdAt: string
  }): Promise<CommunityPostProjectionRow> {
    return recordCommunityPostProjection(this.client, input)
  }

  async createCommunityProvisioningRequest(input: {
    communityId: string
    communityDatabaseBindingId: string
    registryAttemptId: string
    jobId: string
    creatorUserId: string
    displayName: string
    namespaceVerificationId: string
    databaseUrl: string
    createdAt: string
  }): Promise<{
    community: CommunityRow
    binding: CommunityDatabaseBindingRow
    job: JobRow
  }> {
    return createCommunityProvisioningRequest(this.client, input)
  }

  async retryCommunityProvisioningRequest(input: {
    communityId: string
    fallbackBindingId: string
    registryAttemptId: string
    jobId: string
    namespaceVerificationId: string
    databaseUrl: string
    createdAt: string
  }): Promise<{
    community: CommunityRow
    binding: CommunityDatabaseBindingRow
    job: JobRow
  }> {
    return retryCommunityProvisioningRequest(this.client, input)
  }

  async markCommunityProvisioningSucceeded(input: {
    communityId: string
    communityDatabaseBindingId: string
    jobId: string
    actorUserId: string
    resultRef: string | null
    createdAt: string
    metadata: Record<string, unknown>
  }): Promise<{
    community: CommunityRow
    job: JobRow
  }> {
    return markCommunityProvisioningSucceeded(this.client, input)
  }

  async markCommunityProvisioningFailed(input: {
    communityId: string
    jobId: string
    actorUserId: string
    errorCode: string
    createdAt: string
    metadata: Record<string, unknown>
  }): Promise<void> {
    return markCommunityProvisioningFailed(this.client, input)
  }

  async createCommunityRegistryPublicationRequest(input: {
    communityId: string
    registryAttemptId: string
    jobId: string
    createdAt: string
  }): Promise<JobRow> {
    return createCommunityRegistryPublicationRequest(this.client, input)
  }

  async markCommunityRegistryPublicationSucceeded(input: {
    communityId: string
    registryAttemptId: string
    jobId: string
    actorUserId: string
    resultRef: string | null
    createdAt: string
    metadata: Record<string, unknown>
  }): Promise<{
    community: CommunityRow
    job: JobRow
  }> {
    return markCommunityRegistryPublicationSucceeded(this.client, input)
  }

  async markCommunityRegistryPublicationFailed(input: {
    communityId: string
    registryAttemptId: string
    jobId: string | null
    actorUserId: string
    errorCode: string
    createdAt: string
    metadata: Record<string, unknown>
  }): Promise<void> {
    return markCommunityRegistryPublicationFailed(this.client, input)
  }
}

const globalScope = globalThis as typeof globalThis & {
  __pirateControlPlaneCommunityRepository?: ControlPlaneCommunityRepository
  __pirateControlPlaneCommunityRepositoryKey?: string
}

export function getControlPlaneCommunityRepository(env: Env): ControlPlaneCommunityRepository {
  const url = requireControlPlaneDbUrl(env)
  const authToken = String(env.TURSO_CONTROL_PLANE_AUTH_TOKEN || "").trim()
  const cacheKey = `${url}|${authToken}`

  if (
    globalScope.__pirateControlPlaneCommunityRepository
    && globalScope.__pirateControlPlaneCommunityRepositoryKey === cacheKey
  ) {
    return globalScope.__pirateControlPlaneCommunityRepository
  }

  const repository = new ControlPlaneCommunityRepository(
    createClient({
      url,
      authToken: authToken || undefined,
    }),
  )
  globalScope.__pirateControlPlaneCommunityRepository = repository
  globalScope.__pirateControlPlaneCommunityRepositoryKey = cacheKey
  return repository
}
