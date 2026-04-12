PRAGMA foreign_keys = ON;

DROP INDEX IF EXISTS idx_communities_namespace_verification;

CREATE UNIQUE INDEX idx_communities_namespace_verification_unique
    ON communities(namespace_verification_id)
    WHERE namespace_verification_id IS NOT NULL;
