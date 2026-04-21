PRAGMA foreign_keys = ON;

ALTER TABLE communities
    ADD COLUMN registry_publication_state TEXT NOT NULL DEFAULT 'not_started' CHECK (
        registry_publication_state IN (
            'not_started',
            'pending_create',
            'pending_seed',
            'published',
            'stale',
            'publication_error'
        )
    );

ALTER TABLE communities
    ADD COLUMN registry_attempt_id TEXT;

ALTER TABLE communities
    ADD COLUMN registry_published_at TEXT;

ALTER TABLE communities
    ADD COLUMN registry_publication_job_id TEXT;

ALTER TABLE communities
    ADD COLUMN registry_error_code TEXT;

CREATE INDEX idx_communities_registry_publication_state
    ON communities(registry_publication_state, updated_at DESC);

CREATE INDEX idx_communities_registry_attempt
    ON communities(registry_attempt_id)
    WHERE registry_attempt_id IS NOT NULL;

CREATE TABLE community_registry_attempts (
    registry_attempt_id TEXT PRIMARY KEY,
    actor_user_id TEXT NOT NULL,
    actor_primary_wallet_snapshot TEXT,
    actor_governance_address_snapshot TEXT,
    namespace_verification_id TEXT NOT NULL,
    normalized_root_label TEXT NOT NULL,
    community_id TEXT,
    attempt_status TEXT NOT NULL CHECK (
        attempt_status IN ('in_progress', 'succeeded', 'failed')
    ),
    failure_code TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (actor_user_id) REFERENCES users(user_id),
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (namespace_verification_id) REFERENCES namespace_verifications(namespace_verification_id)
);

CREATE INDEX idx_community_registry_attempts_actor
    ON community_registry_attempts(actor_user_id, created_at DESC);

CREATE INDEX idx_community_registry_attempts_wallet
    ON community_registry_attempts(actor_primary_wallet_snapshot, created_at DESC)
    WHERE actor_primary_wallet_snapshot IS NOT NULL;

CREATE INDEX idx_community_registry_attempts_namespace
    ON community_registry_attempts(namespace_verification_id, created_at DESC);

CREATE INDEX idx_community_registry_attempts_community
    ON community_registry_attempts(community_id, created_at DESC)
    WHERE community_id IS NOT NULL;
