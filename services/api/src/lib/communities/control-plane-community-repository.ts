import { internalError } from "../errors"
import { makeId } from "../helpers"
import { createControlPlaneDbClient, type ControlPlaneDbClient } from "../control-plane-db"
import {
  getCommunityDatabaseBindingRowById,
  getCommunityMoneyPolicyRowByCommunityId,
  getCommunityPricingPolicyRowByCommunityId,
  getCommunityRegistryAttemptRowById,
  getCommunityPostProjectionRowByPostId,
  listCommunityRowsByCreatorUserId,
  getCommunityRowById,
  getCommunityRowByNamespaceLabel,
  getCommunityRowByRouteKey,
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
  CommunityMoneyPolicyRow,
  CommunityPricingPolicyRow,
  CommunityRegistryAttemptRow,
  CommunityPostProjectionRow,
  CommunityRow,
  JobRow,
} from "../auth/control-plane-auth-rows"
import { toCommunityPostProjectionRow, toCommunityRow } from "../auth/control-plane-auth-rows"
import type { Env } from "../../types"

type Client = ControlPlaneDbClient

export async function getCommunityById(client: ControlPlaneDbClient, communityId: string): Promise<CommunityRow | null> {
  return getCommunityRowById(client, communityId)
}

export async function getCommunityByNamespaceVerificationId(
  client: ControlPlaneDbClient,
  namespaceVerificationId: string,
): Promise<CommunityRow | null> {
  return getCommunityRowByNamespaceVerificationId(client, namespaceVerificationId)
}

export async function getCommunityByRouteKey(
  client: ControlPlaneDbClient,
  routeKey: string,
): Promise<CommunityRow | null> {
  return getCommunityRowByRouteKey(client, routeKey)
}

export async function getCommunityByNamespaceLabel(
  client: ControlPlaneDbClient,
  input: {
    normalizedLabel: string
    family: "spaces"
  },
): Promise<CommunityRow | null> {
  return getCommunityRowByNamespaceLabel(client, input)
}

export async function listCommunitiesByCreatorUserId(
  client: ControlPlaneDbClient,
  creatorUserId: string,
): Promise<CommunityRow[]> {
  return listCommunityRowsByCreatorUserId(client, creatorUserId)
}

export async function getPrimaryCommunityDatabaseBinding(
  client: ControlPlaneDbClient,
  communityId: string,
): Promise<CommunityDatabaseBindingRow | null> {
  return getPrimaryCommunityDatabaseBindingRow(client, communityId)
}

export async function getCommunityMoneyPolicyByCommunityId(
  client: ControlPlaneDbClient,
  communityId: string,
): Promise<CommunityMoneyPolicyRow | null> {
  return getCommunityMoneyPolicyRowByCommunityId(client, communityId)
}

export async function getCommunityPricingPolicyByCommunityId(
  client: ControlPlaneDbClient,
  communityId: string,
): Promise<CommunityPricingPolicyRow | null> {
  return getCommunityPricingPolicyRowByCommunityId(client, communityId)
}

export async function getJobById(client: ControlPlaneDbClient, jobId: string): Promise<JobRow | null> {
  return getJobRowById(client, jobId)
}

export async function getLatestCommunityProvisioningJob(
  client: ControlPlaneDbClient,
  communityId: string,
): Promise<JobRow | null> {
  return getLatestCommunityProvisioningJobRow(client, communityId)
}

export async function getLatestCommunityRegistryPublicationJob(
  client: ControlPlaneDbClient,
  communityId: string,
): Promise<JobRow | null> {
  return getLatestCommunityRegistryPublicationJobRow(client, communityId)
}

export async function getCommunityPostProjectionByPostId(
  client: ControlPlaneDbClient,
  postId: string,
): Promise<CommunityPostProjectionRow | null> {
  return getCommunityPostProjectionRowByPostId(client, postId)
}

export async function listActiveCommunities(client: ControlPlaneDbClient): Promise<CommunityRow[]> {
  const result = await client.execute({
    sql: `
      SELECT community_id, creator_user_id, display_name, status, provisioning_state, transfer_state,
             route_slug, namespace_verification_id, primary_database_binding_id, registry_publication_state,
             registry_attempt_id, registry_published_at, registry_publication_job_id, registry_error_code,
             projected_member_count, projected_qualified_member_count, created_at, updated_at
      FROM communities
      WHERE status = 'active'
        AND provisioning_state = 'active'
        AND registry_publication_state = 'published'
      ORDER BY created_at DESC, community_id DESC
    `,
    args: [],
  })

  return result.rows.map((row) => toCommunityRow(row))
}

export async function listRecentCommunityPostProjections(
  client: ControlPlaneDbClient,
  input: {
    limit: number
    cursor?: { createdAt: string; postId: string } | null
    communityIds?: string[] | null
  },
): Promise<CommunityPostProjectionRow[]> {
  const communityIds = input.communityIds?.filter(Boolean) ?? []
  const communityFilter = communityIds.length > 0
    ? `AND cpp.community_id IN (${communityIds.map((_, index) => `?${index + 3}`).join(", ")})`
    : ""
  const limitIndex = communityIds.length + 3

  const result = await client.execute({
    sql: `
      SELECT cpp.projection_id, cpp.community_id, cpp.source_post_id, cpp.author_user_id, cpp.identity_mode, cpp.post_type, cpp.status,
             cpp.source_created_at, cpp.projected_payload_json, cpp.projection_version, cpp.created_at, cpp.updated_at
      FROM community_post_projections AS cpp
      INNER JOIN communities AS c
        ON c.community_id = cpp.community_id
      WHERE cpp.projection_version = 1
        AND cpp.status = 'published'
        AND c.status = 'active'
        AND c.provisioning_state = 'active'
        ${communityFilter}
        AND (
          ?1 IS NULL
          OR cpp.source_created_at < ?1
          OR (cpp.source_created_at = ?1 AND cpp.source_post_id < ?2)
        )
      ORDER BY cpp.source_created_at DESC, cpp.source_post_id DESC
      LIMIT ?${limitIndex}
    `,
    args: [
      input.cursor?.createdAt ?? null,
      input.cursor?.postId ?? null,
      ...communityIds,
      input.limit,
    ],
  })

  return result.rows.map((row) => toCommunityPostProjectionRow(row))
}

export async function createCommunityRegistryAttempt(
  client: ControlPlaneDbClient,
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

export async function upsertCommunityMoneyPolicy(
  client: Client,
  input: {
    communityId: string
    fundingPreference: string
    acceptedFundingAssetsJson: string
    acceptedSourceChainsJson: string
    approvedRouteProvidersJson: string | null
    destinationSettlementChainJson: string
    destinationSettlementToken: string
    treasuryDenomination: string | null
    maxSlippageBps: number
    quoteTtlSeconds: number
    routeRequired: boolean
    routeStatusPolicy: CommunityMoneyPolicyRow["route_status_policy"]
    routeHopTolerance: number
    updatedAt: string
  },
): Promise<void> {
  await client.execute({
    sql: `
      INSERT INTO community_money_policies (
        community_id,
        funding_preference,
        accepted_funding_assets_json,
        accepted_source_chains_json,
        approved_route_providers_json,
        destination_settlement_chain_json,
        destination_settlement_token,
        treasury_denomination,
        max_slippage_bps,
        quote_ttl_seconds,
        route_required,
        route_status_policy,
        route_hop_tolerance,
        updated_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14
      )
      ON CONFLICT(community_id) DO UPDATE SET
        funding_preference = excluded.funding_preference,
        accepted_funding_assets_json = excluded.accepted_funding_assets_json,
        accepted_source_chains_json = excluded.accepted_source_chains_json,
        approved_route_providers_json = excluded.approved_route_providers_json,
        destination_settlement_chain_json = excluded.destination_settlement_chain_json,
        destination_settlement_token = excluded.destination_settlement_token,
        treasury_denomination = excluded.treasury_denomination,
        max_slippage_bps = excluded.max_slippage_bps,
        quote_ttl_seconds = excluded.quote_ttl_seconds,
        route_required = excluded.route_required,
        route_status_policy = excluded.route_status_policy,
        route_hop_tolerance = excluded.route_hop_tolerance,
        updated_at = excluded.updated_at
    `,
    args: [
      input.communityId,
      input.fundingPreference,
      input.acceptedFundingAssetsJson,
      input.acceptedSourceChainsJson,
      input.approvedRouteProvidersJson,
      input.destinationSettlementChainJson,
      input.destinationSettlementToken,
      input.treasuryDenomination,
      input.maxSlippageBps,
      input.quoteTtlSeconds,
      input.routeRequired ? 1 : 0,
      input.routeStatusPolicy,
      input.routeHopTolerance,
      input.updatedAt,
    ],
  })
}

export async function upsertCommunityPricingPolicy(
  client: Client,
  input: {
    communityId: string
    regionalPricingEnabled: boolean
    verificationProviderRequirement: CommunityPricingPolicyRow["verification_provider_requirement"]
    defaultTierKey: string | null
    tiersJson: string
    countryAssignmentsJson: string
    sourceTemplateId: string | null
    sourceTemplateVersion: string | null
    pricingPolicyVersion: string
    updatedAt: string
  },
): Promise<void> {
  await client.execute({
    sql: `
      INSERT INTO community_pricing_policies (
        community_id,
        regional_pricing_enabled,
        verification_provider_requirement,
        default_tier_key,
        tiers_json,
        country_assignments_json,
        source_template_id,
        source_template_version,
        pricing_policy_version,
        updated_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10
      )
      ON CONFLICT(community_id) DO UPDATE SET
        regional_pricing_enabled = excluded.regional_pricing_enabled,
        verification_provider_requirement = excluded.verification_provider_requirement,
        default_tier_key = excluded.default_tier_key,
        tiers_json = excluded.tiers_json,
        country_assignments_json = excluded.country_assignments_json,
        source_template_id = excluded.source_template_id,
        source_template_version = excluded.source_template_version,
        pricing_policy_version = excluded.pricing_policy_version,
        updated_at = excluded.updated_at
    `,
    args: [
      input.communityId,
      input.regionalPricingEnabled ? 1 : 0,
      input.verificationProviderRequirement ?? null,
      input.defaultTierKey,
      input.tiersJson,
      input.countryAssignmentsJson,
      input.sourceTemplateId,
      input.sourceTemplateVersion,
      input.pricingPolicyVersion,
      input.updatedAt,
    ],
  })
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

export async function updateCommunityPostProjection(
  client: Client,
  input: {
    sourcePostId: string
    status: "draft" | "published" | "hidden" | "removed" | "deleted"
    projectedPayloadJson: string
    updatedAt: string
  },
): Promise<CommunityPostProjectionRow | null> {
  const result = await client.execute({
    sql: `
      UPDATE community_post_projections
      SET status = ?2,
          projected_payload_json = ?3,
          updated_at = ?4
      WHERE source_post_id = ?1
        AND projection_version = 1
    `,
    args: [
      input.sourcePostId,
      input.status,
      input.projectedPayloadJson,
      input.updatedAt,
    ],
  })
  if (result.rowsAffected === 0) {
    return null
  }
  return await getCommunityPostProjectionRowByPostId(client, input.sourcePostId)
}

export async function deleteCommunityPostProjection(
  client: Client,
  input: {
    sourcePostId: string
  },
): Promise<void> {
  await client.execute({
    sql: `
      DELETE FROM community_post_projections
      WHERE source_post_id = ?1
    `,
    args: [input.sourcePostId],
  })
}

export async function reconcileCommunityPostProjection(
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
    updatedAt: string
  },
): Promise<CommunityPostProjectionRow> {
  const projectionId = makeId("cpp")
  const auditEventId = makeId("aud")
  const tx = await client.transaction("write")

  try {
    const existing = await getCommunityPostProjectionRowByPostId(tx, input.sourcePostId)
    if (existing) {
      await tx.batch([
        {
          sql: `
            UPDATE community_post_projections
            SET status = ?2,
                projected_payload_json = ?3,
                updated_at = ?4
            WHERE source_post_id = ?1
              AND projection_version = 1
          `,
          args: [input.sourcePostId, input.status, input.projectedPayloadJson, input.updatedAt],
        },
        {
          sql: `
            INSERT INTO audit_log (
              audit_event_id, actor_type, actor_id, action, target_type, target_id, community_id, metadata_json, created_at
            ) VALUES (
              ?1, 'system', 'system:post_projection_reconciler', 'community.post_projection_reconciled', 'post', ?2, ?3, ?4, ?5
            )
          `,
          args: [
            auditEventId,
            input.sourcePostId,
            input.communityId,
            JSON.stringify({
              projection_id: existing.projection_id,
              mode: "updated",
            }),
            input.updatedAt,
          ],
        },
      ])
    } else {
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
            input.updatedAt,
          ],
        },
        {
          sql: `
            INSERT INTO audit_log (
              audit_event_id, actor_type, actor_id, action, target_type, target_id, community_id, metadata_json, created_at
            ) VALUES (
              ?1, 'system', 'system:post_projection_reconciler', 'community.post_projection_reconciled', 'post', ?2, ?3, ?4, ?5
            )
          `,
          args: [
            auditEventId,
            input.sourcePostId,
            input.communityId,
            JSON.stringify({
              projection_id: projectionId,
              mode: "created",
              source_created_at: input.sourceCreatedAt,
            }),
            input.updatedAt,
          ],
        },
      ])
    }

    const projection = await getCommunityPostProjectionRowByPostId(tx, input.sourcePostId)
    if (!projection) {
      throw internalError("Community post projection is missing after reconcile")
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
          projected_member_count, projected_qualified_member_count, created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, 'active', 'provisioning', 'none', NULL, ?4, NULL, 'pending_create',
          ?5, NULL, NULL, NULL, 1, 1, ?6, ?6
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
    tableRefs: {
      attemptsTableName: string
      clubRegistryTableName: string
      clubNamespaceTableName: string
      publisherKind: "direct_key"
    }
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
          INSERT INTO community_registry_table_refs (
            community_id, tableland_chain_id, attempts_table_name, club_registry_table_name,
            club_namespace_table_name, publisher_kind, last_published_snapshot_hash,
            last_publish_attempted_at, last_publish_succeeded_at, created_at, updated_at
          ) VALUES (
            ?1, 84532, ?2, ?3,
            ?4, ?5, NULL,
            ?6, ?6, ?6, ?6
          )
          ON CONFLICT(community_id) DO UPDATE SET
            tableland_chain_id = excluded.tableland_chain_id,
            attempts_table_name = excluded.attempts_table_name,
            club_registry_table_name = excluded.club_registry_table_name,
            club_namespace_table_name = excluded.club_namespace_table_name,
            publisher_kind = excluded.publisher_kind,
            last_publish_attempted_at = excluded.last_publish_attempted_at,
            last_publish_succeeded_at = excluded.last_publish_succeeded_at,
            updated_at = excluded.updated_at
        `,
        args: [
          input.communityId,
          input.tableRefs.attemptsTableName,
          input.tableRefs.clubRegistryTableName,
          input.tableRefs.clubNamespaceTableName,
          input.tableRefs.publisherKind,
          input.createdAt,
        ],
      },
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
  getCommunityByRouteKey(routeKey: string): Promise<CommunityRow | null>
  getCommunityByNamespaceLabel(input: {
    normalizedLabel: string
    family: "spaces"
  }): Promise<CommunityRow | null>
  getCommunityByNamespaceVerificationId(namespaceVerificationId: string): Promise<CommunityRow | null>
  listCommunitiesByCreatorUserId(creatorUserId: string): Promise<CommunityRow[]>
  getPrimaryCommunityDatabaseBinding(communityId: string): Promise<CommunityDatabaseBindingRow | null>
  getCommunityMoneyPolicyByCommunityId(communityId: string): Promise<CommunityMoneyPolicyRow | null>
  getCommunityPricingPolicyByCommunityId(communityId: string): Promise<CommunityPricingPolicyRow | null>
  getJobById(jobId: string): Promise<JobRow | null>
  getLatestCommunityProvisioningJob(communityId: string): Promise<JobRow | null>
  listActiveCommunities(): Promise<CommunityRow[]>
  updateCommunityProjectedMembershipCounts(input: {
    communityId: string
    memberCount: number
    qualifiedMemberCount: number
  }): Promise<void>
  getCommunityPostProjectionByPostId(postId: string): Promise<CommunityPostProjectionRow | null>
  listRecentCommunityPostProjections(input: {
    limit: number
    cursor?: { createdAt: string; postId: string } | null
    communityIds?: string[] | null
  }): Promise<CommunityPostProjectionRow[]>
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
  upsertCommunityMoneyPolicy(input: {
    communityId: string
    fundingPreference: string
    acceptedFundingAssetsJson: string
    acceptedSourceChainsJson: string
    approvedRouteProvidersJson: string | null
    destinationSettlementChainJson: string
    destinationSettlementToken: string
    treasuryDenomination: string | null
    maxSlippageBps: number
    quoteTtlSeconds: number
    routeRequired: boolean
    routeStatusPolicy: CommunityMoneyPolicyRow["route_status_policy"]
    routeHopTolerance: number
    updatedAt: string
  }): Promise<void>
  upsertCommunityPricingPolicy(input: {
    communityId: string
    regionalPricingEnabled: boolean
    verificationProviderRequirement: CommunityPricingPolicyRow["verification_provider_requirement"]
    defaultTierKey: string | null
    tiersJson: string
    countryAssignmentsJson: string
    sourceTemplateId: string | null
    sourceTemplateVersion: string | null
    pricingPolicyVersion: string
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
  updateCommunityPostProjection(input: {
    sourcePostId: string
    status: "draft" | "published" | "hidden" | "removed" | "deleted"
    projectedPayloadJson: string
    updatedAt: string
  }): Promise<CommunityPostProjectionRow | null>
  deleteCommunityPostProjection(input: {
    sourcePostId: string
  }): Promise<void>
  reconcileCommunityPostProjection(input: {
    communityId: string
    sourcePostId: string
    authorUserId: string | null
    identityMode: "public" | "anonymous"
    postType: "text" | "image" | "video" | "link" | "song"
    status: "draft" | "published" | "hidden" | "removed" | "deleted"
    sourceCreatedAt: string
    projectedPayloadJson: string
    updatedAt: string
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
    tableRefs: {
      attemptsTableName: string
      clubRegistryTableName: string
      clubNamespaceTableName: string
      publisherKind: "direct_key"
    }
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
  markCommunityRegistryStale(input: {
    communityId: string
    updatedAt: string
  }): Promise<CommunityRow>
}

export class ControlPlaneCommunityRepository implements CommunityRepository {
  constructor(private readonly client: ControlPlaneDbClient) {}

  async getCommunityById(communityId: string): Promise<CommunityRow | null> {
    return getCommunityById(this.client, communityId)
  }

  async getCommunityByRouteKey(routeKey: string): Promise<CommunityRow | null> {
    return getCommunityByRouteKey(this.client, routeKey)
  }

  async getCommunityByNamespaceLabel(input: {
    normalizedLabel: string
    family: "spaces"
  }): Promise<CommunityRow | null> {
    return getCommunityByNamespaceLabel(this.client, input)
  }

  async getCommunityByNamespaceVerificationId(namespaceVerificationId: string): Promise<CommunityRow | null> {
    return getCommunityByNamespaceVerificationId(this.client, namespaceVerificationId)
  }

  async listCommunitiesByCreatorUserId(creatorUserId: string): Promise<CommunityRow[]> {
    return listCommunitiesByCreatorUserId(this.client, creatorUserId)
  }

  async getPrimaryCommunityDatabaseBinding(communityId: string): Promise<CommunityDatabaseBindingRow | null> {
    return getPrimaryCommunityDatabaseBinding(this.client, communityId)
  }

  async getCommunityMoneyPolicyByCommunityId(communityId: string): Promise<CommunityMoneyPolicyRow | null> {
    return getCommunityMoneyPolicyByCommunityId(this.client, communityId)
  }

  async getCommunityPricingPolicyByCommunityId(communityId: string): Promise<CommunityPricingPolicyRow | null> {
    return getCommunityPricingPolicyByCommunityId(this.client, communityId)
  }

  async getJobById(jobId: string): Promise<JobRow | null> {
    return getJobById(this.client, jobId)
  }

  async getLatestCommunityProvisioningJob(communityId: string): Promise<JobRow | null> {
    return getLatestCommunityProvisioningJob(this.client, communityId)
  }

  async listActiveCommunities(): Promise<CommunityRow[]> {
    return listActiveCommunities(this.client)
  }

  async updateCommunityProjectedMembershipCounts(input: {
    communityId: string
    memberCount: number
    qualifiedMemberCount: number
  }): Promise<void> {
    await this.client.execute({
      sql: `
        UPDATE communities
        SET projected_member_count = ?2,
            projected_qualified_member_count = ?3
        WHERE community_id = ?1
      `,
      args: [input.communityId, input.memberCount, input.qualifiedMemberCount],
    })
  }

  async getCommunityPostProjectionByPostId(postId: string): Promise<CommunityPostProjectionRow | null> {
    return getCommunityPostProjectionByPostId(this.client, postId)
  }

  async listRecentCommunityPostProjections(input: {
    limit: number
    cursor?: { createdAt: string; postId: string } | null
    communityIds?: string[] | null
  }): Promise<CommunityPostProjectionRow[]> {
    return listRecentCommunityPostProjections(this.client, input)
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

  async upsertCommunityMoneyPolicy(input: {
    communityId: string
    fundingPreference: string
    acceptedFundingAssetsJson: string
    acceptedSourceChainsJson: string
    approvedRouteProvidersJson: string | null
    destinationSettlementChainJson: string
    destinationSettlementToken: string
    treasuryDenomination: string | null
    maxSlippageBps: number
    quoteTtlSeconds: number
    routeRequired: boolean
    routeStatusPolicy: CommunityMoneyPolicyRow["route_status_policy"]
    routeHopTolerance: number
    updatedAt: string
  }): Promise<void> {
    return upsertCommunityMoneyPolicy(this.client, input)
  }

  async upsertCommunityPricingPolicy(input: {
    communityId: string
    regionalPricingEnabled: boolean
    verificationProviderRequirement: CommunityPricingPolicyRow["verification_provider_requirement"]
    defaultTierKey: string | null
    tiersJson: string
    countryAssignmentsJson: string
    sourceTemplateId: string | null
    sourceTemplateVersion: string | null
    pricingPolicyVersion: string
    updatedAt: string
  }): Promise<void> {
    return upsertCommunityPricingPolicy(this.client, input)
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

  async updateCommunityPostProjection(input: {
    sourcePostId: string
    status: "draft" | "published" | "hidden" | "removed" | "deleted"
    projectedPayloadJson: string
    updatedAt: string
  }): Promise<CommunityPostProjectionRow | null> {
    return updateCommunityPostProjection(this.client, input)
  }

  async deleteCommunityPostProjection(input: {
    sourcePostId: string
  }): Promise<void> {
    return deleteCommunityPostProjection(this.client, input)
  }

  async reconcileCommunityPostProjection(input: {
    communityId: string
    sourcePostId: string
    authorUserId: string | null
    identityMode: "public" | "anonymous"
    postType: "text" | "image" | "video" | "link" | "song"
    status: "draft" | "published" | "hidden" | "removed" | "deleted"
    sourceCreatedAt: string
    projectedPayloadJson: string
    updatedAt: string
  }): Promise<CommunityPostProjectionRow> {
    return reconcileCommunityPostProjection(this.client, input)
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
    tableRefs: {
      attemptsTableName: string
      clubRegistryTableName: string
      clubNamespaceTableName: string
      publisherKind: "direct_key"
    }
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

  async markCommunityRegistryStale(input: {
    communityId: string
    updatedAt: string
  }): Promise<CommunityRow> {
    await this.client.execute({
      sql: `
        UPDATE communities
        SET registry_publication_state = 'stale',
            registry_error_code = NULL,
            updated_at = ?2
        WHERE community_id = ?1
          AND registry_publication_state = 'published'
      `,
      args: [input.communityId, input.updatedAt],
    })

    const row = await getCommunityById(this.client, input.communityId)
    if (!row) {
      throw internalError("Community row missing after registry stale update")
    }
    return row
  }
}

const globalScope = globalThis as typeof globalThis & {
  __pirateControlPlaneCommunityRepository?: ControlPlaneCommunityRepository
  __pirateControlPlaneCommunityRepositoryKey?: string
}

export function getControlPlaneCommunityRepository(env: Env): ControlPlaneCommunityRepository {
  const cacheKey = requireControlPlaneDbUrl(env)

  if (
    globalScope.__pirateControlPlaneCommunityRepository
    && globalScope.__pirateControlPlaneCommunityRepositoryKey === cacheKey
  ) {
    return globalScope.__pirateControlPlaneCommunityRepository
  }

  const repository = new ControlPlaneCommunityRepository(createControlPlaneDbClient(env))
  globalScope.__pirateControlPlaneCommunityRepository = repository
  globalScope.__pirateControlPlaneCommunityRepositoryKey = cacheKey
  return repository
}
