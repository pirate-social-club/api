import type { Client, Transaction } from "@libsql/client"
import {
  numberOrNull,
  requiredNumber,
  requiredString,
  rowValue,
  stringOrNull,
} from "../sql-row"
import type {
  GlobalHandle,
  Job,
  NamespaceVerification,
  NamespaceVerificationSession,
  Post,
  RedditImportSummary,
  RedditVerification,
  SessionExchangeResponse,
  User,
} from "../../types"

export type DbExecutor = Pick<Client, "execute"> | Pick<Transaction, "execute">

export type UserRow = {
  user_id: string
  primary_wallet_attachment_id: string | null
  verification_state: User["verification_state"]
  capability_provider: User["capability_provider"] | "passport" | "zkpass"
  verification_capabilities_json: string
  verified_at: string | null
  nationality: string | null
  current_verification_session_id: string | null
  created_at: string
  updated_at: string
}

export type ProfileRow = {
  user_id: string
  display_name: string | null
  bio: string | null
  avatar_ref: string | null
  cover_ref: string | null
  preferred_locale: string | null
  global_handle_id: string
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
  requested_capabilities_json: string
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

export type NamespaceVerificationSessionRow = {
  namespace_verification_session_id: string
  namespace_verification_id: string | null
  user_id: string
  family: "hns" | "spaces"
  submitted_root_label: string
  normalized_root_label: string | null
  status: NamespaceVerificationSession["status"]
  challenge_kind: string | null
  challenge_payload_json: string | null
  challenge_host: string | null
  challenge_txt_value: string | null
  challenge_expires_at: string | null
  root_exists: number | null
  root_control_verified: number | null
  expiry_horizon_sufficient: number | null
  routing_enabled: number | null
  pirate_dns_authority_verified: number | null
  root_key_proof_verified: number | null
  live_signature_verified: number | null
  anchor_fresh_enough: number | null
  owner_signed_updates_verified: number | null
  club_attach_allowed: number | null
  pirate_web_routing_allowed: number | null
  pirate_subdomain_issuance_allowed: number | null
  owner_signed_record_updates_allowed: number | null
  pirate_subspace_issuance_allowed: number | null
  control_class: NamespaceVerificationSession["control_class"]
  operation_class: NamespaceVerificationSession["operation_class"]
  observation_provider: string | null
  evidence_bundle_ref: string | null
  failure_reason: string | null
  accepted_at: string | null
  anchor_height: number | null
  anchor_block_hash: string | null
  anchor_root_hash: string | null
  proof_root_hash: string | null
  expires_at: string
  created_at: string
  updated_at: string
}

export type NamespaceVerificationRow = {
  namespace_verification_id: string
  user_id: string
  family: "hns" | "spaces"
  normalized_root_label: string
  status: NamespaceVerification["status"]
  root_exists: number
  root_control_verified: number | null
  expiry_horizon_sufficient: number | null
  routing_enabled: number | null
  pirate_dns_authority_verified: number | null
  root_key_proof_verified: number | null
  live_signature_verified: number | null
  anchor_fresh_enough: number | null
  owner_signed_updates_verified: number | null
  club_attach_allowed: number
  pirate_web_routing_allowed: number
  pirate_subdomain_issuance_allowed: number
  owner_signed_record_updates_allowed: number | null
  pirate_subspace_issuance_allowed: number | null
  control_class: NamespaceVerification["control_class"]
  operation_class: NamespaceVerification["operation_class"]
  observation_provider: string | null
  evidence_bundle_ref: string | null
  accepted_at: string
  anchor_height: number | null
  anchor_block_hash: string | null
  anchor_root_hash: string | null
  proof_root_hash: string | null
  expires_at: string
  created_at: string
  updated_at: string
}

export type CommunityRow = {
  community_id: string
  creator_user_id: string
  display_name: string
  status: "draft" | "active" | "frozen" | "archived" | "deleted" | "suspended"
  provisioning_state: "requested" | "provisioning" | "active" | "rotation_required" | "error"
  registry_publication_state:
    | "not_started"
    | "pending_create"
    | "pending_seed"
    | "published"
    | "stale"
    | "publication_error"
  registry_attempt_id: string | null
  registry_published_at: string | null
  registry_publication_job_id: string | null
  registry_error_code: string | null
  transfer_state: "none" | "pending" | "transferred" | "federated"
  route_slug: string | null
  namespace_verification_id: string | null
  primary_database_binding_id: string | null
  created_at: string
  updated_at: string
}

export type CommunityRegistryAttemptRow = {
  registry_attempt_id: string
  actor_user_id: string
  actor_primary_wallet_snapshot: string | null
  actor_governance_address_snapshot: string | null
  namespace_verification_id: string
  normalized_root_label: string
  community_id: string | null
  attempt_status: "in_progress" | "succeeded" | "failed"
  failure_code: string | null
  created_at: string
  updated_at: string
}

export type CommunityDatabaseBindingRow = {
  community_database_binding_id: string
  community_id: string
  binding_role: "primary" | "read_replica" | "archive"
  organization_slug: string
  group_name: string
  group_id: string | null
  database_name: string
  database_id: string | null
  database_url: string
  location: string | null
  status: "active" | "inactive" | "pending_transfer" | "superseded" | "error"
  transferred_at: string | null
  created_at: string
  updated_at: string
}

export type JobRow = {
  job_id: string
  job_type: Job["job_type"]
  job_scope: "platform" | "community"
  community_id: string | null
  subject_type: string
  subject_id: string
  status: Job["status"]
  payload_json: string | null
  result_ref: string | null
  error_code: string | null
  attempt_count: number
  available_at: string | null
  created_at: string
  updated_at: string
}

export type CommunityPostProjectionRow = {
  projection_id: string
  community_id: string
  source_post_id: string
  author_user_id: string | null
  identity_mode: "public" | "anonymous"
  post_type: Post["post_type"]
  status: Post["status"]
  source_created_at: string
  projected_payload_json: string
  projection_version: number
  created_at: string
  updated_at: string
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
    nationality: stringOrNull(rowValue(row, "nationality")),
    current_verification_session_id: stringOrNull(rowValue(row, "current_verification_session_id")),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  }
}

export function toProfileRow(row: unknown): ProfileRow {
  return {
    user_id: requiredString(row, "user_id"),
    display_name: stringOrNull(rowValue(row, "display_name")),
    bio: stringOrNull(rowValue(row, "bio")),
    avatar_ref: stringOrNull(rowValue(row, "avatar_ref")),
    cover_ref: stringOrNull(rowValue(row, "cover_ref")),
    preferred_locale: stringOrNull(rowValue(row, "preferred_locale")),
    global_handle_id: requiredString(row, "global_handle_id"),
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
    requested_capabilities_json: requiredString(row, "requested_capabilities_json"),
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

export function toNamespaceVerificationSessionRow(row: unknown): NamespaceVerificationSessionRow {
  return {
    namespace_verification_session_id: requiredString(row, "namespace_verification_session_id"),
    namespace_verification_id: stringOrNull(rowValue(row, "namespace_verification_id")),
    user_id: requiredString(row, "user_id"),
    family: requiredString(row, "family") as NamespaceVerificationSessionRow["family"],
    submitted_root_label: requiredString(row, "submitted_root_label"),
    normalized_root_label: stringOrNull(rowValue(row, "normalized_root_label")),
    status: requiredString(row, "status") as NamespaceVerificationSession["status"],
    challenge_kind: stringOrNull(rowValue(row, "challenge_kind")),
    challenge_payload_json: stringOrNull(rowValue(row, "challenge_payload_json")),
    challenge_host: stringOrNull(rowValue(row, "challenge_host")),
    challenge_txt_value: stringOrNull(rowValue(row, "challenge_txt_value")),
    challenge_expires_at: stringOrNull(rowValue(row, "challenge_expires_at")),
    root_exists: numberOrNull(rowValue(row, "root_exists")),
    root_control_verified: numberOrNull(rowValue(row, "root_control_verified")),
    expiry_horizon_sufficient: numberOrNull(rowValue(row, "expiry_horizon_sufficient")),
    routing_enabled: numberOrNull(rowValue(row, "routing_enabled")),
    pirate_dns_authority_verified: numberOrNull(rowValue(row, "pirate_dns_authority_verified")),
    root_key_proof_verified: numberOrNull(rowValue(row, "root_key_proof_verified")),
    live_signature_verified: numberOrNull(rowValue(row, "live_signature_verified")),
    anchor_fresh_enough: numberOrNull(rowValue(row, "anchor_fresh_enough")),
    owner_signed_updates_verified: numberOrNull(rowValue(row, "owner_signed_updates_verified")),
    club_attach_allowed: numberOrNull(rowValue(row, "club_attach_allowed")),
    pirate_web_routing_allowed: numberOrNull(rowValue(row, "pirate_web_routing_allowed")),
    pirate_subdomain_issuance_allowed: numberOrNull(rowValue(row, "pirate_subdomain_issuance_allowed")),
    owner_signed_record_updates_allowed: numberOrNull(rowValue(row, "owner_signed_record_updates_allowed")),
    pirate_subspace_issuance_allowed: numberOrNull(rowValue(row, "pirate_subspace_issuance_allowed")),
    control_class: stringOrNull(rowValue(row, "control_class")) as NamespaceVerificationSession["control_class"],
    operation_class: stringOrNull(rowValue(row, "operation_class")) as NamespaceVerificationSession["operation_class"],
    observation_provider: stringOrNull(rowValue(row, "observation_provider")),
    evidence_bundle_ref: stringOrNull(rowValue(row, "evidence_bundle_ref")),
    failure_reason: stringOrNull(rowValue(row, "failure_reason")),
    accepted_at: stringOrNull(rowValue(row, "accepted_at")),
    anchor_height: numberOrNull(rowValue(row, "anchor_height")),
    anchor_block_hash: stringOrNull(rowValue(row, "anchor_block_hash")),
    anchor_root_hash: stringOrNull(rowValue(row, "anchor_root_hash")),
    proof_root_hash: stringOrNull(rowValue(row, "proof_root_hash")),
    expires_at: requiredString(row, "expires_at"),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  }
}

export function toNamespaceVerificationRow(row: unknown): NamespaceVerificationRow {
  return {
    namespace_verification_id: requiredString(row, "namespace_verification_id"),
    user_id: requiredString(row, "user_id"),
    family: requiredString(row, "family") as NamespaceVerificationRow["family"],
    normalized_root_label: requiredString(row, "normalized_root_label"),
    status: requiredString(row, "status") as NamespaceVerification["status"],
    root_exists: requiredNumber(row, "root_exists"),
    root_control_verified: numberOrNull(rowValue(row, "root_control_verified")),
    expiry_horizon_sufficient: numberOrNull(rowValue(row, "expiry_horizon_sufficient")),
    routing_enabled: numberOrNull(rowValue(row, "routing_enabled")),
    pirate_dns_authority_verified: numberOrNull(rowValue(row, "pirate_dns_authority_verified")),
    root_key_proof_verified: numberOrNull(rowValue(row, "root_key_proof_verified")),
    live_signature_verified: numberOrNull(rowValue(row, "live_signature_verified")),
    anchor_fresh_enough: numberOrNull(rowValue(row, "anchor_fresh_enough")),
    owner_signed_updates_verified: numberOrNull(rowValue(row, "owner_signed_updates_verified")),
    club_attach_allowed: requiredNumber(row, "club_attach_allowed"),
    pirate_web_routing_allowed: requiredNumber(row, "pirate_web_routing_allowed"),
    pirate_subdomain_issuance_allowed: requiredNumber(row, "pirate_subdomain_issuance_allowed"),
    owner_signed_record_updates_allowed: numberOrNull(rowValue(row, "owner_signed_record_updates_allowed")),
    pirate_subspace_issuance_allowed: numberOrNull(rowValue(row, "pirate_subspace_issuance_allowed")),
    control_class: stringOrNull(rowValue(row, "control_class")) as NamespaceVerification["control_class"],
    operation_class: stringOrNull(rowValue(row, "operation_class")) as NamespaceVerification["operation_class"],
    observation_provider: stringOrNull(rowValue(row, "observation_provider")),
    evidence_bundle_ref: stringOrNull(rowValue(row, "evidence_bundle_ref")),
    accepted_at: requiredString(row, "accepted_at"),
    anchor_height: numberOrNull(rowValue(row, "anchor_height")),
    anchor_block_hash: stringOrNull(rowValue(row, "anchor_block_hash")),
    anchor_root_hash: stringOrNull(rowValue(row, "anchor_root_hash")),
    proof_root_hash: stringOrNull(rowValue(row, "proof_root_hash")),
    expires_at: requiredString(row, "expires_at"),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  }
}

export function toCommunityRow(row: unknown): CommunityRow {
  return {
    community_id: requiredString(row, "community_id"),
    creator_user_id: requiredString(row, "creator_user_id"),
    display_name: requiredString(row, "display_name"),
    status: requiredString(row, "status") as CommunityRow["status"],
    provisioning_state: requiredString(row, "provisioning_state") as CommunityRow["provisioning_state"],
    registry_publication_state: requiredString(row, "registry_publication_state") as CommunityRow["registry_publication_state"],
    registry_attempt_id: stringOrNull(rowValue(row, "registry_attempt_id")),
    registry_published_at: stringOrNull(rowValue(row, "registry_published_at")),
    registry_publication_job_id: stringOrNull(rowValue(row, "registry_publication_job_id")),
    registry_error_code: stringOrNull(rowValue(row, "registry_error_code")),
    transfer_state: requiredString(row, "transfer_state") as CommunityRow["transfer_state"],
    route_slug: stringOrNull(rowValue(row, "route_slug")),
    namespace_verification_id: stringOrNull(rowValue(row, "namespace_verification_id")),
    primary_database_binding_id: stringOrNull(rowValue(row, "primary_database_binding_id")),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  }
}

export function toCommunityRegistryAttemptRow(row: unknown): CommunityRegistryAttemptRow {
  return {
    registry_attempt_id: requiredString(row, "registry_attempt_id"),
    actor_user_id: requiredString(row, "actor_user_id"),
    actor_primary_wallet_snapshot: stringOrNull(rowValue(row, "actor_primary_wallet_snapshot")),
    actor_governance_address_snapshot: stringOrNull(rowValue(row, "actor_governance_address_snapshot")),
    namespace_verification_id: requiredString(row, "namespace_verification_id"),
    normalized_root_label: requiredString(row, "normalized_root_label"),
    community_id: stringOrNull(rowValue(row, "community_id")),
    attempt_status: requiredString(row, "attempt_status") as CommunityRegistryAttemptRow["attempt_status"],
    failure_code: stringOrNull(rowValue(row, "failure_code")),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  }
}

export function toCommunityDatabaseBindingRow(row: unknown): CommunityDatabaseBindingRow {
  return {
    community_database_binding_id: requiredString(row, "community_database_binding_id"),
    community_id: requiredString(row, "community_id"),
    binding_role: requiredString(row, "binding_role") as CommunityDatabaseBindingRow["binding_role"],
    organization_slug: requiredString(row, "organization_slug"),
    group_name: requiredString(row, "group_name"),
    group_id: stringOrNull(rowValue(row, "group_id")),
    database_name: requiredString(row, "database_name"),
    database_id: stringOrNull(rowValue(row, "database_id")),
    database_url: requiredString(row, "database_url"),
    location: stringOrNull(rowValue(row, "location")),
    status: requiredString(row, "status") as CommunityDatabaseBindingRow["status"],
    transferred_at: stringOrNull(rowValue(row, "transferred_at")),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  }
}

export function toJobRow(row: unknown): JobRow {
  return {
    job_id: requiredString(row, "job_id"),
    job_type: requiredString(row, "job_type") as JobRow["job_type"],
    job_scope: requiredString(row, "job_scope") as JobRow["job_scope"],
    community_id: stringOrNull(rowValue(row, "community_id")),
    subject_type: requiredString(row, "subject_type"),
    subject_id: requiredString(row, "subject_id"),
    status: requiredString(row, "status") as JobRow["status"],
    payload_json: stringOrNull(rowValue(row, "payload_json")),
    result_ref: stringOrNull(rowValue(row, "result_ref")),
    error_code: stringOrNull(rowValue(row, "error_code")),
    attempt_count: requiredNumber(row, "attempt_count"),
    available_at: stringOrNull(rowValue(row, "available_at")),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  }
}

export function toCommunityPostProjectionRow(row: unknown): CommunityPostProjectionRow {
  return {
    projection_id: requiredString(row, "projection_id"),
    community_id: requiredString(row, "community_id"),
    source_post_id: requiredString(row, "source_post_id"),
    author_user_id: stringOrNull(rowValue(row, "author_user_id")),
    identity_mode: requiredString(row, "identity_mode") as CommunityPostProjectionRow["identity_mode"],
    post_type: requiredString(row, "post_type") as CommunityPostProjectionRow["post_type"],
    status: requiredString(row, "status") as CommunityPostProjectionRow["status"],
    source_created_at: requiredString(row, "source_created_at"),
    projected_payload_json: requiredString(row, "projected_payload_json"),
    projection_version: requiredNumber(row, "projection_version"),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
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
