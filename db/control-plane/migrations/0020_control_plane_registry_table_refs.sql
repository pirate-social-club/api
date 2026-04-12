CREATE TABLE community_registry_table_refs (
    community_id TEXT PRIMARY KEY,
    tableland_chain_id INTEGER NOT NULL,
    attempts_table_name TEXT NOT NULL,
    club_registry_table_name TEXT,
    club_namespace_table_name TEXT,
    publisher_kind TEXT NOT NULL CHECK (
        publisher_kind IN ('direct_key')
    ),
    last_published_snapshot_hash TEXT,
    last_publish_attempted_at TEXT,
    last_publish_succeeded_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE INDEX idx_community_registry_table_refs_registry_table
    ON community_registry_table_refs(club_registry_table_name)
    WHERE club_registry_table_name IS NOT NULL;

CREATE INDEX idx_community_registry_table_refs_namespace_table
    ON community_registry_table_refs(club_namespace_table_name)
    WHERE club_namespace_table_name IS NOT NULL;
