CREATE TABLE IF NOT EXISTS telegram_chat_study_message_deliveries (
  telegram_community_bot_id TEXT NOT NULL,
  telegram_user_id TEXT NOT NULL,
  telegram_message_id INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing', 'consumed', 'failed')),
  processing_lease_expires_at TEXT,
  last_error_message TEXT,
  received_at TEXT NOT NULL,
  consumed_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (
    telegram_community_bot_id,
    telegram_user_id,
    telegram_message_id
  ),
  FOREIGN KEY (telegram_community_bot_id)
    REFERENCES telegram_community_bots(telegram_community_bot_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_telegram_chat_study_message_deliveries_status
  ON telegram_chat_study_message_deliveries (
    status,
    processing_lease_expires_at,
    updated_at
  );
