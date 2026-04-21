PRAGMA foreign_keys = ON;

ALTER TABLE profiles
    ADD COLUMN preferred_locale TEXT;

CREATE TABLE reddit_verification_sessions (
    reddit_verification_session_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    reddit_username TEXT NOT NULL,
    verification_code TEXT NOT NULL,
    code_placement_surface TEXT NOT NULL CHECK (
        code_placement_surface IN ('profile', 'bio', 'about')
    ),
    status TEXT NOT NULL CHECK (
        status IN ('pending', 'verified', 'failed', 'expired')
    ),
    verification_hint TEXT,
    failure_code TEXT CHECK (
        failure_code IS NULL OR failure_code IN ('code_not_found', 'username_not_found', 'rate_limited', 'source_error')
    ),
    checked_count INTEGER NOT NULL DEFAULT 0,
    last_checked_at TEXT,
    verified_at TEXT,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE INDEX idx_reddit_verification_sessions_user_created
    ON reddit_verification_sessions(user_id, created_at DESC);

CREATE INDEX idx_reddit_verification_sessions_user_username_created
    ON reddit_verification_sessions(user_id, reddit_username, created_at DESC);

CREATE TABLE external_reputation_snapshots (
    external_reputation_snapshot_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    source_platform TEXT NOT NULL CHECK (
        source_platform IN ('reddit')
    ),
    snapshot_type TEXT NOT NULL CHECK (
        snapshot_type IN ('onboarding')
    ),
    source_account_handle TEXT NOT NULL,
    proof_method TEXT NOT NULL CHECK (
        proof_method IN ('profile_code')
    ),
    captured_at TEXT NOT NULL,
    snapshot_payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE INDEX idx_external_reputation_snapshots_user_source_created
    ON external_reputation_snapshots(user_id, source_platform, created_at DESC);
