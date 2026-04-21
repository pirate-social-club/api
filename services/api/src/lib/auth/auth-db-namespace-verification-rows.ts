import {
  numberOrNull,
  requiredNumber,
  requiredString,
  rowValue,
  stringOrNull,
} from "../sql-row"
import type {
  NamespaceVerification,
  NamespaceVerificationSession,
} from "../../types"

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
  setup_nameservers_json: string | null
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
    setup_nameservers_json: stringOrNull(rowValue(row, "setup_nameservers_json")),
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
