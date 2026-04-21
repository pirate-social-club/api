CREATE TABLE user_agents (
  agent_id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'active', 'suspended', 'revoked', 'transferred', 'deregistered')
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (owner_user_id) REFERENCES users(user_id)
);

CREATE INDEX idx_user_agents_owner
  ON user_agents(owner_user_id, created_at DESC);

CREATE TABLE agent_ownership_records (
  agent_ownership_record_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  ownership_provider TEXT NOT NULL CHECK (
    ownership_provider IN ('self_agent_id', 'clawkey')
  ),
  provider_subject_id TEXT,
  device_id TEXT,
  public_key TEXT,
  ownership_state TEXT NOT NULL CHECK (
    ownership_state IN ('pending', 'verified', 'expired', 'revoked', 'transferred')
  ),
  source_session_id TEXT,
  verified_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  evidence_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (agent_id) REFERENCES user_agents(agent_id),
  FOREIGN KEY (owner_user_id) REFERENCES users(user_id)
);

CREATE INDEX idx_agent_ownership_records_owner
  ON agent_ownership_records(owner_user_id, created_at DESC);

CREATE INDEX idx_agent_ownership_records_agent
  ON agent_ownership_records(agent_id, created_at DESC);

CREATE UNIQUE INDEX idx_agent_ownership_records_active_verified_unique
  ON agent_ownership_records(agent_id)
  WHERE ownership_state = 'verified' AND ended_at IS NULL;

CREATE TABLE agent_ownership_sessions (
  agent_ownership_session_id TEXT PRIMARY KEY,
  session_kind TEXT NOT NULL CHECK (
    session_kind IN ('register', 'refresh', 'transfer', 'deregister')
  ),
  owner_user_id TEXT,
  agent_id TEXT,
  display_name TEXT,
  policy_id TEXT,
  ownership_provider TEXT NOT NULL CHECK (
    ownership_provider IN ('self_agent_id', 'clawkey')
  ),
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'awaiting_owner', 'proof_submitted', 'verified', 'failed', 'expired', 'cancelled')
  ),
  agent_challenge_ref TEXT NOT NULL,
  agent_challenge_payload_json JSONB NOT NULL,
  provider_session_ref TEXT,
  launch_json JSONB NOT NULL,
  callback_path TEXT,
  resolved_agent_ownership_record_id TEXT,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (owner_user_id) REFERENCES users(user_id)
);

CREATE INDEX idx_agent_ownership_sessions_owner
  ON agent_ownership_sessions(owner_user_id, created_at DESC);

CREATE INDEX idx_agent_ownership_sessions_agent
  ON agent_ownership_sessions(agent_id, created_at DESC);

CREATE INDEX idx_agent_ownership_sessions_provider_status
  ON agent_ownership_sessions(ownership_provider, status, created_at DESC);

CREATE TABLE agent_delegated_credentials (
  agent_delegated_credential_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  agent_ownership_record_id TEXT NOT NULL,
  access_token_hash TEXT NOT NULL UNIQUE,
  refresh_token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (
    status IN ('active', 'superseded', 'revoked', 'expired')
  ),
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  refresh_expires_at TIMESTAMPTZ,
  superseded_by_credential_id TEXT,
  refreshed_from_credential_id TEXT,
  invalidated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (agent_id) REFERENCES user_agents(agent_id),
  FOREIGN KEY (owner_user_id) REFERENCES users(user_id),
  FOREIGN KEY (agent_ownership_record_id) REFERENCES agent_ownership_records(agent_ownership_record_id)
);

CREATE INDEX idx_agent_delegated_credentials_owner
  ON agent_delegated_credentials(owner_user_id, created_at DESC);

CREATE INDEX idx_agent_delegated_credentials_agent
  ON agent_delegated_credentials(agent_id, created_at DESC);
