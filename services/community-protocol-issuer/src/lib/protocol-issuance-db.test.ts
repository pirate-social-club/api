import { describe, expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createProtocolIssuanceStore, type ProtocolIssuanceSqlClient } from "./protocol-issuance-db.js";

async function createTestClient(): Promise<ProtocolIssuanceSqlClient & { close(): void }> {
  const client = createClient({ url: `file:/tmp/community-protocol-issuer-${crypto.randomUUID()}.db` });
  await client.batch([
    `CREATE TABLE community_handle_protocol_issuances (
      community_handle_protocol_issuance_id TEXT PRIMARY KEY,
      community_handle_id TEXT NOT NULL,
      protocol_issuance_batch_id TEXT,
      community_id TEXT NOT NULL,
      namespace_id TEXT NOT NULL,
      public_status TEXT NOT NULL CHECK (public_status IN ('issuing', 'issued', 'failed')),
      parent_space TEXT NOT NULL,
      sname TEXT NOT NULL,
      script_pubkey_hex TEXT NOT NULL,
      cert_ref TEXT,
      certificate_payload_ref TEXT,
      error_code TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      issued_at TEXT
    )`,
    `CREATE TABLE protocol_issuance_batches (
      protocol_issuance_batch_id TEXT PRIMARY KEY,
      community_id TEXT NOT NULL,
      namespace_id TEXT NOT NULL,
      parent_space TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('open', 'processing', 'published', 'failed')),
      worker_checkpoint TEXT NOT NULL CHECK (
        worker_checkpoint IN (
          'pending_stage',
          'staged',
          'batched',
          'committed',
          'proving_submitted',
          'proving_complete',
          'broadcast',
          'confirming',
          'published',
          'failed'
        )
      ),
      subsd_root_before TEXT,
      subsd_root_after TEXT,
      proof_required INTEGER NOT NULL DEFAULT 0 CHECK (proof_required IN (0, 1)),
      runpod_job_id TEXT,
      runpod_status TEXT,
      proof_input_ref TEXT,
      proof_receipt_ref TEXT,
      proof_jobs_submitted INTEGER NOT NULL DEFAULT 0 CHECK (proof_jobs_submitted >= 0),
      bitcoin_txid TEXT,
      bitcoin_commit_ref TEXT,
      fabric_submission_ref TEXT,
      error_code TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      committed_at TEXT,
      proving_submitted_at TEXT,
      proving_completed_at TEXT,
      broadcast_at TEXT,
      published_at TEXT
    )`,
  ]);
  return client as unknown as ProtocolIssuanceSqlClient & { close(): void };
}

async function createMigrationBackedTestClient(): Promise<ProtocolIssuanceSqlClient & { close(): void }> {
  const client = createClient({ url: `file:/tmp/community-protocol-issuer-migration-${crypto.randomUUID()}.db` });
  await client.batch([
    `CREATE TABLE communities (community_id TEXT PRIMARY KEY)`,
    `CREATE TABLE namespace_bindings (namespace_id TEXT PRIMARY KEY)`,
    `CREATE TABLE community_handles (community_handle_id TEXT PRIMARY KEY)`,
  ]);
  const migration = readFileSync(resolve(
    import.meta.dir,
    "../../../api/test-fixtures/db/community-template/migrations/1072_community_handle_protocol_issuance.sql",
  ), "utf8");
  const counterMigration = readFileSync(resolve(
    import.meta.dir,
    "../../../api/test-fixtures/db/community-template/migrations/1074_protocol_issuance_proof_job_count.sql",
  ), "utf8");
  const statements = `${migration}\n${counterMigration}`
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
  await client.batch(statements);
  return client as unknown as ProtocolIssuanceSqlClient & { close(): void };
}

async function insertIssuance(client: ProtocolIssuanceSqlClient, id: string, createdAt = "2026-05-09T00:00:00.000Z"): Promise<void> {
  await client.execute({
    sql: `
      INSERT INTO community_handle_protocol_issuances (
        community_handle_protocol_issuance_id,
        community_handle_id,
        protocol_issuance_batch_id,
        community_id,
        namespace_id,
        public_status,
        parent_space,
        sname,
        script_pubkey_hex,
        created_at,
        updated_at
      ) VALUES (
        ?1, ?2, NULL, 'cmt_test', 'ns_test', 'issuing', '@pesto', ?3, ?4, ?5, ?5
      )
    `,
    args: [
      id,
      `ch_${id}`,
      `${id}@pesto`,
      "5120a60869f0dbcf1dc659c9cecbaf8050135ea9e8cdc487053f1dc6880949dc684c",
      createdAt,
    ],
  });
}

describe("protocol issuance DB store", () => {
  test("real community migration has the schema required by the store", async () => {
    const client = await createMigrationBackedTestClient();
    try {
      const batchColumns = await client.execute({
        sql: `PRAGMA table_info(protocol_issuance_batches)`,
      });
      const issuanceColumns = await client.execute({
        sql: `PRAGMA table_info(community_handle_protocol_issuances)`,
      });
      expect(batchColumns.rows.map((row) => row.name)).toEqual([
        "protocol_issuance_batch_id",
        "community_id",
        "namespace_id",
        "parent_space",
        "status",
        "worker_checkpoint",
        "subsd_root_before",
        "subsd_root_after",
        "proof_required",
        "runpod_job_id",
        "runpod_status",
        "proof_input_ref",
        "proof_receipt_ref",
        "bitcoin_txid",
        "bitcoin_commit_ref",
        "fabric_submission_ref",
        "error_code",
        "error_message",
        "created_at",
        "updated_at",
        "committed_at",
        "proving_submitted_at",
        "proving_completed_at",
        "broadcast_at",
        "published_at",
        "proof_jobs_submitted",
      ]);
      expect(issuanceColumns.rows.map((row) => row.name)).toEqual([
        "community_handle_protocol_issuance_id",
        "community_handle_id",
        "protocol_issuance_batch_id",
        "community_id",
        "namespace_id",
        "public_status",
        "parent_space",
        "sname",
        "script_pubkey_hex",
        "cert_ref",
        "certificate_payload_ref",
        "error_code",
        "error_message",
        "created_at",
        "updated_at",
        "issued_at",
      ]);
    } finally {
      client.close();
    }
  });

  test("creates a batch with attached issuances atomically and lists it when ready", async () => {
    const client = await createTestClient();
    try {
      const store = createProtocolIssuanceStore(client);
      await insertIssuance(client, "one");
      await insertIssuance(client, "two");

      const batch = await store.createBatchWithIssuances({
        id: "pib_test",
        communityId: "cmt_test",
        namespaceId: "ns_test",
        parentSpace: "@pesto",
        issuanceIds: ["one", "two"],
        now: "2026-05-09T00:05:00.000Z",
      });
      expect(batch.id).toBe("pib_test");

      const ready = await store.listBatchesReadyToCommit({
        minBatchSize: 2,
        maxBatchSize: 50,
        maxBatchAgeSeconds: 1800,
        now: "2026-05-09T00:05:00.000Z",
      });
      expect(ready).toHaveLength(1);
      expect(ready[0]?.issuances.map((row) => row.id)).toEqual(["one", "two"]);
    } finally {
      client.close();
    }
  });

  test("does not return empty or oversized batches as ready", async () => {
    const client = await createTestClient();
    try {
      const store = createProtocolIssuanceStore(client);
      await insertIssuance(client, "one");
      await insertIssuance(client, "two");
      await insertIssuance(client, "three");
      await store.createBatchWithIssuances({
        id: "pib_oversized",
        communityId: "cmt_test",
        namespaceId: "ns_test",
        parentSpace: "@pesto",
        issuanceIds: ["one", "two", "three"],
        now: "2026-05-09T00:00:00.000Z",
      });
      await client.execute({
        sql: `
          INSERT INTO protocol_issuance_batches (
            protocol_issuance_batch_id, community_id, namespace_id, parent_space, status,
            worker_checkpoint, proof_required, created_at, updated_at
          ) VALUES (
            'pib_empty', 'cmt_test', 'ns_test', '@pesto', 'open',
            'staged', 0, '2026-05-09T00:00:00.000Z', '2026-05-09T00:00:00.000Z'
          )
        `,
      });

      const ready = await store.listBatchesReadyToCommit({
        minBatchSize: 1,
        maxBatchSize: 2,
        maxBatchAgeSeconds: 1,
        now: "2026-05-09T00:05:00.000Z",
      });
      expect(ready).toEqual([]);
    } finally {
      client.close();
    }
  });

  test("marks broadcast, issuance, and published state", async () => {
    const client = await createTestClient();
    try {
      const store = createProtocolIssuanceStore(client);
      await insertIssuance(client, "one");
      await store.createBatchWithIssuances({
        id: "pib_publish",
        communityId: "cmt_test",
        namespaceId: "ns_test",
        parentSpace: "@pesto",
        issuanceIds: ["one"],
        now: "2026-05-09T00:00:00.000Z",
      });
      await store.markBatchCommitted({
        batchId: "pib_publish",
        rootBefore: "before",
        rootAfter: "after",
        proofRequired: false,
        now: "2026-05-09T00:01:00.000Z",
      });
      await store.markBatchBroadcast({
        batchId: "pib_publish",
        bitcoinTxid: "tx-test",
        bitcoinCommitRef: "commit-test",
        now: "2026-05-09T00:02:00.000Z",
      });
      const confirming = await store.listBatchesByCheckpoint({ checkpoint: "confirming", limit: 10 });
      expect(confirming).toHaveLength(1);
      expect(confirming[0]?.issuances.map((row) => row.id)).toEqual(["one"]);

      await store.markIssuancesIssued({
        issuances: [{
          issuanceId: "one",
          certificatePayloadRef: "cert:one@pesto",
        }],
        now: "2026-05-09T00:03:00.000Z",
      });
      await store.markBatchPublished({
        batchId: "pib_publish",
        fabricSubmissionRef: "fabric-test",
        now: "2026-05-09T00:03:00.000Z",
      });

      const batchRows = await client.execute({
        sql: `SELECT status, worker_checkpoint, fabric_submission_ref FROM protocol_issuance_batches WHERE protocol_issuance_batch_id = 'pib_publish'`,
      });
      expect(batchRows.rows[0]).toMatchObject({
        status: "published",
        worker_checkpoint: "published",
        fabric_submission_ref: "fabric-test",
      });
      const issuanceRows = await client.execute({
        sql: `SELECT public_status, certificate_payload_ref, issued_at FROM community_handle_protocol_issuances WHERE community_handle_protocol_issuance_id = 'one'`,
      });
      expect(issuanceRows.rows[0]).toMatchObject({
        public_status: "issued",
        certificate_payload_ref: "cert:one@pesto",
        issued_at: "2026-05-09T00:03:00.000Z",
      });
    } finally {
      client.close();
    }
  });

  test("records retryable batch errors without changing checkpoint", async () => {
    const client = await createTestClient();
    try {
      const store = createProtocolIssuanceStore(client);
      await insertIssuance(client, "one");
      await store.createBatchWithIssuances({
        id: "pib_retryable",
        communityId: "cmt_test",
        namespaceId: "ns_test",
        parentSpace: "@pesto",
        issuanceIds: ["one"],
        now: "2026-05-09T00:00:00.000Z",
      });
      await store.markBatchCommitted({
        batchId: "pib_retryable",
        rootBefore: null,
        rootAfter: "after",
        proofRequired: false,
        now: "2026-05-09T00:01:00.000Z",
      });
      await store.recordBatchRetryableError({
        batchId: "pib_retryable",
        errorCode: "subsd_broadcast_failed",
        errorMessage: "fee too low",
        now: "2026-05-09T00:02:00.000Z",
      });

      const rows = await client.execute({
        sql: `SELECT status, worker_checkpoint, error_code, error_message FROM protocol_issuance_batches WHERE protocol_issuance_batch_id = 'pib_retryable'`,
      });
      expect(rows.rows[0]).toMatchObject({
        status: "processing",
        worker_checkpoint: "committed",
        error_code: "subsd_broadcast_failed",
        error_message: "fee too low",
      });
    } finally {
      client.close();
    }
  });

  test("marks terminal batch failures on the linked issuance rows", async () => {
    const client = await createTestClient();
    try {
      const store = createProtocolIssuanceStore(client);
      await insertIssuance(client, "one");
      await store.createBatchWithIssuances({
        id: "pib_failed",
        communityId: "cmt_test",
        namespaceId: "ns_test",
        parentSpace: "@pesto",
        issuanceIds: ["one"],
        now: "2026-05-09T00:00:00.000Z",
      });
      await store.markBatchFailed({
        batchId: "pib_failed",
        errorCode: "proof_job_failed",
        errorMessage: "worker crashed",
        now: "2026-05-09T00:02:00.000Z",
      });

      const batchRows = await client.execute({
        sql: `SELECT status, worker_checkpoint, error_code FROM protocol_issuance_batches WHERE protocol_issuance_batch_id = 'pib_failed'`,
      });
      expect(batchRows.rows[0]).toMatchObject({
        status: "failed",
        worker_checkpoint: "failed",
        error_code: "proof_job_failed",
      });
      const issuanceRows = await client.execute({
        sql: `SELECT public_status, error_code, error_message FROM community_handle_protocol_issuances WHERE community_handle_protocol_issuance_id = 'one'`,
      });
      expect(issuanceRows.rows[0]).toMatchObject({
        public_status: "failed",
        error_code: "proof_job_failed",
        error_message: "worker crashed",
      });
    } finally {
      client.close();
    }
  });

  test("marks proving submission and completion checkpoints", async () => {
    const client = await createTestClient();
    try {
      const store = createProtocolIssuanceStore(client);
      await insertIssuance(client, "one");
      await store.createBatchWithIssuances({
        id: "pib_proof",
        communityId: "cmt_test",
        namespaceId: "ns_test",
        parentSpace: "@pesto",
        issuanceIds: ["one"],
        now: "2026-05-09T00:00:00.000Z",
      });
      await store.markBatchCommitted({
        batchId: "pib_proof",
        rootBefore: "before",
        rootAfter: "after",
        proofRequired: true,
        now: "2026-05-09T00:01:00.000Z",
      });
      await store.markBatchProvingSubmitted({
        batchId: "pib_proof",
        runpodJobId: "rp_job",
        runpodStatus: "IN_QUEUE",
        proofInputRef: "proof-input-ref",
        now: "2026-05-09T00:02:00.000Z",
      });
      await store.markBatchProvingSubmitted({
        batchId: "pib_proof",
        runpodJobId: "rp_job_next",
        runpodStatus: "IN_QUEUE",
        proofInputRef: "proof-input-ref-next",
        proofReceiptRef: "proof-receipt-ref-first",
        now: "2026-05-09T00:02:30.000Z",
      });
      await store.markBatchProvingComplete({
        batchId: "pib_proof",
        runpodStatus: "COMPLETED",
        proofReceiptRef: "proof-receipt-ref",
        now: "2026-05-09T00:03:00.000Z",
      });

      const rows = await client.execute({
        sql: `
          SELECT worker_checkpoint, runpod_job_id, runpod_status, proof_input_ref, proof_receipt_ref, proof_jobs_submitted
          FROM protocol_issuance_batches
          WHERE protocol_issuance_batch_id = 'pib_proof'
        `,
      });
      expect(rows.rows[0]).toMatchObject({
        worker_checkpoint: "proving_complete",
        runpod_job_id: "rp_job_next",
        runpod_status: "COMPLETED",
        proof_input_ref: "proof-input-ref-next",
        proof_receipt_ref: "proof-receipt-ref",
        proof_jobs_submitted: 2,
      });
    } finally {
      client.close();
    }
  });
});
