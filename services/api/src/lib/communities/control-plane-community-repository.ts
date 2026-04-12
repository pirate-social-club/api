import { createHash } from "node:crypto"
import { internalError } from "../errors"
import { makeId } from "../helpers"
import {
  createControlPlaneDbClient,
  type ControlPlaneDbClient,
  type ControlPlaneDbExecutor,
} from "../control-plane-db"
import {
  getActiveCommunityDbCredentialRowByBindingId,
  getCommunityDatabaseBindingRowById,
  getCommunityMoneyPolicyRowByCommunityId,
  getCommunityPricingPolicyRowByCommunityId,
  getCommunityPostProjectionRowByPostId,
  listCommunityRowsByCreatorUserId,
  getCommunityRowById,
  getCommunityRowByNamespaceLabel,
  getCommunityRowByRouteKey,
  getCommunityRowByNamespaceVerificationId,
  getJobRowById,
  getLatestCommunityProvisioningJobRow,
  getPrimaryCommunityDatabaseBindingRow,
  requireControlPlaneDbUrl,
} from "../auth/control-plane-auth-queries"
import type {
  CommunityDatabaseBindingRow,
  CommunityDbCredentialRow,
  CommunityMoneyPolicyRow,
  CommunityPricingPolicyRow,
  CommunityPostProjectionRow,
  CommunityRow,
  JobRow,
} from "../auth/control-plane-auth-rows"
import { toCommunityPostProjectionRow, toCommunityRow } from "../auth/control-plane-auth-rows"
import {
  decryptCommunityDbCredential,
  encryptCommunityDbCredential,
} from "./community-db-credential-crypto"
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

export async function getActiveCommunityDbCredential(
  client: ControlPlaneDbClient,
  communityDatabaseBindingId: string,
): Promise<CommunityDbCredentialRow | null> {
  return getActiveCommunityDbCredentialRowByBindingId(client, communityDatabaseBindingId)
}

async function upsertCommunityDatabaseBindingRow(
  executor: ControlPlaneDbExecutor,
  input: {
    communityDatabaseBindingId: string
    communityId: string
    organizationSlug: string
    groupName: string
    groupId: string | null
    databaseName: string
    databaseId: string | null
    databaseUrl: string
    location: string | null
    status: CommunityDatabaseBindingRow["status"]
    createdAt: string
    updatedAt: string
  },
): Promise<CommunityDatabaseBindingRow> {
  await executor.execute({
    sql: `
      INSERT INTO community_database_bindings (
        community_database_binding_id, community_id, binding_role, organization_slug, group_name, group_id,
        database_name, database_id, database_url, location, status, transferred_at, created_at, updated_at
      ) VALUES (
        ?1, ?2, 'primary', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, ?11, ?12
      )
      ON CONFLICT(community_database_binding_id) DO UPDATE SET
        community_id = excluded.community_id,
        binding_role = excluded.binding_role,
        organization_slug = excluded.organization_slug,
        group_name = excluded.group_name,
        group_id = excluded.group_id,
        database_name = excluded.database_name,
        database_id = excluded.database_id,
        database_url = excluded.database_url,
        location = excluded.location,
        status = excluded.status,
        transferred_at = excluded.transferred_at,
        updated_at = excluded.updated_at
    `,
    args: [
      input.communityDatabaseBindingId,
      input.communityId,
      input.organizationSlug,
      input.groupName,
      input.groupId,
      input.databaseName,
      input.databaseId,
      input.databaseUrl,
      input.location,
      input.status,
      input.createdAt,
      input.updatedAt,
    ],
  })

  const row = await getCommunityDatabaseBindingRowById(executor, input.communityDatabaseBindingId)
  if (!row) {
    throw internalError("Community database binding row is missing after upsert")
  }

  return row
}

async function upsertActiveCommunityDbCredentialExecutor(
  executor: ControlPlaneDbExecutor,
  input: {
    communityDbCredentialId: string
    communityDatabaseBindingId: string
    tokenName: string
    encryptedToken: string
    encryptionKeyVersion: number
    issuedAt: string
    expiresAt?: string | null
    updatedAt: string
  },
): Promise<CommunityDbCredentialRow> {
  await executor.execute({
    sql: `
      UPDATE community_db_credentials
      SET status = 'superseded',
          invalidated_at = ?2,
          updated_at = ?2
      WHERE community_database_binding_id = ?1
        AND status = 'active'
    `,
    args: [input.communityDatabaseBindingId, input.updatedAt],
  })

  await executor.execute({
    sql: `
      INSERT INTO community_db_credentials (
        community_db_credential_id,
        community_database_binding_id,
        credential_kind,
        token_name,
        encrypted_token,
        encryption_key_version,
        token_scope,
        status,
        issued_at,
        invalidated_at,
        expires_at,
        created_at,
        updated_at
      ) VALUES (
        ?1, ?2, 'database_token', ?3, ?4, ?5, 'database', 'active',
        ?6, NULL, ?7, ?8, ?8
      )
    `,
    args: [
      input.communityDbCredentialId,
      input.communityDatabaseBindingId,
      input.tokenName,
      input.encryptedToken,
      input.encryptionKeyVersion,
      input.issuedAt,
      input.expiresAt ?? null,
      input.updatedAt,
    ],
  })

  const credential = await getActiveCommunityDbCredentialRowByBindingId(executor, input.communityDatabaseBindingId)
  if (!credential) {
    throw internalError("Community DB credential row is missing after upsert")
  }

  return credential
}

export async function upsertActiveCommunityDbCredential(
  client: ControlPlaneDbClient,
  input: {
    communityDbCredentialId: string
    communityDatabaseBindingId: string
    tokenName: string
    encryptedToken: string
    encryptionKeyVersion: number
    issuedAt: string
    expiresAt?: string | null
    updatedAt: string
  },
): Promise<CommunityDbCredentialRow> {
  const tx = await client.transaction("write")

  try {
    const credential = await upsertActiveCommunityDbCredentialExecutor(tx, input)
    await tx.commit()
    return credential
  } catch (error) {
    try {
      await tx.rollback()
    } catch {}
    throw error
  } finally {
    tx.close()
  }
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
             route_slug, namespace_verification_id, primary_database_binding_id,
             projected_member_count, projected_qualified_member_count, created_at, updated_at
      FROM communities
      WHERE status = 'active'
        AND provisioning_state = 'active'
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
  const hasCursor = Boolean(input.cursor?.createdAt && input.cursor?.postId)
  const communityFilterStartIndex = hasCursor ? 3 : 1
  const communityFilter = communityIds.length > 0
    ? `AND cpp.community_id IN (${communityIds.map((_, index) => `?${index + communityFilterStartIndex}`).join(", ")})`
    : ""
  const limitIndex = communityIds.length + communityFilterStartIndex

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
        ${hasCursor
          ? `AND (
          cpp.source_created_at < ?1
          OR (cpp.source_created_at = ?1 AND cpp.source_post_id < ?2)
        )`
          : ""}
      ORDER BY cpp.source_created_at DESC, cpp.source_post_id DESC
      LIMIT ?${limitIndex}
    `,
    args: hasCursor
      ? [
          input.cursor!.createdAt,
          input.cursor!.postId,
          ...communityIds,
          input.limit,
        ]
      : [
          ...communityIds,
          input.limit,
        ],
  })

  return result.rows.map((row) => toCommunityPostProjectionRow(row))
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
    jobId: string
    creatorUserId: string
    displayName: string
    namespaceVerificationId: string
    provisioningMode: string
    bindingSeed: {
      organizationSlug: string
      groupName: string
      databaseName: string
      databaseUrl: string
      location: string | null
      status: CommunityDatabaseBindingRow["status"]
    }
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
          route_slug, namespace_verification_id, primary_database_binding_id,
          projected_member_count, projected_qualified_member_count, created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, 'active', 'provisioning', 'none', NULL, ?4, NULL, 1, 1, ?5, ?5
        )
      `,
      args: [
        input.communityId,
        input.creatorUserId,
        input.displayName,
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
          ?1, ?2, 'primary', ?3, ?4, NULL, ?5, NULL, ?6, ?7, ?8, NULL, ?9, ?9
        )
      `,
      args: [
        input.communityDatabaseBindingId,
        input.communityId,
        input.bindingSeed.organizationSlug,
        input.bindingSeed.groupName,
        input.bindingSeed.databaseName,
        input.bindingSeed.databaseUrl,
        input.bindingSeed.location,
        input.bindingSeed.status,
        input.createdAt,
      ],
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
          mode: input.provisioningMode,
          database_url: input.bindingSeed.databaseUrl,
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
    provisioningMode: string
    fallbackBindingSeed: {
      organizationSlug: string
      groupName: string
      databaseName: string
      databaseUrl: string
      location: string | null
      status: CommunityDatabaseBindingRow["status"]
    }
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
            ?1, ?2, 'primary', ?3, ?4, NULL, ?5, NULL, ?6, ?7, ?8, NULL, ?9, ?9
          )
        `,
        args: [
          input.fallbackBindingId,
          input.communityId,
          input.fallbackBindingSeed.organizationSlug,
          input.fallbackBindingSeed.groupName,
          input.fallbackBindingSeed.databaseName,
          input.fallbackBindingSeed.databaseUrl,
          input.fallbackBindingSeed.location,
          input.fallbackBindingSeed.status,
          input.createdAt,
        ],
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
            updated_at = ?2
        WHERE community_id = ?1
      `,
      args: [input.communityId, input.createdAt],
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
          mode: input.provisioningMode,
          database_url: bindingRow?.database_url ?? input.fallbackBindingSeed.databaseUrl,
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

export async function completeCommunityProvisioning(
  client: Client,
  env: Pick<Env, "TURSO_COMMUNITY_DB_WRAP_KEY">,
  input: {
    communityId: string
    communityDatabaseBindingId: string
    jobId: string
    actorUserId: string
    resultRef: string | null
    createdAt: string
    metadata: Record<string, unknown>
    binding: {
      organizationSlug: string
      groupName: string
      groupId: string | null
      databaseName: string
      databaseId: string | null
      databaseUrl: string
      location: string | null
      status: CommunityDatabaseBindingRow["status"]
      createdAt: string
      updatedAt: string
    }
    credential: {
      tokenName: string
      plaintextToken: string
      encryptionKeyVersion: number
      issuedAt: string
      expiresAt?: string | null
      updatedAt: string
    }
  },
): Promise<{
  community: CommunityRow
  job: JobRow
  binding: CommunityDatabaseBindingRow
  credential: CommunityDbCredentialRow
}> {
  const tx = await client.transaction("write")
  const auditEventId = makeId("aud")

  try {
    const binding = await upsertCommunityDatabaseBindingRow(tx, {
      communityDatabaseBindingId: input.communityDatabaseBindingId,
      communityId: input.communityId,
      organizationSlug: input.binding.organizationSlug,
      groupName: input.binding.groupName,
      groupId: input.binding.groupId,
      databaseName: input.binding.databaseName,
      databaseId: input.binding.databaseId,
      databaseUrl: input.binding.databaseUrl,
      location: input.binding.location,
      status: input.binding.status,
      createdAt: input.binding.createdAt,
      updatedAt: input.binding.updatedAt,
    })

    const credential = await upsertActiveCommunityDbCredentialExecutor(tx, {
      communityDbCredentialId: makeId("cdc"),
      communityDatabaseBindingId: input.communityDatabaseBindingId,
      tokenName: input.credential.tokenName,
      encryptedToken: encryptCommunityDbCredential({
        plaintextToken: input.credential.plaintextToken,
        wrapKey: env.TURSO_COMMUNITY_DB_WRAP_KEY,
      }),
      encryptionKeyVersion: input.credential.encryptionKeyVersion,
      issuedAt: input.credential.issuedAt,
      expiresAt: input.credential.expiresAt ?? null,
      updatedAt: input.credential.updatedAt,
    })

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
    return { community: communityRow, job: jobRow, binding, credential }
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
  getActiveCommunityDatabaseAuthToken(communityDatabaseBindingId: string): Promise<string | null>
  upsertActiveCommunityDatabaseCredential(input: {
    communityDatabaseBindingId: string
    tokenName: string
    plaintextToken: string
    encryptionKeyVersion: number
    issuedAt: string
    expiresAt?: string | null
    updatedAt: string
  }): Promise<CommunityDbCredentialRow>
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
    jobId: string
    creatorUserId: string
    displayName: string
    namespaceVerificationId: string
    provisioningMode: string
    bindingSeed: {
      organizationSlug: string
      groupName: string
      databaseName: string
      databaseUrl: string
      location: string | null
      status: CommunityDatabaseBindingRow["status"]
    }
    createdAt: string
  }): Promise<{
    community: CommunityRow
    binding: CommunityDatabaseBindingRow
    job: JobRow
  }>
  retryCommunityProvisioningRequest(input: {
    communityId: string
    fallbackBindingId: string
    jobId: string
    namespaceVerificationId: string
    provisioningMode: string
    fallbackBindingSeed: {
      organizationSlug: string
      groupName: string
      databaseName: string
      databaseUrl: string
      location: string | null
      status: CommunityDatabaseBindingRow["status"]
    }
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
  completeCommunityProvisioning(input: {
    communityId: string
    communityDatabaseBindingId: string
    jobId: string
    actorUserId: string
    resultRef: string | null
    createdAt: string
    metadata: Record<string, unknown>
    binding: {
      organizationSlug: string
      groupName: string
      groupId: string | null
      databaseName: string
      databaseId: string | null
      databaseUrl: string
      location: string | null
      status: CommunityDatabaseBindingRow["status"]
      createdAt: string
      updatedAt: string
    }
    credential: {
      tokenName: string
      plaintextToken: string
      encryptionKeyVersion: number
      issuedAt: string
      expiresAt?: string | null
      updatedAt: string
    }
  }): Promise<{
    community: CommunityRow
    job: JobRow
    binding: CommunityDatabaseBindingRow
    credential: CommunityDbCredentialRow
  }>
  markCommunityProvisioningFailed(input: {
    communityId: string
    jobId: string
    actorUserId: string
    errorCode: string
    createdAt: string
    metadata: Record<string, unknown>
  }): Promise<void>
}

export class ControlPlaneCommunityRepository implements CommunityRepository {
  constructor(
    private readonly client: ControlPlaneDbClient,
    private readonly env: Pick<Env, "TURSO_COMMUNITY_DB_WRAP_KEY">,
  ) {}

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

  async getActiveCommunityDatabaseAuthToken(communityDatabaseBindingId: string): Promise<string | null> {
    const credential = await getActiveCommunityDbCredential(this.client, communityDatabaseBindingId)
    if (!credential) {
      return null
    }
    return decryptCommunityDbCredential({
      encryptedToken: credential.encrypted_token,
      encryptionKeyVersion: credential.encryption_key_version,
      wrapKey: this.env.TURSO_COMMUNITY_DB_WRAP_KEY,
    })
  }

  async upsertActiveCommunityDatabaseCredential(input: {
    communityDatabaseBindingId: string
    tokenName: string
    plaintextToken: string
    encryptionKeyVersion: number
    issuedAt: string
    expiresAt?: string | null
    updatedAt: string
  }): Promise<CommunityDbCredentialRow> {
    const encryptedToken = encryptCommunityDbCredential({
      plaintextToken: input.plaintextToken,
      wrapKey: this.env.TURSO_COMMUNITY_DB_WRAP_KEY,
    })

    return upsertActiveCommunityDbCredential(this.client, {
      communityDbCredentialId: makeId("cdc"),
      communityDatabaseBindingId: input.communityDatabaseBindingId,
      tokenName: input.tokenName,
      encryptedToken,
      encryptionKeyVersion: input.encryptionKeyVersion,
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt ?? null,
      updatedAt: input.updatedAt,
    })
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
    jobId: string
    creatorUserId: string
    displayName: string
    namespaceVerificationId: string
    provisioningMode: string
    bindingSeed: {
      organizationSlug: string
      groupName: string
      databaseName: string
      databaseUrl: string
      location: string | null
      status: CommunityDatabaseBindingRow["status"]
    }
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
    jobId: string
    namespaceVerificationId: string
    provisioningMode: string
    fallbackBindingSeed: {
      organizationSlug: string
      groupName: string
      databaseName: string
      databaseUrl: string
      location: string | null
      status: CommunityDatabaseBindingRow["status"]
    }
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

  async completeCommunityProvisioning(input: {
    communityId: string
    communityDatabaseBindingId: string
    jobId: string
    actorUserId: string
    resultRef: string | null
    createdAt: string
    metadata: Record<string, unknown>
    binding: {
      organizationSlug: string
      groupName: string
      groupId: string | null
      databaseName: string
      databaseId: string | null
      databaseUrl: string
      location: string | null
      status: CommunityDatabaseBindingRow["status"]
      createdAt: string
      updatedAt: string
    }
    credential: {
      tokenName: string
      plaintextToken: string
      encryptionKeyVersion: number
      issuedAt: string
      expiresAt?: string | null
      updatedAt: string
    }
  }): Promise<{
    community: CommunityRow
    job: JobRow
    binding: CommunityDatabaseBindingRow
    credential: CommunityDbCredentialRow
  }> {
    return completeCommunityProvisioning(this.client, this.env, input)
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
}

const globalScope = globalThis as typeof globalThis & {
  __pirateControlPlaneCommunityRepository?: ControlPlaneCommunityRepository
  __pirateControlPlaneCommunityRepositoryKey?: string
}

function canCacheControlPlaneCommunityRepository(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"
}

export function getControlPlaneCommunityRepository(env: Env): ControlPlaneCommunityRepository {
  const cacheKey = [
    requireControlPlaneDbUrl(env),
    createHash("sha256").update(String(env.TURSO_COMMUNITY_DB_WRAP_KEY || "")).digest("hex"),
  ].join("::")

  if (
    canCacheControlPlaneCommunityRepository()
    && (
    globalScope.__pirateControlPlaneCommunityRepository
    && globalScope.__pirateControlPlaneCommunityRepositoryKey === cacheKey
    )
  ) {
    return globalScope.__pirateControlPlaneCommunityRepository
  }

  const repository = new ControlPlaneCommunityRepository(createControlPlaneDbClient(env), env)
  if (canCacheControlPlaneCommunityRepository()) {
    globalScope.__pirateControlPlaneCommunityRepository = repository
    globalScope.__pirateControlPlaneCommunityRepositoryKey = cacheKey
  }
  return repository
}
