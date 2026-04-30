PRAGMA foreign_keys = ON;

DROP TABLE IF EXISTS community_gate_rules;

CREATE TABLE community_gate_policies (
    community_id TEXT NOT NULL,
    scope TEXT NOT NULL CHECK (
        scope IN ('membership', 'viewer', 'posting')
    ),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version = 1),
    expression_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (community_id, scope),
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE INDEX idx_community_gate_policies_scope_updated
    ON community_gate_policies(scope, updated_at);
