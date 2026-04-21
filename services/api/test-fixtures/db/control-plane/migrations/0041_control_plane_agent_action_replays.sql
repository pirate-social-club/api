CREATE TABLE agent_action_nonce_replays (
  agent_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  signed_at TIMESTAMPTZ NOT NULL,
  canonical_request_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (agent_id, nonce),
  FOREIGN KEY (agent_id) REFERENCES user_agents(agent_id)
);

CREATE INDEX idx_agent_action_nonce_replays_expires_at
  ON agent_action_nonce_replays(expires_at);
