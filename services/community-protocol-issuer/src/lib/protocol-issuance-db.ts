import type {
  BatchWithIssuances,
  CreateBatchWithIssuancesInput,
  MarkBatchCommittedInput,
  MarkBatchBroadcastInput,
  MarkBatchFailedInput,
  MarkBatchPublishedInput,
  MarkBatchProvingCompleteInput,
  MarkBatchProvingSubmittedInput,
  PendingProtocolIssuance,
  ProtocolIssuanceBatch,
  ProtocolIssuanceStore,
} from "./types.js";

type Row = Record<string, unknown>;

type ExecuteResult = {
  rows: Row[];
};

type ExecuteStatement = {
  sql: string;
  args?: unknown[];
};

export type ProtocolIssuanceSqlTransaction = {
  execute(statement: ExecuteStatement): Promise<ExecuteResult>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  close(): void;
};

export type ProtocolIssuanceSqlClient = {
  execute(statement: ExecuteStatement): Promise<ExecuteResult>;
  transaction(mode: "write"): Promise<ProtocolIssuanceSqlTransaction>;
};

function stringValue(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`Expected string column ${key}`);
  }
  return value;
}

function nullableStringValue(row: Row, key: string): string | null {
  const value = row[key];
  return typeof value === "string" ? value : null;
}

function booleanValue(row: Row, key: string): boolean {
  const value = row[key];
  return value === true || value === 1;
}

function enumValue<T extends string>(row: Row, key: string, allowed: readonly T[]): T {
  const value = stringValue(row, key);
  if (!allowed.includes(value as T)) {
    throw new Error(`Unexpected ${key}: ${value}`);
  }
  return value as T;
}

function mapPendingIssuance(row: Row): PendingProtocolIssuance {
  return {
    id: stringValue(row, "community_handle_protocol_issuance_id"),
    communityHandleId: stringValue(row, "community_handle_id"),
    communityId: stringValue(row, "community_id"),
    namespaceId: stringValue(row, "namespace_id"),
    publicStatus: enumValue(row, "public_status", ["issuing", "issued", "failed"] as const),
    parentSpace: stringValue(row, "parent_space"),
    sname: stringValue(row, "sname"),
    scriptPubkeyHex: stringValue(row, "script_pubkey_hex"),
    createdAt: stringValue(row, "created_at"),
  };
}

function mapBatch(row: Row): ProtocolIssuanceBatch {
  return {
    id: stringValue(row, "protocol_issuance_batch_id"),
    communityId: stringValue(row, "community_id"),
    namespaceId: stringValue(row, "namespace_id"),
    parentSpace: stringValue(row, "parent_space"),
    status: enumValue(row, "status", ["open", "processing", "published", "failed"] as const),
    workerCheckpoint: enumValue(row, "worker_checkpoint", [
      "pending_stage",
      "staged",
      "batched",
      "committed",
      "proving_submitted",
      "proving_complete",
      "broadcast",
      "confirming",
      "published",
      "failed",
    ] as const),
    proofRequired: booleanValue(row, "proof_required"),
    subsdRootBefore: nullableStringValue(row, "subsd_root_before"),
    subsdRootAfter: nullableStringValue(row, "subsd_root_after"),
    runpodJobId: nullableStringValue(row, "runpod_job_id"),
    runpodStatus: nullableStringValue(row, "runpod_status"),
    proofInputRef: nullableStringValue(row, "proof_input_ref"),
    proofReceiptRef: nullableStringValue(row, "proof_receipt_ref"),
    errorCode: nullableStringValue(row, "error_code"),
    errorMessage: nullableStringValue(row, "error_message"),
    createdAt: stringValue(row, "created_at"),
    updatedAt: stringValue(row, "updated_at"),
    provingSubmittedAt: nullableStringValue(row, "proving_submitted_at"),
  };
}

async function listBatchIssuances(client: ProtocolIssuanceSqlClient, batchId: string): Promise<PendingProtocolIssuance[]> {
  const result = await client.execute({
    sql: `
      SELECT *
      FROM community_handle_protocol_issuances
      WHERE protocol_issuance_batch_id = ?1
      ORDER BY created_at ASC
    `,
    args: [batchId],
  });
  return result.rows.map(mapPendingIssuance);
}

export function createProtocolIssuanceStore(client: ProtocolIssuanceSqlClient): ProtocolIssuanceStore {
  return {
    async listUnbatchedIssuances(limit) {
      const result = await client.execute({
        sql: `
          SELECT *
          FROM community_handle_protocol_issuances
          WHERE public_status = 'issuing'
            AND protocol_issuance_batch_id IS NULL
          ORDER BY created_at ASC
          LIMIT ?1
        `,
        args: [limit],
      });
      return result.rows.map(mapPendingIssuance);
    },

    async createBatchWithIssuances(input: CreateBatchWithIssuancesInput) {
      if (input.issuanceIds.length === 0) {
        throw new Error("Cannot create a protocol issuance batch without issuances");
      }
      const tx = await client.transaction("write");
      try {
        await tx.execute({
          sql: `
            INSERT INTO protocol_issuance_batches (
              protocol_issuance_batch_id, community_id, namespace_id, parent_space, status,
              worker_checkpoint, proof_required, created_at, updated_at
            ) VALUES (
              ?1, ?2, ?3, ?4, 'open',
              'staged', 0, ?5, ?5
            )
          `,
          args: [input.id, input.communityId, input.namespaceId, input.parentSpace, input.now],
        });
        for (const issuanceId of input.issuanceIds) {
          await tx.execute({
            sql: `
              UPDATE community_handle_protocol_issuances
              SET protocol_issuance_batch_id = ?2,
                  updated_at = ?3
              WHERE community_handle_protocol_issuance_id = ?1
                AND protocol_issuance_batch_id IS NULL
                AND public_status = 'issuing'
            `,
            args: [issuanceId, input.id, input.now],
          });
        }
        await tx.commit();
      } catch (error) {
        await tx.rollback().catch(() => undefined);
        throw error;
      } finally {
        tx.close();
      }
      const result = await client.execute({
        sql: `SELECT * FROM protocol_issuance_batches WHERE protocol_issuance_batch_id = ?1 LIMIT 1`,
        args: [input.id],
      });
      const row = result.rows[0];
      if (!row) {
        throw new Error("Created protocol issuance batch row is missing");
      }
      return mapBatch(row);
    },

    async markIssuancesFailed(input) {
      if (input.issuanceIds.length === 0) {
        return;
      }
      const tx = await client.transaction("write");
      try {
        for (const issuanceId of input.issuanceIds) {
          await tx.execute({
            sql: `
              UPDATE community_handle_protocol_issuances
              SET public_status = 'failed',
                  error_code = ?2,
                  error_message = ?3,
                  updated_at = ?4
              WHERE community_handle_protocol_issuance_id = ?1
                AND public_status = 'issuing'
                AND protocol_issuance_batch_id IS NULL
            `,
            args: [issuanceId, input.errorCode, input.errorMessage, input.now],
          });
        }
        await tx.commit();
      } catch (error) {
        await tx.rollback().catch(() => undefined);
        throw error;
      } finally {
        tx.close();
      }
    },

    async listBatchesReadyToCommit(input) {
      const result = await client.execute({
        sql: `
          SELECT b.*, COUNT(i.community_handle_protocol_issuance_id) AS issuance_count
          FROM protocol_issuance_batches b
          JOIN community_handle_protocol_issuances i
            ON i.protocol_issuance_batch_id = b.protocol_issuance_batch_id
          WHERE b.status = 'open'
            AND b.worker_checkpoint = 'staged'
          GROUP BY b.protocol_issuance_batch_id
          HAVING issuance_count > 0
             AND issuance_count <= ?2
             AND (
               issuance_count >= ?1
               OR b.created_at <= ?3
             )
          ORDER BY b.created_at ASC
        `,
        args: [
          input.minBatchSize,
          input.maxBatchSize,
          new Date(Date.parse(input.now) - input.maxBatchAgeSeconds * 1000).toISOString(),
        ],
      });
      const batches = result.rows.map(mapBatch);
      return Promise.all(batches.map(async (batch): Promise<BatchWithIssuances> => ({
        batch,
        issuances: await listBatchIssuances(client, batch.id),
      })));
    },

    async listBatchesByCheckpoint(input) {
      const result = await client.execute({
        sql: `
          SELECT *
          FROM protocol_issuance_batches
          WHERE status = 'processing'
            AND worker_checkpoint = ?1
          ORDER BY updated_at ASC
          LIMIT ?2
        `,
        args: [input.checkpoint, input.limit],
      });
      const batches = result.rows.map(mapBatch);
      return Promise.all(batches.map(async (batch): Promise<BatchWithIssuances> => ({
        batch,
        issuances: await listBatchIssuances(client, batch.id),
      })));
    },

    async markBatchCommitted(input: MarkBatchCommittedInput) {
      await client.execute({
        sql: `
          UPDATE protocol_issuance_batches
          SET status = 'processing',
              worker_checkpoint = 'committed',
              subsd_root_before = ?2,
              subsd_root_after = ?3,
              proof_required = ?4,
              error_code = NULL,
              error_message = NULL,
              committed_at = ?5,
              updated_at = ?5
          WHERE protocol_issuance_batch_id = ?1
        `,
        args: [
          input.batchId,
          input.rootBefore,
          input.rootAfter,
          input.proofRequired ? 1 : 0,
          input.now,
        ],
      });
    },

    async markBatchProvingSubmitted(input: MarkBatchProvingSubmittedInput) {
      await client.execute({
        sql: `
          UPDATE protocol_issuance_batches
          SET worker_checkpoint = 'proving_submitted',
              runpod_job_id = ?2,
              runpod_status = ?3,
              proof_input_ref = ?4,
              proof_receipt_ref = COALESCE(?6, proof_receipt_ref),
              error_code = NULL,
              error_message = NULL,
              proving_submitted_at = ?5,
              updated_at = ?5
          WHERE protocol_issuance_batch_id = ?1
            AND status = 'processing'
            AND worker_checkpoint IN ('committed', 'proving_submitted')
            AND proof_required = 1
        `,
        args: [
          input.batchId,
          input.runpodJobId,
          input.runpodStatus,
          input.proofInputRef,
          input.now,
          input.proofReceiptRef ?? null,
        ],
      });
    },

    async markBatchProvingComplete(input: MarkBatchProvingCompleteInput) {
      await client.execute({
        sql: `
          UPDATE protocol_issuance_batches
          SET worker_checkpoint = 'proving_complete',
              runpod_status = ?2,
              proof_receipt_ref = ?3,
              error_code = NULL,
              error_message = NULL,
              proving_completed_at = ?4,
              updated_at = ?4
          WHERE protocol_issuance_batch_id = ?1
            AND status = 'processing'
            AND worker_checkpoint = 'proving_submitted'
            AND proof_required = 1
        `,
        args: [input.batchId, input.runpodStatus, input.proofReceiptRef, input.now],
      });
    },

    async markBatchBroadcast(input: MarkBatchBroadcastInput) {
      await client.execute({
        sql: `
          UPDATE protocol_issuance_batches
          SET worker_checkpoint = 'confirming',
              bitcoin_txid = ?2,
              bitcoin_commit_ref = ?3,
              error_code = NULL,
              error_message = NULL,
              broadcast_at = ?4,
              updated_at = ?4
          WHERE protocol_issuance_batch_id = ?1
            AND status = 'processing'
            AND worker_checkpoint IN ('committed', 'proving_complete')
        `,
        args: [input.batchId, input.bitcoinTxid, input.bitcoinCommitRef, input.now],
      });
    },

    async markBatchPublished(input: MarkBatchPublishedInput) {
      await client.execute({
        sql: `
          UPDATE protocol_issuance_batches
          SET status = 'published',
              worker_checkpoint = 'published',
              fabric_submission_ref = ?2,
              error_code = NULL,
              error_message = NULL,
              published_at = ?3,
              updated_at = ?3
          WHERE protocol_issuance_batch_id = ?1
            AND status = 'processing'
            AND worker_checkpoint = 'confirming'
        `,
        args: [input.batchId, input.fabricSubmissionRef, input.now],
      });
    },

    async markIssuancesIssued(input) {
      if (input.issuances.length === 0) {
        return;
      }
      const tx = await client.transaction("write");
      try {
        for (const issuance of input.issuances) {
          await tx.execute({
            sql: `
              UPDATE community_handle_protocol_issuances
              SET public_status = 'issued',
                  certificate_payload_ref = ?2,
                  issued_at = ?3,
                  updated_at = ?3
              WHERE community_handle_protocol_issuance_id = ?1
                AND public_status = 'issuing'
            `,
            args: [issuance.issuanceId, issuance.certificatePayloadRef, input.now],
          });
        }
        await tx.commit();
      } catch (error) {
        await tx.rollback().catch(() => undefined);
        throw error;
      } finally {
        tx.close();
      }
    },

    async recordBatchRetryableError(input: MarkBatchFailedInput) {
      await client.execute({
        sql: `
          UPDATE protocol_issuance_batches
          SET error_code = ?2,
              error_message = ?3,
              updated_at = ?4
          WHERE protocol_issuance_batch_id = ?1
        `,
        args: [input.batchId, input.errorCode, input.errorMessage, input.now],
      });
    },

    async markBatchFailed(input: MarkBatchFailedInput) {
      const tx = await client.transaction("write");
      try {
        await tx.execute({
          sql: `
            UPDATE protocol_issuance_batches
            SET status = 'failed',
                worker_checkpoint = 'failed',
                error_code = ?2,
                error_message = ?3,
                updated_at = ?4
            WHERE protocol_issuance_batch_id = ?1
          `,
          args: [input.batchId, input.errorCode, input.errorMessage, input.now],
        });
        await tx.execute({
          sql: `
            UPDATE community_handle_protocol_issuances
            SET public_status = 'failed',
                error_code = ?2,
                error_message = ?3,
                updated_at = ?4
            WHERE protocol_issuance_batch_id = ?1
              AND public_status = 'issuing'
          `,
          args: [input.batchId, input.errorCode, input.errorMessage, input.now],
        });
        await tx.commit();
      } catch (error) {
        await tx.rollback().catch(() => undefined);
        throw error;
      } finally {
        tx.close();
      }
    },
  };
}
