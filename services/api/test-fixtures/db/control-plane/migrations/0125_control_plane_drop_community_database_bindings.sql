-- De-Turso follow-up: remove the legacy community database binding registry.
-- D1 routing is now structurally represented by community_database_routing:
-- shard_worker_id + binding_name + region are the authoritative directory.

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM community_database_routing
        WHERE provisioning_state IN ('ready', 'provisioning')
          AND (shard_worker_id IS NULL OR binding_name IS NULL OR region IS NULL)
    ) THEN
        RAISE EXCEPTION
            'Aborting binding-registry removal: ready/provisioning D1 routes without shard metadata remain';
    END IF;
END $$;

DO $$
BEGIN
    ALTER TABLE communities DROP CONSTRAINT IF EXISTS communities_primary_database_binding_id_fkey;
    ALTER TABLE communities DROP COLUMN IF EXISTS primary_database_binding_id;
END $$;

DROP TABLE IF EXISTS community_database_bindings;
