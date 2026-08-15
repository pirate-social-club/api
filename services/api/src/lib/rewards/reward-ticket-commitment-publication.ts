import { executeFirst } from "../db-helpers"
import { isPostgresControlPlaneUrl } from "../runtime-deps"
import { rowValue, stringOrNull } from "../sql-row"
import type { Client } from "../sql-client"
import { withTransaction } from "../transactions"

export type RewardTicketCommitmentPublicationResult = Readonly<{
  commitmentBatchId: string
  status: "published"
  publicationReference: string
  publicationTxHash: string | null
  publicationBlockNumber: string | null
  publishedAt: string
}>

function required(row: unknown, key: string): string {
  const value = stringOrNull(rowValue(row, key))
  if (!value) throw new Error(`reward ticket commitment row is missing ${key}`)
  return value
}

function nullable(row: unknown, key: string): string | null {
  return stringOrNull(rowValue(row, key))
}

function txHash(value: string | null | undefined): string | null {
  if (value == null || value === "") return null
  if (!/^0x[0-9a-fA-F]{64}$/u.test(value)) throw new Error("reward ticket publication transaction hash is invalid")
  return value
}

function blockNumber(value: string | number | bigint | null | undefined): string | null {
  if (value == null || value === "") return null
  const normalized = typeof value === "bigint" ? value.toString() : String(value)
  if (!/^(?:0|[1-9][0-9]*)$/u.test(normalized)) {
    throw new Error("reward ticket publication block number is invalid")
  }
  return normalized
}

/**
 * Record durable publication evidence for a frozen beneficiary commitment.
 * This is deliberately separate from the publication transport: callers may
 * publish to a public timestamp/beacon service, then atomically record the
 * evidence here. It performs no RPC, signing, or secret access.
 */
export async function publishRewardTicketCommitment(input: Readonly<{
  client: Client
  controlPlaneDatabaseUrl?: string
  commitmentBatchId: string
  publicationReference: string
  publicationTxHash?: string | null
  publicationBlockNumber?: string | number | bigint | null
  publishedAt: string
}>): Promise<RewardTicketCommitmentPublicationResult> {
  if (!input.commitmentBatchId.trim()) throw new Error("reward ticket commitment batch id is required")
  if (!input.publicationReference.trim()) throw new Error("reward ticket publication reference is required")
  if (!Number.isFinite(Date.parse(input.publishedAt))) throw new Error("reward ticket publication timestamp is invalid")
  const publicationTxHash = txHash(input.publicationTxHash)
  const publicationBlockNumber = blockNumber(input.publicationBlockNumber)
  const rowLocks = isPostgresControlPlaneUrl(String(input.controlPlaneDatabaseUrl ?? ""))

  return withTransaction(input.client, "write", async (tx) => {
    const row = await executeFirst(tx, {
      sql: `
        SELECT b.reward_ticket_beneficiary_commitment_batch_id, b.status,
          b.publication_reference, b.publication_tx_hash, b.publication_block_number,
          b.published_at, d.reward_ticket_pool_drawing_id, d.status AS drawing_status
        FROM reward_ticket_beneficiary_commitment_batches b
        LEFT JOIN reward_ticket_pool_drawings d
          ON d.commitment_batch_id = b.reward_ticket_beneficiary_commitment_batch_id
        WHERE b.reward_ticket_beneficiary_commitment_batch_id = ?1
        LIMIT 1${rowLocks ? " FOR UPDATE" : ""}
      `,
      args: [input.commitmentBatchId],
    })
    if (!row) throw new Error("reward ticket commitment batch not found")
    const status = required(row, "status")
    if (status === "published") {
      return {
        commitmentBatchId: required(row, "reward_ticket_beneficiary_commitment_batch_id"),
        status: "published",
        publicationReference: required(row, "publication_reference"),
        publicationTxHash: nullable(row, "publication_tx_hash"),
        publicationBlockNumber: nullable(row, "publication_block_number"),
        publishedAt: required(row, "published_at"),
      }
    }
    if (status !== "pending") throw new Error(`reward ticket commitment cannot publish from ${status}`)
    if (required(row, "drawing_status") !== "commit_pending") {
      throw new Error("reward ticket commitment drawing is not awaiting publication")
    }

    await tx.execute({
      sql: `
        UPDATE reward_ticket_beneficiary_commitment_batches
        SET status = 'published', publication_reference = ?2,
            publication_tx_hash = ?3, publication_block_number = ?4,
            published_at = ?5, updated_at = ?5
        WHERE reward_ticket_beneficiary_commitment_batch_id = ?1
          AND status = 'pending'
      `,
      args: [input.commitmentBatchId, input.publicationReference, publicationTxHash, publicationBlockNumber, input.publishedAt],
    })
    await tx.execute({
      sql: `
        UPDATE reward_ticket_pool_drawings
        SET committed_at = ?2, updated_at = ?2
        WHERE commitment_batch_id = ?1 AND status = 'commit_pending'
      `,
      args: [input.commitmentBatchId, input.publishedAt],
    })
    return {
      commitmentBatchId: input.commitmentBatchId,
      status: "published",
      publicationReference: input.publicationReference,
      publicationTxHash,
      publicationBlockNumber,
      publishedAt: input.publishedAt,
    }
  })
}
