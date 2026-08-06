ALTER TABLE user_study_preferences RENAME TO user_study_preferences_old;

CREATE TABLE user_study_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  helper_language TEXT NOT NULL CHECK (helper_language IN ('en', 'zh', 'ar', 'ka', 'ru')),
  delivery_mode TEXT NOT NULL CHECK (delivery_mode IN ('audio', 'text', 'both')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO user_study_preferences (
  user_id,
  helper_language,
  delivery_mode,
  created_at,
  updated_at
)
SELECT
  user_id,
  helper_language,
  delivery_mode,
  created_at,
  updated_at
FROM user_study_preferences_old;

DROP TABLE user_study_preferences_old;
