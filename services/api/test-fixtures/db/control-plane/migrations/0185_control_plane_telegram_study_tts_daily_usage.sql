CREATE TABLE telegram_study_tts_daily_usage (
  community_id TEXT NOT NULL,
  usage_day TEXT NOT NULL,
  character_count INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (community_id, usage_day),
  CONSTRAINT chk_telegram_study_tts_daily_usage_day
    CHECK (length(usage_day) = 10 AND usage_day LIKE '____-__-__'),
  CONSTRAINT chk_telegram_study_tts_daily_usage_character_count
    CHECK (character_count >= 0),
  CONSTRAINT fk_telegram_study_tts_daily_usage_community
    FOREIGN KEY (community_id) REFERENCES communities(community_id) ON DELETE CASCADE
);
