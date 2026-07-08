export const KARAOKE_SNAPSHOT_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS karaoke_session_snapshots (
  session_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  state_json TEXT NOT NULL,
  last_client_sequence INTEGER,
  last_stt_sequence INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, attempt_id)
);
`;

export const KARAOKE_OUTBOX_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS karaoke_session_outbox (
  session_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  event_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  PRIMARY KEY (session_id, attempt_id, event_id)
);
`;

export const KARAOKE_OUTBOX_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS karaoke_session_outbox_pending_idx
  ON karaoke_session_outbox (session_id, attempt_id, delivered_at, sequence);
`;

export const KARAOKE_ATTEMPT_FINALIZE_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS karaoke_attempt_finalize_outbox (
  session_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  delivered_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, attempt_id)
);
`;

export const KARAOKE_ATTEMPT_FINALIZE_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS karaoke_attempt_finalize_pending_idx
  ON karaoke_attempt_finalize_outbox (delivered_at, next_attempt_at);
`;

export const KARAOKE_SNAPSHOT_MIGRATION_TAG = "v1_karaoke_session_runtime" as const;
