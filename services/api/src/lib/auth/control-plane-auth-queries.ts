import { internalError } from "../errors"
import { makeId, nowIso } from "../helpers"
import { requireControlPlaneDatabaseUrl } from "../control-plane-db"
import {
  assembleProfile,
  parseRedditImportSummary,
  parseVerificationCapabilities,
  serializeGlobalHandle,
  serializeUser,
  serializeWalletAttachments,
} from "./control-plane-auth-serializers"
import {
  type ExternalReputationSnapshotRow,
  type CommunityDatabaseBindingRow,
  type CommunityMoneyPolicyRow,
  type CommunityPricingPolicyRow,
  type CommunityRegistryAttemptRow,
  type CommunityPostProjectionRow,
  type CommunityRow,
  type DbExecutor,
  type GlobalHandleRow,
  type JobRow,
  type NamespaceVerificationRow,
  type NamespaceVerificationSessionRow,
  type ProfileRow,
  type RedditVerificationSessionRow,
  type SessionSnapshot,
  type UserRow,
  type VerificationSessionRow,
  type WalletAttachmentRow,
  toExternalReputationSnapshotRow,
  toCommunityDatabaseBindingRow,
  toCommunityMoneyPolicyRow,
  toCommunityPricingPolicyRow,
  toCommunityRegistryAttemptRow,
  toCommunityPostProjectionRow,
  toCommunityRow,
  toGlobalHandleRow,
  toJobRow,
  toNamespaceVerificationRow,
  toNamespaceVerificationSessionRow,
  toProfileRow,
  toRedditVerificationSessionRow,
  toUserRow,
  toVerificationSessionRow,
  toWalletAttachmentRow,
} from "./control-plane-auth-rows"
import type { Env, OnboardingStatus, UpstreamIdentity } from "../../types"
import { isCleanupRenameAvailable } from "./global-handle-policy"

type InStatement = {
  sql: string
  args?: Array<string | number | boolean | null>
}

type AuthProviderLinkRow = {
  user_id: string
}

export function requireControlPlaneDbUrl(env: Env): string {
  return requireControlPlaneDatabaseUrl(env)
}

function parseUniqueConstraintFields(error: unknown): string[] {
  const message = error instanceof Error ? error.message : String(error)
  const match = /UNIQUE constraint failed: (.+)$/i.exec(message)
  if (!match?.[1]) {
    return []
  }
  return match[1]
    .split(",")
    .map((field) => field.trim())
    .filter(Boolean)
}

export function hasUniqueConstraintField(error: unknown, field: string): boolean {
  return parseUniqueConstraintFields(error).includes(field)
}

function isMissingTableError(error: unknown, tableName: string): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes("no such table") && message.includes(tableName)
}

export async function firstRow(executor: DbExecutor, stmt: InStatement): Promise<unknown | null> {
  const result = await executor.execute(stmt)
  return result.rows[0] ?? null
}

async function getLatestVerificationSessionRow(executor: DbExecutor, userId: string): Promise<VerificationSessionRow | null> {
  const row = await firstRow(executor, {
    sql: `
      SELECT verification_session_id, user_id, provider, wallet_attachment_id, requested_capabilities_json,
             status, result_ref, failure_code, completed_at, expires_at, created_at, updated_at
      FROM verification_sessions
      WHERE user_id = ?1
      ORDER BY created_at DESC
      LIMIT 1
    `,
    args: [userId],
  })

  return row ? toVerificationSessionRow(row) : null
}

export async function getLatestRedditVerificationSessionRow(
  executor: DbExecutor,
  userId: string,
): Promise<RedditVerificationSessionRow | null> {
  const row = await firstRow(executor, {
    sql: `
      SELECT reddit_verification_session_id, user_id, reddit_username, verification_code, code_placement_surface,
             status, verification_hint, failure_code, checked_count, last_checked_at, verified_at,
             expires_at, created_at, updated_at
      FROM reddit_verification_sessions
      WHERE user_id = ?1
      ORDER BY created_at DESC
      LIMIT 1
    `,
    args: [userId],
  }).catch((error) => {
    if (isMissingTableError(error, "reddit_verification_sessions")) {
      return null
    }
    throw error
  })

  return row ? toRedditVerificationSessionRow(row) : null
}

export async function getLatestRedditVerificationSessionRowForUsername(
  executor: DbExecutor,
  userId: string,
  redditUsername: string,
): Promise<RedditVerificationSessionRow | null> {
  const row = await firstRow(executor, {
    sql: `
      SELECT reddit_verification_session_id, user_id, reddit_username, verification_code, code_placement_surface,
             status, verification_hint, failure_code, checked_count, last_checked_at, verified_at,
             expires_at, created_at, updated_at
      FROM reddit_verification_sessions
      WHERE user_id = ?1
        AND reddit_username = ?2
      ORDER BY created_at DESC
      LIMIT 1
    `,
    args: [userId, redditUsername],
  }).catch((error) => {
    if (isMissingTableError(error, "reddit_verification_sessions")) {
      return null
    }
    throw error
  })

  return row ? toRedditVerificationSessionRow(row) : null
}

export async function getLatestVerifiedRedditVerificationSessionRow(
  executor: DbExecutor,
  userId: string,
): Promise<RedditVerificationSessionRow | null> {
  const row = await firstRow(executor, {
    sql: `
      SELECT reddit_verification_session_id, user_id, reddit_username, verification_code, code_placement_surface,
             status, verification_hint, failure_code, checked_count, last_checked_at, verified_at,
             expires_at, created_at, updated_at
      FROM reddit_verification_sessions
      WHERE user_id = ?1
        AND status = 'verified'
      ORDER BY verified_at DESC, created_at DESC
      LIMIT 1
    `,
    args: [userId],
  }).catch((error) => {
    if (isMissingTableError(error, "reddit_verification_sessions")) {
      return null
    }
    throw error
  })

  return row ? toRedditVerificationSessionRow(row) : null
}

export async function getLatestExternalReputationSnapshotRow(
  executor: DbExecutor,
  userId: string,
): Promise<ExternalReputationSnapshotRow | null> {
  const row = await firstRow(executor, {
    sql: `
      SELECT external_reputation_snapshot_id, user_id, source_platform, snapshot_type, source_account_handle,
             proof_method, captured_at, snapshot_payload_json, created_at, updated_at
      FROM external_reputation_snapshots
      WHERE user_id = ?1
        AND source_platform = 'reddit'
        AND snapshot_type = 'onboarding'
      ORDER BY captured_at DESC, created_at DESC
      LIMIT 1
    `,
    args: [userId],
  }).catch((error) => {
    if (isMissingTableError(error, "external_reputation_snapshots")) {
      return null
    }
    throw error
  })

  return row ? toExternalReputationSnapshotRow(row) : null
}

async function getLatestNamespaceVerificationSessionRow(executor: DbExecutor, userId: string): Promise<NamespaceVerificationSessionRow | null> {
  const row = await firstRow(executor, {
    sql: `
      SELECT namespace_verification_session_id, namespace_verification_id, user_id, family, submitted_root_label,
             normalized_root_label, status, challenge_host, challenge_txt_value, challenge_expires_at,
             challenge_kind, challenge_payload_json,
             root_exists, root_control_verified, expiry_horizon_sufficient, routing_enabled,
             pirate_dns_authority_verified, club_attach_allowed, pirate_web_routing_allowed,
             pirate_subdomain_issuance_allowed, control_class, operation_class, observation_provider,
             evidence_bundle_ref, failure_reason, accepted_at, expires_at,
             anchor_height, anchor_block_hash, anchor_root_hash, proof_root_hash,
             created_at, updated_at
      FROM namespace_verification_sessions
      WHERE user_id = ?1
      ORDER BY created_at DESC
      LIMIT 1
    `,
    args: [userId],
  }).catch((error) => {
    if (isMissingTableError(error, "namespace_verification_sessions")) {
      return null
    }
    throw error
  })

  return row ? toNamespaceVerificationSessionRow(row) : null
}

async function getLatestNamespaceVerificationRow(executor: DbExecutor, userId: string): Promise<NamespaceVerificationRow | null> {
  const row = await firstRow(executor, {
    sql: `
      SELECT namespace_verification_id, user_id, family, normalized_root_label, status,
             root_exists, root_control_verified, expiry_horizon_sufficient, routing_enabled,
             pirate_dns_authority_verified, club_attach_allowed, pirate_web_routing_allowed,
             pirate_subdomain_issuance_allowed, control_class, operation_class, observation_provider,
             evidence_bundle_ref, accepted_at, expires_at,
             anchor_height, anchor_block_hash, anchor_root_hash, proof_root_hash,
             created_at, updated_at
      FROM namespace_verifications
      WHERE user_id = ?1
      ORDER BY accepted_at DESC
      LIMIT 1
    `,
    args: [userId],
  }).catch((error) => {
    if (isMissingTableError(error, "namespace_verifications")) {
      return null
    }
    throw error
  })

  return row ? toNamespaceVerificationRow(row) : null
}

export async function getCommunityRowById(executor: DbExecutor, communityId: string): Promise<CommunityRow | null> {
  const row = await firstRow(executor, {
    sql: `
      SELECT community_id, creator_user_id, display_name, status, provisioning_state,
             registry_publication_state, registry_attempt_id, registry_published_at,
             registry_publication_job_id, registry_error_code, transfer_state,
             route_slug, namespace_verification_id, primary_database_binding_id,
             projected_member_count, projected_qualified_member_count, created_at, updated_at
      FROM communities
      WHERE community_id = ?1
      LIMIT 1
    `,
    args: [communityId],
  })

  return row ? toCommunityRow(row) : null
}

export async function getCommunityRowByNamespaceVerificationId(
  executor: DbExecutor,
  namespaceVerificationId: string,
): Promise<CommunityRow | null> {
  const row = await firstRow(executor, {
    sql: `
      SELECT community_id, creator_user_id, display_name, status, provisioning_state,
             registry_publication_state, registry_attempt_id, registry_published_at,
             registry_publication_job_id, registry_error_code, transfer_state,
             route_slug, namespace_verification_id, primary_database_binding_id,
             projected_member_count, projected_qualified_member_count, created_at, updated_at
      FROM communities
      WHERE namespace_verification_id = ?1
      LIMIT 1
    `,
    args: [namespaceVerificationId],
  })

  return row ? toCommunityRow(row) : null
}

export async function getCommunityRowByRouteKey(
  executor: DbExecutor,
  routeKey: string,
): Promise<CommunityRow | null> {
  const row = await firstRow(executor, {
    sql: `
      SELECT c.community_id, c.creator_user_id, c.display_name, c.status, c.provisioning_state,
             c.registry_publication_state, c.registry_attempt_id, c.registry_published_at,
             c.registry_publication_job_id, c.registry_error_code, c.transfer_state,
             c.route_slug, c.namespace_verification_id, c.primary_database_binding_id,
             c.projected_member_count, c.projected_qualified_member_count, c.created_at, c.updated_at
      FROM communities AS c
      LEFT JOIN namespace_verifications AS nv
        ON nv.namespace_verification_id = c.namespace_verification_id
      WHERE c.route_slug = ?1
         OR nv.normalized_root_label = ?1
      ORDER BY
        CASE
          WHEN c.route_slug = ?1 THEN 0
          WHEN nv.normalized_root_label = ?1 THEN 1
          ELSE 2
        END,
        c.created_at DESC,
        c.community_id DESC
      LIMIT 1
    `,
    args: [routeKey],
  })

  return row ? toCommunityRow(row) : null
}

export async function getCommunityRowByNamespaceLabel(
  executor: DbExecutor,
  input: {
    normalizedLabel: string
    family: "spaces"
  },
): Promise<CommunityRow | null> {
  const row = await firstRow(executor, {
    sql: `
      SELECT c.community_id, c.creator_user_id, c.display_name, c.status, c.provisioning_state,
             c.registry_publication_state, c.registry_attempt_id, c.registry_published_at,
             c.registry_publication_job_id, c.registry_error_code, c.transfer_state,
             c.route_slug, c.namespace_verification_id, c.primary_database_binding_id,
             c.projected_member_count, c.projected_qualified_member_count, c.created_at, c.updated_at
      FROM communities AS c
      INNER JOIN namespace_verifications AS nv
        ON nv.namespace_verification_id = c.namespace_verification_id
      WHERE nv.normalized_root_label = ?1
        AND nv.family = ?2
      ORDER BY c.created_at DESC, c.community_id DESC
      LIMIT 1
    `,
    args: [input.normalizedLabel, input.family],
  })

  return row ? toCommunityRow(row) : null
}

export async function listCommunityRowsByCreatorUserId(
  executor: DbExecutor,
  creatorUserId: string,
): Promise<CommunityRow[]> {
  const result = await executor.execute({
    sql: `
      SELECT community_id, creator_user_id, display_name, status, provisioning_state,
             registry_publication_state, registry_attempt_id, registry_published_at,
             registry_publication_job_id, registry_error_code, transfer_state,
             route_slug, namespace_verification_id, primary_database_binding_id,
             projected_member_count, projected_qualified_member_count, created_at, updated_at
      FROM communities
      WHERE creator_user_id = ?1
      ORDER BY created_at DESC, community_id DESC
    `,
    args: [creatorUserId],
  })

  return result.rows.map((row) => toCommunityRow(row))
}

export async function getCommunityDatabaseBindingRowById(
  executor: DbExecutor,
  communityDatabaseBindingId: string,
): Promise<CommunityDatabaseBindingRow | null> {
  const row = await firstRow(executor, {
    sql: `
      SELECT community_database_binding_id, community_id, binding_role, organization_slug, group_name, group_id,
             database_name, database_id, database_url, location, status, transferred_at, created_at, updated_at
      FROM community_database_bindings
      WHERE community_database_binding_id = ?1
      LIMIT 1
    `,
    args: [communityDatabaseBindingId],
  })

  return row ? toCommunityDatabaseBindingRow(row) : null
}

export async function getPrimaryCommunityDatabaseBindingRow(
  executor: DbExecutor,
  communityId: string,
): Promise<CommunityDatabaseBindingRow | null> {
  const row = await firstRow(executor, {
    sql: `
      SELECT community_database_binding_id, community_id, binding_role, organization_slug, group_name, group_id,
             database_name, database_id, database_url, location, status, transferred_at, created_at, updated_at
      FROM community_database_bindings
      WHERE community_id = ?1
        AND binding_role = 'primary'
      ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, created_at DESC
      LIMIT 1
    `,
    args: [communityId],
  })

  return row ? toCommunityDatabaseBindingRow(row) : null
}

export async function getCommunityMoneyPolicyRowByCommunityId(
  executor: DbExecutor,
  communityId: string,
): Promise<CommunityMoneyPolicyRow | null> {
  const row = await firstRow(executor, {
    sql: `
      SELECT community_id, funding_preference, accepted_funding_assets_json, accepted_source_chains_json,
             approved_route_providers_json, destination_settlement_chain_json, destination_settlement_token,
             treasury_denomination, max_slippage_bps, quote_ttl_seconds, route_required,
             route_status_policy, route_hop_tolerance, updated_at
      FROM community_money_policies
      WHERE community_id = ?1
      LIMIT 1
    `,
    args: [communityId],
  }).catch((error) => {
    if (isMissingTableError(error, "community_money_policies")) {
      return null
    }
    throw error
  })

  return row ? toCommunityMoneyPolicyRow(row) : null
}

export async function getCommunityPricingPolicyRowByCommunityId(
  executor: DbExecutor,
  communityId: string,
): Promise<CommunityPricingPolicyRow | null> {
  const row = await firstRow(executor, {
    sql: `
      SELECT community_id, regional_pricing_enabled, verification_provider_requirement, default_tier_key,
             tiers_json, country_assignments_json, source_template_id, source_template_version,
             pricing_policy_version, updated_at
      FROM community_pricing_policies
      WHERE community_id = ?1
      LIMIT 1
    `,
    args: [communityId],
  }).catch((error) => {
    if (isMissingTableError(error, "community_pricing_policies")) {
      return null
    }
    throw error
  })

  return row ? toCommunityPricingPolicyRow(row) : null
}

export async function getJobRowById(executor: DbExecutor, jobId: string): Promise<JobRow | null> {
  const row = await firstRow(executor, {
    sql: `
      SELECT job_id, job_type, job_scope, community_id, subject_type, subject_id, status, payload_json,
             result_ref, error_code, attempt_count, available_at, created_at, updated_at
      FROM jobs
      WHERE job_id = ?1
      LIMIT 1
    `,
    args: [jobId],
  })

  return row ? toJobRow(row) : null
}

export async function getLatestCommunityProvisioningJobRow(executor: DbExecutor, communityId: string): Promise<JobRow | null> {
  const row = await firstRow(executor, {
    sql: `
      SELECT job_id, job_type, job_scope, community_id, subject_type, subject_id, status, payload_json,
             result_ref, error_code, attempt_count, available_at, created_at, updated_at
      FROM jobs
      WHERE community_id = ?1
        AND job_type = 'community_provisioning'
      ORDER BY created_at DESC, job_id DESC
      LIMIT 1
    `,
    args: [communityId],
  })

  return row ? toJobRow(row) : null
}

export async function getLatestJobRowBySubjectAndType(
  executor: DbExecutor,
  input: {
    subjectType: string
    subjectId: string
    jobType: JobRow["job_type"]
  },
): Promise<JobRow | null> {
  const row = await firstRow(executor, {
    sql: `
      SELECT job_id, job_type, job_scope, community_id, subject_type, subject_id, status, payload_json,
             result_ref, error_code, attempt_count, available_at, created_at, updated_at
      FROM jobs
      WHERE subject_type = ?1
        AND subject_id = ?2
        AND job_type = ?3
      ORDER BY created_at DESC, job_id DESC
      LIMIT 1
    `,
    args: [input.subjectType, input.subjectId, input.jobType],
  }).catch((error) => {
    if (isMissingTableError(error, "jobs")) {
      return null
    }
    throw error
  })

  return row ? toJobRow(row) : null
}

export async function getLatestCommunityRegistryPublicationJobRow(
  executor: DbExecutor,
  communityId: string,
): Promise<JobRow | null> {
  const row = await firstRow(executor, {
    sql: `
      SELECT job_id, job_type, job_scope, community_id, subject_type, subject_id, status, payload_json,
             result_ref, error_code, attempt_count, available_at, created_at, updated_at
      FROM jobs
      WHERE community_id = ?1
        AND job_type = 'community_registry_publication'
      ORDER BY created_at DESC, job_id DESC
      LIMIT 1
    `,
    args: [communityId],
  })

  return row ? toJobRow(row) : null
}

export async function getCommunityRegistryAttemptRowById(
  executor: DbExecutor,
  registryAttemptId: string,
): Promise<CommunityRegistryAttemptRow | null> {
  const row = await firstRow(executor, {
    sql: `
      SELECT registry_attempt_id, actor_user_id, actor_primary_wallet_snapshot, actor_governance_address_snapshot,
             namespace_verification_id, normalized_root_label, community_id, attempt_status, failure_code,
             created_at, updated_at
      FROM community_registry_attempts
      WHERE registry_attempt_id = ?1
      LIMIT 1
    `,
    args: [registryAttemptId],
  }).catch((error) => {
    if (isMissingTableError(error, "community_registry_attempts")) {
      return null
    }
    throw error
  })

  return row ? toCommunityRegistryAttemptRow(row) : null
}

export async function getCommunityPostProjectionRowByPostId(
  executor: DbExecutor,
  postId: string,
): Promise<CommunityPostProjectionRow | null> {
  const row = await firstRow(executor, {
    sql: `
      SELECT projection_id, community_id, source_post_id, author_user_id, identity_mode, post_type, status,
             source_created_at, projected_payload_json, projection_version, created_at, updated_at
      FROM community_post_projections
      WHERE source_post_id = ?1
        AND projection_version = 1
      LIMIT 1
    `,
    args: [postId],
  })

  return row ? toCommunityPostProjectionRow(row) : null
}

export async function deriveOnboardingStatus(
  executor: DbExecutor,
  userRow: UserRow,
  activeGlobalHandleRow: GlobalHandleRow,
): Promise<OnboardingStatus> {
  const capabilities = parseVerificationCapabilities(userRow.verification_capabilities_json)
  const latestVerificationSession = await getLatestVerificationSessionRow(executor, userRow.user_id)
  const latestNamespaceVerification = await getLatestNamespaceVerificationRow(executor, userRow.user_id)
  const latestNamespaceVerificationSession = await getLatestNamespaceVerificationSessionRow(executor, userRow.user_id)
  const latestRedditVerification = await getLatestRedditVerificationSessionRow(executor, userRow.user_id)
  const latestRedditImportJob = await getLatestJobRowBySubjectAndType(executor, {
    subjectType: "user",
    subjectId: userRow.user_id,
    jobType: "reddit_snapshot_import",
  })
  const latestRedditSnapshot = await getLatestExternalReputationSnapshotRow(executor, userRow.user_id)

  const uniqueHumanState: OnboardingStatus["unique_human_verification_status"] = capabilities.unique_human.state === "verified"
    ? "verified"
    : latestVerificationSession?.status === "pending"
      ? "pending"
      : latestVerificationSession?.status === "expired"
        ? "expired"
        : latestVerificationSession?.status === "failed" || latestVerificationSession?.status === "canceled"
          ? "failed"
          : "not_started"

  const namespaceStatus: OnboardingStatus["namespace_verification_status"] = latestNamespaceVerification
    ? latestNamespaceVerification.status
    : latestNamespaceVerificationSession
      ? (
          latestNamespaceVerificationSession.status === "verified"
            ? "verified"
            : latestNamespaceVerificationSession.status === "expired"
              ? "expired"
              : latestNamespaceVerificationSession.status === "disputed"
                ? "disputed"
                : latestNamespaceVerificationSession.status === "failed"
                  ? "failed"
                  : "pending"
        )
      : "not_started"

  const missingRequirements: string[] = []
  if (uniqueHumanState !== "verified") {
    missingRequirements.push("unique_human_verification")
  }
  if (namespaceStatus !== "verified") {
    missingRequirements.push("namespace_verification")
  }

  const redditVerificationStatus: OnboardingStatus["reddit_verification_status"] = latestRedditVerification
    ? latestRedditVerification.status === "verified"
      ? "verified"
      : latestRedditVerification.status === "pending"
        ? "pending"
        : "failed"
    : "not_started"

  const redditImportStatus: OnboardingStatus["reddit_import_status"] = latestRedditImportJob
    ? latestRedditImportJob.status
    : "not_started"

  const suggestedCommunityIds = latestRedditSnapshot
    ? parseRedditImportSummary(latestRedditSnapshot.snapshot_payload_json).suggested_communities.map(
        (community) => community.community_id,
      )
    : []

  return {
    generated_handle_assigned: activeGlobalHandleRow.issuance_source === "generated_signup",
    cleanup_rename_available: isCleanupRenameAvailable({
      userCreatedAt: userRow.created_at,
      activeGlobalHandle: serializeGlobalHandle(activeGlobalHandleRow),
    }),
    unique_human_verification_status: uniqueHumanState,
    namespace_verification_status: namespaceStatus,
    community_creation_ready: missingRequirements.length === 0,
    missing_requirements: missingRequirements,
    reddit_verification_status: redditVerificationStatus,
    reddit_import_status: redditImportStatus,
    suggested_community_ids: suggestedCommunityIds,
  }
}

export async function findActiveAuthProviderLink(executor: DbExecutor, provider: string, providerSubject: string): Promise<AuthProviderLinkRow | null> {
  const row = await firstRow(executor, {
    sql: `
      SELECT user_id
      FROM auth_provider_links
      WHERE provider = ?1
        AND provider_subject = ?2
        AND status = 'active'
      LIMIT 1
    `,
    args: [provider, providerSubject],
  })

  if (!row) {
    return null
  }

  return {
    user_id: String((row as Record<string, unknown>).user_id),
  }
}

export async function getUserRow(executor: DbExecutor, userId: string): Promise<UserRow | null> {
  const row = await firstRow(executor, {
    sql: `
      SELECT user_id, primary_wallet_attachment_id, verification_state, capability_provider,
             verification_capabilities_json, verified_at, nationality, current_verification_session_id,
             created_at, updated_at
      FROM users
      WHERE user_id = ?1
      LIMIT 1
    `,
    args: [userId],
  })

  return row ? toUserRow(row) : null
}

export async function listUserRowsByIds(executor: DbExecutor, userIds: string[]): Promise<UserRow[]> {
  const normalized = [...new Set(userIds.filter(Boolean))]
  if (normalized.length === 0) {
    return []
  }

  const placeholders = normalized.map((_, index) => `?${index + 1}`).join(", ")
  const result = await executor.execute({
    sql: `
      SELECT user_id, primary_wallet_attachment_id, verification_state, capability_provider,
             verification_capabilities_json, verified_at, nationality, current_verification_session_id,
             created_at, updated_at
      FROM users
      WHERE user_id IN (${placeholders})
    `,
    args: normalized,
  })

  return result.rows.map((row) => toUserRow(row))
}

export async function getProfileRow(executor: DbExecutor, userId: string): Promise<ProfileRow | null> {
  const row = await firstRow(executor, {
    sql: `
      SELECT user_id, display_name, bio, avatar_ref, cover_ref, preferred_locale, global_handle_id, created_at, updated_at
      FROM profiles
      WHERE user_id = ?1
      LIMIT 1
    `,
    args: [userId],
  })

  return row ? toProfileRow(row) : null
}

export async function getGlobalHandleRow(executor: DbExecutor, globalHandleId: string): Promise<GlobalHandleRow | null> {
  const row = await firstRow(executor, {
    sql: `
      SELECT global_handle_id, user_id, label_normalized, label_display, status, tier, issuance_source,
             redirect_target_global_handle_id, price_paid_usd, free_rename_consumed, issued_at,
             replaced_at, created_at, updated_at
      FROM global_handles
      WHERE global_handle_id = ?1
      LIMIT 1
    `,
    args: [globalHandleId],
  })

  return row ? toGlobalHandleRow(row) : null
}

export async function listActiveWalletAttachmentRows(executor: DbExecutor, userId: string): Promise<WalletAttachmentRow[]> {
  const result = await executor.execute({
    sql: `
      SELECT wallet_attachment_id, chain_namespace, wallet_address_normalized, wallet_address_display, is_primary
      FROM wallet_attachments
      WHERE user_id = ?1
        AND status = 'active'
      ORDER BY attached_at ASC
    `,
    args: [userId],
  })

  return result.rows.map(toWalletAttachmentRow)
}

export async function reconcileWalletAttachments(
  executor: DbExecutor,
  input: {
    userId: string
    identity: UpstreamIdentity
    updatedAt: string
  },
): Promise<void> {
  if (input.identity.provider !== "privy" || input.identity.walletAddresses.length === 0) {
    return
  }

  const knownRows = await listActiveWalletAttachmentRows(executor, input.userId)
  const knownByAddress = new Map(knownRows.map((row) => [row.wallet_address_normalized, row]))

  for (const walletAddress of input.identity.walletAddresses) {
    if (knownByAddress.has(walletAddress)) {
      continue
    }

    await executor.execute({
      sql: `
        INSERT OR IGNORE INTO wallet_attachments (
          wallet_attachment_id,
          user_id,
          chain_namespace,
          wallet_address_normalized,
          wallet_address_display,
          source_provider,
          source_subject,
          attachment_kind,
          is_primary,
          status,
          attached_at,
          detached_at,
          created_at,
          updated_at
        ) VALUES (?1, ?2, 'eip155:1', ?3, ?4, ?5, ?6, 'external', 0, 'active', ?7, NULL, ?7, ?7)
      `,
      args: [
        makeId("wal"),
        input.userId,
        walletAddress,
        walletAddress,
        input.identity.provider,
        input.identity.providerSubject,
        input.updatedAt,
      ],
    })
  }

  const activeRows = await listActiveWalletAttachmentRows(executor, input.userId)
  const selectedWalletAddress = input.identity.selectedWalletAddress ?? input.identity.walletAddresses[0] ?? null
  const desiredPrimaryRow =
    (selectedWalletAddress
      ? activeRows.find((row) => row.wallet_address_normalized === selectedWalletAddress)
      : null)
    ?? activeRows.find((row) => row.is_primary === 1)
    ?? activeRows[0]
    ?? null

  await executor.execute({
    sql: `
      UPDATE wallet_attachments
      SET is_primary = CASE WHEN wallet_attachment_id = ?2 THEN 1 ELSE 0 END,
          updated_at = ?3
      WHERE user_id = ?1
        AND status = 'active'
    `,
    args: [input.userId, desiredPrimaryRow?.wallet_attachment_id ?? "", input.updatedAt],
  })

  await executor.execute({
    sql: `
      UPDATE users
      SET primary_wallet_attachment_id = ?2,
          updated_at = ?3
      WHERE user_id = ?1
    `,
    args: [input.userId, desiredPrimaryRow?.wallet_attachment_id ?? null, input.updatedAt],
  })
}

export async function loadSnapshot(executor: DbExecutor, userId: string): Promise<SessionSnapshot> {
  const userRow = await getUserRow(executor, userId)
  if (!userRow) {
    throw internalError("Resolved user row is missing")
  }

  const profileRow = await getProfileRow(executor, userId)
  if (!profileRow) {
    throw internalError("Resolved profile row is missing")
  }

  const globalHandleRow = await getGlobalHandleRow(executor, profileRow.global_handle_id)
  if (!globalHandleRow) {
    throw internalError("Resolved global handle row is missing")
  }

  const walletRows = await listActiveWalletAttachmentRows(executor, userId)

  return {
    user: serializeUser(userRow),
    profile: assembleProfile(profileRow, globalHandleRow),
    onboarding: await deriveOnboardingStatus(executor, userRow, globalHandleRow),
    wallet_attachments: serializeWalletAttachments(walletRows),
  }
}
