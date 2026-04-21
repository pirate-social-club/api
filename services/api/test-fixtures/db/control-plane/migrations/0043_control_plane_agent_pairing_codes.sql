CREATE TABLE agent_pairing_codes (
  code TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'claimed', 'completed', 'expired')
  ),
  claimed_at TIMESTAMPTZ,
  connection_token_hash TEXT UNIQUE,
  agent_ownership_session_id TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (user_id) REFERENCES users(user_id),
  FOREIGN KEY (agent_ownership_session_id) REFERENCES agent_ownership_sessions(agent_ownership_session_id)
);

CREATE INDEX idx_agent_pairing_codes_user
  ON agent_pairing_codes(user_id, created_at DESC);

CREATE INDEX idx_agent_pairing_codes_expires
  ON agent_pairing_codes(expires_at DESC);

CREATE UNIQUE INDEX idx_agent_pairing_codes_session_unique
  ON agent_pairing_codes(agent_ownership_session_id)
  WHERE agent_ownership_session_id IS NOT NULL;
