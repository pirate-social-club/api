DO $$
BEGIN
  ALTER TABLE users
    DROP COLUMN IF EXISTS nationality;

  ALTER TABLE communities
    DROP COLUMN IF EXISTS registry_publication_state,
    DROP COLUMN IF EXISTS registry_attempt_id,
    DROP COLUMN IF EXISTS registry_published_at,
    DROP COLUMN IF EXISTS registry_publication_job_id,
    DROP COLUMN IF EXISTS registry_error_code,
    DROP COLUMN IF EXISTS projected_member_count,
    DROP COLUMN IF EXISTS projected_qualified_member_count,
    DROP COLUMN IF EXISTS registry_last_mutation_published_at;
END $$;
