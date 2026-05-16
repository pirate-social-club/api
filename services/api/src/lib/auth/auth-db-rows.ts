export type { DbExecutor } from "../db-helpers"
import {
  numberOrNull,
  requiredNumber,
  requiredString,
  rowValue,
  stringOrNull,
} from "../sql-row"
import type {
  GlobalHandle,
  LinkedHandle,
  RedditVerification,
  SessionExchangeResponse,
  User,
} from "../../types"

export type {
  CommunityCommentProjectionRow,
  CommunityDatabaseBindingRow,
  CommunityDbCredentialRow,
  CommunityFollowProjectionRow,
  CommunityMembershipProjectionRow,
  CommunityPostProjectionRow,
  CommunityRow,
  JobRow,
} from "./auth-db-community-rows"
export {
  toCommunityCommentProjectionRow,
  toCommunityDatabaseBindingRow,
  toCommunityDbCredentialRow,
  toCommunityFollowProjectionRow,
  toCommunityMembershipProjectionRow,
  toCommunityPostProjectionRow,
  toCommunityRow,
  toJobRow,
} from "./auth-db-community-rows"
export type {
  NamespaceVerificationRow,
  NamespaceVerificationSessionRow,
} from "./auth-db-namespace-verification-rows"
export {
  toNamespaceVerificationRow,
  toNamespaceVerificationSessionRow,
} from "./auth-db-namespace-verification-rows"

export type UserRow = {
  user_id: string
  primary_wallet_attachment_id: string | null
  verification_state: User["verification_state"]
  capability_provider: User["capability_provider"] | "passport" | "zkpass"
  verification_capabilities_json: string
  verified_at: string | null
  current_verification_session_id: string | null
  onboarding_dismissed_at: string | null
  created_at: string
  updated_at: string
}

export type ProfileRow = {
  user_id: string
  display_name: string | null
  bio: string | null
  bio_source: "ens" | "manual" | "none" | null
  avatar_ref: string | null
  avatar_source: "ens" | "upload" | "none" | null
  cover_ref: string | null
  cover_source: "ens" | "upload" | "none" | null
  preferred_locale: string | null
  display_verified_nationality_badge: number
  global_handle_id: string
  primary_linked_handle_id: string | null
  xmtp_inbox_id: string | null
  created_at: string
  updated_at: string
}

export type LinkedHandleRow = {
  linked_handle_id: string
  user_id: string
  wallet_attachment_id: string | null
  kind: LinkedHandle["kind"]
  label_normalized: string
  label_display: string
  verification_state: LinkedHandle["verification_state"]
  metadata_json: string | null
  created_at: string
  updated_at: string
}

export type GlobalHandleRow = {
  global_handle_id: string
  user_id: string
  label_normalized: string
  label_display: string
  status: GlobalHandle["status"]
  tier: GlobalHandle["tier"]
  issuance_source: GlobalHandle["issuance_source"]
  redirect_target_global_handle_id: string | null
  price_paid_usd: number | null
  free_rename_consumed: number
  issued_at: string
  replaced_at: string | null
  created_at: string
  updated_at: string
}

export type WalletAttachmentRow = {
  wallet_attachment_id: string
  chain_namespace: string
  wallet_address_normalized: string
  wallet_address_display: string
  is_primary: number
}

export type VerificationSessionRow = {
  verification_session_id: string
  user_id: string
  provider: "self" | "very" | "passport"
  provider_mode: "qr_deeplink" | "widget" | "native_sdk" | null
  requested_capabilities_json: string
  verification_requirements_json: string | null
  status: "pending" | "verified" | "failed" | "expired" | "canceled"
  upstream_session_ref: string | null
  result_ref: string | null
  failure_code: string | null
  wallet_attachment_id: string | null
  verification_intent: string | null
  policy_id: string | null
  completed_at: string | null
  expires_at: string | null
  created_at: string
  updated_at: string
}

export type UserAttestationRow = {
  user_attestation_id: string
  capability_key: string | null
  status: "accepted" | "expired" | "revoked" | "superseded"
  verified_at: string | null
  expires_at: string | null
}

export type RedditVerificationSessionRow = {
  reddit_verification_session_id: string
  user_id: string
  reddit_username: string
  verification_code: string
  code_placement_surface: NonNullable<RedditVerification["code_placement_surface"]>
  status: RedditVerification["status"]
  verification_hint: string | null
  failure_code: RedditVerification["failure_code"]
  checked_count: number
  last_checked_at: string | null
  verified_at: string | null
  expires_at: string
  created_at: string
  updated_at: string
}

export type ExternalReputationSnapshotRow = {
  external_reputation_snapshot_id: string
  user_id: string
  source_platform: "reddit"
  snapshot_type: "onboarding"
  source_account_handle: string
  proof_method: "profile_code"
  captured_at: string
  snapshot_payload_json: string
  created_at: string
  updated_at: string
}

export type SessionSnapshot = Omit<SessionExchangeResponse, "access_token">

export function toUserRow(row: unknown): UserRow {
  return {
    user_id: requiredString(row, "user_id"),
    primary_wallet_attachment_id: stringOrNull(rowValue(row, "primary_wallet_attachment_id")),
    verification_state: requiredString(row, "verification_state") as User["verification_state"],
    capability_provider: (stringOrNull(rowValue(row, "capability_provider")) as User["capability_provider"] | "passport" | "zkpass"),
    verification_capabilities_json: requiredString(row, "verification_capabilities_json"),
    verified_at: stringOrNull(rowValue(row, "verified_at")),
    current_verification_session_id: stringOrNull(rowValue(row, "current_verification_session_id")),
    onboarding_dismissed_at: stringOrNull(rowValue(row, "onboarding_dismissed_at")),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  }
}

export function toProfileRow(row: unknown): ProfileRow {
  return {
    user_id: requiredString(row, "user_id"),
    display_name: stringOrNull(rowValue(row, "display_name")),
    bio: stringOrNull(rowValue(row, "bio")),
    bio_source: stringOrNull(rowValue(row, "bio_source")) as ProfileRow["bio_source"],
    avatar_ref: stringOrNull(rowValue(row, "avatar_ref")),
    avatar_source: stringOrNull(rowValue(row, "avatar_source")) as ProfileRow["avatar_source"],
    cover_ref: stringOrNull(rowValue(row, "cover_ref")),
    cover_source: stringOrNull(rowValue(row, "cover_source")) as ProfileRow["cover_source"],
    preferred_locale: stringOrNull(rowValue(row, "preferred_locale")),
    display_verified_nationality_badge: numberOrNull(rowValue(row, "display_verified_nationality_badge")) ?? 0,
    global_handle_id: requiredString(row, "global_handle_id"),
    primary_linked_handle_id: stringOrNull(rowValue(row, "primary_linked_handle_id")),
    xmtp_inbox_id: stringOrNull(rowValue(row, "xmtp_inbox_id")),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  }
}

export function toLinkedHandleRow(row: unknown): LinkedHandleRow {
  return {
    linked_handle_id: requiredString(row, "linked_handle_id"),
    user_id: requiredString(row, "user_id"),
    wallet_attachment_id: stringOrNull(rowValue(row, "wallet_attachment_id")),
    kind: requiredString(row, "kind") as LinkedHandle["kind"],
    label_normalized: requiredString(row, "label_normalized"),
    label_display: requiredString(row, "label_display"),
    verification_state: requiredString(row, "verification_state") as LinkedHandle["verification_state"],
    metadata_json: stringOrNull(rowValue(row, "metadata_json")),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  }
}

export function toGlobalHandleRow(row: unknown): GlobalHandleRow {
  return {
    global_handle_id: requiredString(row, "global_handle_id"),
    user_id: requiredString(row, "user_id"),
    label_normalized: requiredString(row, "label_normalized"),
    label_display: requiredString(row, "label_display"),
    status: requiredString(row, "status") as GlobalHandle["status"],
    tier: requiredString(row, "tier") as GlobalHandle["tier"],
    issuance_source: requiredString(row, "issuance_source") as GlobalHandle["issuance_source"],
    redirect_target_global_handle_id: stringOrNull(rowValue(row, "redirect_target_global_handle_id")),
    price_paid_usd: numberOrNull(rowValue(row, "price_paid_usd")),
    free_rename_consumed: requiredNumber(row, "free_rename_consumed"),
    issued_at: requiredString(row, "issued_at"),
    replaced_at: stringOrNull(rowValue(row, "replaced_at")),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  }
}

export function toWalletAttachmentRow(row: unknown): WalletAttachmentRow {
  return {
    wallet_attachment_id: requiredString(row, "wallet_attachment_id"),
    chain_namespace: requiredString(row, "chain_namespace"),
    wallet_address_normalized: requiredString(row, "wallet_address_normalized"),
    wallet_address_display: requiredString(row, "wallet_address_display"),
    is_primary: requiredNumber(row, "is_primary"),
  }
}

export function toVerificationSessionRow(row: unknown): VerificationSessionRow {
  return {
    verification_session_id: requiredString(row, "verification_session_id"),
    user_id: requiredString(row, "user_id"),
    provider: requiredString(row, "provider") as VerificationSessionRow["provider"],
    provider_mode: stringOrNull(rowValue(row, "provider_mode")) as VerificationSessionRow["provider_mode"],
    requested_capabilities_json: requiredString(row, "requested_capabilities_json"),
    verification_requirements_json: stringOrNull(rowValue(row, "verification_requirements_json")),
    status: requiredString(row, "status") as VerificationSessionRow["status"],
    upstream_session_ref: stringOrNull(rowValue(row, "upstream_session_ref")),
    result_ref: stringOrNull(rowValue(row, "result_ref")),
    failure_code: stringOrNull(rowValue(row, "failure_code")),
    wallet_attachment_id: stringOrNull(rowValue(row, "wallet_attachment_id")),
    verification_intent: stringOrNull(rowValue(row, "verification_intent")),
    policy_id: stringOrNull(rowValue(row, "policy_id")),
    completed_at: stringOrNull(rowValue(row, "completed_at")),
    expires_at: stringOrNull(rowValue(row, "expires_at")),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  }
}

export function toUserAttestationRow(row: unknown): UserAttestationRow {
  return {
    user_attestation_id: requiredString(row, "user_attestation_id"),
    capability_key: stringOrNull(rowValue(row, "capability_key")),
    status: requiredString(row, "status") as UserAttestationRow["status"],
    verified_at: stringOrNull(rowValue(row, "verified_at")),
    expires_at: stringOrNull(rowValue(row, "expires_at")),
  }
}

export function toRedditVerificationSessionRow(row: unknown): RedditVerificationSessionRow {
  return {
    reddit_verification_session_id: requiredString(row, "reddit_verification_session_id"),
    user_id: requiredString(row, "user_id"),
    reddit_username: requiredString(row, "reddit_username"),
    verification_code: requiredString(row, "verification_code"),
    code_placement_surface: requiredString(row, "code_placement_surface") as NonNullable<RedditVerification["code_placement_surface"]>,
    status: requiredString(row, "status") as RedditVerification["status"],
    verification_hint: stringOrNull(rowValue(row, "verification_hint")),
    failure_code: stringOrNull(rowValue(row, "failure_code")) as RedditVerification["failure_code"],
    checked_count: requiredNumber(row, "checked_count"),
    last_checked_at: stringOrNull(rowValue(row, "last_checked_at")),
    verified_at: stringOrNull(rowValue(row, "verified_at")),
    expires_at: requiredString(row, "expires_at"),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  }
}

export function toExternalReputationSnapshotRow(row: unknown): ExternalReputationSnapshotRow {
  return {
    external_reputation_snapshot_id: requiredString(row, "external_reputation_snapshot_id"),
    user_id: requiredString(row, "user_id"),
    source_platform: requiredString(row, "source_platform") as "reddit",
    snapshot_type: requiredString(row, "snapshot_type") as "onboarding",
    source_account_handle: requiredString(row, "source_account_handle"),
    proof_method: requiredString(row, "proof_method") as "profile_code",
    captured_at: requiredString(row, "captured_at"),
    snapshot_payload_json: requiredString(row, "snapshot_payload_json"),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  }
}
