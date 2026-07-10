ALTER TABLE communities
  ADD COLUMN IF NOT EXISTS primary_database_binding_id TEXT;

ALTER TABLE community_database_routing
  ADD COLUMN IF NOT EXISTS backend TEXT NOT NULL DEFAULT 'd1';

ALTER TABLE community_database_routing
  ADD COLUMN IF NOT EXISTS turso_database_binding_id TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'community_database_routing_backend_check'
      AND conrelid = 'community_database_routing'::regclass
  ) THEN
    ALTER TABLE community_database_routing
      ADD CONSTRAINT community_database_routing_backend_check
      CHECK (backend IN ('d1', 'turso'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'community_database_routing_backend_shape_check'
      AND conrelid = 'community_database_routing'::regclass
  ) THEN
    ALTER TABLE community_database_routing
      ADD CONSTRAINT community_database_routing_backend_shape_check
      CHECK (
        (backend = 'd1' AND shard_worker_id IS NOT NULL AND binding_name IS NOT NULL)
        OR (backend = 'turso' AND turso_database_binding_id IS NOT NULL)
      );
  END IF;
END $$;
