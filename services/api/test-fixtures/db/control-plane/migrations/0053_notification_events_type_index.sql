CREATE INDEX IF NOT EXISTS idx_notification_events_type_created
  ON notification_events (type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notification_events_dedupe_key
  ON notification_events (dedupe_key)
  WHERE dedupe_key IS NOT NULL;
