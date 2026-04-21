import { internalError } from "../errors"
import type {
  AgentChallenge,
  AgentHandle,
  AgentOwnershipRecord,
  AgentOwnershipSession,
  AgentOwnershipSessionLaunch,
  UserAgent,
} from "./types"
import type {
  AgentOwnershipRecordRow,
  AgentOwnershipSessionRow,
  AgentHandleRow,
  UserAgentRow,
} from "./agent-db-rows"

export function parseAgentChallenge(raw: string): AgentChallenge {
  try {
    const parsed = JSON.parse(raw) as AgentChallenge
    if (!parsed || typeof parsed !== "object") {
      throw new Error("invalid")
    }
    return parsed
  } catch {
    throw internalError("Stored agent challenge payload is malformed")
  }
}

function parseLaunch(raw: string): AgentOwnershipSessionLaunch {
  try {
    const parsed = JSON.parse(raw) as AgentOwnershipSessionLaunch
    if (!parsed || typeof parsed !== "object" || typeof parsed.mode !== "string") {
      throw new Error("invalid")
    }
    return parsed
  } catch {
    throw internalError("Stored agent ownership launch payload is malformed")
  }
}

export function serializeAgentOwnershipRecord(row: AgentOwnershipRecordRow): AgentOwnershipRecord {
  return {
    agent_ownership_record_id: row.agent_ownership_record_id,
    agent_id: row.agent_id,
    owner_user_id: row.owner_user_id,
    ownership_provider: row.ownership_provider,
    provider_subject_id: row.provider_subject_id,
    device_id: row.device_id,
    public_key: row.public_key,
    ownership_state: row.ownership_state,
    source_session_id: row.source_session_id,
    verified_at: row.verified_at,
    expires_at: row.expires_at,
    ended_at: row.ended_at,
    evidence_ref: row.evidence_ref,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

export function serializeAgentHandle(row: AgentHandleRow): AgentHandle {
  return {
    agent_handle_id: row.agent_handle_id,
    agent_id: row.agent_id,
    label_normalized: row.label_normalized,
    label_display: row.label_display,
    status: row.status,
    redirect_target_agent_handle_id: row.redirect_target_agent_handle_id,
    issued_at: row.issued_at,
    replaced_at: row.replaced_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

export function serializeAgentOwnershipSession(row: AgentOwnershipSessionRow): AgentOwnershipSession {
  return {
    agent_ownership_session_id: row.agent_ownership_session_id,
    session_kind: row.session_kind,
    owner_user_id: row.owner_user_id,
    agent_id: row.agent_id,
    ownership_provider: row.ownership_provider,
    status: row.status,
    agent_challenge_ref: row.agent_challenge_ref,
    provider_session_ref: row.provider_session_ref,
    launch: parseLaunch(row.launch_json),
    callback_path: row.callback_path,
    resolved_agent_ownership_record_id: row.resolved_agent_ownership_record_id,
    created_at: row.created_at,
    expires_at: row.expires_at,
    updated_at: row.updated_at,
  }
}

export function serializeUserAgent(
  row: UserAgentRow,
  currentOwnership: AgentOwnershipRecord | null,
  handle: AgentHandle | null = null,
): UserAgent {
  return {
    agent_id: row.agent_id,
    owner_user_id: row.owner_user_id,
    display_name: row.display_name,
    handle,
    status: row.status,
    current_ownership_record_id: currentOwnership?.agent_ownership_record_id ?? null,
    current_ownership: currentOwnership,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}
