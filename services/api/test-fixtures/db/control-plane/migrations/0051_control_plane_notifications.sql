CREATE TABLE IF NOT EXISTS user_tasks (
  task_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  priority INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT,
  resolved_at TIMESTAMPTZ,
  dismissed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE INDEX IF NOT EXISTS idx_user_tasks_user_status
  ON user_tasks (user_id, status, updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_tasks_user_type_subject
  ON user_tasks (user_id, type, subject_id)
  WHERE status = 'open';

CREATE TABLE IF NOT EXISTS notification_events (
  event_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  actor_user_id TEXT,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  object_type TEXT,
  object_id TEXT,
  payload_json TEXT,
  dedupe_key TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (actor_user_id) REFERENCES users(user_id)
);

CREATE INDEX IF NOT EXISTS idx_notification_events_created
  ON notification_events (created_at DESC);

CREATE TABLE IF NOT EXISTS notification_receipts (
  event_id TEXT NOT NULL,
  recipient_user_id TEXT NOT NULL,
  seen_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (event_id, recipient_user_id),
  FOREIGN KEY (event_id) REFERENCES notification_events(event_id),
  FOREIGN KEY (recipient_user_id) REFERENCES users(user_id)
);

CREATE INDEX IF NOT EXISTS idx_notification_receipts_recipient
  ON notification_receipts (recipient_user_id, read_at, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE user_tasks TO control_plane_api_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE notification_events TO control_plane_api_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE notification_receipts TO control_plane_api_rw;

GRANT SELECT ON TABLE user_tasks TO control_plane_api_ro, control_plane_ops_ro;
GRANT SELECT ON TABLE notification_events TO control_plane_api_ro, control_plane_ops_ro;
GRANT SELECT ON TABLE notification_receipts TO control_plane_api_ro, control_plane_ops_ro;
