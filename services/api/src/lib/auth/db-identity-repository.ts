import type { Client } from "../sql-client"
import { internalError } from "../errors"
import { generateHandleCandidate } from "./handle-generator"
import { buildDefaultVerificationCapabilities } from "../verification/verification-capabilities"
import {
  deriveOnboardingStatus,
  dismissOnboardingForUser,
  findActiveAuthProviderLink,
  getGlobalHandleRow,
  getGlobalHandleRowByLabelNormalized,
  getVerifiedLinkedHandleRowByLabelNormalized,
  getActiveWalletAttachmentRowByWallet,
  listLinkedHandleRows,
  getProfileRow,
  getUserRow,
  listActiveWalletAttachmentRows,
  loadSnapshot,
  reconcileWalletAttachments,
} from "./auth-db-user-queries"
import { listIdentityWallets } from "./upstream-wallets"
import { listCreatedCommunityRowsByCreatorUserId } from "./auth-db-community-queries"
import {
  hasUniqueConstraintField,
  hasUniqueConstraintName,
} from "./auth-db-query-helpers"
import {
  assembleProfile,
  getPrimaryWalletAddressFromRows,
  getProfilePublicHandleLabel,
  parseVerificationCapabilities,
  serializeUser,
  serializeWalletAttachments,
} from "./auth-serializers"
import type { SessionSnapshot, UserRow } from "./auth-db-rows"
import { makeId, nowIso } from "../helpers"
import { unixSeconds } from "../../serializers/time"
import { publicCommunityId } from "../public-ids"
import type { OnboardingStatus, Profile, UpstreamIdentity, User, WalletAttachmentSummary } from "../../types"
import type { PublicProfileResolution } from "./repositories"
import { deriveVerificationState } from "../verification/verification-capabilities"

function normalizePublicHandleLabel(value: string): {
  labelDisplay: string
  labelNormalized: string
} {
  const trimmed = value.trim().toLowerCase().replace(/^@+/u, "")
  const withoutSuffix = trimmed.endsWith(".pirate")
    ? trimmed.slice(0, -".pirate".length)
    : trimmed

  return {
    labelDisplay: `${withoutSuffix}.pirate`,
    labelNormalized: withoutSuffix,
  }
}

function serializeInternalUser(row: UserRow): User {
  const verificationCapabilities = parseVerificationCapabilities(row.verification_capabilities_json)
  return {
    user_id: row.user_id,
    primary_wallet_attachment_id: row.primary_wallet_attachment_id,
    verification_state: deriveVerificationState(verificationCapabilities),
    capability_provider: row.capability_provider === "self" || row.capability_provider === "very"
      ? row.capability_provider
      : null,
    verification_capabilities: verificationCapabilities,
    verified_at: row.verified_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function normalizePublicLinkedHandleLabel(value: string): string {
  return value.trim().toLowerCase().replace(/^@+/u, "")
}

function normalizeSubmittedPrefixedId(prefix: string, value: string): string {
  const trimmed = value.trim()
  return trimmed.startsWith(`${prefix}_${prefix}_`) ? trimmed.slice(prefix.length + 1) : trimmed
}

function isActiveAuthProviderSubjectConflict(error: unknown): boolean {
  return hasUniqueConstraintName(error, "idx_auth_provider_links_active_subject")
    || hasUniqueConstraintField(error, "auth_provider_links.provider_subject")
    || hasUniqueConstraintField(error, "provider_subject")
}

async function resolveExistingUserIdForWalletIdentity(
  executor: Parameters<typeof getActiveWalletAttachmentRowByWallet>[0],
  identity: UpstreamIdentity,
): Promise<string | null> {
  if (identity.provider !== "privy" && identity.provider !== "jwt") {
    return null
  }

  const wallets = listIdentityWallets(identity)
  if (wallets.length === 0) {
    return null
  }

  const userIds = new Set<string>()
  for (const wallet of wallets) {
    const existingWallet = await getActiveWalletAttachmentRowByWallet(
      executor,
      wallet.chainNamespace,
      wallet.walletAddressNormalized,
    )
    if (existingWallet) {
      userIds.add(existingWallet.user_id)
    }
  }

  if (userIds.size > 1) {
    throw internalError("Identity wallets are already attached to multiple users")
  }

  return [...userIds][0] ?? null
}

export class DatabaseIdentityRepository {
  constructor(private readonly client: Client) {}

  close(): void | Promise<void> {
    return this.client.close?.()
  }

  async exchangeIdentity(identity: UpstreamIdentity): Promise<SessionSnapshot> {
    const provider = identity.provider
    const providerSubject = identity.providerSubject
    const providerUserRef = identity.providerUserRef ?? providerSubject
    const tx = await this.client.transaction("write")
    let resolvedUserId: string | null = null

    try {
      const existing = await findActiveAuthProviderLink(tx, provider, providerSubject)
      if (existing) {
        resolvedUserId = existing.user_id
        await reconcileWalletAttachments(tx, {
          userId: resolvedUserId,
          identity,
          updatedAt: nowIso(),
        })
      } else {
        const createdAt = nowIso()
        const authProviderLinkId = makeId("apl")
        const existingWalletUserId = await resolveExistingUserIdForWalletIdentity(tx, identity)

        if (existingWalletUserId) {
          await tx.execute({
            sql: `
              INSERT INTO auth_provider_links (
                auth_provider_link_id,
                user_id,
                provider,
                provider_subject,
                provider_user_ref,
                status,
                linked_at,
                revoked_at,
                created_at,
                updated_at
              ) VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6, NULL, ?6, ?6)
            `,
            args: [authProviderLinkId, existingWalletUserId, provider, providerSubject, providerUserRef, createdAt],
          })

          await reconcileWalletAttachments(tx, {
            userId: existingWalletUserId,
            identity,
            updatedAt: createdAt,
          })

          resolvedUserId = existingWalletUserId
        } else {
          const userId = makeId("usr")

          await tx.execute({
            sql: `
              INSERT INTO users (
                user_id,
                primary_wallet_attachment_id,
                verification_state,
                capability_provider,
                verification_capabilities_json,
                verified_at,
                current_verification_session_id,
                created_at,
                updated_at
              ) VALUES (?1, NULL, 'unverified', NULL, ?2, NULL, NULL, ?3, ?3)
            `,
            args: [userId, JSON.stringify(buildDefaultVerificationCapabilities()), createdAt],
          })

          let insertedGlobalHandleId: string | null = null
          let attempts = 0
          while (!insertedGlobalHandleId && attempts < 12) {
            attempts += 1
            const candidate = generateHandleCandidate()
            const globalHandleId = makeId("ghd")

            try {
              await tx.execute({
                sql: `
                  INSERT INTO global_handles (
                    global_handle_id,
                    user_id,
                    label_normalized,
                    label_display,
                    status,
                    tier,
                    issuance_source,
                    redirect_target_global_handle_id,
                    price_paid_usd,
                    free_rename_consumed,
                    issued_at,
                    replaced_at,
                    created_at,
                    updated_at
                  ) VALUES (?1, ?2, ?3, ?4, 'active', 'generated', 'generated_signup', NULL, NULL, 0, ?5, NULL, ?5, ?5)
                `,
                args: [globalHandleId, userId, candidate.labelNormalized, candidate.labelDisplay, createdAt],
              })
              insertedGlobalHandleId = globalHandleId
            } catch (error) {
              if (!hasUniqueConstraintField(error, "global_handles.label_normalized")) {
                throw error
              }
            }
          }

          if (!insertedGlobalHandleId) {
            throw internalError("Could not allocate a generated global handle after repeated retries")
          }

          await tx.execute({
            sql: `
              INSERT INTO profiles (
                user_id,
                display_name,
                bio,
                avatar_ref,
                cover_ref,
                global_handle_id,
                created_at,
                updated_at
              ) VALUES (?1, NULL, NULL, NULL, NULL, ?2, ?3, ?3)
            `,
            args: [userId, insertedGlobalHandleId, createdAt],
          })

          await tx.execute({
            sql: `
              INSERT INTO auth_provider_links (
                auth_provider_link_id,
                user_id,
                provider,
                provider_subject,
                provider_user_ref,
                status,
                linked_at,
                revoked_at,
                created_at,
                updated_at
              ) VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6, NULL, ?6, ?6)
            `,
            args: [authProviderLinkId, userId, provider, providerSubject, providerUserRef, createdAt],
          })

          await reconcileWalletAttachments(tx, {
            userId,
            identity,
            updatedAt: createdAt,
          })

          resolvedUserId = userId
        }
      }

      await tx.commit()
    } catch (error) {
      try {
        await tx.rollback()
      } catch (rollbackError) {
        console.error("[auth] rollback failed while exchanging identity", rollbackError)
      }

      if (isActiveAuthProviderSubjectConflict(error)) {
        const existing = await findActiveAuthProviderLink(this.client, provider, providerSubject)
        if (existing) {
          resolvedUserId = existing.user_id
        } else {
          throw error
        }
      } else if (hasUniqueConstraintName(error, "idx_wallet_attachments_active_primary")) {
        const existing = await findActiveAuthProviderLink(this.client, provider, providerSubject)
        if (existing) {
          resolvedUserId = existing.user_id
        } else {
          throw error
        }
      } else {
        throw error
      }
    } finally {
      tx.close()
    }

    if (!resolvedUserId) {
      throw internalError("Resolved user id is missing after exchange")
    }

    return await loadSnapshot(this.client, resolvedUserId)
  }

  async getUserById(userId: string): Promise<User | null> {
    const userRow = await getUserRow(this.client, userId)
    return userRow ? serializeInternalUser(userRow) : null
  }

  async getWalletAttachmentsByUserId(userId: string): Promise<WalletAttachmentSummary[]> {
    const walletRows = await listActiveWalletAttachmentRows(this.client, userId)
    return serializeWalletAttachments(walletRows)
  }

  async getWalletAttachmentById(walletAttachmentId: string): Promise<(WalletAttachmentSummary & { user_id: string; status: string }) | null> {
    const rawId = normalizeSubmittedPrefixedId("wal", walletAttachmentId)
    if (!rawId) {
      return null
    }
    const row = (await this.client.execute({
      sql: `
        SELECT wallet_attachment_id, user_id, chain_namespace, wallet_address_normalized, wallet_address_display, is_primary, status
        FROM wallet_attachments
        WHERE wallet_attachment_id = ?1
        LIMIT 1
      `,
      args: [rawId],
    })).rows[0]
    if (!row) {
      return null
    }
    return {
      wallet_attachment: String((row as Record<string, unknown>).wallet_attachment_id),
      user_id: String((row as Record<string, unknown>).user_id),
      chain_namespace: String((row as Record<string, unknown>).chain_namespace),
      wallet_address: String((row as Record<string, unknown>).wallet_address_display),
      is_primary: Number((row as Record<string, unknown>).is_primary ?? 0) === 1,
      status: String((row as Record<string, unknown>).status),
    }
  }

  async getOnboardingStatusByUserId(userId: string): Promise<OnboardingStatus | null> {
    const userRow = await getUserRow(this.client, userId)
    if (!userRow) {
      return null
    }
    const profileRow = await getProfileRow(this.client, userId)
    if (!profileRow) {
      return null
    }
    const globalHandleRow = await getGlobalHandleRow(this.client, profileRow.global_handle_id)
    if (!globalHandleRow) {
      return null
    }
    return deriveOnboardingStatus(this.client, userRow, globalHandleRow)
  }

  async dismissOnboarding(userId: string): Promise<OnboardingStatus | null> {
    await dismissOnboardingForUser(this.client, userId, nowIso())
    return this.getOnboardingStatusByUserId(userId)
  }

  async getProfileByUserId(userId: string): Promise<Profile | null> {
    const userRow = await getUserRow(this.client, userId)
    if (!userRow) {
      return null
    }
    const profileRow = await getProfileRow(this.client, userId)
    if (!profileRow) {
      return null
    }
    const globalHandleRow = await getGlobalHandleRow(this.client, profileRow.global_handle_id)
    if (!globalHandleRow) {
      return null
    }
    const linkedHandleRows = await listLinkedHandleRows(this.client, userId)
    const walletRows = await listActiveWalletAttachmentRows(this.client, userId)
    const primaryWalletAddress = getPrimaryWalletAddressFromRows(
      userRow.primary_wallet_attachment_id,
      walletRows,
    )
    return assembleProfile(profileRow, globalHandleRow, linkedHandleRows, primaryWalletAddress, serializeUser(userRow))
  }

  async resolvePublicProfileByHandle(handleLabel: string): Promise<PublicProfileResolution | null> {
    const requestedHandle = normalizePublicHandleLabel(handleLabel)
    const requestedHandleRow = await getGlobalHandleRowByLabelNormalized(
      this.client,
      requestedHandle.labelNormalized,
    )
    if (!requestedHandleRow) {
      return await this.resolvePublicProfileByLinkedHandle(handleLabel)
    }

    const canonicalHandleRow = requestedHandleRow.status === "redirect" && requestedHandleRow.redirect_target_global_handle_id
      ? await getGlobalHandleRow(this.client, requestedHandleRow.redirect_target_global_handle_id)
      : requestedHandleRow
    if (!canonicalHandleRow) {
      return null
    }

    const profileRow = await getProfileRow(this.client, canonicalHandleRow.user_id)
    if (!profileRow) {
      return null
    }

    const linkedHandleRows = await listLinkedHandleRows(this.client, canonicalHandleRow.user_id)
    const walletRows = await listActiveWalletAttachmentRows(this.client, canonicalHandleRow.user_id)
    const createdCommunityRows = await listCreatedCommunityRowsByCreatorUserId(this.client, canonicalHandleRow.user_id)
    const userRow = await getUserRow(this.client, canonicalHandleRow.user_id)

    const profile = assembleProfile(
      profileRow,
      canonicalHandleRow,
      linkedHandleRows,
      getPrimaryWalletAddressFromRows(null, walletRows),
      userRow ? serializeUser(userRow) : null,
    )
    const resolvedPublicHandle = getProfilePublicHandleLabel(profile)
    const canonicalPirateRequest = requestedHandleRow.global_handle_id === canonicalHandleRow.global_handle_id

    return {
      profile,
      requested_handle_label: requestedHandle.labelDisplay,
      resolved_handle_label: resolvedPublicHandle,
      is_canonical: canonicalPirateRequest && resolvedPublicHandle === canonicalHandleRow.label_display,
      created_communities: createdCommunityRows.map((row) => ({
        community: publicCommunityId(row.community_id),
        display_name: row.display_name,
        route_slug: row.route_slug,
        created: unixSeconds(row.created_at),
      })),
    }
  }

  async resolvePublicProfileByLinkedHandle(handleLabel: string): Promise<PublicProfileResolution | null> {
    const requestedLinkedHandleLabel = normalizePublicLinkedHandleLabel(handleLabel)
    const linkedHandleRow = await getVerifiedLinkedHandleRowByLabelNormalized(
      this.client,
      requestedLinkedHandleLabel,
    )
    if (!linkedHandleRow) {
      return null
    }

    const profileRow = await getProfileRow(this.client, linkedHandleRow.user_id)
    if (!profileRow || profileRow.primary_linked_handle_id !== linkedHandleRow.linked_handle_id) {
      return null
    }

    const globalHandleRow = await getGlobalHandleRow(this.client, profileRow.global_handle_id)
    if (!globalHandleRow) {
      return null
    }

    const linkedHandleRows = await listLinkedHandleRows(this.client, linkedHandleRow.user_id)
    const walletRows = await listActiveWalletAttachmentRows(this.client, linkedHandleRow.user_id)
    const createdCommunityRows = await listCreatedCommunityRowsByCreatorUserId(this.client, linkedHandleRow.user_id)
    const userRow = await getUserRow(this.client, linkedHandleRow.user_id)

    return {
      profile: assembleProfile(
        profileRow,
        globalHandleRow,
        linkedHandleRows,
        getPrimaryWalletAddressFromRows(null, walletRows),
        userRow ? serializeUser(userRow) : null,
      ),
      requested_handle_label: linkedHandleRow.label_display,
      resolved_handle_label: linkedHandleRow.label_display,
      is_canonical: true,
      created_communities: createdCommunityRows.map((row) => ({
        community: publicCommunityId(row.community_id),
        display_name: row.display_name,
        route_slug: row.route_slug,
        created: unixSeconds(row.created_at),
      })),
    }
  }
}
