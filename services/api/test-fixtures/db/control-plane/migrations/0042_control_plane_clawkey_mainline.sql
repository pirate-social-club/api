ALTER TABLE agent_ownership_records
  DROP CONSTRAINT IF EXISTS agent_ownership_records_ownership_provider_check;

ALTER TABLE agent_ownership_records
  ADD CONSTRAINT agent_ownership_records_ownership_provider_check
  CHECK (ownership_provider IN ('self_agent_id', 'clawkey'));

ALTER TABLE agent_ownership_sessions
  DROP CONSTRAINT IF EXISTS agent_ownership_sessions_ownership_provider_check;

ALTER TABLE agent_ownership_sessions
  ADD CONSTRAINT agent_ownership_sessions_ownership_provider_check
  CHECK (ownership_provider IN ('self_agent_id', 'clawkey'));
