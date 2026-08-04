import {
  SCHEMA_ATTESTATION_INVENTORY_SQL,
  SCHEMA_ATTESTATION_MIGRATION_LEDGER_SQL,
  isShardSchemaObservationProof,
  schemaAttestationDigest,
  shardSchemaObservationProof,
  type ShardLoadSnapshotRequest,
  type ShardMigrationLedgerRow,
  type ShardSchemaInventoryRow,
  type ShardSchemaObservationProof,
} from "@pirate/api-shared"
import { resolveD1, type ShardEnv } from "./shard-read"

type ProvisioningAttestationOutcome =
  { status: "published"; poolVersion: number } | { status: "skipped"; reason: string }

const INVALIDATE_PROVISIONING_ATTESTATION_SQL = `
INSERT INTO d1_pool_schema_attestations (
  shard_worker_id, binding_name, community_id, pool_version,
  attestation_epoch, state, verdict_status, effective_policy_digest,
  schema_fingerprint, migration_ledger_digest, canonical_inventory_digest,
  verified_at, writer_kind, writer_run_id, last_error_code, last_error_detail
)
SELECT ?1, p.binding_name, p.community_id, p.version,
       ?4, 'invalid', 'error', ?5,
       ?6, ?6, ?6,
       NULL, 'provisioner', ?4, 'error', 'provisioning schema observation in progress'
FROM d1_pool p
WHERE p.binding_name = ?2
  AND p.community_id = ?3
  AND p.last_loaded_at IS NOT NULL
  AND p.last_error IS NULL
ON CONFLICT(shard_worker_id, binding_name) DO UPDATE SET
  community_id = excluded.community_id,
  pool_version = excluded.pool_version,
  attestation_epoch = excluded.attestation_epoch,
  state = excluded.state,
  verdict_status = excluded.verdict_status,
  effective_policy_digest = excluded.effective_policy_digest,
  schema_fingerprint = excluded.schema_fingerprint,
  migration_ledger_digest = excluded.migration_ledger_digest,
  canonical_inventory_digest = excluded.canonical_inventory_digest,
  verified_at = excluded.verified_at,
  writer_kind = excluded.writer_kind,
  writer_run_id = excluded.writer_run_id,
  last_error_code = excluded.last_error_code,
  last_error_detail = excluded.last_error_detail
WHERE NOT (
  d1_pool_schema_attestations.writer_kind = 'full_scan'
  AND d1_pool_schema_attestations.state = 'invalid'
)
RETURNING community_id, pool_version
`

const PUBLISH_PROVISIONING_ATTESTATION_SQL = `
UPDATE d1_pool_schema_attestations
SET state = 'verified',
    verdict_status = 'satisfied',
    schema_fingerprint = ?6,
    migration_ledger_digest = ?7,
    canonical_inventory_digest = ?8,
    verified_at = ?9,
    last_error_code = NULL,
    last_error_detail = NULL
WHERE shard_worker_id = ?1
  AND binding_name = ?2
  AND community_id = ?3
  AND pool_version = ?4
  AND attestation_epoch = ?5
  AND writer_kind = 'provisioner'
  AND writer_run_id = ?5
  AND state = 'invalid'
  AND EXISTS (
    SELECT 1 FROM d1_pool p
    WHERE p.binding_name = ?2
      AND p.community_id = ?3
      AND p.version = ?4
      AND p.last_loaded_at IS NOT NULL
      AND p.last_error IS NULL
  )
RETURNING pool_version
`

const RECORD_PROVISIONING_ATTESTATION_FAILURE_SQL = `
UPDATE d1_pool_schema_attestations
SET schema_fingerprint = ?6,
    migration_ledger_digest = ?7,
    canonical_inventory_digest = ?8,
    last_error_code = ?9,
    last_error_detail = ?10
WHERE shard_worker_id = ?1
  AND binding_name = ?2
  AND community_id = ?3
  AND pool_version = ?4
  AND attestation_epoch = ?5
  AND writer_kind = 'provisioner'
  AND writer_run_id = ?5
  AND state = 'invalid'
`

function proofMatches(actual: ShardSchemaObservationProof, expected: ShardSchemaObservationProof): boolean {
  return (
    actual.format_version === expected.format_version &&
    actual.kind === expected.kind &&
    actual.schema_fingerprint === expected.schema_fingerprint &&
    actual.migration_ledger_digest === expected.migration_ledger_digest &&
    actual.canonical_inventory_digest === expected.canonical_inventory_digest
  )
}

function resultRows(result: D1Result | undefined): Record<string, unknown>[] {
  return Array.isArray(result?.results) ? (result.results as Record<string, unknown>[]) : []
}

/**
 * Observe and attest one newly loaded target without participating in the load
 * result. The WorkerEntrypoint schedules this with waitUntil and catches every
 * rejection, so no outcome here can fail community creation.
 */
export async function publishProvisioningSchemaAttestation(
  env: ShardEnv,
  input: Pick<ShardLoadSnapshotRequest, "communityId" | "bindingName" | "attestation">,
): Promise<ProvisioningAttestationOutcome> {
  const attestation = input.attestation
  if (!attestation) return { status: "skipped", reason: "attestation_not_configured" }
  if (!/^[0-9a-f]{64}$/u.test(attestation.effectivePolicyDigest)) {
    return { status: "skipped", reason: "invalid_policy_digest" }
  }
  if (!isShardSchemaObservationProof(attestation.expectedObservationProof)) {
    return { status: "skipped", reason: "invalid_expected_observation_proof" }
  }
  const pool = env.D1_POOL
  if (!pool) return { status: "skipped", reason: "pool_not_configured" }
  const target = resolveD1(env, input.bindingName)
  if (!("prepare" in target)) return { status: "skipped", reason: target.code }

  const shardWorkerId = String(env.COMMUNITY_D1_SHARD_WORKER_ID ?? "community-d1-shard-staging")
  const writerRunId = `provisioner:${crypto.randomUUID()}`
  const unavailableDigest = await schemaAttestationDigest({
    unavailable: "provisioning_schema_observation_in_progress",
  })
  const invalidated = await pool
    .prepare(INVALIDATE_PROVISIONING_ATTESTATION_SQL)
    .bind(
      shardWorkerId,
      input.bindingName,
      input.communityId,
      writerRunId,
      attestation.effectivePolicyDigest,
      unavailableDigest,
    )
    .all()
  const invalidatedRows = resultRows(invalidated)
  if (invalidatedRows.length !== 1) {
    return {
      status: "skipped",
      reason: "generation_changed_or_full_scan_in_progress",
    }
  }
  const poolVersion = Number(invalidatedRows[0]?.pool_version)
  if (!Number.isSafeInteger(poolVersion) || poolVersion < 0) {
    throw new Error("provisioning attestation invalidation returned an invalid pool generation")
  }

  const [schemaResult, ledgerResult] = await target.batch([
    target.prepare(SCHEMA_ATTESTATION_INVENTORY_SQL),
    target.prepare(SCHEMA_ATTESTATION_MIGRATION_LEDGER_SQL),
  ])
  if (!Array.isArray(schemaResult?.results) || !Array.isArray(ledgerResult?.results)) {
    throw new Error("provisioning schema observation returned malformed D1 results")
  }
  const actualProof = await shardSchemaObservationProof({
    schemaRows: schemaResult.results as ShardSchemaInventoryRow[],
    migrationLedgerRows: ledgerResult.results as ShardMigrationLedgerRow[],
  })
  if (!proofMatches(actualProof, attestation.expectedObservationProof)) {
    await pool
      .prepare(RECORD_PROVISIONING_ATTESTATION_FAILURE_SQL)
      .bind(
        shardWorkerId,
        input.bindingName,
        input.communityId,
        poolVersion,
        writerRunId,
        actualProof.schema_fingerprint,
        actualProof.migration_ledger_digest,
        actualProof.canonical_inventory_digest,
        "observation_mismatch",
        "observed shard schema does not match the deployed snapshot proof",
      )
      .run()
    return { status: "skipped", reason: "raw_observation_mismatch" }
  }

  const published = await pool
    .prepare(PUBLISH_PROVISIONING_ATTESTATION_SQL)
    .bind(
      shardWorkerId,
      input.bindingName,
      input.communityId,
      poolVersion,
      writerRunId,
      actualProof.schema_fingerprint,
      actualProof.migration_ledger_digest,
      actualProof.canonical_inventory_digest,
      new Date().toISOString(),
    )
    .all()
  if (resultRows(published).length !== 1) {
    return { status: "skipped", reason: "generation_or_writer_epoch_changed" }
  }
  return { status: "published", poolVersion }
}

export const PROVISIONING_ATTESTATION_INVALIDATE_SQL = INVALIDATE_PROVISIONING_ATTESTATION_SQL
export const PROVISIONING_ATTESTATION_PUBLISH_SQL = PUBLISH_PROVISIONING_ATTESTATION_SQL
