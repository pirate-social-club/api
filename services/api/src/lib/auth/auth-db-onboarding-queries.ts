import type { DbExecutor } from "../db-helpers"
import {
  parseRedditImportSummary,
  parseVerificationCapabilities,
  serializeGlobalHandle,
} from "./auth-serializers"
import { isCleanupRenameAvailable } from "./global-handle-policy"
import {
  type ExternalReputationSnapshotRow,
  type GlobalHandleRow,
  type NamespaceVerificationRow,
  type NamespaceVerificationSessionRow,
  type RedditVerificationSessionRow,
  type UserRow,
  type VerificationSessionRow,
  toExternalReputationSnapshotRow,
  toNamespaceVerificationRow,
  toNamespaceVerificationSessionRow,
  toRedditVerificationSessionRow,
  toVerificationSessionRow,
} from "./auth-db-rows"
import { firstRow } from "./auth-db-query-helpers"
import { getLatestJobRowBySubjectAndType } from "./auth-db-community-queries"
import type { OnboardingStatus } from "../../types"
import { nullableUnixSeconds } from "../../serializers/time"

async function getLatestVerificationSessionRow(executor: DbExecutor, userId: string): Promise<VerificationSessionRow | null> {
  const row = await firstRow(executor, {
    sql: `
      SELECT verification_session_id, user_id, provider, requested_capabilities_json, verification_requirements_json,
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
  })

  return row ? toExternalReputationSnapshotRow(row) : null
}

async function getLatestNamespaceVerificationSessionRow(executor: DbExecutor, userId: string): Promise<NamespaceVerificationSessionRow | null> {
  const row = await firstRow(executor, {
    sql: `
      SELECT namespace_verification_session_id, namespace_verification_id, user_id, family, submitted_root_label,
             normalized_root_label, status, challenge_host, challenge_txt_value, setup_nameservers_json, challenge_expires_at,
             root_exists, root_control_verified, expiry_horizon_sufficient, routing_enabled,
             pirate_dns_authority_verified, club_attach_allowed, pirate_web_routing_allowed,
             pirate_subdomain_issuance_allowed, control_class, operation_class, observation_provider,
             evidence_bundle_ref, failure_reason, accepted_at, expires_at, created_at, updated_at
      FROM namespace_verification_sessions
      WHERE user_id = ?1
      ORDER BY created_at DESC
      LIMIT 1
    `,
    args: [userId],
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
             evidence_bundle_ref, accepted_at, expires_at, created_at, updated_at
      FROM namespace_verifications
      WHERE user_id = ?1
      ORDER BY accepted_at DESC
      LIMIT 1
    `,
    args: [userId],
  })

  return row ? toNamespaceVerificationRow(row) : null
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
    : capabilities.unique_human.state === "expired"
      ? "expired"
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
        (community) => community.community.replace(/^com_/, ""),
      )
    : []

  return {
    generated_handle_assigned: activeGlobalHandleRow.issuance_source === "generated_signup",
    cleanup_rename_available: activeGlobalHandleRow.issuance_source === "generated_signup"
      && isCleanupRenameAvailable({
        userCreatedAt: userRow.created_at,
        activeGlobalHandle: serializeGlobalHandle(activeGlobalHandleRow),
      }),
    onboarding_dismissed_at: nullableUnixSeconds(userRow.onboarding_dismissed_at),
    unique_human_verification_status: uniqueHumanState,
    namespace_verification_status: namespaceStatus,
    community_creation_ready: missingRequirements.length === 0,
    missing_requirements: missingRequirements,
    reddit_verification_status: redditVerificationStatus,
    reddit_import_status: redditImportStatus,
    suggested_community_ids: suggestedCommunityIds,
  }
}
