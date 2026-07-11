import { boolOrNull } from "../sql-row"
import {
  applyLazyCapabilityExpiry,
  buildDefaultVerificationCapabilities,
  deriveVerificationState,
} from "../verification/verification-capabilities"
import { normalizeIdentityCountryAlpha2 } from "../identity/country-codes"
import { nullableUnixSeconds, unixSeconds } from "../../serializers/time"
import { decodePublicNamespaceVerificationId, decodePublicNamespaceVerificationSessionId, publicId } from "../public-ids"
import { parseJsonField, parseOptionalJsonField } from "../json"
import type {
  ExternalReputationSnapshotRow,
  GlobalHandleRow,
  LinkedHandleRow,
  NamespaceVerificationRow,
  NamespaceVerificationSessionRow,
  ProfileRow,
  RedditVerificationSessionRow,
  UserAttestationRow,
  UserRow,
  VerificationSessionRow,
  WalletAttachmentRow,
} from "./auth-db-rows"
import type { User as ContractUser } from "@pirate/api-contracts"
import type {
  GlobalHandle,
  LinkedHandle,
  NamespaceVerification,
  NamespaceVerificationAssertions,
  NamespaceVerificationCapabilities,
  NamespaceVerificationSession,
  Profile,
  RedditImportSummary,
  RedditVerification,
  VerificationCapabilities,
  VerificationSession,
  VerificationSessionLaunch,
  WalletAttachmentSummary,
} from "../../types"

export function parseVerificationCapabilities(raw: string | null | undefined): VerificationCapabilities {
  if (!raw) {
    return applyLazyCapabilityExpiry(buildDefaultVerificationCapabilities())
  }

  try {
    const parsed = JSON.parse(raw) as Partial<VerificationCapabilities>
    const defaults = buildDefaultVerificationCapabilities()
    return applyLazyCapabilityExpiry({
      unique_human: parsed.unique_human ?? defaults.unique_human,
      age_over_18: parsed.age_over_18 ?? defaults.age_over_18,
      minimum_age: parsed.minimum_age ?? defaults.minimum_age,
      nationality: parsed.nationality ?? defaults.nationality,
      gender: parsed.gender ?? defaults.gender,
      wallet_score: parsed.wallet_score ?? defaults.wallet_score,
    })
  } catch {
    return applyLazyCapabilityExpiry(buildDefaultVerificationCapabilities())
  }
}

export function serializeUser(row: UserRow): ContractUser {
  const verificationCapabilities = parseVerificationCapabilities(row.verification_capabilities_json)
  return {
    id: `usr_${row.user_id}`,
    object: "user",
    primary_wallet_attachment: row.primary_wallet_attachment_id,
    verification_state: deriveVerificationState(verificationCapabilities),
    capability_provider: row.capability_provider === "self" || row.capability_provider === "very"
      ? row.capability_provider
      : null,
    verification_capabilities: verificationCapabilities,
    verified_at: nullableUnixSeconds(row.verified_at),
    created: unixSeconds(row.created_at),
  }
}

export function serializeGlobalHandle(row: GlobalHandleRow): GlobalHandle {
  return {
    id: `gh_${row.global_handle_id}`,
    object: "global_handle",
    label: row.label_display,
    tier: row.tier,
    status: row.status,
    issuance_source: row.issuance_source,
    redirect_target_global_handle: row.redirect_target_global_handle_id,
    price_paid_cents: typeof row.price_paid_usd === "number" && Number.isFinite(row.price_paid_usd)
      ? Math.round(row.price_paid_usd * 100)
      : null,
    free_rename_consumed: Boolean(row.free_rename_consumed),
    issued_at: unixSeconds(row.issued_at),
    replaced_at: nullableUnixSeconds(row.replaced_at),
  }
}

function parseLinkedHandleMetadata(raw: string | null): Record<string, unknown> | null {
  const parsed = parseOptionalJsonField<unknown>(raw, "linked_handles.metadata_json")
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null
}

function serializeLinkedHandleRow(row: LinkedHandleRow): LinkedHandle {
  return {
    linked_handle: row.linked_handle_id,
    label: row.label_display,
    kind: row.kind,
    metadata: parseLinkedHandleMetadata(row.metadata_json),
    verification_state: row.verification_state,
  }
}

function serializePirateLinkedHandle(row: GlobalHandleRow): LinkedHandle {
  return {
    linked_handle: `global:${row.global_handle_id}`,
    label: row.label_display,
    kind: "pirate",
    verification_state: "verified",
  }
}

export function assembleProfile(
  profileRow: ProfileRow,
  globalHandleRow: GlobalHandleRow,
  linkedHandleRows: LinkedHandleRow[] = [],
  primaryWalletAddress: string | null = null,
  user?: Pick<ContractUser, "verification_capabilities"> | null,
): Profile {
  const externalLinkedHandles = linkedHandleRows.map(serializeLinkedHandleRow)
  const primaryPublicHandle = profileRow.primary_linked_handle_id
    ? externalLinkedHandles.find((handle) => handle.linked_handle === profileRow.primary_linked_handle_id) ?? null
    : null
  const nationality = user?.verification_capabilities.nationality
  const nationalityBadgeCountry = profileRow.display_verified_nationality_badge === 1
    && nationality?.state === "verified"
    && nationality.provider === "self"
    ? normalizeIdentityCountryAlpha2(nationality.value)
    : null

  return {
    id: `usr_${profileRow.user_id}`,
    object: "profile",
    display_name: profileRow.display_name,
    avatar_ref: profileRow.avatar_ref,
    avatar_source: profileRow.avatar_source,
    cover_ref: profileRow.cover_ref,
    cover_source: profileRow.cover_source,
    bio: profileRow.bio,
    bio_source: profileRow.bio_source,
    preferred_locale: profileRow.preferred_locale,
    display_verified_nationality_badge: profileRow.display_verified_nationality_badge === 1,
    nationality_badge_country: nationalityBadgeCountry,
    linked_handles: [serializePirateLinkedHandle(globalHandleRow), ...externalLinkedHandles],
    primary_public_handle: primaryPublicHandle,
    primary_wallet_address: primaryWalletAddress,
    xmtp_inbox: profileRow.xmtp_inbox_id,
    global_handle: serializeGlobalHandle(globalHandleRow),
    created: unixSeconds(profileRow.created_at),
  }
}

export function getPrimaryWalletAddressFromRows(
  primaryWalletAttachmentId: string | null,
  walletRows: WalletAttachmentRow[],
): string | null {
  const primaryWalletRow =
    (primaryWalletAttachmentId
      ? walletRows.find((row) => row.wallet_attachment_id === primaryWalletAttachmentId)
      : null)
    ?? walletRows.find((row) => row.is_primary === 1)
    ?? null

  return primaryWalletRow?.wallet_address_display ?? null
}

type PublicHandleProfile = Pick<Profile, "global_handle" | "primary_public_handle">

export function getProfilePublicHandleLabel(profile: PublicHandleProfile): string {
  return profile.primary_public_handle?.label ?? profile.global_handle.label
}

export function getProfilePublicHandleStem(profile: PublicHandleProfile): string {
  return getProfilePublicHandleLabel(profile).replace(/\.pirate$/iu, "").trim()
}

export function serializeWalletAttachments(rows: WalletAttachmentRow[]): WalletAttachmentSummary[] {
  return rows.map((row) => ({
    wallet_attachment: row.wallet_attachment_id,
    chain_namespace: row.chain_namespace,
    wallet_address: row.wallet_address_display,
    is_primary: Boolean(row.is_primary),
  }))
}

function buildNamespaceAssertions(input: {
  root_exists: number | null
  root_control_verified: number | null
  expiry_horizon_sufficient: number | null
  routing_enabled: number | null
  pirate_dns_authority_verified: number | null
  root_key_proof_verified: number | null
  fabric_publish_verified: number | null
  anchor_fresh_enough: number | null
  owner_signed_updates_verified: number | null
}): NamespaceVerificationAssertions {
  return {
    root_exists: boolOrNull(input.root_exists),
    root_control_verified: boolOrNull(input.root_control_verified),
    expiry_horizon_sufficient: boolOrNull(input.expiry_horizon_sufficient),
    routing_enabled: boolOrNull(input.routing_enabled),
    pirate_dns_authority_verified: boolOrNull(input.pirate_dns_authority_verified),
    root_key_proof_verified: boolOrNull(input.root_key_proof_verified),
    fabric_publish_verified: boolOrNull(input.fabric_publish_verified),
    anchor_fresh_enough: boolOrNull(input.anchor_fresh_enough),
    owner_signed_updates_verified: boolOrNull(input.owner_signed_updates_verified),
  }
}

function buildNamespaceCapabilities(input: {
  club_attach_allowed: number | null
  pirate_web_routing_allowed: number | null
  pirate_subdomain_issuance_allowed: number | null
  owner_signed_record_updates_allowed: number | null
  pirate_subspace_issuance_allowed: number | null
}): NamespaceVerificationCapabilities {
  return {
    club_attach_allowed: boolOrNull(input.club_attach_allowed),
    pirate_web_routing_allowed: boolOrNull(input.pirate_web_routing_allowed),
    pirate_subdomain_issuance_allowed: boolOrNull(input.pirate_subdomain_issuance_allowed),
    owner_signed_record_updates_allowed: boolOrNull(input.owner_signed_record_updates_allowed),
    pirate_subspace_issuance_allowed: boolOrNull(input.pirate_subspace_issuance_allowed),
  }
}

function parseChallengePayload(raw: string | null | undefined): Record<string, unknown> | null {
  const parsed = parseOptionalJsonField<unknown>(raw, "namespace_verification_sessions.challenge_payload_json")
  return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null
}

export function serializeVerificationSession(input: {
  row: VerificationSessionRow
  attestationRows: UserAttestationRow[]
  launch?: VerificationSessionLaunch | null
}): VerificationSession {
  const requestedCapabilities = parseJsonField<VerificationSession["requested_capabilities"]>(
    input.row.requested_capabilities_json,
    "verification_sessions.requested_capabilities_json",
  )
  const verificationRequirements = input.row.verification_requirements_json
    ? parseJsonField<VerificationSession["verification_requirements"]>(
      input.row.verification_requirements_json,
      "verification_sessions.verification_requirements_json",
    )
    : []
  return {
    id: `vs_${input.row.verification_session_id}`,
    object: "verification_session",
    user: `usr_${input.row.user_id}`,
    provider: input.row.provider === "self" || input.row.provider === "very" || input.row.provider === "zkpassport"
      ? input.row.provider
      : "self",
    provider_mode: input.row.provider_mode
      ?? (input.row.provider === "very" && input.row.upstream_session_ref
        ? "widget"
        : input.row.provider === "zkpassport"
          ? "web_sdk"
          : null),
    wallet_attachment: input.row.wallet_attachment_id,
    requested_capabilities: requestedCapabilities,
    verification_requirements: verificationRequirements,
    verification_intent: input.row.verification_intent as VerificationSession["verification_intent"],
    policy: input.row.policy_id,
    status: input.row.status === "canceled" ? "failed" : input.row.status,
    launch: input.launch ?? undefined,
    nationality: null,
    age_at_verification: null,
    attestation: input.attestationRows.length > 0 ? input.attestationRows[0].user_attestation_id : null,
    proof_hash: input.row.result_ref,
    evidence_ref: input.row.result_ref,
    verified_at: nullableUnixSeconds(input.attestationRows.length > 0 ? input.attestationRows[0].verified_at : input.row.completed_at),
    failure_reason: input.row.failure_code,
    created: unixSeconds(input.row.created_at),
    expires_at: unixSeconds(input.row.expires_at ?? input.row.created_at),
  }
}

export function serializeNamespaceVerificationSession(
  row: NamespaceVerificationSessionRow,
): NamespaceVerificationSession {
  const storedSetupNameservers = parseOptionalStringArray(row.setup_nameservers_json)

  return {
    id: publicId(decodePublicNamespaceVerificationSessionId(row.namespace_verification_session_id), "nvs"),
    object: "namespace_verification_session",
    namespace_verification: row.namespace_verification_id ? publicId(decodePublicNamespaceVerificationId(row.namespace_verification_id), "nv") : row.namespace_verification_id,
    user: `usr_${row.user_id}`,
    family: row.family,
    submitted_root_label: row.submitted_root_label,
    normalized_root_label: row.normalized_root_label,
    status: row.status,
    challenge_kind: (row.challenge_kind as NamespaceVerificationSession["challenge_kind"]) ?? null,
    challenge_host: row.challenge_host,
    challenge_txt_value: row.challenge_txt_value,
    challenge_payload: parseChallengePayload(row.challenge_payload_json),
    challenge_expires_at: nullableUnixSeconds(row.challenge_expires_at),
    setup_nameservers: storedSetupNameservers,
    assertions: buildNamespaceAssertions(row),
    capabilities: buildNamespaceCapabilities(row),
    control_class: row.control_class,
    operation_class: row.operation_class,
    observation_provider: row.observation_provider,
    evidence_bundle_ref: row.evidence_bundle_ref,
    failure_reason: row.failure_reason,
    accepted_at: nullableUnixSeconds(row.accepted_at),
    created: unixSeconds(row.created_at),
    expires_at: unixSeconds(row.expires_at ?? row.created_at),
  }
}

function parseOptionalStringArray(raw: string | null): string[] | null {
  const parsed = parseOptionalJsonField<unknown>(raw, "namespace_verification_sessions.setup_nameservers_json")
  if (!Array.isArray(parsed)) {
    return null
  }

  const values = parsed
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean)

  return values.length > 0 ? values : null
}

export function serializeNamespaceVerification(row: NamespaceVerificationRow): NamespaceVerification {
  return {
    id: `nv_${row.namespace_verification_id}`,
    object: "namespace_verification",
    user: `usr_${row.user_id}`,
    family: row.family,
    normalized_root_label: row.normalized_root_label,
    status: row.status,
    assertions: buildNamespaceAssertions(row),
    capabilities: buildNamespaceCapabilities(row),
    control_class: row.control_class,
    operation_class: row.operation_class,
    observation_provider: row.observation_provider,
    evidence_bundle_ref: row.evidence_bundle_ref,
    accepted_at: unixSeconds(row.accepted_at),
    created: unixSeconds(row.created_at),
    expires_at: unixSeconds(row.expires_at),
  }
}

export function serializeRedditVerification(row: RedditVerificationSessionRow): RedditVerification {
  return {
    reddit_username: row.reddit_username,
    status: row.status,
    verification_hint: row.verification_hint,
    code_placement_surface: row.code_placement_surface,
    last_checked_at: nullableUnixSeconds(row.last_checked_at),
    failure_code: row.failure_code,
  }
}

export function parseRedditImportSummary(raw: string): RedditImportSummary {
  const parsed = parseJsonField<RedditImportSummary & { global_karma?: number | null }>(
    raw,
    "external_reputation_snapshots.snapshot_payload_json",
  )
  const importedRedditScore = parsed.imported_reddit_score ?? parsed.global_karma ?? null
  return {
    reddit_username: parsed.reddit_username,
    imported_at: typeof parsed.imported_at === "number" ? parsed.imported_at : unixSeconds(parsed.imported_at),
    account_age_days: parsed.account_age_days ?? null,
    imported_reddit_score: importedRedditScore,
    top_subreddits: Array.isArray(parsed.top_subreddits) ? parsed.top_subreddits : [],
    moderator_of: Array.isArray(parsed.moderator_of) ? parsed.moderator_of : [],
    inferred_interests: Array.isArray(parsed.inferred_interests) ? parsed.inferred_interests : [],
    suggested_communities: Array.isArray(parsed.suggested_communities)
      ? parsed.suggested_communities.map((community) => ({
        ...community,
        community: "community" in community
          ? community.community
          : (community as { community_id?: string }).community_id ?? "",
      }))
      : [],
    coverage_note: parsed.coverage_note ?? null,
  }
}

export function serializeRedditImportSummary(row: ExternalReputationSnapshotRow): RedditImportSummary {
  return parseRedditImportSummary(row.snapshot_payload_json)
}
