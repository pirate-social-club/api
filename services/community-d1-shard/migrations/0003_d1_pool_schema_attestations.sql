-- Bounded, generation-bound schema verdicts produced by the authoritative
-- full-fleet verifier. Releases do not read this table yet: the REST scan stays
-- authoritative until the publisher and aggregate-reader phases are reviewed.
--
-- Pool identity is part of the primary key because each shard Worker owns an
-- independent D1_POOL. community_id + pool_version bind a verdict to one exact
-- allocation generation; the publisher's write is additionally fenced against
-- the current d1_pool row so a release/reallocation race cannot bless a new
-- tenant with an old tenant's observation.

CREATE TABLE d1_pool_schema_attestations (
  shard_worker_id TEXT NOT NULL,
  binding_name TEXT NOT NULL,
  community_id TEXT NOT NULL,
  pool_version INTEGER NOT NULL,
  attestation_epoch TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('invalid', 'verified')),
  verdict_status TEXT NOT NULL CHECK (verdict_status IN (
    'satisfied',
    'missing_migration',
    'ledger_missing_artifacts_present',
    'ledger_present_artifacts_missing',
    'partial_artifacts',
    'checksum_mismatch',
    'canonical_schema_missing',
    'canonical_schema_regression',
    'schema_not_ready',
    'missing_from_config',
    'error'
  )),
  effective_policy_digest TEXT NOT NULL
    CHECK (length(effective_policy_digest) = 64 AND effective_policy_digest NOT GLOB '*[^0-9a-f]*'),
  schema_fingerprint TEXT NOT NULL
    CHECK (length(schema_fingerprint) = 64 AND schema_fingerprint NOT GLOB '*[^0-9a-f]*'),
  migration_ledger_digest TEXT NOT NULL
    CHECK (length(migration_ledger_digest) = 64 AND migration_ledger_digest NOT GLOB '*[^0-9a-f]*'),
  canonical_inventory_digest TEXT NOT NULL
    CHECK (length(canonical_inventory_digest) = 64 AND canonical_inventory_digest NOT GLOB '*[^0-9a-f]*'),
  verified_at TEXT,
  writer_kind TEXT NOT NULL CHECK (writer_kind = 'full_scan'),
  writer_run_id TEXT NOT NULL,
  last_error_code TEXT,
  last_error_detail TEXT CHECK (length(last_error_detail) <= 2000),
  PRIMARY KEY (shard_worker_id, binding_name),
  FOREIGN KEY (binding_name) REFERENCES d1_pool(binding_name) ON DELETE CASCADE,
  CHECK (
    (state = 'verified' AND verified_at IS NOT NULL AND last_error_code IS NULL)
    OR (state = 'invalid' AND verified_at IS NULL)
  )
);

CREATE INDEX idx_d1_pool_schema_attestations_policy
  ON d1_pool_schema_attestations(shard_worker_id, effective_policy_digest, state);
