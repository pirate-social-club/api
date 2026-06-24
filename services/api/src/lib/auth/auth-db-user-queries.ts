import type { DbExecutor } from "../db-helpers"
import { internalError } from "../errors"
import { makeId } from "../helpers"
import {
  assembleProfile,
  getPrimaryWalletAddressFromRows,
  serializeUser,
  serializeWalletAttachments,
} from "./auth-serializers"
import {
  type GlobalHandleRow,
  type LinkedHandleRow,
  type ProfileRow,
  type SessionSnapshot,
  type UserRow,
  type WalletAttachmentRow,
  toGlobalHandleRow,
  toLinkedHandleRow,
  toProfileRow,
  toUserRow,
  toWalletAttachmentRow,
} from "./auth-db-rows"
import { deriveOnboardingStatus } from "./auth-db-onboarding-queries"
import { firstRow } from "./auth-db-query-helpers"
import { listIdentityWallets, resolveExplicitSelectedIdentityWallet } from "./upstream-wallets"
import type { UpstreamIdentity } from "../../types"

const ETHEREUM_MAINNET_NAMESPACE = "eip155:1"

type PrimaryInitRow = {
  wallet_attachment_id: string
  chain_namespace: string
  wallet_address_normalized: string
  attachment_kind: string
  is_primary: number
}

export {
  deriveOnboardingStatus,
  getLatestExternalReputationSnapshotRow,
  getLatestRedditVerificationSessionRow,
  getLatestRedditVerificationSessionRowForUsername,
} from "./auth-db-onboarding-queries"

type AuthProviderLinkRow = {
  user_id: string
}

function buildInClause(values: string[], startIndex = 1): { placeholders: string; args: string[] } | null {
  const uniqueValues = Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)))
  if (uniqueValues.length === 0) {
    return null
  }
  return {
    placeholders: uniqueValues.map((_, index) => `?${startIndex + index}`).join(", "),
    args: uniqueValues,
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
             verification_capabilities_json, verified_at, current_verification_session_id,
             onboarding_dismissed_at,
             created_at, updated_at
      FROM users
      WHERE user_id = ?1
      LIMIT 1
    `,
    args: [userId],
  })

  return row ? toUserRow(row) : null
}

export async function listUserRowsByUserIds(executor: DbExecutor, userIds: string[]): Promise<UserRow[]> {
  const clause = buildInClause(userIds)
  if (!clause) {
    return []
  }
  const result = await executor.execute({
    sql: `
      SELECT user_id, primary_wallet_attachment_id, verification_state, capability_provider,
             verification_capabilities_json, verified_at, current_verification_session_id,
             onboarding_dismissed_at,
             created_at, updated_at
      FROM users
      WHERE user_id IN (${clause.placeholders})
    `,
    args: clause.args,
  })

  return result.rows.map(toUserRow)
}

export async function dismissOnboardingForUser(executor: DbExecutor, userId: string, dismissedAt: string): Promise<void> {
  await executor.execute({
    sql: `
      UPDATE users
      SET onboarding_dismissed_at = ?2,
          updated_at = ?2
      WHERE user_id = ?1
    `,
    args: [userId, dismissedAt],
  })
}

export async function getProfileRow(executor: DbExecutor, userId: string): Promise<ProfileRow | null> {
  const row = await firstRow(executor, {
    sql: `
      SELECT user_id, display_name, bio, avatar_ref, cover_ref, preferred_locale,
             bio_source, avatar_source, cover_source,
             display_verified_nationality_badge,
             global_handle_id, primary_linked_handle_id, xmtp_inbox_id, created_at, updated_at
      FROM profiles
      WHERE user_id = ?1
      LIMIT 1
    `,
    args: [userId],
  })

  return row ? toProfileRow(row) : null
}

export async function listProfileRowsByUserIds(executor: DbExecutor, userIds: string[]): Promise<ProfileRow[]> {
  const clause = buildInClause(userIds)
  if (!clause) {
    return []
  }
  const result = await executor.execute({
    sql: `
      SELECT user_id, display_name, bio, avatar_ref, cover_ref, preferred_locale,
             bio_source, avatar_source, cover_source,
             display_verified_nationality_badge,
             global_handle_id, primary_linked_handle_id, xmtp_inbox_id, created_at, updated_at
      FROM profiles
      WHERE user_id IN (${clause.placeholders})
    `,
    args: clause.args,
  })

  return result.rows.map(toProfileRow)
}

export async function getActiveWalletAttachmentRowByAddress(
  executor: DbExecutor,
  walletAddressNormalized: string,
): Promise<(WalletAttachmentRow & { user_id: string }) | null> {
  const row = await firstRow(executor, {
    sql: `
      SELECT wallet_attachment_id, user_id, chain_namespace, wallet_address_normalized, wallet_address_display, is_primary
      FROM wallet_attachments
      WHERE wallet_address_normalized = ?1
        AND status = 'active'
      ORDER BY is_primary DESC, attached_at ASC
      LIMIT 1
    `,
    args: [walletAddressNormalized],
  })

  return row ? { ...toWalletAttachmentRow(row), user_id: String((row as Record<string, unknown>).user_id) } : null
}

export async function getActiveWalletAttachmentRowByWallet(
  executor: DbExecutor,
  chainNamespace: string,
  walletAddressNormalized: string,
): Promise<(WalletAttachmentRow & { user_id: string }) | null> {
  const row = await firstRow(executor, {
    sql: `
      SELECT wallet_attachment_id, user_id, chain_namespace, wallet_address_normalized, wallet_address_display, is_primary
      FROM wallet_attachments
      WHERE chain_namespace = ?1
        AND wallet_address_normalized = ?2
        AND status = 'active'
      ORDER BY is_primary DESC, attached_at ASC
      LIMIT 1
    `,
    args: [chainNamespace, walletAddressNormalized],
  })

  return row ? { ...toWalletAttachmentRow(row), user_id: String((row as Record<string, unknown>).user_id) } : null
}

export async function listLinkedHandleRows(executor: DbExecutor, userId: string): Promise<LinkedHandleRow[]> {
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
}

export async function listLinkedHandleRowsByUserIds(executor: DbExecutor, userIds: string[]): Promise<LinkedHandleRow[]> {
  const clause = buildInClause(userIds)
  if (!clause) {
    return []
  }
  const result = await executor.execute({
    sql: `
      SELECT linked_handle_id, user_id, wallet_attachment_id, kind, label_normalized, label_display,
             verification_state, metadata_json, created_at, updated_at
      FROM linked_handles
      WHERE user_id IN (${clause.placeholders})
      ORDER BY
        user_id ASC,
        CASE kind
          WHEN 'ens' THEN 0
          ELSE 1
        END,
        label_display ASC
    `,
    args: clause.args,
  })

  return result.rows.map(toLinkedHandleRow)
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
  })

  return row ? toLinkedHandleRow(row) : null
}

export async function getVerifiedLinkedHandleRowByLabelNormalized(
  executor: DbExecutor,
  labelNormalized: string,
): Promise<LinkedHandleRow | null> {
  const row = await firstRow(executor, {
    sql: `
      SELECT linked_handle_id, user_id, wallet_attachment_id, kind, label_normalized, label_display,
             verification_state, metadata_json, created_at, updated_at
      FROM linked_handles
      WHERE label_normalized = ?1
        AND verification_state = 'verified'
      LIMIT 1
    `,
    args: [labelNormalized],
  })

  return row ? toLinkedHandleRow(row) : null
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

export async function listGlobalHandleRowsByIds(executor: DbExecutor, globalHandleIds: string[]): Promise<GlobalHandleRow[]> {
  const clause = buildInClause(globalHandleIds)
  if (!clause) {
    return []
  }
  const result = await executor.execute({
    sql: `
      SELECT global_handle_id, user_id, label_normalized, label_display, status, tier, issuance_source,
             redirect_target_global_handle_id, price_paid_usd, free_rename_consumed, issued_at,
             replaced_at, created_at, updated_at
      FROM global_handles
      WHERE global_handle_id IN (${clause.placeholders})
    `,
    args: clause.args,
  })

  return result.rows.map(toGlobalHandleRow)
}

export async function getGlobalHandleRowByLabelNormalized(
  executor: DbExecutor,
  labelNormalized: string,
): Promise<GlobalHandleRow | null> {
  const row = await firstRow(executor, {
    sql: `
      SELECT global_handle_id, user_id, label_normalized, label_display, status, tier, issuance_source,
             redirect_target_global_handle_id, price_paid_usd, free_rename_consumed, issued_at,
             replaced_at, created_at, updated_at
      FROM global_handles
      WHERE label_normalized = ?1
      LIMIT 1
    `,
    args: [labelNormalized],
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

export async function listActiveWalletAttachmentRowsByUserIds(
  executor: DbExecutor,
  userIds: string[],
): Promise<Array<WalletAttachmentRow & { user_id: string }>> {
  const clause = buildInClause(userIds)
  if (!clause) {
    return []
  }
  const result = await executor.execute({
    sql: `
      SELECT wallet_attachment_id, user_id, chain_namespace, wallet_address_normalized, wallet_address_display, is_primary
      FROM wallet_attachments
      WHERE user_id IN (${clause.placeholders})
        AND status = 'active'
      ORDER BY user_id ASC, attached_at ASC
    `,
    args: clause.args,
  })

  return result.rows.map((row) => ({
    ...toWalletAttachmentRow(row),
    user_id: String((row as Record<string, unknown>).user_id),
  }))
}

export async function reconcileWalletAttachments(
  executor: DbExecutor,
  input: {
    userId: string
    identity: UpstreamIdentity
    updatedAt: string
  },
): Promise<void> {
  if (input.identity.provider !== "privy" && input.identity.provider !== "jwt") {
    return
  }

  const identityWallets = listIdentityWallets(input.identity)
  if (identityWallets.length === 0) {
    return
  }

  const knownRows = await listActiveWalletAttachmentRows(executor, input.userId)
  const knownByAddress = new Map(knownRows.map((row) => [
    `${row.chain_namespace}:${row.wallet_address_normalized}`,
    row,
  ]))

  for (const wallet of identityWallets) {
    if (knownByAddress.has(`${wallet.chainNamespace}:${wallet.walletAddressNormalized}`)) {
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
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?9, 0, 'active', ?8, NULL, ?8, ?8)
      `,
      args: [
        makeId("wal"),
        input.userId,
        wallet.chainNamespace,
        wallet.walletAddressNormalized,
        wallet.walletAddress,
        input.identity.provider,
        input.identity.providerSubject,
        input.updatedAt,
        wallet.attachmentKind,
      ],
    })
  }
}

// Initialize the user's identity (primary) wallet exactly once, and never replace an existing
// one. Authentication and refresh may discover wallets via reconcileWalletAttachments, but the
// identity wallet is set here only when the user has none, and is otherwise changed solely by
// explicit user action (PUT /users/me/identity-wallet). For now `primary_wallet_attachment_id
// IS NULL` means "not initialized yet"; clearing a primary is not supported.
export async function initializePrimaryWalletIfNeeded(
  executor: DbExecutor,
  input: {
    userId: string
    identity: UpstreamIdentity
    updatedAt: string
  },
): Promise<void> {
  const userRow = await getUserRow(executor, input.userId)
  if (!userRow) {
    return
  }

  // Legacy guard: if a primary pointer already exists, treat it as the source of truth and
  // realign any disagreeing is_primary flags (idempotent — affects 0 rows when consistent).
  if (userRow.primary_wallet_attachment_id) {
    await repairPrimaryFlagToPointer(executor, input.userId, userRow.primary_wallet_attachment_id, input.updatedAt)
    return
  }

  const initRows = await listPrimaryInitRows(executor, input.userId)
  if (initRows.length === 0) {
    return
  }

  const explicit = resolveExplicitSelectedIdentityWallet(input.identity)
  const candidate =
    (explicit
      ? initRows.find((row) => (
        row.chain_namespace === explicit.chainNamespace
          && row.wallet_address_normalized === explicit.walletAddressNormalized
      ))
      : null)
    ?? pickEmbeddedInitRow(initRows)
    ?? null

  if (!candidate) {
    // External-only Privy users legitimately have no identity wallet until they pick one.
    return
  }

  // Race-safe claim: only the writer that flips the NULL pointer to non-NULL is the winner.
  const claim = await executor.execute({
    sql: `
      UPDATE users
      SET primary_wallet_attachment_id = ?2,
          updated_at = ?3
      WHERE user_id = ?1
        AND primary_wallet_attachment_id IS NULL
    `,
    args: [input.userId, candidate.wallet_attachment_id, input.updatedAt],
  })

  if ((claim.rowsAffected ?? 0) !== 1) {
    // A concurrent exchange already initialized the primary; do not diverge.
    return
  }

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

  await executor.execute({
    sql: `
      UPDATE wallet_attachments
      SET is_primary = 1,
          updated_at = ?3
      WHERE user_id = ?1
        AND wallet_attachment_id = ?2
        AND status = 'active'
    `,
    args: [input.userId, candidate.wallet_attachment_id, input.updatedAt],
  })
}

async function listPrimaryInitRows(executor: DbExecutor, userId: string): Promise<PrimaryInitRow[]> {
  const result = await executor.execute({
    sql: `
      SELECT wallet_attachment_id, chain_namespace, wallet_address_normalized, attachment_kind, is_primary
      FROM wallet_attachments
      WHERE user_id = ?1
        AND status = 'active'
      ORDER BY attached_at ASC, wallet_attachment_id ASC
    `,
    args: [userId],
  })

  return result.rows.map((row) => {
    const record = row as Record<string, unknown>
    return {
      wallet_attachment_id: String(record.wallet_attachment_id),
      chain_namespace: String(record.chain_namespace),
      wallet_address_normalized: String(record.wallet_address_normalized),
      attachment_kind: String(record.attachment_kind),
      is_primary: Number(record.is_primary),
    }
  })
}

// Embedded-first: oldest active embedded EVM attachment (rows already ordered by attached_at,
// then wallet_attachment_id, so provider ordering cannot affect the result).
function pickEmbeddedInitRow(initRows: PrimaryInitRow[]): PrimaryInitRow | null {
  return initRows.find((row) => (
    row.attachment_kind === "embedded" && row.chain_namespace === ETHEREUM_MAINNET_NAMESPACE
  )) ?? null
}

async function repairPrimaryFlagToPointer(
  executor: DbExecutor,
  userId: string,
  primaryWalletAttachmentId: string,
  updatedAt: string,
): Promise<void> {
  await executor.execute({
    sql: `
      UPDATE wallet_attachments
      SET is_primary = 0,
          updated_at = ?3
      WHERE user_id = ?1
        AND status = 'active'
        AND is_primary = 1
        AND wallet_attachment_id <> ?2
    `,
    args: [userId, primaryWalletAttachmentId, updatedAt],
  })

  await executor.execute({
    sql: `
      UPDATE wallet_attachments
      SET is_primary = 1,
          updated_at = ?3
      WHERE user_id = ?1
        AND status = 'active'
        AND is_primary = 0
        AND wallet_attachment_id = ?2
    `,
    args: [userId, primaryWalletAttachmentId, updatedAt],
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

  const primaryWalletAddress = getPrimaryWalletAddressFromRows(
    userRow.primary_wallet_attachment_id,
    walletRows,
  )

  const user = serializeUser(userRow)

  return {
    user,
    profile: assembleProfile(profileRow, globalHandleRow, linkedHandleRows, primaryWalletAddress, user),
    onboarding: await deriveOnboardingStatus(executor, userRow, globalHandleRow),
    wallet_attachments: serializeWalletAttachments(walletRows),
  }
}
