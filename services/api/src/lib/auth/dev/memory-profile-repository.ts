import { badRequestError, conflictError, notFoundError } from "../../errors"
import { makeId, nowIso } from "../../helpers"
import { getProfilePublicHandleLabel } from "../auth-serializers"
import {
  assertFreeCleanupRenameEligible,
  buildHandleUpgradeQuote,
  isCleanupRenameAvailable,
  normalizeDesiredGlobalHandleLabel,
} from "../global-handle-policy"
import { assertRedditHandleClaimEligible, buildRedditHandleClaimQuote } from "../reddit-handle-claim-policy"
import { exposeMemoryGlobalHandle, exposeMemoryProfile, getMemoryRecordByUserId, getMemoryStore, type MemoryGlobalHandle } from "./memory-auth-store"
import type { GlobalHandle, GlobalHandlePaidClaimRequest, HandleUpgradeQuote, Profile } from "../../../types"
import type { PublicProfileResolution, UpdateProfileInput } from "../repositories"

export class MemoryProfileRepository {
  async getProfileByUserId(userId: string): Promise<Profile | null> {
    const record = getMemoryRecordByUserId(userId)
    return record ? exposeMemoryProfile(record) : null
  }

  async listProfilesByUserIds(userIds: string[]): Promise<Map<string, Profile>> {
    const profiles = new Map<string, Profile>()
    for (const userId of new Set(userIds.map((value) => value.trim()).filter(Boolean))) {
      const profile = await this.getProfileByUserId(userId)
      if (profile) {
        profiles.set(userId, profile)
      }
    }
    return profiles
  }

  async resolvePublicProfileByHandle(handleLabel: string): Promise<PublicProfileResolution | null> {
    const trimmedHandleLabel = handleLabel.trim().toLowerCase()
    const normalizedHandleLabel = trimmedHandleLabel.endsWith(".pirate")
      ? trimmedHandleLabel
      : `${trimmedHandleLabel}.pirate`

    const pirateRecord = [...getMemoryStore().byUserId.values()].find((candidate) => (
      candidate.profile.global_handle.label.toLowerCase() === normalizedHandleLabel
    ))
    const record = pirateRecord ?? [...getMemoryStore().byUserId.values()].find((candidate) => (
      candidate.profile.primary_public_handle?.label.toLowerCase() === trimmedHandleLabel
    ))
    if (!record) {
      return null
    }
    const exposedProfile = exposeMemoryProfile(record)
    const publicHandle = getProfilePublicHandleLabel(exposedProfile)
    const requestedHandle = pirateRecord ? normalizedHandleLabel : publicHandle

    return {
      profile: exposedProfile,
      requested_handle_label: requestedHandle,
      resolved_handle_label: publicHandle,
      is_canonical: publicHandle.toLowerCase() === requestedHandle.toLowerCase(),
      created_communities: [],
    }
  }

  async resolvePublicProfileByWalletAddress(walletAddress: string): Promise<PublicProfileResolution | null> {
    const normalizedWalletAddress = walletAddress.trim().toLowerCase()
    const record = [...getMemoryStore().byUserId.values()].find((candidate) => (
      candidate.walletAttachments.some((attachment) => (
        attachment.wallet_address.toLowerCase() === normalizedWalletAddress
      ))
    ))
    if (!record) {
      return null
    }

    const exposedProfile = exposeMemoryProfile(record)
    const publicHandle = getProfilePublicHandleLabel(exposedProfile)
    return {
      profile: exposedProfile,
      requested_handle_label: walletAddress.trim(),
      resolved_handle_label: publicHandle,
      is_canonical: true,
      created_communities: [],
    }
  }

  async updateXmtpInboxId(userId: string, xmtpInboxId: string | null): Promise<Profile | null> {
    const record = getMemoryRecordByUserId(userId)
    if (!record) {
      return null
    }

    record.profile = {
      ...record.profile,
      xmtp_inbox_id: xmtpInboxId,
      updated_at: nowIso(),
    }
    return exposeMemoryProfile(record)
  }

  async updateProfile(userId: string, input: UpdateProfileInput): Promise<Profile | null> {
    const record = getMemoryRecordByUserId(userId)
    if (!record) {
      return null
    }

    record.profile = {
      ...record.profile,
      display_name: input.display_name !== undefined ? input.display_name : record.profile.display_name,
      avatar_ref: input.avatar_ref !== undefined ? input.avatar_ref : record.profile.avatar_ref,
      avatar_source: input.avatar_source !== undefined
        ? input.avatar_source
        : input.avatar_ref !== undefined
          ? (input.avatar_ref == null ? "none" : "upload")
          : record.profile.avatar_source,
      cover_ref: input.cover_ref !== undefined ? input.cover_ref : record.profile.cover_ref,
      cover_source: input.cover_source !== undefined
        ? input.cover_source
        : input.cover_ref !== undefined
          ? (input.cover_ref == null ? "none" : "upload")
          : record.profile.cover_source,
      bio: input.bio !== undefined ? input.bio : record.profile.bio,
      bio_source: input.bio_source !== undefined
        ? input.bio_source
        : input.bio !== undefined
          ? (input.bio == null ? "none" : "manual")
          : record.profile.bio_source,
      preferred_locale: input.preferred_locale !== undefined ? input.preferred_locale : record.profile.preferred_locale,
      display_verified_nationality_badge: input.display_verified_nationality_badge !== undefined
        ? Boolean(input.display_verified_nationality_badge)
        : record.profile.display_verified_nationality_badge,
      updated_at: nowIso(),
    }
    return exposeMemoryProfile(record)
  }

  async syncLinkedHandles(userId: string): Promise<Profile | null> {
    const record = getMemoryRecordByUserId(userId)
    return record ? exposeMemoryProfile(record) : null
  }

  async setPrimaryPublicHandle(userId: string, linkedHandleId: string | null): Promise<Profile | null> {
    const record = getMemoryRecordByUserId(userId)
    if (!record) {
      return null
    }

    record.profile = {
      ...record.profile,
      primary_public_handle: linkedHandleId == null
        ? null
        : (record.profile.linked_handles ?? []).find((handle) => handle.linked_handle_id === linkedHandleId) ?? null,
      updated_at: nowIso(),
    }

    return exposeMemoryProfile(record)
  }

  async renameGlobalHandle(userId: string, desiredLabel: string): Promise<GlobalHandle | null> {
    const record = getMemoryRecordByUserId(userId)
    if (!record) {
      return null
    }

    const desired = normalizeDesiredGlobalHandleLabel(desiredLabel)
    if (desired.labelDisplay === record.profile.global_handle.label) {
      return exposeMemoryGlobalHandle(record.profile.global_handle)
    }

    assertFreeCleanupRenameEligible({
      desiredLabel: desired.labelDisplay,
      labelNormalized: desired.labelNormalized,
      activeGlobalHandle: exposeMemoryGlobalHandle(record.profile.global_handle),
      userCreatedAt: record.user.created_at,
    })

    const store = getMemoryStore()
    for (const candidateRecord of store.byUserId.values()) {
      if (
        candidateRecord.user.user_id !== userId
        && candidateRecord.profile.global_handle.status === "active"
        && candidateRecord.profile.global_handle.label.toLowerCase() === desired.labelDisplay.toLowerCase()
      ) {
        throw conflictError("Desired label is unavailable")
      }
    }

    const updatedAt = nowIso()
    const next: MemoryGlobalHandle = {
      global_handle_id: makeId("ghl"),
      label: desired.labelDisplay,
      tier: "standard",
      status: "active",
      issuance_source: "free_cleanup_rename",
      redirect_target_global_handle_id: null,
      price_paid_cents: null,
      free_rename_consumed: true,
      issued_at: updatedAt,
      replaced_at: null,
    }

    record.profile = {
      ...record.profile,
      global_handle: next,
      linked_handles: [
        {
          linked_handle_id: `global:${next.global_handle_id}`,
          label: next.label,
          kind: "pirate",
          verification_state: "verified",
        },
        ...(record.profile.linked_handles ?? []).filter((handle) => handle.kind !== "pirate"),
      ],
      updated_at: updatedAt,
    }
    record.onboarding = {
      ...record.onboarding,
      generated_handle_assigned: false,
      cleanup_rename_available: false,
    }
    return exposeMemoryGlobalHandle(next)
  }

  async claimRedditGlobalHandle(userId: string, desiredLabel: string): Promise<GlobalHandle | null> {
    const record = getMemoryRecordByUserId(userId)
    if (!record) {
      return null
    }

    const desired = normalizeDesiredGlobalHandleLabel(desiredLabel)
    if (desired.labelDisplay === record.profile.global_handle.label) {
      return exposeMemoryGlobalHandle(record.profile.global_handle)
    }

    const labelAvailable = this.isGlobalHandleAvailable(userId, desired.labelDisplay)
    const redditClaimOwnerUserId = this.getRedditClaimOwnerUserId(desired.labelDisplay)
    const quote = buildRedditHandleClaimQuote({
      desiredLabel: desired.labelDisplay,
      labelNormalized: desired.labelNormalized,
      currentActiveLabelNormalized: record.profile.global_handle.label.replace(/\.pirate$/i, "").toLowerCase(),
      labelAvailable,
      profileAlreadyUsedRedditClaim: record.profile.global_handle.issuance_source === "reddit_verified_claim",
      redditClaimedByAnotherUser: redditClaimOwnerUserId != null && redditClaimOwnerUserId !== userId,
      verifiedRedditUsername: record.redditVerification?.status === "verified" ? record.redditVerification.reddit_username : null,
      latestImportSummary: record.redditImportSummary,
    })
    assertRedditHandleClaimEligible(quote)

    const updatedAt = nowIso()
    const next: MemoryGlobalHandle = {
      global_handle_id: makeId("ghl"),
      label: desired.labelDisplay,
      tier: quote.tier,
      status: "active",
      issuance_source: "reddit_verified_claim",
      redirect_target_global_handle_id: null,
      price_paid_cents: null,
      free_rename_consumed: true,
      issued_at: updatedAt,
      replaced_at: null,
    }

    record.profile = {
      ...record.profile,
      global_handle: next,
      linked_handles: [
        {
          linked_handle_id: `global:${next.global_handle_id}`,
          label: next.label,
          kind: "pirate",
          verification_state: "verified",
        },
        ...(record.profile.linked_handles ?? []).filter((handle) => handle.kind !== "pirate"),
      ],
      updated_at: updatedAt,
    }
    record.onboarding = {
      ...record.onboarding,
      generated_handle_assigned: false,
      cleanup_rename_available: false,
    }
    return exposeMemoryGlobalHandle(next)
  }

  async quoteGlobalHandleUpgrade(userId: string, desiredLabel: string): Promise<HandleUpgradeQuote | null> {
    const record = getMemoryRecordByUserId(userId)
    if (!record) {
      return null
    }

    const desired = normalizeDesiredGlobalHandleLabel(desiredLabel)
    const labelAvailable = this.isGlobalHandleAvailable(userId, desired.labelDisplay)
    const redditClaimOwnerUserId = this.getRedditClaimOwnerUserId(desired.labelDisplay)
    const redditQuote = buildRedditHandleClaimQuote({
      desiredLabel: desired.labelDisplay,
      labelNormalized: desired.labelNormalized,
      currentActiveLabelNormalized: record.profile.global_handle.label.replace(/\.pirate$/i, "").toLowerCase(),
      labelAvailable,
      profileAlreadyUsedRedditClaim: record.profile.global_handle.issuance_source === "reddit_verified_claim",
      redditClaimedByAnotherUser: redditClaimOwnerUserId != null && redditClaimOwnerUserId !== userId,
      verifiedRedditUsername: record.redditVerification?.status === "verified" ? record.redditVerification.reddit_username : null,
      latestImportSummary: record.redditImportSummary,
    })
    if (redditQuote.eligible || redditQuote.reason !== "Desired label must match a verified Reddit username") {
      return redditQuote
    }

    const quote = buildHandleUpgradeQuote({
      desiredLabel: desired.labelDisplay,
      labelNormalized: desired.labelNormalized,
      currentActiveLabelNormalized: record.profile.global_handle.label.replace(/\.pirate$/i, "").toLowerCase(),
      cleanupRenameAvailable: isCleanupRenameAvailable({
        userCreatedAt: record.user.created_at,
        activeGlobalHandle: exposeMemoryGlobalHandle(record.profile.global_handle),
      }),
      labelAvailable,
    })
    if (!quote.eligible || quote.price_cents <= 0) {
      return quote
    }
    return {
      ...quote,
      quote: `ghq_mem_${desired.labelNormalized}`,
      currency: "USD",
      quote_ttl_seconds: 900,
      quoted_at: Math.floor(Date.now() / 1000),
      expires_at: Math.floor(Date.now() / 1000) + 900,
      payment_instructions: null,
    }
  }

  async claimPaidGlobalHandle(userId: string, body: GlobalHandlePaidClaimRequest): Promise<GlobalHandle | null> {
    const record = getMemoryRecordByUserId(userId)
    if (!record) {
      return null
    }
    const quote = body.quote?.trim()
    if (!quote) {
      throw badRequestError("quote is required")
    }
    const labelNormalized = quote.replace(/^ghq_mem_/, "").replace(/^ghq_/, "")
    if (!body.settlement_wallet_attachment?.trim()) {
      throw badRequestError("settlement_wallet_attachment is required for paid handle claims")
    }
    if (!body.funding_tx_ref?.trim()) {
      throw badRequestError("funding_tx_ref is required for paid handle claims")
    }
    if (!record.walletAttachments.some((wallet) => wallet.wallet_attachment_id === body.settlement_wallet_attachment)) {
      throw notFoundError("settlement_wallet_attachment is not available for this user")
    }
    if (!this.isGlobalHandleAvailable(userId, `${labelNormalized}.pirate`)) {
      throw conflictError("Desired label is unavailable")
    }
    const paidQuote = buildHandleUpgradeQuote({
      desiredLabel: `${labelNormalized}.pirate`,
      labelNormalized,
      currentActiveLabelNormalized: record.profile.global_handle.label.replace(/\.pirate$/i, "").toLowerCase(),
      cleanupRenameAvailable: false,
      labelAvailable: true,
    })
    if (!paidQuote.eligible || paidQuote.price_cents <= 0) {
      throw badRequestError("Global handle quote is not payable")
    }

    const updatedAt = nowIso()
    const next: MemoryGlobalHandle = {
      global_handle_id: makeId("ghl"),
      label: `${labelNormalized}.pirate`,
      tier: paidQuote.tier,
      status: "active",
      issuance_source: "paid_upgrade",
      redirect_target_global_handle_id: null,
      price_paid_cents: paidQuote.price_cents,
      free_rename_consumed: true,
      issued_at: updatedAt,
      replaced_at: null,
    }

    record.profile = {
      ...record.profile,
      global_handle: next,
      linked_handles: [
        {
          linked_handle_id: `global:${next.global_handle_id}`,
          label: next.label,
          kind: "pirate",
          verification_state: "verified",
        },
        ...(record.profile.linked_handles ?? []).filter((handle) => handle.kind !== "pirate"),
      ],
      updated_at: updatedAt,
    }
    record.onboarding = {
      ...record.onboarding,
      generated_handle_assigned: false,
      cleanup_rename_available: false,
    }
    return exposeMemoryGlobalHandle(next)
  }

  private isGlobalHandleAvailable(userId: string, labelDisplay: string): boolean {
    const store = getMemoryStore()
    return ![...store.byUserId.values()].some((candidateRecord) => (
      candidateRecord.user.user_id !== userId
      && candidateRecord.profile.global_handle.status === "active"
      && candidateRecord.profile.global_handle.label.toLowerCase() === labelDisplay.toLowerCase()
    ))
  }

  private getRedditClaimOwnerUserId(labelDisplay: string): string | null {
    const store = getMemoryStore()
    const owner = [...store.byUserId.values()].find((candidateRecord) => (
      candidateRecord.profile.global_handle.issuance_source === "reddit_verified_claim"
      && candidateRecord.profile.global_handle.label.toLowerCase() === labelDisplay.toLowerCase()
    ))
    return owner?.user.user_id ?? null
  }
}
