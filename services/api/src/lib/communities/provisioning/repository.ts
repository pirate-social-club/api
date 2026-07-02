import type { Client } from "../../sql-client"
import { internalError } from "../../errors"
import { withTransaction } from "../../transactions"
import { auditEventInsert } from "../../audit"
import {
  getCommunityRowById,
  getJobRowById,
  getLatestCommunityProvisioningJobRow,
} from "../../auth/auth-db-community-queries"
import type {
  CommunityDatabaseBindingRow,
  CommunityRow,
  JobRow,
} from "../../auth/auth-db-rows"
import type { InitialCommunityDatabaseBinding } from "../community-repository-types"

function syntheticBindingRow(input: {
  communityDatabaseBindingId: string
  communityId: string
  binding: InitialCommunityDatabaseBinding
  createdAt: string
}): CommunityDatabaseBindingRow {
  return {
    community_database_binding_id: input.communityDatabaseBindingId,
    community_id: input.communityId,
    binding_role: "primary",
    organization_slug: input.binding.organizationSlug,
    group_name: input.binding.groupName,
    group_id: input.binding.groupId,
    database_name: input.binding.databaseName,
    database_id: input.binding.databaseId,
    database_url: input.binding.databaseUrl,
    location: input.binding.location,
    requires_credentials: input.binding.requiresCredentials,
    status: "active",
    transferred_at: null,
    created_at: input.createdAt,
    updated_at: input.createdAt,
  }
}

export async function createCommunityProvisioningRequest(
  client: Client,
  input: {
    communityId: string
    communityDatabaseBindingId: string
    jobId: string
    creatorUserId: string
    displayName: string
    description?: string | null
    avatarRef?: string | null
    bannerRef?: string | null
    membershipMode: "open" | "request" | "gated"
    namespaceVerificationId: string | null
    routeSlug?: string | null
    binding: InitialCommunityDatabaseBinding
    createdAt: string
  },
): Promise<{
  community: CommunityRow
  binding: CommunityDatabaseBindingRow
  job: JobRow
}> {
  return await withTransaction(client, "write", async (tx) => {
    await tx.execute({
      sql: `
        INSERT INTO communities (
          community_id, creator_user_id, display_name, description, avatar_ref, banner_ref, membership_mode, status, provisioning_state, transfer_state,
          route_slug, namespace_verification_id, pending_namespace_verification_session_id,
          created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, ?7, 'active', 'provisioning', 'none', ?8, ?9, NULL, ?10, ?10
        )
      `,
      args: [
        input.communityId,
        input.creatorUserId,
        input.displayName,
        input.description ?? null,
        input.avatarRef ?? null,
        input.bannerRef ?? null,
        input.membershipMode,
        input.routeSlug,
        input.namespaceVerificationId,
        input.createdAt,
      ],
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
          mode: input.binding.provisioningMode,
          database_url: input.binding.databaseUrl,
        }),
        input.createdAt,
      ],
    })

    const communityRow = await getCommunityRowById(tx, input.communityId)
    const bindingRow = syntheticBindingRow({
      communityDatabaseBindingId: input.communityDatabaseBindingId,
      communityId: input.communityId,
      binding: input.binding,
      createdAt: input.createdAt,
    })
    const jobRow = await getJobRowById(tx, input.jobId)
    if (!communityRow || !jobRow) {
      throw internalError("Community provisioning request rows are missing after insert")
    }

    return { community: communityRow, binding: bindingRow, job: jobRow }
  })
}

export async function retryCommunityProvisioningRequest(
  client: Client,
  input: {
    communityId: string
    fallbackBindingId: string
    jobId: string
    namespaceVerificationId: string
    routeSlug: string
    binding: InitialCommunityDatabaseBinding
    createdAt: string
  },
): Promise<{
  community: CommunityRow
  binding: CommunityDatabaseBindingRow
  job: JobRow
}> {
  return await withTransaction(client, "write", async (tx) => {
    const communityRow = await getCommunityRowById(tx, input.communityId)
    if (!communityRow) {
      throw internalError("Community row is missing for retry")
    }

    const bindingRow = syntheticBindingRow({
      communityDatabaseBindingId: input.fallbackBindingId,
      communityId: input.communityId,
      binding: input.binding,
      createdAt: input.createdAt,
    })

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
          mode: input.binding.provisioningMode,
          database_url: bindingRow.database_url,
          retry: true,
        }),
        attemptCount,
        input.createdAt,
      ],
    })

    const refreshedCommunityRow = await getCommunityRowById(tx, input.communityId)
    const jobRow = await getJobRowById(tx, input.jobId)
    if (!refreshedCommunityRow || !jobRow) {
      throw internalError("Community provisioning retry rows are missing after insert")
    }

    return { community: refreshedCommunityRow, binding: bindingRow, job: jobRow }
  })
}

export async function markCommunityProvisioningSucceeded(
  client: Client,
  input: {
    communityId: string
    communityDatabaseBindingId: string
    jobId: string
    actorUserId: string
    resultRef: string | null
    description?: string | null
    avatarRef?: string | null
    bannerRef?: string | null
    createdAt: string
    metadata: Record<string, unknown>
  },
): Promise<{
  community: CommunityRow
  job: JobRow
}> {
  return await withTransaction(client, "write", async (tx) => {
    await tx.batch([
      {
        sql: `
          UPDATE communities
          SET status = 'active',
              provisioning_state = 'active',
              description = ?2,
              avatar_ref = ?3,
              banner_ref = ?4,
              updated_at = ?5
          WHERE community_id = ?1
        `,
        args: [
          input.communityId,
          input.description ?? null,
          input.avatarRef ?? null,
          input.bannerRef ?? null,
          input.createdAt,
        ],
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
      auditEventInsert({
        action: "community.provisioning_succeeded",
        actorId: input.actorUserId,
        actorType: "user",
        communityId: input.communityId,
        createdAt: input.createdAt,
        targetId: input.communityId,
        targetType: "community",
        metadata: input.metadata,
      }),
    ])

    const communityRow = await getCommunityRowById(tx, input.communityId)
    const jobRow = await getJobRowById(tx, input.jobId)
    if (!communityRow || !jobRow) {
      throw internalError("Provisioning success rows are missing after update")
    }

    return { community: communityRow, job: jobRow }
  })
}

export async function persistProvisionedD1Binding(
  client: Client,
  input: {
    communityDatabaseBindingId: string
    bindingName: string
    databaseUrl: string
    region: string
    updatedAt: string
  },
): Promise<void> {
  void client
  void input
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
  await withTransaction(client, "write", async (tx) => {
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
      auditEventInsert({
        action: "community.provisioning_failed",
        actorId: input.actorUserId,
        actorType: "user",
        communityId: input.communityId,
        createdAt: input.createdAt,
        targetId: input.communityId,
        targetType: "community",
        metadata: input.metadata,
      }),
    ])
  })
}
