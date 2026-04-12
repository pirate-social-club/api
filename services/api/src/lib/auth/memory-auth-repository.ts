import { conflictError, internalError, verificationRequired } from "../errors"
import { buildDefaultVerificationCapabilities } from "../verification/verification-capabilities"
import { makeId, nowIso } from "../helpers"
import { generateHandleCandidate } from "./handle-generator"
import {
  assertFreeCleanupRenameEligible,
  assertRedditVerifiedClaimEligible,
  buildHandleUpgradeQuote,
  normalizeDesiredGlobalHandleLabel,
  isCleanupRenameAvailable,
  isReservedGlobalHandleLabel,
  validateDesiredGlobalHandleLabel,
} from "./global-handle-policy"
import { checkRedditVerificationCode, importRedditSnapshot, makeRedditVerificationCode } from "../onboarding/reddit-bootstrap"
import type {
  Env,
  GlobalHandle,
  HandleUpgradeQuote,
  Job,
  OnboardingStatus,
  Profile,
  RedditImportSummary,
  RedditVerification,
  SessionExchangeResponse,
  UpstreamIdentity,
  User,
  WalletAttachmentSummary,
} from "../../types"

type RepositoryRecord = {
  user: User
  profile: Profile
  onboarding: OnboardingStatus
  walletAttachments: WalletAttachmentSummary[]
  providerLinks: Array<{ provider: string; providerSubject: string; providerUserRef: string | null }>
  redditVerification: RedditVerification | null
  redditVerificationCode: string | null
  redditVerificationExpiresAt: string | null
  redditVerificationCheckedCount: number
  redditImportSummary: RedditImportSummary | null
  redditImportJob: Job | null
}

type MemoryStore = {
  byUserId: Map<string, RepositoryRecord>
  userIdByProviderSubject: Map<string, string>
}

const globalScope = globalThis as typeof globalThis & {
  __pirateMemoryAuthStore?: MemoryStore
}

function getMemoryStore(): MemoryStore {
  if (!globalScope.__pirateMemoryAuthStore) {
    globalScope.__pirateMemoryAuthStore = {
      byUserId: new Map(),
      userIdByProviderSubject: new Map(),
    }
  }
  return globalScope.__pirateMemoryAuthStore
}

function makeProviderKey(provider: string, subject: string): string {
  return `${provider}:${subject}`
}

function buildNewRecord(identity: UpstreamIdentity): RepositoryRecord {
  const timestamp = nowIso()
  const userId = makeId("usr")
  const primaryWalletAddress = identity.selectedWalletAddress ?? identity.walletAddresses[0] ?? null
  const walletAttachments = identity.walletAddresses.map((walletAddress) => ({
    wallet_attachment_id: makeId("wal"),
    chain_namespace: "eip155:1",
    wallet_address: walletAddress,
    is_primary: primaryWalletAddress === walletAddress,
  }))
  const primaryWalletAttachmentId =
    walletAttachments.find((attachment) => attachment.is_primary)?.wallet_attachment_id ?? null
  const candidate = generateHandleCandidate()
  const globalHandle = {
    global_handle_id: makeId("ghl"),
    label: candidate.labelDisplay,
    tier: "generated" as const,
    status: "active" as const,
    issuance_source: "generated_signup" as const,
    redirect_target_global_handle_id: null,
    price_paid_usd: null,
    free_rename_consumed: false,
    issued_at: timestamp,
    replaced_at: null,
  }

  return {
    user: {
      user_id: userId,
      primary_wallet_attachment_id: primaryWalletAttachmentId,
      verification_state: "unverified",
      capability_provider: null,
      verification_capabilities: buildDefaultVerificationCapabilities(),
      verified_at: null,
      nationality: null,
      created_at: timestamp,
      updated_at: timestamp,
    },
    profile: {
      user_id: userId,
      display_name: null,
      avatar_ref: null,
      bio: null,
      preferred_locale: null,
      global_handle: globalHandle,
      created_at: timestamp,
      updated_at: timestamp,
    },
    onboarding: {
      generated_handle_assigned: true,
      cleanup_rename_available: true,
      unique_human_verification_status: "not_started",
      namespace_verification_status: "not_started",
      community_creation_ready: false,
      missing_requirements: ["unique_human_verification", "namespace_verification"],
      reddit_verification_status: "not_started",
      reddit_import_status: "not_started",
      suggested_community_ids: [],
    },
    walletAttachments,
    providerLinks: [
      {
        provider: identity.provider,
        providerSubject: identity.providerSubject,
        providerUserRef: identity.providerUserRef,
      },
    ],
    redditVerification: null,
    redditVerificationCode: null,
    redditVerificationExpiresAt: null,
    redditVerificationCheckedCount: 0,
    redditImportSummary: null,
    redditImportJob: null,
  }
}

function mergeWallets(existing: WalletAttachmentSummary[], identity: UpstreamIdentity): WalletAttachmentSummary[] {
  const byAddress = new Map(existing.map((attachment) => [attachment.wallet_address, attachment]))
  for (const walletAddress of identity.walletAddresses) {
    if (!byAddress.has(walletAddress)) {
      byAddress.set(walletAddress, {
        wallet_attachment_id: makeId("wal"),
        chain_namespace: "eip155:1",
        wallet_address: walletAddress,
        is_primary: false,
      })
    }
  }

  const selectedWalletAddress = identity.selectedWalletAddress ?? identity.walletAddresses[0] ?? null
  const attachments = [...byAddress.values()]
  for (const attachment of attachments) {
    attachment.is_primary = selectedWalletAddress != null && attachment.wallet_address === selectedWalletAddress
  }
  if (!attachments.some((attachment) => attachment.is_primary) && attachments[0]) {
    attachments[0].is_primary = true
  }
  return attachments
}

export class MemoryAuthRepository {
  async exchangeIdentity(identity: UpstreamIdentity): Promise<Omit<SessionExchangeResponse, "access_token">> {
    const store = getMemoryStore()
    const providerKey = makeProviderKey(identity.provider, identity.providerSubject)
    const existingUserId = store.userIdByProviderSubject.get(providerKey)

    if (!existingUserId) {
      const record = buildNewRecord(identity)
      store.byUserId.set(record.user.user_id, record)
      store.userIdByProviderSubject.set(providerKey, record.user.user_id)
      return {
        user: record.user,
        profile: record.profile,
        onboarding: record.onboarding,
        wallet_attachments: record.walletAttachments,
      }
    }

    const record = store.byUserId.get(existingUserId)
    if (!record) {
      throw internalError(`Missing user record for ${existingUserId}`)
    }

    const updatedAt = nowIso()
    record.walletAttachments = mergeWallets(record.walletAttachments, identity)
    record.user.primary_wallet_attachment_id =
      record.walletAttachments.find((attachment) => attachment.is_primary)?.wallet_attachment_id ?? null
    record.user.updated_at = updatedAt
    record.profile.updated_at = updatedAt
    if (!record.providerLinks.some((link) => link.provider === identity.provider && link.providerSubject === identity.providerSubject)) {
      record.providerLinks.push({
        provider: identity.provider,
        providerSubject: identity.providerSubject,
        providerUserRef: identity.providerUserRef,
      })
    }

    return {
      user: record.user,
      profile: record.profile,
      onboarding: record.onboarding,
      wallet_attachments: record.walletAttachments,
    }
  }

  getRecordByUserId(userId: string): RepositoryRecord | null {
    return getMemoryStore().byUserId.get(userId) ?? null
  }

  async getUserById(userId: string): Promise<User | null> {
    return this.getRecordByUserId(userId)?.user ?? null
  }

  async listUsersByIds(userIds: string[]): Promise<User[]> {
    return [...new Set(userIds)]
      .map((userId) => this.getRecordByUserId(userId)?.user ?? null)
      .filter((user): user is User => user != null)
  }

  async getWalletAttachmentsByUserId(userId: string): Promise<WalletAttachmentSummary[]> {
    return this.getRecordByUserId(userId)?.walletAttachments ?? []
  }

  async getOnboardingStatusByUserId(userId: string): Promise<OnboardingStatus | null> {
    return this.getRecordByUserId(userId)?.onboarding ?? null
  }

  async getProfileByUserId(userId: string): Promise<Profile | null> {
    return this.getRecordByUserId(userId)?.profile ?? null
  }

  async updateProfile(userId: string, input: {
    display_name?: string | null
    avatar_ref?: string | null
    bio?: string | null
    preferred_locale?: string | null
  }): Promise<Profile | null> {
    const record = this.getRecordByUserId(userId)
    if (!record) {
      return null
    }

    record.profile = {
      ...record.profile,
      display_name: input.display_name !== undefined ? input.display_name : record.profile.display_name,
      avatar_ref: input.avatar_ref !== undefined ? input.avatar_ref : record.profile.avatar_ref,
      bio: input.bio !== undefined ? input.bio : record.profile.bio,
      preferred_locale: input.preferred_locale !== undefined ? input.preferred_locale : record.profile.preferred_locale,
      updated_at: nowIso(),
    }
    return record.profile
  }

  async renameGlobalHandle(userId: string, desiredLabel: string, issuanceSource?: string): Promise<GlobalHandle | null> {
    const record = this.getRecordByUserId(userId)
    if (!record) {
      return null
    }

    const desired = normalizeDesiredGlobalHandleLabel(desiredLabel)
    if (desired.labelDisplay === record.profile.global_handle.label) {
      return record.profile.global_handle
    }

    assertFreeCleanupRenameEligible({
      desiredLabel: desired.labelDisplay,
      labelNormalized: desired.labelNormalized,
      activeGlobalHandle: record.profile.global_handle,
      userCreatedAt: record.user.created_at,
    })

    if (issuanceSource === "reddit_verified_claim") {
      assertRedditVerifiedClaimEligible({
        labelNormalized: desired.labelNormalized,
        verifiedRedditUsername: record.redditVerification?.status === "verified"
          ? record.redditVerification.reddit_username
          : null,
      })
    }

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

    const resolvedIssuanceSource = issuanceSource ?? "free_cleanup_rename"
    const updatedAt = nowIso()
    const next: GlobalHandle = {
      global_handle_id: makeId("ghl"),
      label: desired.labelDisplay,
      tier: "standard",
      status: "active",
      issuance_source: resolvedIssuanceSource as GlobalHandle["issuance_source"],
      redirect_target_global_handle_id: null,
      price_paid_usd: null,
      free_rename_consumed: true,
      issued_at: updatedAt,
      replaced_at: null,
    }

    record.profile = {
      ...record.profile,
      global_handle: next,
      updated_at: updatedAt,
    }
    record.onboarding = {
      ...record.onboarding,
      generated_handle_assigned: false,
      cleanup_rename_available: false,
    }
    return next
  }

  async getLatestVerifiedRedditUsername(userId: string): Promise<string | null> {
    const record = this.getRecordByUserId(userId)
    if (!record || record.redditVerification?.status !== "verified") {
      return null
    }
    return record.redditVerification.reddit_username
  }

  async quoteGlobalHandleUpgrade(userId: string, desiredLabel: string): Promise<HandleUpgradeQuote | null> {
    const record = this.getRecordByUserId(userId)
    if (!record) {
      return null
    }

    const desired = normalizeDesiredGlobalHandleLabel(desiredLabel)
    const store = getMemoryStore()
    const labelAvailable = ![...store.byUserId.values()].some((candidateRecord) => (
      candidateRecord.user.user_id !== userId
      && candidateRecord.profile.global_handle.status === "active"
      && candidateRecord.profile.global_handle.label.toLowerCase() === desired.labelDisplay.toLowerCase()
    ))

    return buildHandleUpgradeQuote({
      desiredLabel: desired.labelDisplay,
      labelNormalized: desired.labelNormalized,
      currentActiveLabelNormalized: record.profile.global_handle.label.replace(/\.pirate$/i, "").toLowerCase(),
      cleanupRenameAvailable: isCleanupRenameAvailable({
        userCreatedAt: record.user.created_at,
        activeGlobalHandle: record.profile.global_handle,
      }),
      labelAvailable,
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

    const record = this.getRecordByUserId(userId)
    if (record && record.profile.global_handle.label.replace(/\.pirate$/i, "").toLowerCase() === result.labelNormalized) {
      return { label: result.labelNormalized, status: "available" }
    }

    const store = getMemoryStore()
    const takenBy = [...store.byUserId.values()].find((candidateRecord) => (
      candidateRecord.user.user_id !== userId
      && candidateRecord.profile.global_handle.status === "active"
      && candidateRecord.profile.global_handle.label.replace(/\.pirate$/i, "").toLowerCase() === result.labelNormalized
    ))
    if (takenBy) {
      return { label: result.labelNormalized, status: "taken" }
    }

    return { label: result.labelNormalized, status: "available" }
  }

  async startOrCheckRedditVerification(input: {
    env: Env
    userId: string
    redditUsername: string
  }): Promise<RedditVerification> {
    const record = this.getRecordByUserId(input.userId)
    if (!record) {
      throw internalError(`Missing user record for ${input.userId}`)
    }

    const existing = record.redditVerification
    const now = new Date()
    if (
      existing
      && existing.reddit_username === input.redditUsername
      && existing.status === "pending"
      && record.redditVerificationCode
      && record.redditVerificationExpiresAt
    ) {
      if (Date.parse(record.redditVerificationExpiresAt) <= now.getTime()) {
        record.redditVerification = {
          ...existing,
          status: "expired",
        }
      } else if (record.redditVerificationCheckedCount >= 10) {
        record.redditVerificationCheckedCount += 1
        record.redditVerification = {
          ...existing,
          status: "failed",
          failure_code: "rate_limited",
          last_checked_at: now.toISOString(),
        }
      } else {
      const result = await checkRedditVerificationCode({
        env: input.env,
        redditUsername: input.redditUsername,
        verificationCode: record.redditVerificationCode,
      })
      record.redditVerificationCheckedCount += 1
      const next: RedditVerification = result.status === "verified"
        ? {
            ...existing,
            status: "verified",
            failure_code: null,
            last_checked_at: now.toISOString(),
          }
        : result.status === "pending"
          ? {
              ...existing,
              failure_code: result.failureCode,
              last_checked_at: now.toISOString(),
            }
          : {
              ...existing,
              status: "failed",
              failure_code: result.failureCode,
              last_checked_at: now.toISOString(),
            }
      record.redditVerification = next
      }
      record.onboarding.reddit_verification_status = record.redditVerification.status === "verified"
        ? "verified"
        : record.redditVerification.status === "pending"
          ? "pending"
          : "failed"
      return record.redditVerification
    }

    const verificationCode = makeRedditVerificationCode()
    const expiresAt = new Date(now.getTime() + 15 * 60 * 1000).toISOString()
    const created: RedditVerification = {
      reddit_username: input.redditUsername,
      status: "pending",
      verification_hint: `Add \`${verificationCode}\` to your Reddit profile and retry verification.`,
      code_placement_surface: "profile",
      last_checked_at: null,
      failure_code: null,
    }
    record.redditVerification = created
    record.redditVerificationCode = verificationCode
    record.redditVerificationExpiresAt = expiresAt
    record.redditVerificationCheckedCount = 0
    record.onboarding.reddit_verification_status = "pending"
    return created
  }

  async startRedditSnapshotImport(input: {
    env: Env
    userId: string
    redditUsername: string
  }): Promise<{ job: Job }> {
    const record = this.getRecordByUserId(input.userId)
    if (!record) {
      throw internalError(`Missing user record for ${input.userId}`)
    }
    if (record.redditVerification?.status !== "verified" || record.redditVerification.reddit_username !== input.redditUsername) {
      throw verificationRequired("Reddit verification is required")
    }
    if (record.redditImportJob?.status === "running") {
      const staleAfterSeconds = Number(String(input.env.REDDIT_IMPORT_JOB_STALE_AFTER_SECONDS || "").trim())
      const thresholdSeconds = Number.isFinite(staleAfterSeconds) && staleAfterSeconds > 0 ? Math.trunc(staleAfterSeconds) : 300
      const updatedAtMs = Date.parse(record.redditImportJob.updated_at)
      if (Number.isFinite(updatedAtMs) && updatedAtMs < (Date.now() - (thresholdSeconds * 1000))) {
        record.redditImportJob = {
          ...record.redditImportJob,
          status: "queued",
          error_code: null,
          updated_at: nowIso(),
        }
        record.onboarding.reddit_import_status = "queued"
      }
    }
    if (record.redditImportJob && (record.redditImportJob.status === "queued" || record.redditImportJob.status === "running")) {
      return {
        job: record.redditImportJob,
      }
    }

    const job: Job = {
      job_id: makeId("job"),
      job_type: "reddit_snapshot_import",
      status: "queued",
      subject_type: "user",
      subject_id: input.userId,
      result_ref: null,
      error_code: null,
      created_at: nowIso(),
      updated_at: nowIso(),
    }
    record.redditImportJob = job
    record.onboarding.reddit_import_status = "queued"

    return {
      job: record.redditImportJob,
    }
  }

  async processQueuedRedditSnapshotImport(input: {
    env: Env
    userId: string
    jobId: string
  }): Promise<boolean> {
    const record = this.getRecordByUserId(input.userId)
    if (!record) {
      return false
    }
    if (!record.redditImportJob || record.redditImportJob.job_id !== input.jobId) {
      return false
    }
    if (record.redditImportJob.status !== "queued") {
      return false
    }

    record.redditImportJob = {
      ...record.redditImportJob,
      status: "running",
      updated_at: nowIso(),
    }
    record.onboarding.reddit_import_status = "running"
    const redditUsername = record.redditVerification?.reddit_username
    if (!redditUsername) {
      record.redditImportJob = {
        ...record.redditImportJob,
        status: "failed",
        error_code: "invalid_payload",
        updated_at: nowIso(),
      }
      record.onboarding.reddit_import_status = "failed"
      return true
    }

    try {
      const summary = await importRedditSnapshot({
        env: input.env,
        redditUsername,
      })
      record.redditImportSummary = summary
      record.redditImportJob = {
        ...record.redditImportJob,
        status: "succeeded",
        result_ref: makeId("ers"),
        updated_at: nowIso(),
      }
      record.onboarding.reddit_import_status = "succeeded"
      record.onboarding.suggested_community_ids = summary.suggested_communities.map((community) => community.community_id)
    } catch (error) {
      record.redditImportJob = {
        ...record.redditImportJob,
        status: "failed",
        error_code: "source_error",
        updated_at: nowIso(),
      }
      record.onboarding.reddit_import_status = "failed"
    }
    return true
  }

  async drainRedditSnapshotImportJobs(input: {
    env: Env
    maxJobs: number
    staleAfterSeconds: number
  }): Promise<{ recoveredCount: number; drainedCount: number }> {
    const store = getMemoryStore()
    let recoveredCount = 0
    let drainedCount = 0
    const nowMs = Date.now()

    for (const record of store.byUserId.values()) {
      if (
        record.redditImportJob?.status === "running"
        && Date.parse(record.redditImportJob.updated_at) < (nowMs - (input.staleAfterSeconds * 1000))
      ) {
        record.redditImportJob = {
          ...record.redditImportJob,
          status: "queued",
          error_code: null,
          updated_at: nowIso(),
        }
        record.onboarding.reddit_import_status = "queued"
        recoveredCount += 1
      }
    }

    const queued = [...store.byUserId.values()]
      .filter((record) => record.redditImportJob?.status === "queued")
      .sort((a, b) => String(a.redditImportJob?.created_at || "").localeCompare(String(b.redditImportJob?.created_at || "")))
      .slice(0, input.maxJobs)

    for (const record of queued) {
      if (!record.redditImportJob) {
        continue
      }
      const claimed = await this.processQueuedRedditSnapshotImport({
        env: input.env,
        userId: record.user.user_id,
        jobId: record.redditImportJob.job_id,
      })
      if (claimed) {
        drainedCount += 1
      }
    }

    return { recoveredCount, drainedCount }
  }

  async getLatestRedditImportSummary(userId: string): Promise<RedditImportSummary | null> {
    return this.getRecordByUserId(userId)?.redditImportSummary ?? null
  }
}
