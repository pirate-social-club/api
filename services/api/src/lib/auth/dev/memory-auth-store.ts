import { internalError } from "../../errors"
import { buildDefaultVerificationCapabilities } from "../../verification/verification-capabilities"
import { makeId, nowIso } from "../../helpers"
import { normalizeIdentityCountryAlpha2 } from "../../identity/country-codes"
import { generateHandleCandidate } from "../handle-generator"
import { listIdentityWallets, pickEmbeddedEvmIdentityWallet, resolveExplicitSelectedIdentityWallet } from "../upstream-wallets"
import { nullableUnixSeconds, unixSeconds } from "../../../serializers/time"
import type {
  GlobalHandle,
  Job,
  OnboardingStatus,
  Profile,
  RedditImportSummary,
  RedditVerification,
  SessionExchangeResponse,
  UpstreamIdentity,
  User,
  WalletAttachmentSummary,
} from "../../../types"

export type MemoryWalletAttachment = {
  wallet_attachment_id: string
  chain_namespace: string
  wallet_address: string
  is_primary: boolean
}

export type MemoryGlobalHandle = {
  global_handle_id: string
  label: string
  tier: GlobalHandle["tier"]
  status: GlobalHandle["status"]
  issuance_source: GlobalHandle["issuance_source"]
  redirect_target_global_handle_id: string | null
  price_paid_cents: number | null
  free_rename_consumed: boolean
  issued_at: string
  replaced_at: string | null
}

type MemoryLinkedHandle = {
  linked_handle_id: string
  label: string
  kind: "pirate" | "ens"
  verification_state: "unverified" | "verified" | "stale"
}

type MemoryProfile = {
  user_id: string
  display_name: string | null
  avatar_ref: string | null
  avatar_source: Profile["avatar_source"]
  cover_ref: string | null
  cover_source: Profile["cover_source"]
  bio: string | null
  bio_source: Profile["bio_source"]
  preferred_locale: string | null
  linked_handles: MemoryLinkedHandle[]
  primary_public_handle: MemoryLinkedHandle | null
  primary_wallet_address: string | null
  xmtp_inbox_id: string | null
  global_handle: MemoryGlobalHandle
  display_verified_nationality_badge: boolean
  nationality_badge_country: string | null
  created_at: string
  updated_at: string
}

export type MemoryAuthRecord = {
  user: User
  profile: MemoryProfile
  onboarding: OnboardingStatus
  walletAttachments: MemoryWalletAttachment[]
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

export function exposeMemoryGlobalHandle(handle: MemoryGlobalHandle): GlobalHandle {
  return {
    id: `gh_${handle.global_handle_id}`,
    object: "global_handle",
    label: handle.label,
    tier: handle.tier,
    status: handle.status,
    issuance_source: handle.issuance_source,
    redirect_target_global_handle: handle.redirect_target_global_handle_id,
    price_paid_cents: handle.price_paid_cents,
    free_rename_consumed: handle.free_rename_consumed,
    issued_at: unixSeconds(handle.issued_at),
    replaced_at: nullableUnixSeconds(handle.replaced_at),
  }
}

function exposeMemoryLinkedHandle(handle: MemoryLinkedHandle): Profile["linked_handles"] extends Array<infer T> | null | undefined ? T : never {
  return {
    linked_handle: handle.linked_handle_id,
    label: handle.label,
    kind: handle.kind,
    verification_state: handle.verification_state,
  }
}

export function exposeMemoryWalletAttachments(attachments: MemoryWalletAttachment[]): WalletAttachmentSummary[] {
  return attachments.map((attachment) => ({
    wallet_attachment: attachment.wallet_attachment_id,
    chain_namespace: attachment.chain_namespace,
    wallet_address: attachment.wallet_address,
    is_primary: attachment.is_primary,
  }))
}

function exposeMemoryUser(user: User): SessionExchangeResponse["user"] {
  return {
    id: `usr_${user.user_id}`,
    object: "user",
    primary_wallet_attachment: user.primary_wallet_attachment_id,
    verification_state: user.verification_state,
    capability_provider: user.capability_provider,
    verification_capabilities: user.verification_capabilities,
    verified_at: nullableUnixSeconds(user.verified_at),
    created: unixSeconds(user.created_at),
  }
}

export function exposeMemoryProfile(record: MemoryAuthRecord): Profile {
  const nationality = record.user.verification_capabilities.nationality
  const nationalityBadgeCountry = record.profile.display_verified_nationality_badge
    && nationality.state === "verified"
    && nationality.provider === "self"
    ? normalizeIdentityCountryAlpha2(nationality.value)
    : null

  return {
    id: `usr_${record.profile.user_id}`,
    object: "profile",
    display_name: record.profile.display_name,
    avatar_ref: record.profile.avatar_ref,
    avatar_source: record.profile.avatar_source,
    cover_ref: record.profile.cover_ref,
    cover_source: record.profile.cover_source,
    bio: record.profile.bio,
    bio_source: record.profile.bio_source,
    preferred_locale: record.profile.preferred_locale,
    linked_handles: record.profile.linked_handles.map(exposeMemoryLinkedHandle),
    primary_public_handle: record.profile.primary_public_handle
      ? exposeMemoryLinkedHandle(record.profile.primary_public_handle)
      : null,
    primary_wallet_address: record.profile.primary_wallet_address,
    xmtp_inbox: record.profile.xmtp_inbox_id,
    global_handle: exposeMemoryGlobalHandle(record.profile.global_handle),
    display_verified_nationality_badge: record.profile.display_verified_nationality_badge,
    nationality_badge_country: nationalityBadgeCountry,
    created: unixSeconds(record.profile.created_at),
  }
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

// Mirror of the DB initializePrimaryWalletIfNeeded policy: an explicit selection
// (e.g. JWT selected_wallet_address) wins, otherwise embedded-first; never an arbitrary
// ordering fallback. Returns the attachment id to mark primary, or null.
function chooseInitialPrimaryAttachmentId(
  attachments: MemoryWalletAttachment[],
  identity: UpstreamIdentity,
): string | null {
  const explicit = resolveExplicitSelectedIdentityWallet(identity)
  if (explicit) {
    const match = attachments.find((attachment) => (
      attachment.chain_namespace === explicit.chainNamespace
        && attachment.wallet_address === explicit.walletAddress
    ))
    if (match) {
      return match.wallet_attachment_id
    }
  }

  const embedded = pickEmbeddedEvmIdentityWallet(identity)
  if (embedded) {
    const match = attachments.find((attachment) => (
      attachment.chain_namespace === embedded.chainNamespace
        && attachment.wallet_address === embedded.walletAddress
    ))
    if (match) {
      return match.wallet_attachment_id
    }
  }

  return null
}

function buildNewRecord(identity: UpstreamIdentity): MemoryAuthRecord {
  const timestamp = nowIso()
  const userId = makeId("usr")
  const identityWallets = listIdentityWallets(identity)
  const walletAttachments: MemoryWalletAttachment[] = identityWallets.map((wallet) => ({
    wallet_attachment_id: makeId("wal"),
    chain_namespace: wallet.chainNamespace,
    wallet_address: wallet.walletAddress,
    is_primary: false,
  }))
  const primaryWalletAttachmentId = chooseInitialPrimaryAttachmentId(walletAttachments, identity)
  for (const attachment of walletAttachments) {
    attachment.is_primary = attachment.wallet_attachment_id === primaryWalletAttachmentId
  }
  const primaryWalletAddress =
    walletAttachments.find((attachment) => attachment.is_primary)?.wallet_address ?? null
  const candidate = generateHandleCandidate()
  const globalHandle = {
    global_handle_id: makeId("ghl"),
    label: candidate.labelDisplay,
    tier: "generated" as const,
    status: "active" as const,
    issuance_source: "generated_signup" as const,
    redirect_target_global_handle_id: null,
    price_paid_cents: null,
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
      avatar_source: null,
      cover_ref: null,
      cover_source: null,
      bio: null,
      bio_source: null,
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
      xmtp_inbox_id: null,
      global_handle: globalHandle,
      display_verified_nationality_badge: false,
      nationality_badge_country: null,
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
      onboarding_dismissed_at: null,
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

function mergeWallets(
  existing: MemoryWalletAttachment[],
  identity: UpstreamIdentity,
  currentPrimaryId: string | null,
): MemoryWalletAttachment[] {
  const identityWallets = listIdentityWallets(identity)
  const byAddress = new Map(existing.map((attachment) => [
    `${attachment.chain_namespace}:${attachment.wallet_address}`,
    attachment,
  ]))
  for (const wallet of identityWallets) {
    const key = `${wallet.chainNamespace}:${wallet.walletAddressNormalized}`
    if (!byAddress.has(key)) {
      byAddress.set(key, {
        wallet_attachment_id: makeId("wal"),
        chain_namespace: wallet.chainNamespace,
        wallet_address: wallet.walletAddress,
        is_primary: false,
      })
    }
  }

  const attachments = [...byAddress.values()]

  // Pointer is the source of truth: if a primary already exists, preserve it (realigning the
  // flag if a legacy state disagrees). Discovering new wallets must never replace it.
  if (currentPrimaryId && attachments.some((attachment) => attachment.wallet_attachment_id === currentPrimaryId)) {
    for (const attachment of attachments) {
      attachment.is_primary = attachment.wallet_attachment_id === currentPrimaryId
    }
    return attachments
  }
  if (attachments.some((attachment) => attachment.is_primary)) {
    return attachments
  }

  // No primary yet → initialize once (explicit selection or embedded-first; may stay unset).
  const initialPrimaryId = chooseInitialPrimaryAttachmentId(attachments, identity)
  for (const attachment of attachments) {
    attachment.is_primary = attachment.wallet_attachment_id === initialPrimaryId
  }
  return attachments
}

export function getMemoryRecordByUserId(userId: string): MemoryAuthRecord | null {
  return getMemoryStore().byUserId.get(userId) ?? null
}

export function getMemoryWalletAttachmentById(walletAttachmentId: string): (WalletAttachmentSummary & { user_id: string; status: string }) | null {
  const rawId = walletAttachmentId.startsWith("wal_wal_") ? walletAttachmentId.slice("wal_".length) : walletAttachmentId
  for (const record of getMemoryStore().byUserId.values()) {
    const attachment = record.walletAttachments.find((wallet) => wallet.wallet_attachment_id === rawId)
    if (attachment) {
      return {
        wallet_attachment: attachment.wallet_attachment_id,
        user_id: record.user.user_id,
        chain_namespace: attachment.chain_namespace,
        wallet_address: attachment.wallet_address,
        is_primary: attachment.is_primary,
        status: "active",
      }
    }
  }
  return null
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
      user: exposeMemoryUser(record.user),
      profile: exposeMemoryProfile(record),
      onboarding: record.onboarding,
      wallet_attachments: exposeMemoryWalletAttachments(record.walletAttachments),
    }
  }

  const record = store.byUserId.get(existingUserId)
  if (!record) {
    throw internalError(`Missing user record for ${existingUserId}`)
  }

  const updatedAt = nowIso()
  record.walletAttachments = mergeWallets(
    record.walletAttachments,
    identity,
    record.user.primary_wallet_attachment_id ?? null,
  )
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
    user: exposeMemoryUser(record.user),
    profile: exposeMemoryProfile(record),
    onboarding: record.onboarding,
    wallet_attachments: exposeMemoryWalletAttachments(record.walletAttachments),
  }
}
