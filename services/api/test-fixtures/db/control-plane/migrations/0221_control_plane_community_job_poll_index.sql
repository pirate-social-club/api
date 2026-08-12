CREATE INDEX IF NOT EXISTS idx_communities_scheduled_job_poll
  ON communities(status, provisioning_state, created_at, community_id);
