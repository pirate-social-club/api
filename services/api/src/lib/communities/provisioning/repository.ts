import type { Client } from "../../sql-client"
import { internalError } from "../../errors"
import { makeId } from "../../helpers"
import {
  getCommunityRowById,
  getCommunityDatabaseBindingRowById,
  getJobRowById,
  getLatestCommunityProvisioningJobRow,
  getPrimaryCommunityDatabaseBindingRow,
} from "../../auth/auth-db-community-queries"
import type {
  CommunityDatabaseBindingRow,
  CommunityRow,
  JobRow,
} from "../../auth/auth-db-rows"

export async function createCommunityProvisioningRequest(
  client: Client,
  input: {
    communityId: string
    communityDatabaseBindingId: string
    jobId: string
    creatorUserId: string
    displayName: string
    membershipMode: "open" | "request" | "gated"
    namespaceVerificationId: string | null
    routeSlug?: string | null
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
          community_id, creator_user_id, display_name, membership_mode, status, provisioning_state, transfer_state,
          route_slug, namespace_verification_id, pending_namespace_verification_session_id,
          primary_database_binding_id, created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, ?4, 'active', 'provisioning', 'none', ?5, ?6, NULL, NULL, ?7, ?7
        )
      `,
      args: [
        input.communityId,
        input.creatorUserId,
        input.displayName,
        input.membershipMode,
        input.routeSlug,
        input.namespaceVerificationId,
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
    jobId: string
    namespaceVerificationId: string
    routeSlug: string
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
            route_slug = ?2,
            updated_at = ?3
        WHERE community_id = ?1
      `,
      args: [input.communityId, input.routeSlug, input.createdAt],
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

export async function persistProvisionedCommunityDatabaseAccess(
  client: Client,
  input: {
    communityDatabaseBindingId: string
    communityDbCredentialId: string
    organizationSlug: string
    groupName: string
    groupId: string | null
    databaseName: string
    databaseId: string | null
    databaseUrl: string
    location: string | null
    tokenName: string
    encryptedToken: string
    encryptionKeyVersion: number
    issuedAt: string
    expiresAt: string | null
    updatedAt: string
  },
): Promise<void> {
  const tx = await client.transaction("write")

  try {
    await tx.batch([
      {
        sql: `
          UPDATE community_database_bindings
          SET organization_slug = ?2,
              group_name = ?3,
              group_id = ?4,
              database_name = ?5,
              database_id = ?6,
              database_url = ?7,
              location = ?8,
              status = 'active',
              transferred_at = NULL,
              updated_at = ?9
          WHERE community_database_binding_id = ?1
        `,
        args: [
          input.communityDatabaseBindingId,
          input.organizationSlug,
          input.groupName,
          input.groupId,
          input.databaseName,
          input.databaseId,
          input.databaseUrl,
          input.location,
          input.updatedAt,
        ],
      },
      {
        sql: `
          UPDATE community_db_credentials
          SET status = 'superseded',
              invalidated_at = ?2,
              updated_at = ?2
          WHERE community_database_binding_id = ?1
            AND status = 'active'
        `,
        args: [input.communityDatabaseBindingId, input.updatedAt],
      },
      {
        sql: `
          INSERT INTO community_db_credentials (
            community_db_credential_id, community_database_binding_id, credential_kind, token_name,
            encrypted_token, encryption_key_version, token_scope, status, issued_at, invalidated_at,
            expires_at, created_at, updated_at
          ) VALUES (
            ?1, ?2, 'database_token', ?3,
            ?4, ?5, 'database', 'active', ?6, NULL,
            ?7, ?8, ?8
          )
        `,
        args: [
          input.communityDbCredentialId,
          input.communityDatabaseBindingId,
          input.tokenName,
          input.encryptedToken,
          input.encryptionKeyVersion,
          input.issuedAt,
          input.expiresAt,
          input.updatedAt,
        ],
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
