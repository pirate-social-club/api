import { internalError } from "../errors"
import { buildDefaultVerificationCapabilities } from "../verification/verification-capabilities"
import { makeId, nowIso } from "../helpers"
import { generateHandleCandidate } from "./handle-generator"
import type {
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

export type MemoryAuthRecord = {
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
  byUserId: Map<string, MemoryAuthRecord>
  userIdByProviderSubject: Map<string, string>
}

const globalScope = globalThis as typeof globalThis & {
  __pirateMemoryAuthStore?: MemoryStore
}

export function getMemoryStore(): MemoryStore {
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

export function getPrimaryWalletAddress(record: Pick<MemoryAuthRecord, "user" | "walletAttachments">): string | null {
  return (
    (record.user.primary_wallet_attachment_id
      ? record.walletAttachments.find((attachment) => (
        attachment.wallet_attachment_id === record.user.primary_wallet_attachment_id
      ))
      : null)
    ?? record.walletAttachments.find((attachment) => attachment.is_primary)
    ?? null
  )?.wallet_address ?? null
}

function buildNewRecord(identity: UpstreamIdentity): MemoryAuthRecord {
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
      created_at: timestamp,
      updated_at: timestamp,
    },
    profile: {
      user_id: userId,
      display_name: null,
      avatar_ref: null,
      cover_ref: null,
      bio: null,
      preferred_locale: null,
      linked_handles: [
        {
          linked_handle_id: `global:${globalHandle.global_handle_id}`,
          label: globalHandle.label,
          kind: "pirate",
          verification_state: "verified",
        },
      ],
      primary_public_handle: null,
      primary_wallet_address: primaryWalletAddress,
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

export function getMemoryRecordByUserId(userId: string): MemoryAuthRecord | null {
  return getMemoryStore().byUserId.get(userId) ?? null
}

export async function exchangeMemoryIdentity(
  identity: UpstreamIdentity,
): Promise<Omit<SessionExchangeResponse, "access_token">> {
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
  record.profile.primary_wallet_address = getPrimaryWalletAddress(record)
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
