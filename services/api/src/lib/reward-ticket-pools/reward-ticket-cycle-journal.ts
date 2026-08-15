import { executeFirst } from "../db-helpers"
import { makeId } from "../helpers"
import { rowValue, stringOrNull } from "../sql-row"
import type { Client } from "../sql-client"

export type RewardTicketClientFactory = () => Client | Promise<Client>

export type PreparedRewardTicketSubmission = Readonly<{
  nonce: number
  signedTransaction: string
  transactionHash: string
}>

type SubmissionIdentity = PreparedRewardTicketSubmission & Readonly<{
  operationId: string
  operationKind: "commitment_publication" | "ticket_purchase" | "winnings_claim"
  signerAddress: string
  targetAddress: string
  callDataHash: string
  valueWei: bigint
}>

function required(row: unknown, key: string): string {
  const value = stringOrNull(rowValue(row, key))
  if (!value) throw new Error(`reward ticket cycle journal row is missing ${key}`)
  return value
}

function submissionFromRow(row: unknown): PreparedRewardTicketSubmission {
  const nonce = Number(required(row, "nonce"))
  if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error("reward ticket submission nonce is invalid")
  return {
    nonce,
    signedTransaction: required(row, "signed_transaction"),
    transactionHash: required(row, "transaction_hash"),
  }
}

function duplicateKey(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "23505")
}

export class RewardTicketCycleJournal {
  constructor(
    private readonly clientFactory: RewardTicketClientFactory,
    readonly cycleId: string,
  ) {
    if (!cycleId.trim()) throw new Error("reward ticket automation cycle id is required")
  }

  private async withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    const client = await this.clientFactory()
    try {
      return await fn(client)
    } finally {
      await client.close?.()
    }
  }

  async findSubmission(operationId: string): Promise<PreparedRewardTicketSubmission | null> {
    return this.withClient(async (client) => {
      const row = await executeFirst(client, {
        sql: `
          SELECT nonce, signed_transaction, transaction_hash
          FROM reward_ticket_evm_submissions
          WHERE reward_ticket_automation_cycle_id = ?1 AND operation_id = ?2
          LIMIT 1
        `,
        args: [this.cycleId, operationId],
      })
      return row ? submissionFromRow(row) : null
    })
  }

  async nextNonceFloor(signerAddress: string): Promise<number> {
    return this.withClient(async (client) => {
      const row = await executeFirst(client, {
        sql: `
          SELECT COALESCE(MAX(nonce) + 1, 0) AS next_nonce
          FROM reward_ticket_evm_submissions
          WHERE chain_id = 84532 AND LOWER(signer_address) = LOWER(?1)
            AND status IN ('prepared', 'broadcast', 'confirmed', 'needs_review')
        `,
        args: [signerAddress],
      })
      const nonce = Number(required(row, "next_nonce"))
      if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error("reward ticket next nonce is invalid")
      return nonce
    })
  }

  async persistPrepared(input: SubmissionIdentity): Promise<PreparedRewardTicketSubmission> {
    try {
      await this.withClient(async (client) => {
        await client.execute({
          sql: `
            INSERT INTO reward_ticket_evm_submissions (
              reward_ticket_evm_submission_id, reward_ticket_automation_cycle_id,
              operation_id, operation_kind, chain_id, signer_address, nonce,
              target_address, call_data_hash, value_wei, signed_transaction,
              transaction_hash, status, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, 84532, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
              'prepared', NOW(), NOW())
          `,
          args: [
            makeId("rtes"), this.cycleId, input.operationId, input.operationKind,
            input.signerAddress, input.nonce, input.targetAddress, input.callDataHash,
            input.valueWei.toString(), input.signedTransaction, input.transactionHash,
          ],
        })
      })
      return {
        nonce: input.nonce,
        signedTransaction: input.signedTransaction,
        transactionHash: input.transactionHash,
      }
    } catch (error) {
      if (!duplicateKey(error)) throw error
      const existing = await this.findSubmission(input.operationId)
      if (existing) return existing
      throw error
    }
  }

  async requirePreparedByHash(transactionHash: string): Promise<PreparedRewardTicketSubmission> {
    return this.withClient(async (client) => {
      const row = await executeFirst(client, {
        sql: `
          SELECT nonce, signed_transaction, transaction_hash
          FROM reward_ticket_evm_submissions
          WHERE reward_ticket_automation_cycle_id = ?1
            AND chain_id = 84532 AND transaction_hash = ?2
          LIMIT 1
        `,
        args: [this.cycleId, transactionHash],
      })
      if (!row) throw new Error("reward ticket transaction was not durably prepared for this cycle")
      return submissionFromRow(row)
    })
  }

  async markBroadcast(transactionHash: string, now: string): Promise<void> {
    await this.withClient(async (client) => {
      const result = await client.execute({
        sql: `
          UPDATE reward_ticket_evm_submissions
          SET status = 'broadcast', broadcast_at = COALESCE(broadcast_at, ?3), updated_at = ?3
          WHERE reward_ticket_automation_cycle_id = ?1 AND chain_id = 84532
            AND transaction_hash = ?2 AND status IN ('prepared', 'broadcast', 'needs_review')
          RETURNING reward_ticket_evm_submission_id
        `,
        args: [this.cycleId, transactionHash, now],
      })
      if (result.rows.length !== 1) throw new Error("reward ticket broadcast crossed cycle boundary")
    })
  }

  async appendEvidence(input: Readonly<{
    sequenceNumber: number
    kind: string
    evidence: Readonly<Record<string, unknown>>
    evidenceHash: string
    observedAt: string
  }>): Promise<void> {
    await this.withClient(async (client) => {
      await client.execute({
        sql: `
          INSERT INTO reward_ticket_automation_evidence (
            reward_ticket_automation_evidence_id, reward_ticket_automation_cycle_id,
            sequence_number, evidence_kind, evidence_json, evidence_hash,
            observed_at, created_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NOW())
        `,
        args: [
          makeId("rtae"), this.cycleId, input.sequenceNumber, input.kind,
          JSON.stringify(input.evidence), input.evidenceHash, input.observedAt,
        ],
      })
    })
  }
}
