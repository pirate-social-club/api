CREATE TABLE telegram_audio_file_cache (
    telegram_community_bot_id TEXT NOT NULL
        REFERENCES telegram_community_bots(telegram_community_bot_id) ON DELETE CASCADE,
    content_hash TEXT NOT NULL,
    telegram_file_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (telegram_community_bot_id, content_hash),
    CONSTRAINT telegram_audio_file_cache_content_hash_check
        CHECK (length(content_hash) > 0),
    CONSTRAINT telegram_audio_file_cache_file_id_check
        CHECK (length(telegram_file_id) > 0)
);
