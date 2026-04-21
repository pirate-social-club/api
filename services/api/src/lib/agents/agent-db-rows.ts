import {
  requiredString,
  rowValue,
  stringOrNull,
} from "../sql-row"
import type {
  AgentOwnershipPairingStatus,
  AgentOwnershipRecord,
  AgentHandle,
  AgentHandleStatus,
  AgentOwnershipProvider,
  AgentOwnershipSessionKind,
  AgentOwnershipSessionStatus,
  UserAgent,
  UserAgentStatus,
} from "./types"

export type AgentOwnershipSessionRow = {
  agent_ownership_session_id: string
  session_kind: AgentOwnershipSessionKind
  owner_user_id: string | null
  agent_id: string | null
  display_name: string | null
  policy_id: string | null
  ownership_provider: AgentOwnershipProvider
  status: AgentOwnershipSessionStatus
  agent_challenge_ref: string
  agent_challenge_payload_json: string
  provider_session_ref: string | null
  launch_json: string
  callback_path: string | null
  resolved_agent_ownership_record_id: string | null
  failure_reason: string | null
  created_at: string
  expires_at: string
  updated_at: string
}

export type AgentOwnershipRecordRow = {
  agent_ownership_record_id: string
  agent_id: string
  owner_user_id: string
  ownership_provider: AgentOwnershipProvider
  provider_subject_id: string | null
  device_id: string | null
  public_key: string | null
  ownership_state: AgentOwnershipRecord["ownership_state"]
  source_session_id: string | null
  verified_at: string | null
  expires_at: string | null
  ended_at: string | null
  evidence_ref: string | null
  created_at: string
  updated_at: string
}

export type UserAgentRow = {
  agent_id: string
  owner_user_id: string
  display_name: string
  status: UserAgentStatus
  created_at: string
  updated_at: string
}

export type AgentHandleRow = {
  agent_handle_id: string
  agent_id: string
  label_normalized: string
  label_display: string
  status: AgentHandleStatus
  redirect_target_agent_handle_id: string | null
  issued_at: string
  replaced_at: string | null
  created_at: string
  updated_at: string
}

export type AgentDelegatedCredentialRow = {
  agent_delegated_credential_id: string
  agent_id: string
  owner_user_id: string
  agent_ownership_record_id: string
  access_token_hash: string
  refresh_token_hash: string
  status: "active" | "superseded" | "revoked" | "expired"
  issued_at: string
  expires_at: string
  refresh_expires_at: string | null
  superseded_by_credential_id: string | null
  refreshed_from_credential_id: string | null
  invalidated_at: string | null
  created_at: string
  updated_at: string
}

export type AgentPairingCodeRow = {
  code: string
  user_id: string
  status: AgentOwnershipPairingStatus
  claimed_at: string | null
  connection_token_hash: string | null
  agent_ownership_session_id: string | null
  expires_at: string
  created_at: string
}

export function toAgentOwnershipSessionRow(row: unknown): AgentOwnershipSessionRow {
  return {
    agent_ownership_session_id: requiredString(row, "agent_ownership_session_id"),
    session_kind: requiredString(row, "session_kind") as AgentOwnershipSessionKind,
    owner_user_id: stringOrNull(rowValue(row, "owner_user_id")),
    agent_id: stringOrNull(rowValue(row, "agent_id")),
    display_name: stringOrNull(rowValue(row, "display_name")),
    policy_id: stringOrNull(rowValue(row, "policy_id")),
    ownership_provider: requiredString(row, "ownership_provider") as AgentOwnershipProvider,
    status: requiredString(row, "status") as AgentOwnershipSessionStatus,
    agent_challenge_ref: requiredString(row, "agent_challenge_ref"),
    agent_challenge_payload_json: requiredString(row, "agent_challenge_payload_json"),
    provider_session_ref: stringOrNull(rowValue(row, "provider_session_ref")),
    launch_json: requiredString(row, "launch_json"),
    callback_path: stringOrNull(rowValue(row, "callback_path")),
    resolved_agent_ownership_record_id: stringOrNull(rowValue(row, "resolved_agent_ownership_record_id")),
    failure_reason: stringOrNull(rowValue(row, "failure_reason")),
    created_at: requiredString(row, "created_at"),
    expires_at: requiredString(row, "expires_at"),
    updated_at: requiredString(row, "updated_at"),
  }
}

export function toAgentOwnershipRecordRow(row: unknown): AgentOwnershipRecordRow {
  return {
    agent_ownership_record_id: requiredString(row, "agent_ownership_record_id"),
    agent_id: requiredString(row, "agent_id"),
    owner_user_id: requiredString(row, "owner_user_id"),
    ownership_provider: requiredString(row, "ownership_provider") as AgentOwnershipProvider,
    provider_subject_id: stringOrNull(rowValue(row, "provider_subject_id")),
    device_id: stringOrNull(rowValue(row, "device_id")),
    public_key: stringOrNull(rowValue(row, "public_key")),
    ownership_state: requiredString(row, "ownership_state") as AgentOwnershipRecord["ownership_state"],
    source_session_id: stringOrNull(rowValue(row, "source_session_id")),
    verified_at: stringOrNull(rowValue(row, "verified_at")),
    expires_at: stringOrNull(rowValue(row, "expires_at")),
    ended_at: stringOrNull(rowValue(row, "ended_at")),
    evidence_ref: stringOrNull(rowValue(row, "evidence_ref")),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  }
}

export function toUserAgentRow(row: unknown): UserAgentRow {
  return {
    agent_id: requiredString(row, "agent_id"),
    owner_user_id: requiredString(row, "owner_user_id"),
    display_name: requiredString(row, "display_name"),
    status: requiredString(row, "status") as UserAgent["status"],
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  }
}

export function toAgentHandleRow(row: unknown): AgentHandleRow {
  return {
    agent_handle_id: requiredString(row, "agent_handle_id"),
    agent_id: requiredString(row, "agent_id"),
    label_normalized: requiredString(row, "label_normalized"),
    label_display: requiredString(row, "label_display"),
    status: requiredString(row, "status") as AgentHandle["status"],
    redirect_target_agent_handle_id: stringOrNull(rowValue(row, "redirect_target_agent_handle_id")),
    issued_at: requiredString(row, "issued_at"),
    replaced_at: stringOrNull(rowValue(row, "replaced_at")),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  }
}

export function toAgentDelegatedCredentialRow(row: unknown): AgentDelegatedCredentialRow {
  return {
    agent_delegated_credential_id: requiredString(row, "agent_delegated_credential_id"),
    agent_id: requiredString(row, "agent_id"),
    owner_user_id: requiredString(row, "owner_user_id"),
    agent_ownership_record_id: requiredString(row, "agent_ownership_record_id"),
    access_token_hash: requiredString(row, "access_token_hash"),
    refresh_token_hash: requiredString(row, "refresh_token_hash"),
    status: requiredString(row, "status") as AgentDelegatedCredentialRow["status"],
    issued_at: requiredString(row, "issued_at"),
    expires_at: requiredString(row, "expires_at"),
    refresh_expires_at: stringOrNull(rowValue(row, "refresh_expires_at")),
    superseded_by_credential_id: stringOrNull(rowValue(row, "superseded_by_credential_id")),
    refreshed_from_credential_id: stringOrNull(rowValue(row, "refreshed_from_credential_id")),
    invalidated_at: stringOrNull(rowValue(row, "invalidated_at")),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  }
}

export function toAgentPairingCodeRow(row: unknown): AgentPairingCodeRow {
  return {
    code: requiredString(row, "code"),
    user_id: requiredString(row, "user_id"),
    status: requiredString(row, "status") as AgentOwnershipPairingStatus,
    claimed_at: stringOrNull(rowValue(row, "claimed_at")),
    connection_token_hash: stringOrNull(rowValue(row, "connection_token_hash")),
    agent_ownership_session_id: stringOrNull(rowValue(row, "agent_ownership_session_id")),
    expires_at: requiredString(row, "expires_at"),
    created_at: requiredString(row, "created_at"),
  }
}
