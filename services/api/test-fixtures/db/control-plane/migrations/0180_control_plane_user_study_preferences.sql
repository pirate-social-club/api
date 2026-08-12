CREATE TABLE user_study_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  helper_language TEXT NOT NULL CHECK (helper_language IN ('en', 'zh', 'ar', 'ka')),
  delivery_mode TEXT NOT NULL CHECK (delivery_mode IN ('audio', 'text', 'both')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
