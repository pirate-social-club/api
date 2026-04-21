CREATE TABLE agent_handles (
  agent_handle_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  label_normalized TEXT NOT NULL,
  label_display TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('active', 'redirect', 'retired')
  ),
  redirect_target_agent_handle_id TEXT,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  replaced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (agent_id) REFERENCES user_agents(agent_id),
  FOREIGN KEY (redirect_target_agent_handle_id) REFERENCES agent_handles(agent_handle_id)
);

CREATE UNIQUE INDEX idx_agent_handles_active_label
  ON agent_handles(label_normalized)
  WHERE status = 'active';

CREATE UNIQUE INDEX idx_agent_handles_active_agent
  ON agent_handles(agent_id)
  WHERE status = 'active';

