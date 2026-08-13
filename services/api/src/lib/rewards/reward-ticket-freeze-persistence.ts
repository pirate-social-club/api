import { executeFirst } from "../db-helpers"
import { makeId } from "../helpers"
import { isPostgresControlPlaneUrl } from "../runtime-deps"
import { rowValue, stringOrNull } from "../sql-row"
import type { Client } from "../sql-client"
import { withTransaction } from "../transactions"
import {
  verifyRewardTicketCommitmentProof,
  type RewardTicketPoolCommitment,
} from "./reward-ticket-freeze"

type FreezeResult = Readonly<{
  drawingId: string
  status: "commit_pending" | "closed_no_entries"
  commitmentBatchId: string | null
  beneficiaryCount: number
}>

function required(row: unknown, key: string): string {
  const value = stringOrNull(rowValue(row, key))
  if (!value) throw new Error(`reward ticket freeze row is missing ${key}`)
  return value
}

function positiveInteger(value: number, key: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`reward ticket freeze ${key} is invalid`)
}

function hash(value: string, key: string): string {
  const normalized = value.replace(/^0x/u, "").toLowerCase()
  if (!/^[0-9a-f]{64}$/u.test(normalized)) throw new Error(`reward ticket freeze ${key} is invalid`)
  return normalized
}

function validateCommitment(input: RewardTicketPoolCommitment): void {
  if (!input.poolDrawingId.trim()) throw new Error("reward ticket freeze pool drawing is invalid")
  if (input.beneficiaries.length === 0) throw new Error("reward ticket freeze beneficiaries are empty")
  const positions = input.beneficiaries.map((beneficiary) => beneficiary.canonicalPosition)
  if (positions.some((position, index) => position !== index)) {
    throw new Error("reward ticket freeze beneficiary positions are not canonical")
  }
  if (new Set(input.beneficiaries.map((beneficiary) => beneficiary.rewardIdentityId)).size
    !== input.beneficiaries.length) {
    throw new Error("reward ticket freeze beneficiary identities are duplicated")
  }
  for (const beneficiary of input.beneficiaries) {
    if (!beneficiary.rewardIdentityId.trim() || !beneficiary.userId.trim() || !beneficiary.qualificationEventId.trim()) {
      throw new Error("reward ticket freeze beneficiary identity is invalid")
    }
    hash(beneficiary.qualificationEvidenceHash, "qualification evidence hash")
  }
  hash(input.snapshotHash, "snapshot hash")
  hash(input.leafHash, "leaf hash")
}

/**
 * Persist a frozen daily beneficiary set without crossing an RPC boundary.
 * The caller builds the commitment from a read-only candidate snapshot first;
 * this transaction only validates the drawing window, writes the snapshot,
 * and moves the drawing to commit_pending. Publication is a later operation.
 */
export async function persistRewardTicketPoolFreeze(input: Readonly<{
  client: Client
  controlPlaneDatabaseUrl?: string
  poolDrawingId: string
  commitment: RewardTicketPoolCommitment | null
  publication?: Readonly<{
    rootHash: string
    leafIndex: number
    inclusionProof: readonly string[]
  }>
  now: string
}>): Promise<FreezeResult> {
  if (!input.poolDrawingId.trim()) throw new Error("reward ticket freeze pool drawing is required")
  if (!Number.isFinite(Date.parse(input.now))) throw new Error("reward ticket freeze timestamp is invalid")
  if (input.commitment) {
    validateCommitment(input.commitment)
    if (input.commitment.poolDrawingId !== input.poolDrawingId) {
      throw new Error("reward ticket freeze drawing identity mismatch")
    }
    if (!input.publication) throw new Error("reward ticket freeze publication is required")
    positiveInteger(input.publication.leafIndex + 1, "commitment leaf index")
    hash(input.publication.rootHash, "commitment root hash")
    input.publication.inclusionProof.forEach((proofHash) => hash(proofHash, "commitment proof hash"))
    if (!verifyRewardTicketCommitmentProof({
      leafHash: input.commitment.leafHash,
      proof: input.publication.inclusionProof,
      rootHash: input.publication.rootHash,
    })) {
      throw new Error("reward ticket freeze commitment proof is invalid")
    }
  }

  const rowLocks = isPostgresControlPlaneUrl(String(input.controlPlaneDatabaseUrl ?? ""))
  return withTransaction(input.client, "write", async (tx) => {
    const drawing = await executeFirst(tx, {
      sql: `
        SELECT d.reward_ticket_pool_drawing_id, d.status, d.drawing_id,
          d.entry_cutoff_at, p.chain_id, p.jackpot_address, p.terms_hash
        FROM reward_ticket_pool_drawings d
        JOIN reward_ticket_pools p ON p.reward_ticket_pool_id = d.reward_ticket_pool_id
        WHERE d.reward_ticket_pool_drawing_id = ?1
        LIMIT 1${rowLocks ? " FOR UPDATE" : ""}
      `,
      args: [input.poolDrawingId],
    })
    if (!drawing) throw new Error("reward ticket pool drawing not found")
    const status = required(drawing, "status")
    if (status !== "entry_open") throw new Error(`reward ticket drawing cannot freeze from ${status}`)
    const cutoff = Date.parse(required(drawing, "entry_cutoff_at"))
    if (!Number.isFinite(cutoff) || Date.parse(input.now) < cutoff) {
      throw new Error("reward ticket drawing entry cutoff has not passed")
    }

    const drawingId = required(drawing, "drawing_id")
    if (!input.commitment) {
      await tx.execute({
        sql: `
          UPDATE reward_ticket_pool_drawings
          SET status = 'closed_no_entries', beneficiary_count = 0,
              frozen_at = ?2, updated_at = ?2
          WHERE reward_ticket_pool_drawing_id = ?1 AND status = 'entry_open'
        `,
        args: [input.poolDrawingId, input.now],
      })
      return { drawingId, status: "closed_no_entries", commitmentBatchId: null, beneficiaryCount: 0 }
    }

    const chainId = Number(required(drawing, "chain_id"))
    positiveInteger(chainId, "chain id")
    if (BigInt(drawingId) < 0n) throw new Error("reward ticket freeze drawing id is invalid")

    const commitmentBatchId = makeId("rtcb")
    await tx.execute({
      sql: `
        INSERT INTO reward_ticket_beneficiary_commitment_batches (
          reward_ticket_beneficiary_commitment_batch_id, chain_id, jackpot_address,
          drawing_id, root_hash, publication_kind, status, frozen_at, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, 'platform_merkle_root_v1', 'pending', ?6, ?6, ?6)
      `,
      args: [
        commitmentBatchId, chainId, required(drawing, "jackpot_address"), drawingId,
        hash(input.publication!.rootHash, "commitment root hash"), input.now,
      ],
    })
    for (const beneficiary of input.commitment.beneficiaries) {
      await tx.execute({
        sql: `
          INSERT INTO reward_ticket_pool_beneficiaries (
            reward_ticket_pool_drawing_id, reward_identity_id, user_id,
            reward_qualification_event_id, qualification_evidence_hash,
            canonical_position, qualified_at, created_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
        `,
        args: [
          input.poolDrawingId, beneficiary.rewardIdentityId, beneficiary.userId,
          beneficiary.qualificationEventId, hash(beneficiary.qualificationEvidenceHash, "qualification evidence hash"),
          beneficiary.canonicalPosition, beneficiary.qualifiedAt, input.now,
        ],
      })
    }
    await tx.execute({
      sql: `
        UPDATE reward_ticket_pool_drawings
        SET status = 'commit_pending', beneficiary_count = ?2,
            snapshot_hash = ?3, commitment_batch_id = ?4,
            commitment_leaf_index = ?5, commitment_inclusion_proof_json = ?6,
            frozen_at = ?7, updated_at = ?7
        WHERE reward_ticket_pool_drawing_id = ?1 AND status = 'entry_open'
      `,
      args: [
        input.poolDrawingId, input.commitment.beneficiaries.length,
        hash(input.commitment.snapshotHash, "snapshot hash"), commitmentBatchId,
        input.publication!.leafIndex, JSON.stringify(input.publication!.inclusionProof), input.now,
      ],
    })
    return {
      drawingId,
      status: "commit_pending",
      commitmentBatchId,
      beneficiaryCount: input.commitment.beneficiaries.length,
    }
  })
}
