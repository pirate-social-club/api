import type { Client } from "../sql-client"
import { conflictError, notFoundError } from "../errors"
import { nowIso } from "../helpers"
import type { Env, GlobalHandle, HandleUpgradeQuote, Profile } from "../../types"
import { DatabaseIdentityRepository } from "./db-identity-repository"
import {
  firstRow,
  getGlobalHandleRow,
  getLatestExternalReputationSnapshotRow,
  getLatestRedditVerificationSessionRowForUsername,
  getLinkedHandleRow,
  getProfileRow,
  getUserRow,
  hasUniqueConstraintField,
  listActiveWalletAttachmentRows,
  listLinkedHandleRows,
} from "./auth-db-queries"
import { parseRedditImportSummary, serializeGlobalHandle } from "./auth-serializers"
import {
  assertFreeCleanupRenameEligible,
  buildHandleUpgradeQuote,
  isCleanupRenameAvailable,
  normalizeDesiredGlobalHandleLabel,
} from "./global-handle-policy"
import { assertRedditHandleClaimEligible, buildRedditHandleClaimQuote } from "./reddit-handle-claim-policy"
import { makeId } from "../helpers"
import { resolveVerifiedEnsProfile } from "./ens-linked-handle-service"
import type { PublicProfileResolution } from "./repositories"

export type UpdateProfileInput = {
  display_name?: string | null
  avatar_ref?: string | null
  avatar_source?: Profile["avatar_source"]
  cover_ref?: string | null
  cover_source?: Profile["cover_source"]
  bio?: string | null
  bio_source?: Profile["bio_source"]
  preferred_locale?: string | null
  display_verified_nationality_badge?: boolean | null
}

function parseLinkedHandleMetadata(raw: string | null): Record<string, unknown> | null {
  if (!raw) {
    return null
  }

  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function stringMetadataValue(metadata: Record<string, unknown> | null, key: string): string | null {
  const value = metadata?.[key]
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function shouldUseEnsValue(currentRef: string | null, currentSource: "ens" | "upload" | "none" | "manual" | null): boolean {
  return currentSource === "ens" || (currentSource == null && currentRef == null)
}

export class DatabaseProfileRepository {
  private readonly identityRepository: DatabaseIdentityRepository

  constructor(
    private readonly client: Client,
    private readonly env: Env,
  ) {
    this.identityRepository = new DatabaseIdentityRepository(client)
  }

  async getProfileByUserId(userId: string): Promise<Profile | null> {
    return await this.identityRepository.getProfileByUserId(userId)
  }

  async resolvePublicProfileByHandle(handleLabel: string): Promise<PublicProfileResolution | null> {
    return await this.identityRepository.resolvePublicProfileByHandle(handleLabel)
  }

  async updateProfile(userId: string, input: UpdateProfileInput): Promise<Profile | null> {
    const existing = await getProfileRow(this.client, userId)
    if (!existing) {
      return null
    }

    let ensMetadata: Record<string, unknown> | null = null
    if (input.avatar_source === "ens" || input.cover_source === "ens" || input.bio_source === "ens") {
      const verifiedEnsHandle = (await listLinkedHandleRows(this.client, userId))
        .find((handle) => handle.kind === "ens" && handle.verification_state === "verified")
      ensMetadata = parseLinkedHandleMetadata(verifiedEnsHandle?.metadata_json ?? null)
    }

    const ensAvatar = stringMetadataValue(ensMetadata, "avatar")
    const ensCover = stringMetadataValue(ensMetadata, "header")
    const ensBio = stringMetadataValue(ensMetadata, "description")

    const avatarRef = input.avatar_source === "ens"
      ? ensAvatar
      : input.avatar_source === "none"
        ? null
        : input.avatar_ref !== undefined
          ? input.avatar_ref
          : existing.avatar_ref
    const avatarSource = input.avatar_source === "ens"
      ? (ensAvatar ? "ens" : null)
      : input.avatar_source === "none"
        ? "none"
        : input.avatar_ref !== undefined
          ? (input.avatar_ref == null ? "none" : "upload")
          : existing.avatar_source

    const coverRef = input.cover_source === "ens"
      ? ensCover
      : input.cover_source === "none"
        ? null
        : input.cover_ref !== undefined
          ? input.cover_ref
          : existing.cover_ref
    const coverSource = input.cover_source === "ens"
      ? (ensCover ? "ens" : null)
      : input.cover_source === "none"
        ? "none"
        : input.cover_ref !== undefined
          ? (input.cover_ref == null ? "none" : "upload")
          : existing.cover_source

    const bio = input.bio_source === "ens"
      ? ensBio
      : input.bio_source === "none"
        ? null
        : input.bio !== undefined
          ? input.bio
          : existing.bio
    const bioSource = input.bio_source === "ens"
      ? (ensBio ? "ens" : null)
      : input.bio_source === "none"
        ? "none"
        : input.bio !== undefined
          ? (input.bio == null ? "none" : "manual")
          : existing.bio_source

    const updatedAt = nowIso()
    await this.client.execute({
      sql: `
        UPDATE profiles
        SET display_name = ?2,
            avatar_ref = ?3,
            cover_ref = ?4,
            bio = ?5,
            preferred_locale = ?6,
            display_verified_nationality_badge = ?7,
            avatar_source = ?8,
            cover_source = ?9,
            bio_source = ?10,
            updated_at = ?11
        WHERE user_id = ?1
      `,
      args: [
        userId,
        input.display_name !== undefined ? input.display_name : existing.display_name,
        avatarRef,
        coverRef,
        bio,
        input.preferred_locale !== undefined ? input.preferred_locale : existing.preferred_locale,
        input.display_verified_nationality_badge !== undefined
          ? (input.display_verified_nationality_badge ? 1 : 0)
          : existing.display_verified_nationality_badge,
        avatarSource,
        coverSource,
        bioSource,
        updatedAt,
      ],
    })

    return await this.identityRepository.getProfileByUserId(userId)
  }

  async renameGlobalHandle(userId: string, desiredLabel: string): Promise<GlobalHandle | null> {
    const userRow = await getUserRow(this.client, userId)
    const profileRow = await getProfileRow(this.client, userId)
    if (!userRow || !profileRow) {
      return null
    }

    const activeGlobalHandleRow = await getGlobalHandleRow(this.client, profileRow.global_handle_id)
    if (!activeGlobalHandleRow) {
      return null
    }

    const desired = normalizeDesiredGlobalHandleLabel(desiredLabel)
    if (desired.labelDisplay === activeGlobalHandleRow.label_display) {
      return serializeGlobalHandle(activeGlobalHandleRow)
    }

    assertFreeCleanupRenameEligible({
      desiredLabel: desired.labelDisplay,
      labelNormalized: desired.labelNormalized,
      activeGlobalHandle: serializeGlobalHandle(activeGlobalHandleRow),
      userCreatedAt: userRow.created_at,
    })

    const tx = await this.client.transaction("write")
    try {
      const updatedAt = nowIso()
      const nextGlobalHandleId = makeId("ghd")

      await tx.execute({
        sql: `
          UPDATE global_handles
          SET status = 'redirect',
              redirect_target_global_handle_id = NULL,
              replaced_at = ?2,
              updated_at = ?2
          WHERE global_handle_id = ?1
        `,
        args: [activeGlobalHandleRow.global_handle_id, updatedAt],
      })

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
          ) VALUES (
            ?1, ?2, ?3, ?4, 'active', 'standard', 'free_cleanup_rename', NULL, NULL, 1, ?5, NULL, ?5, ?5
          )
        `,
        args: [nextGlobalHandleId, userId, desired.labelNormalized, desired.labelDisplay, updatedAt],
      })

      await tx.execute({
        sql: `
          UPDATE global_handles
          SET redirect_target_global_handle_id = ?2,
              updated_at = ?3
          WHERE global_handle_id = ?1
        `,
        args: [activeGlobalHandleRow.global_handle_id, nextGlobalHandleId, updatedAt],
      })

      await tx.execute({
        sql: `
          UPDATE profiles
          SET global_handle_id = ?2,
              updated_at = ?3
          WHERE user_id = ?1
        `,
        args: [userId, nextGlobalHandleId, updatedAt],
      })

      await tx.commit()
    } catch (error) {
      try {
        await tx.rollback()
      } catch {}
      if (hasUniqueConstraintField(error, "global_handles.label_normalized")) {
        throw conflictError("Desired label is unavailable")
      }
      throw error
    } finally {
      tx.close()
    }

    const nextGlobalHandleRow = await getProfileRow(this.client, userId)
      .then((nextProfile) => nextProfile ? getGlobalHandleRow(this.client, nextProfile.global_handle_id) : null)
    return nextGlobalHandleRow ? serializeGlobalHandle(nextGlobalHandleRow) : null
  }

  async claimRedditGlobalHandle(userId: string, desiredLabel: string): Promise<GlobalHandle | null> {
    const userRow = await getUserRow(this.client, userId)
    const profileRow = await getProfileRow(this.client, userId)
    if (!userRow || !profileRow) {
      return null
    }

    const activeGlobalHandleRow = await getGlobalHandleRow(this.client, profileRow.global_handle_id)
    if (!activeGlobalHandleRow) {
      return null
    }

    const desired = normalizeDesiredGlobalHandleLabel(desiredLabel)
    if (desired.labelDisplay === activeGlobalHandleRow.label_display) {
      return serializeGlobalHandle(activeGlobalHandleRow)
    }

    const activeLabelOwnerUserId = await this.getActiveGlobalHandleOwnerUserId(desired.labelNormalized)
    const latestRedditVerification = await getLatestRedditVerificationSessionRowForUsername(this.client, userId, desired.labelNormalized)
    const latestRedditSnapshot = await getLatestExternalReputationSnapshotRow(this.client, userId)
    const latestRedditImportSummary = latestRedditSnapshot?.source_account_handle === desired.labelNormalized
      ? parseRedditImportSummary(latestRedditSnapshot.snapshot_payload_json)
      : null
    const quote = buildRedditHandleClaimQuote({
      desiredLabel: desired.labelDisplay,
      labelNormalized: desired.labelNormalized,
      currentActiveLabelNormalized: activeGlobalHandleRow.label_normalized,
      labelAvailable: activeLabelOwnerUserId == null || activeLabelOwnerUserId === userId,
      verifiedRedditUsername: latestRedditVerification?.status === "verified" ? latestRedditVerification.reddit_username : null,
      latestImportSummary: latestRedditImportSummary,
    })
    assertRedditHandleClaimEligible(quote)

    const tx = await this.client.transaction("write")
    try {
      const updatedAt = nowIso()
      const nextGlobalHandleId = makeId("ghd")

      await tx.execute({
        sql: `
          UPDATE global_handles
          SET status = 'redirect',
              redirect_target_global_handle_id = NULL,
              replaced_at = ?2,
              updated_at = ?2
          WHERE global_handle_id = ?1
        `,
        args: [activeGlobalHandleRow.global_handle_id, updatedAt],
      })

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
          ) VALUES (
            ?1, ?2, ?3, ?4, 'active', ?5, 'reddit_verified_claim', NULL, NULL, 1, ?6, NULL, ?6, ?6
          )
        `,
        args: [nextGlobalHandleId, userId, desired.labelNormalized, desired.labelDisplay, quote.tier, updatedAt],
      })

      await tx.execute({
        sql: `
          UPDATE global_handles
          SET redirect_target_global_handle_id = ?2,
              updated_at = ?3
          WHERE global_handle_id = ?1
        `,
        args: [activeGlobalHandleRow.global_handle_id, nextGlobalHandleId, updatedAt],
      })

      await tx.execute({
        sql: `
          UPDATE profiles
          SET global_handle_id = ?2,
              updated_at = ?3
          WHERE user_id = ?1
        `,
        args: [userId, nextGlobalHandleId, updatedAt],
      })

      await tx.commit()
    } catch (error) {
      try {
        await tx.rollback()
      } catch {}
      if (hasUniqueConstraintField(error, "global_handles.label_normalized")) {
        throw conflictError("Desired label is unavailable")
      }
      throw error
    } finally {
      tx.close()
    }

    const nextGlobalHandleRow = await getProfileRow(this.client, userId)
      .then((nextProfile) => nextProfile ? getGlobalHandleRow(this.client, nextProfile.global_handle_id) : null)
    return nextGlobalHandleRow ? serializeGlobalHandle(nextGlobalHandleRow) : null
  }

  async quoteGlobalHandleUpgrade(userId: string, desiredLabel: string): Promise<HandleUpgradeQuote | null> {
    const userRow = await getUserRow(this.client, userId)
    const profileRow = await getProfileRow(this.client, userId)
    if (!userRow || !profileRow) {
      return null
    }

    const activeGlobalHandleRow = await getGlobalHandleRow(this.client, profileRow.global_handle_id)
    if (!activeGlobalHandleRow) {
      return null
    }

    const desired = normalizeDesiredGlobalHandleLabel(desiredLabel)
    const activeLabelOwnerUserId = await this.getActiveGlobalHandleOwnerUserId(desired.labelNormalized)
    const labelAvailable = activeLabelOwnerUserId == null || activeLabelOwnerUserId === userId
    const latestRedditVerification = await getLatestRedditVerificationSessionRowForUsername(this.client, userId, desired.labelNormalized)
    const latestRedditSnapshot = await getLatestExternalReputationSnapshotRow(this.client, userId)
    const latestRedditImportSummary = latestRedditSnapshot?.source_account_handle === desired.labelNormalized
      ? parseRedditImportSummary(latestRedditSnapshot.snapshot_payload_json)
      : null
    const redditQuote = buildRedditHandleClaimQuote({
      desiredLabel: desired.labelDisplay,
      labelNormalized: desired.labelNormalized,
      currentActiveLabelNormalized: activeGlobalHandleRow.label_normalized,
      labelAvailable,
      verifiedRedditUsername: latestRedditVerification?.status === "verified" ? latestRedditVerification.reddit_username : null,
      latestImportSummary: latestRedditImportSummary,
    })
    if (redditQuote.eligible || redditQuote.reason !== "Desired label must match a verified Reddit username") {
      return redditQuote
    }

    return buildHandleUpgradeQuote({
      desiredLabel: desired.labelDisplay,
      labelNormalized: desired.labelNormalized,
      currentActiveLabelNormalized: activeGlobalHandleRow.label_normalized,
      cleanupRenameAvailable: isCleanupRenameAvailable({
        userCreatedAt: userRow.created_at,
        activeGlobalHandle: serializeGlobalHandle(activeGlobalHandleRow),
      }),
      labelAvailable,
    })
  }

  private async getActiveGlobalHandleOwnerUserId(labelNormalized: string): Promise<string | null> {
    const activeRow = await this.client.execute({
      sql: `
        SELECT user_id
        FROM global_handles
        WHERE label_normalized = ?1
          AND status = 'active'
        LIMIT 1
      `,
      args: [labelNormalized],
    })
    return activeRow.rows[0]?.user_id == null ? null : String(activeRow.rows[0]?.user_id)
  }

  async syncLinkedHandles(userId: string): Promise<Profile | null> {
    const userRow = await getUserRow(this.client, userId)
    const profileRow = await getProfileRow(this.client, userId)
    if (!userRow || !profileRow) {
      return null
    }

    const walletRows = await listActiveWalletAttachmentRows(this.client, userId)
    const primaryWalletRow =
      walletRows.find((row) => row.wallet_attachment_id === userRow.primary_wallet_attachment_id)
      ?? walletRows.find((row) => row.is_primary === 1)
      ?? null

    if (!primaryWalletRow || primaryWalletRow.chain_namespace !== "eip155:1") {
      return await this.identityRepository.getProfileByUserId(userId)
    }

    const resolvedEnsProfile = await resolveVerifiedEnsProfile(this.env, primaryWalletRow.wallet_address_display)
    const updatedAt = nowIso()
    const tx = await this.client.transaction("write")

    try {
      await tx.execute({
        sql: `
          UPDATE linked_handles
          SET verification_state = 'stale',
              updated_at = ?2
          WHERE user_id = ?1
            AND kind = 'ens'
        `,
        args: [userId, updatedAt],
      })

      let verifiedLinkedHandleId: string | null = null
      if (resolvedEnsProfile) {
        const resolvedEnsName = resolvedEnsProfile.name
        const normalizedLabel = resolvedEnsName.toLowerCase()
        const metadataJson = JSON.stringify({
          ...resolvedEnsProfile.metadata,
          wallet_address: primaryWalletRow.wallet_address_display,
        })
        const existingRow = await firstRow(tx, {
          sql: `
            SELECT linked_handle_id
            FROM linked_handles
            WHERE user_id = ?1
              AND kind = 'ens'
              AND label_normalized = ?2
            LIMIT 1
          `,
          args: [userId, normalizedLabel],
        })

        if (existingRow) {
          verifiedLinkedHandleId = String((existingRow as Record<string, unknown>).linked_handle_id)
          await tx.execute({
            sql: `
              UPDATE linked_handles
              SET wallet_attachment_id = ?2,
                  label_display = ?3,
                  verification_state = 'verified',
                  metadata_json = ?4,
                  updated_at = ?5
              WHERE linked_handle_id = ?1
            `,
            args: [
              verifiedLinkedHandleId,
              primaryWalletRow.wallet_attachment_id,
              resolvedEnsName,
              metadataJson,
              updatedAt,
            ],
          })
        } else {
          verifiedLinkedHandleId = makeId("lnk")
          await tx.execute({
            sql: `
              INSERT INTO linked_handles (
                linked_handle_id,
                user_id,
                wallet_attachment_id,
                kind,
                label_normalized,
                label_display,
                verification_state,
                metadata_json,
                created_at,
                updated_at
              ) VALUES (?1, ?2, ?3, 'ens', ?4, ?5, 'verified', ?6, ?7, ?7)
            `,
            args: [
              verifiedLinkedHandleId,
              userId,
              primaryWalletRow.wallet_attachment_id,
              normalizedLabel,
              resolvedEnsName,
              metadataJson,
              updatedAt,
            ],
          })
        }

        const nextAvatarRef = shouldUseEnsValue(profileRow.avatar_ref, profileRow.avatar_source)
          ? resolvedEnsProfile.metadata.avatar ?? null
          : profileRow.avatar_ref
        const nextAvatarSource = shouldUseEnsValue(profileRow.avatar_ref, profileRow.avatar_source)
          ? (resolvedEnsProfile.metadata.avatar ? "ens" : null)
          : profileRow.avatar_source
        const nextCoverRef = shouldUseEnsValue(profileRow.cover_ref, profileRow.cover_source)
          ? resolvedEnsProfile.metadata.header ?? null
          : profileRow.cover_ref
        const nextCoverSource = shouldUseEnsValue(profileRow.cover_ref, profileRow.cover_source)
          ? (resolvedEnsProfile.metadata.header ? "ens" : null)
          : profileRow.cover_source
        const nextBio = shouldUseEnsValue(profileRow.bio, profileRow.bio_source)
          ? resolvedEnsProfile.metadata.description ?? null
          : profileRow.bio
        const nextBioSource = shouldUseEnsValue(profileRow.bio, profileRow.bio_source)
          ? (resolvedEnsProfile.metadata.description ? "ens" : null)
          : profileRow.bio_source

        await tx.execute({
          sql: `
            UPDATE profiles
            SET avatar_ref = ?2,
                cover_ref = ?3,
                bio = ?4,
                avatar_source = ?5,
                cover_source = ?6,
                bio_source = ?7,
                updated_at = ?8
            WHERE user_id = ?1
          `,
          args: [
            userId,
            nextAvatarRef,
            nextCoverRef,
            nextBio,
            nextAvatarSource,
            nextCoverSource,
            nextBioSource,
            updatedAt,
          ],
        })
      }

      if (profileRow.primary_linked_handle_id && profileRow.primary_linked_handle_id !== verifiedLinkedHandleId) {
        await tx.execute({
          sql: `
            UPDATE profiles
            SET primary_linked_handle_id = NULL,
                updated_at = ?2
            WHERE user_id = ?1
          `,
          args: [userId, updatedAt],
        })
      }

      await tx.commit()
    } catch (error) {
      try {
        await tx.rollback()
      } catch {}
      throw error
    } finally {
      tx.close()
    }

    return await this.identityRepository.getProfileByUserId(userId)
  }

  async setPrimaryPublicHandle(userId: string, linkedHandleId: string | null): Promise<Profile | null> {
    const existing = await getProfileRow(this.client, userId)
    if (!existing) {
      return null
    }

    if (linkedHandleId !== null) {
      const linkedHandle = await getLinkedHandleRow(this.client, userId, linkedHandleId)
      if (!linkedHandle) {
        throw notFoundError("Linked handle not found")
      }
      if (linkedHandle.verification_state !== "verified") {
        throw conflictError("Linked handle is not verified")
      }
    }

    await this.client.execute({
      sql: `
        UPDATE profiles
        SET primary_linked_handle_id = ?2,
            updated_at = ?3
        WHERE user_id = ?1
      `,
      args: [userId, linkedHandleId, nowIso()],
    })

    return await this.identityRepository.getProfileByUserId(userId)
  }
}
