ALTER TABLE communities
    ADD COLUMN registry_last_mutation_published_at TIMESTAMPTZ;

CREATE TABLE community_registry_mutation_attempts (
    registry_mutation_attempt_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    mutation_kind TEXT NOT NULL CHECK (
        mutation_kind IN (
            'profile',
            'rules',
            'resource_links',
            'reference_links',
            'governance',
            'donation_public',
            'handle_policy_summary',
            'livestream_public'
        )
    ),
    publisher_attempt_id TEXT NOT NULL,
    actor_user_id TEXT NOT NULL,
    actor_primary_wallet_snapshot TEXT,
    actor_governance_address_snapshot TEXT,
    attempt_status TEXT NOT NULL CHECK (
        attempt_status IN ('in_progress', 'succeeded', 'failed')
    ),
    failure_code TEXT,
    attempts_table_name TEXT,
    dataset_table_name TEXT,
    secondary_table_name TEXT,
    snapshot_hash TEXT NOT NULL,
    published_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (actor_user_id) REFERENCES users(user_id)
);

CREATE UNIQUE INDEX idx_community_registry_mutation_attempts_publisher_attempt
    ON community_registry_mutation_attempts(publisher_attempt_id);

CREATE INDEX idx_community_registry_mutation_attempts_current
    ON community_registry_mutation_attempts(community_id, mutation_kind, published_at DESC)
    WHERE attempt_status = 'succeeded';

CREATE INDEX idx_community_registry_mutation_attempts_actor
    ON community_registry_mutation_attempts(actor_user_id, created_at DESC);

CREATE INDEX idx_community_registry_mutation_attempts_community
    ON community_registry_mutation_attempts(community_id, created_at DESC);
