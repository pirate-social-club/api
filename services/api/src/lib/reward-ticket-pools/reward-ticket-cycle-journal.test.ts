import { describe, expect, test } from "bun:test"
import { Wallet } from "ethers"

import type { Client, InStatement, QueryResult, Transaction } from "../sql-client"
import { RewardTicketCycleJournal } from "./reward-ticket-cycle-journal"
import { DurableRewardTicketTransactionCoordinator } from "./reward-ticket-transaction-coordinator"

type Row = {
  cycleId: string
  operationId: string
  nonce: number
  signedTransaction: string
  transactionHash: string
  status: string
}

function fakeDatabase() {
  const rows: Row[] = []
  const events: string[] = []
  let closeCount = 0

  function client(): Client {
    return {
      async execute(statement: InStatement | string): Promise<QueryResult> {
        const sql = typeof statement === "string" ? statement : statement.sql
        const args = typeof statement === "string" ? [] : statement.args ?? []
        if (sql.includes("COALESCE(MAX(nonce)")) {
          const matching = rows.filter((row) => row.status !== "reverted")
          const next = matching.length ? Math.max(...matching.map((row) => row.nonce)) + 1 : 0
          return { rows: [{ next_nonce: String(next) }] }
        }
        if (sql.includes("INSERT INTO reward_ticket_evm_submissions")) {
          const operationId = String(args[2])
          const nonce = Number(args[5])
          if (rows.some((row) => row.operationId === operationId || row.nonce === nonce)) {
            throw Object.assign(new Error("duplicate"), { code: "23505" })
          }
          rows.push({
            cycleId: String(args[1]),
            operationId,
            nonce,
            signedTransaction: String(args[9]),
            transactionHash: String(args[10]),
            status: "prepared",
          })
          events.push("prepared")
          return { rows: [], rowsAffected: 1 }
        }
        if (sql.includes("FROM reward_ticket_evm_submissions")) {
          const cycleId = String(args[0])
          const needle = String(args[1])
          const row = rows.find((candidate) => candidate.cycleId === cycleId
            && (candidate.operationId === needle || candidate.transactionHash === needle))
          return { rows: row ? [{
            nonce: String(row.nonce),
            signed_transaction: row.signedTransaction,
            transaction_hash: row.transactionHash,
          }] : [] }
        }
        if (sql.includes("UPDATE reward_ticket_evm_submissions")) {
          const row = rows.find((candidate) => candidate.cycleId === String(args[0])
            && candidate.transactionHash === String(args[1]))
          if (row) row.status = "broadcast"
          return { rows: [], rowsAffected: row ? 1 : 0 }
        }
        if (sql.includes("INSERT INTO reward_ticket_automation_evidence")) {
          events.push(`evidence:${String(args[1])}`)
          return { rows: [], rowsAffected: 1 }
        }
        throw new Error(`unexpected SQL: ${sql}`)
      },
      async batch(): Promise<QueryResult[]> { return [] },
      async transaction(): Promise<Transaction> { throw new Error("transaction not expected") },
      close() { closeCount += 1 },
    }
  }

  return { rows, events, client, closeCount: () => closeCount }
}

const privateKey = "0x59c6995e998f97a5a0044976f7d5f772f191a22c2dbe57b16e8e31f5f6f34a5b"
const target = "0x98E9Ce3bEaEEc3abCdBc2bD5F8495C55a14FA334"

describe("reward ticket cycle journal", () => {
  test("fails closed on cross-cycle reads, updates, and duplicate operations", async () => {
    const db = fakeDatabase()
    const first = new RewardTicketCycleJournal(db.client, "cycle_a")
    const second = new RewardTicketCycleJournal(db.client, "cycle_b")
    const submission = {
      operationId: "purchase:1",
      operationKind: "ticket_purchase" as const,
      signerAddress: new Wallet(privateKey).address,
      targetAddress: target,
      callDataHash: `0x${"11".repeat(32)}`,
      valueWei: 0n,
      nonce: 1,
      signedTransaction: "0x02f8",
      transactionHash: `0x${"22".repeat(32)}`,
    }
    await first.persistPrepared(submission)

    expect(await second.findSubmission(submission.operationId)).toBeNull()
    await expect(second.requirePreparedByHash(submission.transactionHash)).rejects.toThrow(
      "not durably prepared for this cycle",
    )
    await expect(second.markBroadcast(submission.transactionHash, new Date().toISOString())).rejects.toThrow(
      "crossed cycle boundary",
    )
    await expect(second.persistPrepared({ ...submission, nonce: 2 })).rejects.toMatchObject({ code: "23505" })
    expect(db.closeCount()).toBe(6)
  })

  test("commits signed bytes before broadcast and reuses them after restart", async () => {
    const db = fakeDatabase()
    const journal = new RewardTicketCycleJournal(db.client, "cycle_a")
    const wallet = new Wallet(privateKey)
    let broadcastCount = 0
    const provider = {
      async getTransactionCount() { return 0 },
      async getFeeData() { return { maxFeePerGas: 2n, maxPriorityFeePerGas: 1n, gasPrice: 2n } },
      async estimateGas() { return 21_000n },
      async broadcastTransaction() {
        expect(db.events).toEqual(["prepared"])
        broadcastCount += 1
      },
      async getTransaction() { return null },
    }
    const coordinator = new DurableRewardTicketTransactionCoordinator(
      journal, provider, wallet, "ticket_purchase", () => "2026-08-15T00:00:00.000Z",
    )
    const input = { operationId: "purchase:1", to: target, data: "0x1234", value: 0n }
    const first = await coordinator.prepare(input)
    const recovered = await coordinator.prepare(input)

    expect(recovered).toEqual(first)
    expect(db.rows).toHaveLength(1)
    await coordinator.broadcastExact(recovered.signedTransaction)
    expect(broadcastCount).toBe(1)
    expect(db.rows[0]?.status).toBe("broadcast")
  })

  test("refuses to broadcast signed bytes absent from the bound cycle", async () => {
    const db = fakeDatabase()
    const wallet = new Wallet(privateKey)
    const signed = await wallet.signTransaction({
      chainId: 84532, type: 2, nonce: 0, to: target, data: "0x", value: 0n,
      gasLimit: 21_000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n,
    })
    let broadcast = false
    const coordinator = new DurableRewardTicketTransactionCoordinator(
      new RewardTicketCycleJournal(db.client, "wrong_cycle"),
      {
        async getTransactionCount() { return 0 },
        async getFeeData() { return { maxFeePerGas: 2n, maxPriorityFeePerGas: 1n, gasPrice: 2n } },
        async estimateGas() { return 21_000n },
        async broadcastTransaction() { broadcast = true },
        async getTransaction() { return null },
      },
      wallet,
      "ticket_purchase",
    )

    await expect(coordinator.broadcastExact(signed)).rejects.toThrow("not durably prepared for this cycle")
    expect(broadcast).toBe(false)
  })
})
