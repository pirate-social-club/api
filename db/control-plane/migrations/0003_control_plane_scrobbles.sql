PRAGMA foreign_keys = ON;

CREATE TABLE scrobble_ingest_events (
    scrobble_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    track_id TEXT NOT NULL,
    community_id TEXT,
    source_type TEXT NOT NULL,
    playback_started_at TEXT NOT NULL,
    playback_position_ms INTEGER,
    credited_duration_ms INTEGER,
    ingestion_mode TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    anchor_status TEXT NOT NULL DEFAULT 'queued' CHECK (
        anchor_status IN (
            'queued',
            'awaiting_wallet',
            'awaiting_track',
            'anchoring',
            'anchored',
            'failed',
            'suppressed'
        )
    ),
    anchor_attempt_count INTEGER NOT NULL DEFAULT 0,
    wallet_attachment_id TEXT,
    accepted_at TEXT NOT NULL,
    anchored_at TEXT,
    chain_tx_hash TEXT,
    chain_log_index INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(user_id),
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (wallet_attachment_id) REFERENCES wallet_attachments(wallet_attachment_id)
);

CREATE UNIQUE INDEX idx_scrobble_idempotency
    ON scrobble_ingest_events(user_id, idempotency_key);

CREATE INDEX idx_scrobble_anchor_status
    ON scrobble_ingest_events(anchor_status, accepted_at);

CREATE INDEX idx_scrobble_user_status
    ON scrobble_ingest_events(user_id, anchor_status);

CREATE INDEX idx_scrobble_wallet_anchor
    ON scrobble_ingest_events(wallet_attachment_id, anchor_status)
    WHERE anchor_status IN ('queued', 'awaiting_track', 'awaiting_wallet');

CREATE TABLE scrobble_anchor_batches (
    batch_id TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (
        status IN ('queued', 'submitting', 'confirmed', 'failed')
    ),
    publisher_kind TEXT NOT NULL CHECK (
        publisher_kind IN ('direct-key', 'pkp')
    ),
    chain_id INTEGER NOT NULL DEFAULT 1315,
    wallet_address TEXT NOT NULL,
    tx_hash TEXT,
    error_code TEXT,
    item_count INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    confirmed_at TEXT,
    updated_at TEXT NOT NULL
);

CREATE INDEX idx_scrobble_anchor_batches_status
    ON scrobble_anchor_batches(status, created_at);

CREATE TABLE scrobble_anchor_batch_items (
    batch_id TEXT NOT NULL,
    scrobble_id TEXT NOT NULL,
    item_index INTEGER NOT NULL,
    event_log_index INTEGER,
    PRIMARY KEY (batch_id, scrobble_id),
    FOREIGN KEY (batch_id) REFERENCES scrobble_anchor_batches(batch_id),
    FOREIGN KEY (scrobble_id) REFERENCES scrobble_ingest_events(scrobble_id)
);

CREATE INDEX idx_scrobble_anchor_batch_items_scrobble
    ON scrobble_anchor_batch_items(scrobble_id);

CREATE TABLE track_anchor_state (
    track_id TEXT PRIMARY KEY,
    metadata_hash TEXT NOT NULL,
    registration_status TEXT NOT NULL DEFAULT 'not_registered' CHECK (
        registration_status IN ('not_registered', 'registering', 'registered')
    ),
    registered_tx_hash TEXT,
    registered_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX idx_track_anchor_state_not_registered
    ON track_anchor_state(registration_status)
    WHERE registration_status = 'not_registered';

CREATE TABLE projection_outbox (
    outbox_id TEXT PRIMARY KEY,
    target_scope TEXT NOT NULL CHECK (
        target_scope IN ('club', 'global')
    ),
    target_id TEXT NOT NULL,
    projection_kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (
        status IN ('pending', 'running', 'done', 'failed')
    ),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX idx_projection_outbox_status
    ON projection_outbox(status, created_at);

CREATE INDEX idx_projection_outbox_target
    ON projection_outbox(target_scope, target_id);
