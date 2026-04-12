PRAGMA foreign_keys = OFF;

DROP INDEX IF EXISTS idx_community_registry_table_refs_registry_table;
DROP INDEX IF EXISTS idx_community_registry_table_refs_namespace_table;
DROP INDEX IF EXISTS idx_community_registry_attempts_actor;
DROP INDEX IF EXISTS idx_community_registry_attempts_wallet;
DROP INDEX IF EXISTS idx_community_registry_attempts_namespace;
DROP INDEX IF EXISTS idx_community_registry_attempts_community;
DROP INDEX IF EXISTS idx_communities_registry_publication_state;
DROP INDEX IF EXISTS idx_communities_registry_attempt;

DROP TABLE IF EXISTS community_registry_table_refs;
DROP TABLE IF EXISTS community_registry_attempts;

ALTER TABLE communities DROP COLUMN registry_error_code;
ALTER TABLE communities DROP COLUMN registry_publication_job_id;
ALTER TABLE communities DROP COLUMN registry_published_at;
ALTER TABLE communities DROP COLUMN registry_attempt_id;
ALTER TABLE communities DROP COLUMN registry_publication_state;

DELETE FROM jobs
WHERE job_type = 'community_registry_publication';

PRAGMA foreign_keys = ON;
