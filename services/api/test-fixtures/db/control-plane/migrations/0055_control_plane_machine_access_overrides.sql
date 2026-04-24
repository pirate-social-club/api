CREATE TABLE machine_access_overrides (
    machine_access_override_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    surface TEXT NOT NULL CHECK (
        surface IN ('all', 'community_stats', 'thread_cards', 'thread_bodies', 'top_comments', 'events')
    ),
    effect TEXT NOT NULL CHECK (
        effect IN ('disable')
    ),
    reason_code TEXT NOT NULL,
    note TEXT,
    created_by_user_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    revoked_by_user_id TEXT,
    revoked_reason TEXT,
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (created_by_user_id) REFERENCES users(user_id),
    FOREIGN KEY (revoked_by_user_id) REFERENCES users(user_id)
);

CREATE INDEX idx_machine_access_overrides_active
    ON machine_access_overrides(community_id, surface, created_at DESC)
    WHERE revoked_at IS NULL;
