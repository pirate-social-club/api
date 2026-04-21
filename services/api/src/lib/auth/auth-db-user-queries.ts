import type { DbExecutor } from "../db-helpers"
import { internalError } from "../errors"
import { makeId } from "../helpers"
import {
  assembleProfile,
  parseRedditImportSummary,
  parseVerificationCapabilities,
  serializeUser,
  serializeWalletAttachments,
} from "./auth-serializers"
import {
  type ExternalReputationSnapshotRow,
  type GlobalHandleRow,
  type LinkedHandleRow,
  type NamespaceVerificationRow,
  type NamespaceVerificationSessionRow,
  type ProfileRow,
  type RedditVerificationSessionRow,
  type SessionSnapshot,
  type UserRow,
  type VerificationSessionRow,
  type WalletAttachmentRow,
  toExternalReputationSnapshotRow,
  toGlobalHandleRow,
  toLinkedHandleRow,
  toNamespaceVerificationRow,
  toNamespaceVerificationSessionRow,
  toProfileRow,
  toRedditVerificationSessionRow,
  toUserRow,
  toVerificationSessionRow,
  toWalletAttachmentRow,
} from "./auth-db-rows"
import {
  ensureProfilesPrimaryLinkedHandleColumn,
  firstRow,
  isMissingColumnError,
  isMissingTableError,
} from "./auth-db-query-helpers"
import { getLatestJobRowBySubjectAndType } from "./auth-db-community-queries"
import type { OnboardingStatus, UpstreamIdentity } from "../../types"

type AuthProviderLinkRow = {
  user_id: string
}

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
  const stmt = {
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
  }
  const legacyStmt = {
    sql: `
      SELECT namespace_verification_session_id, namespace_verification_id, user_id, family, submitted_root_label,
             normalized_root_label, status, challenge_host, challenge_txt_value, challenge_expires_at,
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
  }
  const row = await firstRow(executor, stmt).catch(async (error) => {
    if (isMissingTableError(error, "namespace_verification_sessions")) {
      return null
    }
    if (isMissingColumnError(error, "setup_nameservers_json")) {
      return await firstRow(executor, legacyStmt)
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
             evidence_bundle_ref, accepted_at, expires_at, created_at, updated_at
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
        (community) => community.community_id,
      )
    : []

  return {
    generated_handle_assigned: activeGlobalHandleRow.issuance_source === "generated_signup",
    cleanup_rename_available: !Boolean(activeGlobalHandleRow.free_rename_consumed),
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

export async function getProfileRow(executor: DbExecutor, userId: string): Promise<ProfileRow | null> {
  const stmt = {
    sql: `
      SELECT user_id, display_name, bio, avatar_ref, cover_ref, preferred_locale,
             global_handle_id, primary_linked_handle_id, created_at, updated_at
      FROM profiles
      WHERE user_id = ?1
      LIMIT 1
    `,
    args: [userId],
  }
  const legacyStmt = {
    sql: `
      SELECT user_id, display_name, bio, avatar_ref, cover_ref, preferred_locale,
             global_handle_id, created_at, updated_at
      FROM profiles
      WHERE user_id = ?1
      LIMIT 1
    `,
    args: [userId],
  }

  const row = await firstRow(executor, stmt).catch(async (error) => {
    if (isMissingColumnError(error, "primary_linked_handle_id")) {
      await ensureProfilesPrimaryLinkedHandleColumn(executor)
      return await firstRow(executor, stmt).catch(async (retryError) => {
        if (isMissingColumnError(retryError, "primary_linked_handle_id")) {
          return await firstRow(executor, legacyStmt)
        }
        throw retryError
      })
    }
    throw error
  })

  return row ? toProfileRow(row) : null
}

export async function listLinkedHandleRows(executor: DbExecutor, userId: string): Promise<LinkedHandleRow[]> {
  try {
    const result = await executor.execute({
      sql: `
        SELECT linked_handle_id, user_id, wallet_attachment_id, kind, label_normalized, label_display,
               verification_state, metadata_json, created_at, updated_at
        FROM linked_handles
        WHERE user_id = ?1
        ORDER BY
          CASE kind
            WHEN 'ens' THEN 0
            ELSE 1
          END,
          label_display ASC
      `,
      args: [userId],
    })

    return result.rows.map(toLinkedHandleRow)
  } catch (error) {
    if (isMissingTableError(error, "linked_handles")) {
      return []
    }
    throw error
  }
}

export async function getLinkedHandleRow(
  executor: DbExecutor,
  userId: string,
  linkedHandleId: string,
): Promise<LinkedHandleRow | null> {
  const row = await firstRow(executor, {
    sql: `
      SELECT linked_handle_id, user_id, wallet_attachment_id, kind, label_normalized, label_display,
             verification_state, metadata_json, created_at, updated_at
      FROM linked_handles
      WHERE user_id = ?1
        AND linked_handle_id = ?2
      LIMIT 1
    `,
    args: [userId, linkedHandleId],
  }).catch((error) => {
    if (isMissingTableError(error, "linked_handles")) {
      return null
    }
    throw error
  })

  return row ? toLinkedHandleRow(row) : null
}

export async function getGlobalHandleRow(executor: DbExecutor, globalHandleId: string): Promise<GlobalHandleRow | null> {
  const stmt = {
    sql: `
      SELECT global_handle_id, user_id, label_normalized, label_display, status, tier, issuance_source,
             redirect_target_global_handle_id, price_paid_usd, free_rename_consumed, issued_at,
             replaced_at, created_at, updated_at
      FROM global_handles
      WHERE global_handle_id = ?1
      LIMIT 1
    `,
    args: [globalHandleId],
  }

  const row = await firstRow(executor, stmt).catch(async (error) => {
    if (
      isMissingColumnError(error, "price_paid_usd")
      || isMissingColumnError(error, "free_rename_consumed")
      || isMissingColumnError(error, "replaced_at")
    ) {
      return await firstRow(executor, {
        sql: `
          SELECT global_handle_id, user_id, label_normalized, label_display, status, tier, issuance_source,
                 redirect_target_global_handle_id, issued_at, created_at, updated_at
          FROM global_handles
          WHERE global_handle_id = ?1
          LIMIT 1
        `,
        args: [globalHandleId],
      }).then((legacyRow) => {
        if (!legacyRow) {
          return null
        }

        return {
          ...legacyRow,
          price_paid_usd: null,
          free_rename_consumed: 0,
          replaced_at: null,
        }
      })
    }

    throw error
  })

  return row ? toGlobalHandleRow(row) : null
}

export async function getGlobalHandleRowByLabelNormalized(
  executor: DbExecutor,
  labelNormalized: string,
): Promise<GlobalHandleRow | null> {
  const stmt = {
    sql: `
      SELECT global_handle_id, user_id, label_normalized, label_display, status, tier, issuance_source,
             redirect_target_global_handle_id, price_paid_usd, free_rename_consumed, issued_at,
             replaced_at, created_at, updated_at
      FROM global_handles
      WHERE label_normalized = ?1
      LIMIT 1
    `,
    args: [labelNormalized],
  }

  const row = await firstRow(executor, stmt).catch(async (error) => {
    if (
      isMissingColumnError(error, "price_paid_usd")
      || isMissingColumnError(error, "free_rename_consumed")
      || isMissingColumnError(error, "replaced_at")
    ) {
      return await firstRow(executor, {
        sql: `
          SELECT global_handle_id, user_id, label_normalized, label_display, status, tier, issuance_source,
                 redirect_target_global_handle_id, issued_at, created_at, updated_at
          FROM global_handles
          WHERE label_normalized = ?1
          LIMIT 1
        `,
        args: [labelNormalized],
      }).then((legacyRow) => {
        if (!legacyRow) {
          return null
        }

        return {
          ...legacyRow,
          price_paid_usd: null,
          free_rename_consumed: 0,
          replaced_at: null,
        }
      })
    }

    throw error
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
      SET is_primary = 0,
          updated_at = ?2
      WHERE user_id = ?1
        AND status = 'active'
        AND is_primary = 1
    `,
    args: [input.userId, input.updatedAt],
  })

  if (desiredPrimaryRow) {
    await executor.execute({
      sql: `
        UPDATE wallet_attachments
        SET is_primary = 1,
            updated_at = ?3
        WHERE user_id = ?1
          AND wallet_attachment_id = ?2
          AND status = 'active'
      `,
      args: [input.userId, desiredPrimaryRow.wallet_attachment_id, input.updatedAt],
    })
  }

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
  const linkedHandleRows = await listLinkedHandleRows(executor, userId)

  return {
    user: serializeUser(userRow),
    profile: assembleProfile(profileRow, globalHandleRow, linkedHandleRows),
    onboarding: await deriveOnboardingStatus(executor, userRow, globalHandleRow),
    wallet_attachments: serializeWalletAttachments(walletRows),
  }
}
