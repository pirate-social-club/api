CREATE TABLE analytics_outbox (
    analytics_event_id TEXT PRIMARY KEY,
    event_name TEXT NOT NULL,
    event_version INTEGER NOT NULL,
    event_time TEXT NOT NULL,
    received_at TEXT NOT NULL,
    environment TEXT NOT NULL,
    source TEXT NOT NULL CHECK (
        source IN ('web', 'api', 'job', 'backfill')
    ),
    app_surface TEXT NOT NULL CHECK (
        app_surface IN ('web', 'api', 'worker')
    ),
    session_id TEXT NOT NULL DEFAULT '',
    anonymous_id TEXT NOT NULL DEFAULT '',
    user_id_hash TEXT NOT NULL DEFAULT '',
    community_id TEXT NOT NULL DEFAULT '',
    post_id TEXT NOT NULL DEFAULT '',
    comment_id TEXT NOT NULL DEFAULT '',
    listing_id TEXT NOT NULL DEFAULT '',
    quote_id TEXT NOT NULL DEFAULT '',
    purchase_id TEXT NOT NULL DEFAULT '',
    verification_session_id TEXT NOT NULL DEFAULT '',
    request_id TEXT NOT NULL DEFAULT '',
    idempotency_key TEXT NOT NULL DEFAULT '',
    properties_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL CHECK (
        status IN ('pending', 'sending', 'sent', 'failed', 'discarded')
    ),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL,
    last_error TEXT,
    tinybird_status_code INTEGER,
    sent_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX idx_analytics_outbox_status_next_attempt
    ON analytics_outbox(status, next_attempt_at, created_at);

CREATE INDEX idx_analytics_outbox_event_created
    ON analytics_outbox(event_name, created_at DESC);
