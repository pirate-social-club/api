import { describe, expect, test } from "bun:test"

import type { Client, InStatement, QueryResult, Transaction } from "../sql-client"
import { buildRewardTicketCommitmentBatch, freezeRewardTicketPool } from "./reward-ticket-freeze"
import { persistRewardTicketPoolFreeze } from "./reward-ticket-freeze-persistence"

const row = {
  reward_ticket_pool_drawing_id: "rtd_1",
  status: "entry_open",
  drawing_id: "141",
  entry_cutoff_at: "2026-08-13T23:00:00.000Z",
  chain_id: "84532",
  jackpot_address: "0x465dA3c859f193A3807386387bEE941B2A4c3279",
  terms_hash: "11".repeat(32),
}

function clientForDrawing(): { client: Client; statements: string[] } {
  const statements: string[] = []
  const tx: Transaction = {
    async execute(statement: InStatement | string): Promise<QueryResult> {
      const sql = typeof statement === "string" ? statement : statement.sql
      statements.push(sql)
      if (sql.includes("FROM reward_ticket_pool_drawings")) return { rows: [row] }
      return { rows: [], rowsAffected: 1 }
    },
    async batch(): Promise<QueryResult[]> { return [] },
    async commit(): Promise<void> {},
    async rollback(): Promise<void> {},
    close(): void {},
  }
  return {
    statements,
    client: {
      async execute(): Promise<QueryResult> { return { rows: [] } },
      async batch(): Promise<QueryResult[]> { return [] },
      async transaction(): Promise<Transaction> { return tx },
    } as Client,
  }
}

const commitmentInput = {
  chainId: 84532,
  jackpotAddress: row.jackpot_address,
  drawingId: 141n,
  poolDrawingId: "rtd_1",
  termsHash: row.terms_hash,
  entryOpensAt: "2026-08-13T00:00:00.000Z",
  entryCutoffAt: row.entry_cutoff_at,
  now: "2026-08-13T23:01:00.000Z",
  qualifyingActivity: "either" as const,
  candidates: [{
    rewardIdentityId: "identity_1",
    userId: "user_1",
    eventId: "event_1",
    activity: "study" as const,
    qualifiedAt: "2026-08-13T12:00:00.000Z",
    evidenceSummary: { session: "session_1" },
  }],
}

describe("reward ticket freeze persistence", () => {
  test("writes a pending commitment and moves the drawing to commit_pending", async () => {
    const commitment = freezeRewardTicketPool(commitmentInput)
    const batch = buildRewardTicketCommitmentBatch([commitment])
    const fake = clientForDrawing()
    const result = await persistRewardTicketPoolFreeze({
      client: fake.client,
      poolDrawingId: "rtd_1",
      commitment,
      publication: {
        rootHash: batch.rootHash,
        leafIndex: 0,
        inclusionProof: batch.proofs["rtd_1"]!,
      },
      now: commitmentInput.now,
    })
    expect(result).toMatchObject({ status: "commit_pending", beneficiaryCount: 1 })
    expect(fake.statements.some((sql) => sql.includes("INSERT INTO reward_ticket_beneficiary_commitment_batches"))).toBe(true)
    expect(fake.statements.some((sql) => sql.includes("INSERT INTO reward_ticket_pool_beneficiaries"))).toBe(true)
    expect(fake.statements.some((sql) => sql.includes("status = 'commit_pending'"))).toBe(true)
  })

  test("closes a post-cutoff drawing with no entrants without creating a commitment", async () => {
    const fake = clientForDrawing()
    const result = await persistRewardTicketPoolFreeze({
      client: fake.client,
      poolDrawingId: "rtd_1",
      commitment: null,
      now: commitmentInput.now,
    })
    expect(result).toMatchObject({ status: "closed_no_entries", beneficiaryCount: 0 })
    expect(fake.statements.some((sql) => sql.includes("INSERT INTO reward_ticket_beneficiary_commitment_batches"))).toBe(false)
  })
})
