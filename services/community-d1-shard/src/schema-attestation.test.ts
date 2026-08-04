import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import {
  BOOTSTRAP_STATE_TABLE_DDL,
  SCHEMA_ATTESTATION_INVENTORY_SQL,
  SCHEMA_ATTESTATION_MIGRATION_LEDGER_SQL,
  shardSchemaObservationProof,
  type ShardMigrationLedgerRow,
  type ShardSchemaInventoryRow,
  type ShardSchemaObservationProof,
} from "@pirate/api-shared"
import { publishProvisioningSchemaAttestation } from "./schema-attestation"
import type { ShardEnv } from "./shard-read"

const POLICY = "a".repeat(64)
const BINDING = "DB_CMTY_TEST"
const COMMUNITY = "cmt_test"

type Prepared = D1PreparedStatement & {
  _sql: string
  _args: unknown[]
}

function d1(db: Database, beforeBatch?: () => void): D1Database {
  const prepare = (sql: string): Prepared => {
    const statement = {
      _sql: sql,
      _args: [] as unknown[],
      bind(...args: unknown[]) {
        return Object.assign(prepare(sql), { _args: args })
      },
      async first() {
        return db.query(sql).get(...statement._args) as Record<string, unknown> | null
      },
      async all() {
        return {
          success: true,
          results: db.query(sql).all(...statement._args) as Record<string, unknown>[],
          meta: { changes: 0 },
        }
      },
      async run() {
        const result = db.query(sql).run(...statement._args)
        return {
          success: true,
          results: [],
          meta: { changes: result.changes },
        }
      },
      raw() {
        throw new Error("not implemented")
      },
    }
    return statement as Prepared
  }
  return {
    prepare,
    async batch(statements: D1PreparedStatement[]) {
      beforeBatch?.()
      return Promise.all(statements.map((statement) => (statement as Prepared).all()))
    },
    async exec(sql: string) {
      db.exec(sql)
      return { count: 0, duration: 0 }
    },
    withSession() {
      throw new Error("not implemented")
    },
    dump() {
      throw new Error("not implemented")
    },
  } as D1Database
}

function setup(beforeTargetBatch?: (pool: Database) => void) {
  const pool = new Database(":memory:")
  pool.exec(`
    CREATE TABLE d1_pool (
      binding_name TEXT PRIMARY KEY,
      community_id TEXT,
      last_loaded_at TEXT,
      last_error TEXT,
      version INTEGER NOT NULL
    );
    CREATE TABLE d1_pool_schema_attestations (
      shard_worker_id TEXT NOT NULL,
      binding_name TEXT NOT NULL,
      community_id TEXT NOT NULL,
      pool_version INTEGER NOT NULL,
      attestation_epoch TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('invalid', 'verified')),
      verdict_status TEXT NOT NULL,
      effective_policy_digest TEXT NOT NULL,
      schema_fingerprint TEXT NOT NULL,
      migration_ledger_digest TEXT NOT NULL,
      canonical_inventory_digest TEXT NOT NULL,
      verified_at TEXT,
      writer_kind TEXT NOT NULL CHECK (writer_kind IN ('full_scan', 'provisioner', 'migration')),
      writer_run_id TEXT NOT NULL,
      last_error_code TEXT,
      last_error_detail TEXT,
      PRIMARY KEY (shard_worker_id, binding_name)
    );
    INSERT INTO d1_pool VALUES ('${BINDING}', '${COMMUNITY}', '2026-08-04T00:00:00Z', NULL, 3);
  `)
  const target = new Database(":memory:")
  target.exec(`
    CREATE TABLE schema_migrations (
      migration_name TEXT PRIMARY KEY,
      migration_label TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE things (thing_id TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO schema_migrations (migration_name, migration_label, checksum)
      VALUES ('0001.sql', 'community-template', '${"b".repeat(64)}');
    ${BOOTSTRAP_STATE_TABLE_DDL};
  `)
  const env: ShardEnv = {
    COMMUNITY_D1_SHARD_WORKER_ID: "shard-staging",
    D1_POOL: d1(pool),
    [BINDING]: d1(target, () => beforeTargetBatch?.(pool)),
  }
  return { pool, target, env }
}

async function expectedProof(target: Database): Promise<ShardSchemaObservationProof> {
  return shardSchemaObservationProof({
    schemaRows: target.query<ShardSchemaInventoryRow, []>(SCHEMA_ATTESTATION_INVENTORY_SQL).all(),
    migrationLedgerRows: target.query<ShardMigrationLedgerRow, []>(SCHEMA_ATTESTATION_MIGRATION_LEDGER_SQL).all(),
  })
}

describe("provisioning schema attestation", () => {
  test("publishes a raw-observed proof for the exact loaded generation", async () => {
    const { pool, target, env } = setup()
    try {
      const outcome = await publishProvisioningSchemaAttestation(env, {
        communityId: COMMUNITY,
        bindingName: BINDING,
        attestation: {
          effectivePolicyDigest: POLICY,
          expectedObservationProof: await expectedProof(target),
        },
      })
      expect(outcome).toEqual({ status: "published", poolVersion: 3 })
      expect(
        pool
          .query("SELECT state, writer_kind, effective_policy_digest, pool_version FROM d1_pool_schema_attestations")
          .get(),
      ).toEqual({
        state: "verified",
        writer_kind: "provisioner",
        effective_policy_digest: POLICY,
        pool_version: 3,
      })
    } finally {
      pool.close()
      target.close()
    }
  })

  test("does not overwrite an authoritative full scan in progress", async () => {
    const { pool, target, env } = setup()
    try {
      pool.exec(`INSERT INTO d1_pool_schema_attestations VALUES (
        'shard-staging', '${BINDING}', '${COMMUNITY}', 3, 'full-scan:1',
        'invalid', 'error', '${POLICY}', '${"c".repeat(64)}', '${"c".repeat(64)}', '${"c".repeat(64)}',
        NULL, 'full_scan', 'full-scan:1', 'error', 'authoritative full scan in progress'
      )`)
      const outcome = await publishProvisioningSchemaAttestation(env, {
        communityId: COMMUNITY,
        bindingName: BINDING,
        attestation: {
          effectivePolicyDigest: POLICY,
          expectedObservationProof: await expectedProof(target),
        },
      })
      expect(outcome).toEqual({
        status: "skipped",
        reason: "generation_changed_or_full_scan_in_progress",
      })
      expect(pool.query("SELECT writer_kind, writer_run_id FROM d1_pool_schema_attestations").get()).toEqual({
        writer_kind: "full_scan",
        writer_run_id: "full-scan:1",
      })
    } finally {
      pool.close()
      target.close()
    }
  })

  test("leaves an invalid row when the independently observed target mismatches", async () => {
    const { pool, target, env } = setup()
    try {
      const expected = await expectedProof(target)
      const outcome = await publishProvisioningSchemaAttestation(env, {
        communityId: COMMUNITY,
        bindingName: BINDING,
        attestation: {
          effectivePolicyDigest: POLICY,
          expectedObservationProof: {
            ...expected,
            schema_fingerprint: "0".repeat(64),
          },
        },
      })
      expect(outcome).toEqual({
        status: "skipped",
        reason: "raw_observation_mismatch",
      })
      expect(
        pool
          .query("SELECT state, writer_kind, last_error_code, last_error_detail FROM d1_pool_schema_attestations")
          .get(),
      ).toEqual({
        state: "invalid",
        writer_kind: "provisioner",
        last_error_code: "observation_mismatch",
        last_error_detail: "observed shard schema does not match the deployed snapshot proof",
      })
    } finally {
      pool.close()
      target.close()
    }
  })

  test("cannot publish after the allocation generation changes during observation", async () => {
    const { pool, target, env } = setup((poolDb) => {
      poolDb.exec("UPDATE d1_pool SET version = version + 1")
    })
    try {
      const outcome = await publishProvisioningSchemaAttestation(env, {
        communityId: COMMUNITY,
        bindingName: BINDING,
        attestation: {
          effectivePolicyDigest: POLICY,
          expectedObservationProof: await expectedProof(target),
        },
      })
      expect(outcome).toEqual({
        status: "skipped",
        reason: "generation_or_writer_epoch_changed",
      })
      expect(pool.query("SELECT state, pool_version FROM d1_pool_schema_attestations").get()).toEqual({
        state: "invalid",
        pool_version: 3,
      })
    } finally {
      pool.close()
      target.close()
    }
  })
})
