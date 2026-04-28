import { boolOrNull } from "../sql-row"
import {
  applyLazyCapabilityExpiry,
  buildDefaultVerificationCapabilities,
  deriveVerificationState,
} from "../verification/verification-capabilities"
import { normalizeIdentityCountryAlpha2 } from "../identity/country-codes"
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
  User,
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

export function serializeUser(row: UserRow): User {
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

export function serializeGlobalHandle(row: GlobalHandleRow): GlobalHandle {
  return {
    global_handle_id: row.global_handle_id,
    label: row.label_display,
    tier: row.tier,
    status: row.status,
    issuance_source: row.issuance_source,
    redirect_target_global_handle_id: row.redirect_target_global_handle_id,
    price_paid_usd: row.price_paid_usd,
    free_rename_consumed: Boolean(row.free_rename_consumed),
    issued_at: row.issued_at,
    replaced_at: row.replaced_at,
  }
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

export function serializeLinkedHandleRow(row: LinkedHandleRow): LinkedHandle {
  return {
    linked_handle_id: row.linked_handle_id,
    label: row.label_display,
    kind: row.kind,
    metadata: parseLinkedHandleMetadata(row.metadata_json),
    verification_state: row.verification_state,
  }
}

export function serializePirateLinkedHandle(row: GlobalHandleRow): LinkedHandle {
  return {
    linked_handle_id: `global:${row.global_handle_id}`,
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
  user?: Pick<User, "verification_capabilities"> | null,
): Profile {
  const externalLinkedHandles = linkedHandleRows.map(serializeLinkedHandleRow)
  const primaryPublicHandle = profileRow.primary_linked_handle_id
    ? externalLinkedHandles.find((handle) => handle.linked_handle_id === profileRow.primary_linked_handle_id) ?? null
    : null
  const nationality = user?.verification_capabilities.nationality
  const nationalityBadgeCountry = profileRow.display_verified_nationality_badge === 1
    && nationality?.state === "verified"
    && nationality.provider === "self"
    ? normalizeIdentityCountryAlpha2(nationality.value)
    : null

  return {
    user_id: profileRow.user_id,
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
    global_handle: serializeGlobalHandle(globalHandleRow),
    created_at: profileRow.created_at,
    updated_at: profileRow.updated_at,
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
    wallet_attachment_id: row.wallet_attachment_id,
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
  if (!raw) {
    return null
  }

  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

export function serializeVerificationSession(input: {
  row: VerificationSessionRow
  attestationRows: UserAttestationRow[]
  launch?: VerificationSessionLaunch | null
}): VerificationSession {
  const requestedCapabilities = JSON.parse(input.row.requested_capabilities_json) as VerificationSession["requested_capabilities"]
  const verificationRequirements = input.row.verification_requirements_json
    ? JSON.parse(input.row.verification_requirements_json) as VerificationSession["verification_requirements"]
    : []
  return {
    verification_session_id: input.row.verification_session_id,
    user_id: input.row.user_id,
    provider: input.row.provider === "self" || input.row.provider === "very" ? input.row.provider : "self",
    provider_mode: input.row.provider === "very" && input.row.upstream_session_ref ? "widget" : null,
    wallet_attachment_id: input.row.wallet_attachment_id,
    requested_capabilities: requestedCapabilities,
    verification_requirements: verificationRequirements,
    verification_intent: input.row.verification_intent as VerificationSession["verification_intent"],
    policy_id: input.row.policy_id,
    status: input.row.status === "canceled" ? "failed" : input.row.status,
    launch: input.launch ?? undefined,
    nationality: null,
    age_at_verification: null,
    attestation_id: input.attestationRows.length > 0 ? input.attestationRows[0].user_attestation_id : null,
    proof_hash: input.row.result_ref,
    evidence_ref: input.row.result_ref,
    verified_at: input.attestationRows.length > 0 ? input.attestationRows[0].verified_at : input.row.completed_at,
    failure_reason: input.row.failure_code,
    created_at: input.row.created_at,
    expires_at: input.row.expires_at ?? input.row.created_at,
  }
}

export function serializeNamespaceVerificationSession(
  row: NamespaceVerificationSessionRow,
  input?: { setupNameservers?: string[] | null },
): NamespaceVerificationSession {
  const storedSetupNameservers = parseOptionalStringArray(row.setup_nameservers_json)

  return {
    namespace_verification_session_id: row.namespace_verification_session_id,
    namespace_verification_id: row.namespace_verification_id,
    user_id: row.user_id,
    family: row.family,
    submitted_root_label: row.submitted_root_label,
    normalized_root_label: row.normalized_root_label,
    status: row.status,
    challenge_kind: (row.challenge_kind as NamespaceVerificationSession["challenge_kind"]) ?? null,
    challenge_host: row.challenge_host,
    challenge_txt_value: row.challenge_txt_value,
    challenge_payload: parseChallengePayload(row.challenge_payload_json),
    challenge_expires_at: row.challenge_expires_at,
    setup_nameservers: input?.setupNameservers ?? storedSetupNameservers,
    assertions: buildNamespaceAssertions(row),
    capabilities: buildNamespaceCapabilities(row),
    control_class: row.control_class,
    operation_class: row.operation_class,
    observation_provider: row.observation_provider,
    evidence_bundle_ref: row.evidence_bundle_ref,
    failure_reason: row.failure_reason,
    accepted_at: row.accepted_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    expires_at: row.expires_at,
  }
}

function parseOptionalStringArray(raw: string | null): string[] | null {
  if (!raw) {
    return null
  }

  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      return null
    }

    const values = parsed
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter(Boolean)

    return values.length > 0 ? values : null
  } catch {
    return null
  }
}

export function serializeNamespaceVerification(row: NamespaceVerificationRow): NamespaceVerification {
  return {
    namespace_verification_id: row.namespace_verification_id,
    user_id: row.user_id,
    family: row.family,
    normalized_root_label: row.normalized_root_label,
    status: row.status,
    assertions: buildNamespaceAssertions(row),
    capabilities: buildNamespaceCapabilities(row),
    control_class: row.control_class,
    operation_class: row.operation_class,
    observation_provider: row.observation_provider,
    evidence_bundle_ref: row.evidence_bundle_ref,
    accepted_at: row.accepted_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    expires_at: row.expires_at,
  }
}

export function serializeRedditVerification(row: RedditVerificationSessionRow): RedditVerification {
  return {
    reddit_username: row.reddit_username,
    status: row.status,
    verification_hint: row.verification_hint,
    code_placement_surface: row.code_placement_surface,
    last_checked_at: row.last_checked_at,
    failure_code: row.failure_code,
  }
}

export function parseRedditImportSummary(raw: string): RedditImportSummary {
  const parsed = JSON.parse(raw) as RedditImportSummary & { global_karma?: number | null }
  const importedRedditScore = parsed.imported_reddit_score ?? parsed.global_karma ?? null
  return {
    reddit_username: parsed.reddit_username,
    imported_at: parsed.imported_at,
    account_age_days: parsed.account_age_days ?? null,
    imported_reddit_score: importedRedditScore,
    top_subreddits: Array.isArray(parsed.top_subreddits) ? parsed.top_subreddits : [],
    moderator_of: Array.isArray(parsed.moderator_of) ? parsed.moderator_of : [],
    inferred_interests: Array.isArray(parsed.inferred_interests) ? parsed.inferred_interests : [],
    suggested_communities: Array.isArray(parsed.suggested_communities) ? parsed.suggested_communities : [],
    coverage_note: parsed.coverage_note ?? null,
  }
}

export function serializeRedditImportSummary(row: ExternalReputationSnapshotRow): RedditImportSummary {
  return parseRedditImportSummary(row.snapshot_payload_json)
}
