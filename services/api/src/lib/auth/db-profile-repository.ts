import type { Client } from "../sql-client"
import { conflictError, notFoundError } from "../errors"
import { nowIso } from "../helpers"
import type { Env, GlobalHandle, HandleUpgradeQuote, Profile } from "../../types"
import { DatabaseIdentityRepository } from "./db-identity-repository"
import {
  ensureProfilesPrimaryLinkedHandleColumn,
  firstRow,
  getGlobalHandleRow,
  getLinkedHandleRow,
  getProfileRow,
  getUserRow,
  hasUniqueConstraintField,
  listActiveWalletAttachmentRows,
} from "./auth-db-queries"
import { serializeGlobalHandle } from "./auth-serializers"
import {
  assertFreeCleanupRenameEligible,
  buildHandleUpgradeQuote,
  isCleanupRenameAvailable,
  normalizeDesiredGlobalHandleLabel,
} from "./global-handle-policy"
import { makeId } from "../helpers"
import { resolveVerifiedEnsName } from "./ens-linked-handle-service"
import type { PublicProfileResolution } from "./repositories"

export type UpdateProfileInput = {
  display_name?: string | null
  avatar_ref?: string | null
  cover_ref?: string | null
  bio?: string | null
  preferred_locale?: string | null
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
    await ensureProfilesPrimaryLinkedHandleColumn(this.client)
    const existing = await getProfileRow(this.client, userId)
    if (!existing) {
      return null
    }

    const updatedAt = nowIso()
    await this.client.execute({
      sql: `
        UPDATE profiles
        SET display_name = ?2,
            avatar_ref = ?3,
            cover_ref = ?4,
            bio = ?5,
            preferred_locale = ?6,
            updated_at = ?7
        WHERE user_id = ?1
      `,
      args: [
        userId,
        input.display_name !== undefined ? input.display_name : existing.display_name,
        input.avatar_ref !== undefined ? input.avatar_ref : existing.avatar_ref,
        input.cover_ref !== undefined ? input.cover_ref : existing.cover_ref,
        input.bio !== undefined ? input.bio : existing.bio,
        input.preferred_locale !== undefined ? input.preferred_locale : existing.preferred_locale,
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
    const activeRow = await this.client.execute({
      sql: `
        SELECT user_id
        FROM global_handles
        WHERE label_normalized = ?1
          AND status = 'active'
        LIMIT 1
      `,
      args: [desired.labelNormalized],
    })
    const activeLabelOwnerUserId = activeRow.rows[0]?.user_id == null ? null : String(activeRow.rows[0]?.user_id)

    return buildHandleUpgradeQuote({
      desiredLabel: desired.labelDisplay,
      labelNormalized: desired.labelNormalized,
      currentActiveLabelNormalized: activeGlobalHandleRow.label_normalized,
      cleanupRenameAvailable: isCleanupRenameAvailable({
        userCreatedAt: userRow.created_at,
        activeGlobalHandle: serializeGlobalHandle(activeGlobalHandleRow),
      }),
      labelAvailable: activeLabelOwnerUserId == null || activeLabelOwnerUserId === userId,
    })
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

    const resolvedEnsName = await resolveVerifiedEnsName(this.env, primaryWalletRow.wallet_address_display)
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
      if (resolvedEnsName) {
        const normalizedLabel = resolvedEnsName.toLowerCase()
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
              JSON.stringify({ wallet_address: primaryWalletRow.wallet_address_display }),
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
              JSON.stringify({ wallet_address: primaryWalletRow.wallet_address_display }),
              updatedAt,
            ],
          })
        }
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
        }).catch(async (error) => {
          if (error instanceof Error && error.message.includes("no such column: primary_linked_handle_id")) {
            await ensureProfilesPrimaryLinkedHandleColumn(tx)
            await tx.execute({
              sql: `
                UPDATE profiles
                SET primary_linked_handle_id = NULL,
                    updated_at = ?2
                WHERE user_id = ?1
              `,
              args: [userId, updatedAt],
            })
            return
          }
          throw error
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
    }).catch(async (error) => {
      if (error instanceof Error && error.message.includes("no such column: primary_linked_handle_id")) {
        await ensureProfilesPrimaryLinkedHandleColumn(this.client)
        await this.client.execute({
          sql: `
            UPDATE profiles
            SET primary_linked_handle_id = ?2,
                updated_at = ?3
            WHERE user_id = ?1
          `,
          args: [userId, linkedHandleId, nowIso()],
        })
        return
      }
      throw error
    })

    return await this.identityRepository.getProfileByUserId(userId)
  }
}
