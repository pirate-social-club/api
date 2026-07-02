-- De-Turso: remove the deprecated Turso community-database backend from the
-- control plane. All communities have migrated to the D1 backend (prod + staging
-- verified zero `backend='turso'` routing rows before this migration). Turso rows
-- + credentials are preserved out-of-band as a cold backup before this runs.
--
-- KEEP `community_database_bindings` — the D1 provisioning path writes/reads it
-- (persistProvisionedD1Binding, communities.primary_database_binding_id). Only the
-- Turso-only credentials table + the routing table's Turso columns are removed.

-- Safety net: refuse to run if any Turso routing rows remain (should be zero).
-- Postgres-only DO block (skipped on the SQLite test mirror).
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM community_database_routing WHERE backend = 'turso') THEN
        RAISE EXCEPTION
            'Aborting de-Turso migration: % turso routing rows still present — reconcile them first',
            (SELECT count(*) FROM community_database_routing WHERE backend = 'turso');
    END IF;
END $$;

-- Turso-only encrypted-credentials table (dependent side of the FK to
-- community_database_bindings, which stays). SQLite mirror drops it too (unused).
DROP TABLE IF EXISTS community_db_credentials;

-- Drop the backend-predicated shard index (recreated below without the predicate).
DROP INDEX IF EXISTS idx_community_database_routing_shard;

-- Drop the Turso CHECK constraints + columns. Wrapped in a DO block (0058
-- convention): the SQLite test mirror skips DO blocks — it cannot DROP a named
-- CHECK constraint or a constrained column — so the mirror leaves these columns
-- in place (nullable there), which the API no longer reads or writes.
DO $$
BEGIN
    ALTER TABLE community_database_routing DROP CONSTRAINT IF EXISTS chk_d1_fields;
    ALTER TABLE community_database_routing DROP CONSTRAINT IF EXISTS chk_migrated_at;
    ALTER TABLE community_database_routing DROP COLUMN IF EXISTS turso_database_binding_id;
    ALTER TABLE community_database_routing DROP COLUMN IF EXISTS backend;
END $$;

-- Recreate the shard lookup index without the (now-removed) backend predicate.
-- Every remaining routing row is structurally a D1 shard binding.
CREATE INDEX idx_community_database_routing_shard
    ON community_database_routing(shard_worker_id)
    WHERE provisioning_state = 'ready';
