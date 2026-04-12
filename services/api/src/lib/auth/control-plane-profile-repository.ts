import { conflictError } from "../errors"
import { nowIso } from "../helpers"
import type { ControlPlaneDbClient } from "../control-plane-db"
import type { GlobalHandle, HandleUpgradeQuote, Profile } from "../../types"
import { ControlPlaneIdentityRepository } from "./control-plane-identity-repository"
import {
  getGlobalHandleRow,
  getLatestVerifiedRedditVerificationSessionRow,
  getProfileRow,
  getUserRow,
  hasUniqueConstraintField,
} from "./control-plane-auth-queries"
import { serializeGlobalHandle } from "./control-plane-auth-serializers"
import {
  assertFreeCleanupRenameEligible,
  assertRedditVerifiedClaimEligible,
  buildHandleUpgradeQuote,
  isCleanupRenameAvailable,
  isReservedGlobalHandleLabel,
  normalizeDesiredGlobalHandleLabel,
  validateDesiredGlobalHandleLabel,
} from "./global-handle-policy"
import { makeId } from "../helpers"

export type UpdateProfileInput = {
  display_name?: string | null
  avatar_ref?: string | null
  bio?: string | null
  preferred_locale?: string | null
}

export class ControlPlaneProfileRepository {
  private readonly identityRepository: ControlPlaneIdentityRepository

  constructor(private readonly client: ControlPlaneDbClient) {
    this.identityRepository = new ControlPlaneIdentityRepository(client)
  }

  async getProfileByUserId(userId: string): Promise<Profile | null> {
    return await this.identityRepository.getProfileByUserId(userId)
  }

  async updateProfile(userId: string, input: UpdateProfileInput): Promise<Profile | null> {
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
            bio = ?4,
            preferred_locale = ?5,
            updated_at = ?6
        WHERE user_id = ?1
      `,
      args: [
        userId,
        input.display_name !== undefined ? input.display_name : existing.display_name,
        input.avatar_ref !== undefined ? input.avatar_ref : existing.avatar_ref,
        input.bio !== undefined ? input.bio : existing.bio,
        input.preferred_locale !== undefined ? input.preferred_locale : existing.preferred_locale,
        updatedAt,
      ],
    })

    return await this.identityRepository.getProfileByUserId(userId)
  }

  async renameGlobalHandle(userId: string, desiredLabel: string, issuanceSource?: string): Promise<GlobalHandle | null> {
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

    if (issuanceSource === "reddit_verified_claim") {
      const verifiedRedditUsername = await getLatestVerifiedRedditVerificationSessionRow(this.client, userId)
      assertRedditVerifiedClaimEligible({
        labelNormalized: desired.labelNormalized,
        verifiedRedditUsername: verifiedRedditUsername?.reddit_username ?? null,
      })
    }

    const resolvedIssuanceSource = issuanceSource ?? "free_cleanup_rename"

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
            ?1, ?2, ?3, ?4, 'active', 'standard', ?5, NULL, NULL, 1, ?6, NULL, ?6, ?6
          )
        `,
        args: [nextGlobalHandleId, userId, desired.labelNormalized, desired.labelDisplay, resolvedIssuanceSource, updatedAt],
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

  async checkGlobalHandleAvailability(userId: string, label: string): Promise<{
    label: string
    status: "available" | "taken" | "reserved" | "invalid"
    suggestion?: { label: string; source: "variation" | "generated" }
  }> {
    const result = validateDesiredGlobalHandleLabel(label)
    if (!result.valid) {
      return { label: label.trim().toLowerCase(), status: "invalid" }
    }

    if (isReservedGlobalHandleLabel(result.labelNormalized)) {
      return { label: result.labelNormalized, status: "reserved" }
    }

    const profileRow = await getProfileRow(this.client, userId)
    if (!profileRow) {
      return { label: result.labelNormalized, status: "available" }
    }

    const activeGlobalHandleRow = await getGlobalHandleRow(this.client, profileRow.global_handle_id)
    if (activeGlobalHandleRow && activeGlobalHandleRow.label_normalized === result.labelNormalized) {
      return { label: result.labelNormalized, status: "available" }
    }

    const activeRow = await this.client.execute({
      sql: `
        SELECT user_id
        FROM global_handles
        WHERE label_normalized = ?1
          AND status = 'active'
        LIMIT 1
      `,
      args: [result.labelNormalized],
    })
    const activeLabelOwnerUserId = activeRow.rows[0]?.user_id == null ? null : String(activeRow.rows[0]?.user_id)

    if (activeLabelOwnerUserId != null && activeLabelOwnerUserId !== userId) {
      return { label: result.labelNormalized, status: "taken" }
    }

    return { label: result.labelNormalized, status: "available" }
  }
}
