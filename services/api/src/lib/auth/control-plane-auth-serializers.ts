import { createHash } from "node:crypto"
import { boolOrNull } from "../sql-row"
import { buildDefaultVerificationCapabilities } from "../verification/verification-capabilities"
import type {
  ExternalReputationSnapshotRow,
  GlobalHandleRow,
  NamespaceVerificationRow,
  NamespaceVerificationSessionRow,
  ProfileRow,
  RedditVerificationSessionRow,
  UserAttestationRow,
  UserRow,
  VerificationSessionRow,
  WalletAttachmentRow,
} from "./control-plane-auth-rows"
import type {
  GlobalHandle,
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
  WalletAttachmentSummary,
} from "../../types"

export function parseVerificationCapabilities(raw: string | null | undefined): VerificationCapabilities {
  if (!raw) {
    return buildDefaultVerificationCapabilities()
  }

  try {
    const parsed = JSON.parse(raw) as Partial<VerificationCapabilities>
    const defaults = buildDefaultVerificationCapabilities()
    return {
      unique_human: parsed.unique_human ?? defaults.unique_human,
      age_over_18: parsed.age_over_18 ?? defaults.age_over_18,
      nationality: parsed.nationality ?? defaults.nationality,
      gender: parsed.gender ?? defaults.gender,
      sanctions_clear: parsed.sanctions_clear ?? defaults.sanctions_clear,
      wallet_score: parsed.wallet_score ?? defaults.wallet_score,
    }
  } catch {
    return buildDefaultVerificationCapabilities()
  }
}

export function serializeUser(row: UserRow): User {
  return {
    user_id: row.user_id,
    primary_wallet_attachment_id: row.primary_wallet_attachment_id,
    verification_state: row.verification_state,
    capability_provider: row.capability_provider === "self" || row.capability_provider === "very"
      ? row.capability_provider
      : null,
    verification_capabilities: parseVerificationCapabilities(row.verification_capabilities_json),
    verified_at: row.verified_at,
    nationality: row.nationality,
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

export function assembleProfile(profileRow: ProfileRow, globalHandleRow: GlobalHandleRow): Profile {
  return {
    user_id: profileRow.user_id,
    display_name: profileRow.display_name,
    avatar_ref: profileRow.avatar_ref,
    bio: profileRow.bio,
    preferred_locale: profileRow.preferred_locale,
    global_handle: serializeGlobalHandle(globalHandleRow),
    created_at: profileRow.created_at,
    updated_at: profileRow.updated_at,
  }
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
}): NamespaceVerificationAssertions {
  return {
    root_exists: boolOrNull(input.root_exists),
    root_control_verified: boolOrNull(input.root_control_verified),
    expiry_horizon_sufficient: boolOrNull(input.expiry_horizon_sufficient),
    routing_enabled: boolOrNull(input.routing_enabled),
    pirate_dns_authority_verified: boolOrNull(input.pirate_dns_authority_verified),
  }
}

function buildNamespaceCapabilities(input: {
  club_attach_allowed: number | null
  pirate_web_routing_allowed: number | null
  pirate_subdomain_issuance_allowed: number | null
}): NamespaceVerificationCapabilities {
  return {
    club_attach_allowed: boolOrNull(input.club_attach_allowed),
    pirate_web_routing_allowed: boolOrNull(input.pirate_web_routing_allowed),
    pirate_subdomain_issuance_allowed: boolOrNull(input.pirate_subdomain_issuance_allowed),
  }
}

function parseJsonObject(value: string | null | undefined): Record<string, unknown> | null {
  if (!value) {
    return null
  }

  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function buildVerificationCallbackPath(verificationSessionId: string): string {
  return `/verification-sessions/${verificationSessionId}/callback`
}

function buildSelfUserIdentifierHex(userId: string): string {
  return `0x${createHash("sha256").update(userId).digest("hex")}`
}

function buildVeryWidgetLaunch(input: {
  env?: {
    VERY_VERIFY_URL?: string
    VERY_WIDGET_APP_ID?: string
    VERY_WIDGET_CONTEXT?: string
    VERY_WIDGET_EXTERNAL_NULLIFIER?: string
    VERY_WIDGET_TYPE_ID?: string
  }
}) {
  const externalNullifier = input.env?.VERY_WIDGET_EXTERNAL_NULLIFIER?.trim() || "pirate-community-creation"

  return {
    app_id: input.env?.VERY_WIDGET_APP_ID?.trim() || "",
    context: input.env?.VERY_WIDGET_CONTEXT?.trim() || "VeryAI - Palm Verification Timestamp",
    type_id: input.env?.VERY_WIDGET_TYPE_ID?.trim() || "3",
    query: {
      conditions: [{
        identifier: "val",
        operation: "IN",
        value: {
          from: "1743436800",
          to: "2043436800",
        },
      }],
      options: {
        expiredAtLowerBound: "1743436800",
        externalNullifier,
        equalCheckId: "0",
        pseudonym: "0",
      },
    },
    verify_url: input.env?.VERY_VERIFY_URL?.trim() || "https://verify.very.org/api/v1/verify",
  }
}

function buildSelfAppLaunch(input: {
  env?: {
    SELF_VERIFICATION_SCOPE?: string
    SELF_MOCK_PASSPORT?: string
  }
  requestedCapabilities: VerificationSession["requested_capabilities"]
  endpoint: string
  verificationSessionId: string
  userId: string
}): NonNullable<NonNullable<VerificationSession["launch"]>["self_app"]> {
  const mockPassport = input.env?.SELF_MOCK_PASSPORT === "true"
  return {
    app_name: "Pirate",
    header: "Verify with Self",
    endpoint: input.endpoint,
    endpoint_type: mockPassport ? "staging_https" : "https",
    scope: input.env?.SELF_VERIFICATION_SCOPE?.trim() || "pirate-verification-v0",
    session_id: input.verificationSessionId,
    user_id: buildSelfUserIdentifierHex(input.userId),
    user_id_type: "hex",
    disclosures: {
      nationality: input.requestedCapabilities.includes("nationality"),
      minimum_age: input.requestedCapabilities.includes("age_over_18") ? 18 : null,
      gender: input.requestedCapabilities.includes("gender"),
    },
    dev_mode: mockPassport,
    version: 2,
    chain_id: mockPassport ? 11142220 : 42220,
    user_defined_data: input.verificationSessionId,
  }
}

export function serializeVerificationSession(input: {
  row: VerificationSessionRow
  attestationRow: UserAttestationRow | null
  env?: {
    VERY_VERIFY_URL?: string
    VERY_WIDGET_APP_ID?: string
    VERY_WIDGET_CONTEXT?: string
    VERY_WIDGET_EXTERNAL_NULLIFIER?: string
    VERY_WIDGET_TYPE_ID?: string
    SELF_MOCK_PASSPORT?: string
    SELF_VERIFICATION_SCOPE?: string
  }
}): VerificationSession {
  const requestedCapabilities = JSON.parse(input.row.requested_capabilities_json) as VerificationSession["requested_capabilities"]
  const isVery = input.row.provider === "very"
  const callbackPath = buildVerificationCallbackPath(input.row.verification_session_id)
  const selfEndpoint = input.row.upstream_session_ref ?? callbackPath
  return {
    verification_session_id: input.row.verification_session_id,
    user_id: input.row.user_id,
    provider: input.row.provider === "self" || input.row.provider === "very" ? input.row.provider : "self",
    provider_mode: isVery ? "widget" : "qr_deeplink",
    wallet_attachment_id: input.row.wallet_attachment_id,
    requested_capabilities: requestedCapabilities,
    status: input.row.status === "canceled" ? "failed" : input.row.status,
    launch: isVery
      ? {
          mode: "widget",
          very_widget: buildVeryWidgetLaunch({
            env: input.env,
          }),
        }
      : {
          mode: "qr_deeplink",
          self_app: buildSelfAppLaunch({
            env: input.env,
            requestedCapabilities,
            endpoint: selfEndpoint,
            verificationSessionId: input.row.verification_session_id,
            userId: input.row.user_id,
          }),
        },
    callback_path: isVery ? `/verification-sessions/${input.row.verification_session_id}/complete` : callbackPath,
    nationality: null,
    age_at_verification: null,
    attestation_id: input.attestationRow?.user_attestation_id ?? null,
    proof_hash: input.row.result_ref,
    evidence_ref: null,
    verified_at: input.attestationRow?.verified_at ?? input.row.completed_at,
    failure_reason: input.row.failure_code,
    created_at: input.row.created_at,
    expires_at: input.row.expires_at ?? input.row.created_at,
  }
}

export function serializeNamespaceVerificationSession(row: NamespaceVerificationSessionRow): NamespaceVerificationSession {
  return {
    namespace_verification_session_id: row.namespace_verification_session_id,
    namespace_verification_id: row.namespace_verification_id,
    user_id: row.user_id,
    family: row.family,
    submitted_root_label: row.submitted_root_label,
    normalized_root_label: row.normalized_root_label,
    status: row.status,
    challenge_host: row.challenge_host,
    challenge_txt_value: row.challenge_txt_value,
    challenge_expires_at: row.challenge_expires_at,
    challenge_kind: row.challenge_kind,
    challenge_payload: parseJsonObject(row.challenge_payload_json),
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
  const parsed = JSON.parse(raw) as RedditImportSummary
  return {
    reddit_username: parsed.reddit_username,
    imported_at: parsed.imported_at,
    account_age_days: parsed.account_age_days ?? null,
    global_karma: parsed.global_karma ?? null,
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
