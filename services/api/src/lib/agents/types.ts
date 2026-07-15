import type { PublicAgentResolution } from "../../types"

export type AgentOwnershipProvider = "self_agent_id" | "clawkey"
export type AgentOwnershipSessionKind = "register" | "refresh" | "transfer" | "deregister"
export type AgentOwnershipPairingStatus = "pending" | "claimed" | "completed" | "expired"
export type AgentOwnershipSessionStatus =
  | "pending"
  | "awaiting_owner"
  | "proof_submitted"
  | "verified"
  | "failed"
  | "expired"
  | "cancelled"
export type UserAgentStatus = "pending" | "active" | "suspended" | "revoked" | "transferred" | "deregistered"
export type AgentOwnershipState = "pending" | "verified" | "expired" | "revoked" | "transferred"
export type AgentHandleStatus = "active" | "redirect" | "retired"

export type AgentChallenge = {
  device_id: string
  public_key: string
  message: string
  signature: string
  timestamp: number
}

type SelfAgentOwnershipLaunch = {
  deep_link?: string | null
  qr_ref?: string | null
  session_token_ref?: string | null
}

type ClawkeyRegistrationLaunch = {
  session_id: string
  registration_url: string
  expires_at?: string | null
}

export type AgentOwnershipSessionLaunch = {
  mode: "qr_deeplink" | "registration_url" | "none"
  self_agent?: SelfAgentOwnershipLaunch
  clawkey_registration?: ClawkeyRegistrationLaunch
}

export type AgentOwnershipRecord = {
  agent_ownership_record_id: string
  agent_id: string
  owner_user_id: string
  ownership_provider: AgentOwnershipProvider
  provider_subject_id: string | null
  device_id: string | null
  public_key: string | null
  ownership_state: AgentOwnershipState
  source_session_id: string | null
  verified_at: string | null
  expires_at: string | null
  ended_at: string | null
  evidence_ref: string | null
  created_at: string
  updated_at: string
}

export type AgentDelegatedCredential = {
  agent_delegated_credential_id: string
  agent_id: string
  owner_user_id: string
  current_ownership_record_id: string
  token_type: "Bearer"
  access_token: string
  refresh_token: string
  issued_at: string
  expires_at: string
  refresh_expires_at: string | null
}

export type AgentOwnershipSession = {
  agent_ownership_session_id: string
  session_kind: AgentOwnershipSessionKind
  owner_user_id: string | null
  agent_id: string | null
  ownership_provider: AgentOwnershipProvider
  status: AgentOwnershipSessionStatus
  agent_challenge_ref: string
  provider_session_ref: string | null
  launch: AgentOwnershipSessionLaunch
  callback_path: string | null
  resolved_agent_ownership_record_id: string | null
  created_at: string
  expires_at: string
  updated_at: string
}

export type UserAgent = {
  agent_id: string
  owner_user_id: string
  display_name: string
  handle: AgentHandle | null
  status: UserAgentStatus
  current_ownership_record_id: string | null
  current_ownership: AgentOwnershipRecord | null
  created_at: string
  updated_at: string
}

export type UserAgentListResponse = {
  items: UserAgent[]
  next_cursor: string | null
}

export type AgentHandle = {
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

export type { PublicAgentResolution }

export type AgentOwnershipPairing = {
  pairing_code: string
  expires_at: string
}

export type AgentOwnershipPairingClaimResult = {
  agent_ownership_session_id: string
  registration_url: string
  connection_token: string
}
