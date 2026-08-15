// Production-dialect coverage for the Megapot cycle journal. This test applies
// canonical Core migration 0235 and drives the API adapter through real
// PostgreSQL constraints across the prepare/broadcast crash boundary.
import { SQL } from "bun"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { Wallet } from "ethers"

import type { Client, InStatement, QueryResult, Transaction } from "../sql-client"
import { RewardTicketCycleJournal } from "./reward-ticket-cycle-journal"
import { DurableRewardTicketTransactionCoordinator } from "./reward-ticket-transaction-coordinator"
import { splitSqlStatements } from "../../../shared/sql-migration"

const ADMIN_URL = process.env.BOOKINGS_REPO_TEST_ADMIN_URL
if (process.env.REWARD_TICKET_JOURNAL_PG_CI_REQUIRED === "true" && !ADMIN_URL) {
  throw new Error("BOOKINGS_REPO_TEST_ADMIN_URL is required for reward ticket journal PostgreSQL CI")
}
const RUN = Boolean(ADMIN_URL)
const TEST_DB = "reward_ticket_cycle_journal_test"

function urlFor(database?: string): string {
  const url = new URL(ADMIN_URL as string)
  if (database) url.pathname = `/${database}`
  if (!url.searchParams.get("sslmode")) url.searchParams.set("sslmode", "disable")
  return url.toString()
}

function connect(database?: string): SQL {
  return new SQL({ url: urlFor(database), tls: false, max: 1, connectionTimeout: 5 } as Record<string, unknown>)
}

let database: SQL

function clientFactory(): Client {
  const toPostgres = (sql: string) => sql.replace(/\?(\d+)/gu, (_match, index: string) => `$${index}`)
  return {
    async execute(statement: InStatement | string): Promise<QueryResult> {
      const input = typeof statement === "string" ? { sql: statement, args: [] } : statement
      const rows = await database.unsafe(toPostgres(input.sql), input.args ?? []) as Record<string, unknown>[]
      return { rows: Array.from(rows) }
    },
    async batch(): Promise<QueryResult[]> { throw new Error("batch not expected") },
    async transaction(): Promise<Transaction> { throw new Error("transaction not expected") },
    close() {},
  }
}

const privateKey = "0x59c6995e998f97a5a0044976f7d5f772f191a22c2dbe57b16e8e31f5f6f34a5b"
const jackpot = "0x465dA3c859f193A3807386387bEE941B2A4c3279"
const target = "0x98E9Ce3bEaEEc3abCdBc2bD5F8495C55a14FA334"

describe.skipIf(!RUN)("reward ticket cycle journal (real Postgres)", () => {
  beforeAll(async () => {
    const root = connect()
    await root.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`)
    await root.unsafe(`CREATE DATABASE ${TEST_DB}`)
    await root.end()

    database = connect(TEST_DB)
    const coreRoot = process.env.PIRATE_CORE_REPO
    if (!coreRoot) throw new Error("PIRATE_CORE_REPO is required for reward ticket journal PostgreSQL CI")
    const migration = await readFile(resolve(
      coreRoot,
      "db/control-plane/migrations/0235_control_plane_reward_ticket_cycle_journal.sql",
    ), "utf8")
    for (const statement of splitSqlStatements(migration)) {
      await database.unsafe(statement)
    }
    for (const [cycleId, drawingId] of [["cycle_a", 1], ["cycle_b", 2]] as const) {
      await database.unsafe(`
        INSERT INTO reward_ticket_automation_cycles (
          reward_ticket_automation_cycle_id, schedule_key, chain_id,
          jackpot_address, drawing_id, status, runner_version, source_commit,
          scheduled_for
        ) VALUES ($1, $2, 84532, $3, $4, 'planned', 'pg-test', $5, NOW())
      `, [cycleId, `schedule_${cycleId}`, jackpot, drawingId, "1".repeat(40)])
    }
  })

  afterAll(async () => {
    if (database) await database.end()
    const root = connect()
    await root.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`).catch(() => {})
    await root.end()
    const sentinel = process.env.REWARD_TICKET_JOURNAL_PG_SENTINEL_PATH
    if (sentinel) await writeFile(sentinel, "reward-ticket-cycle-journal-postgres-suite-complete\n", "utf8")
  })

  test("persists before broadcast and recovers exact signed bytes", async () => {
    const journal = new RewardTicketCycleJournal(clientFactory, "cycle_a")
    const wallet = new Wallet(privateKey)
    let broadcasts = 0
    const coordinator = new DurableRewardTicketTransactionCoordinator(journal, {
      async getTransactionCount() { return 0 },
      async getFeeData() { return { maxFeePerGas: 2n, maxPriorityFeePerGas: 1n, gasPrice: 2n } },
      async estimateGas() { return 21_000n },
      async broadcastTransaction() {
        const rows = await database.unsafe(
          "SELECT status FROM reward_ticket_evm_submissions WHERE operation_id = 'purchase:pg'",
        ) as { status: string }[]
        expect(rows[0]?.status).toBe("prepared")
        broadcasts += 1
      },
      async getTransaction() { return null },
    }, wallet, "ticket_purchase", () => "2026-08-15T00:00:00.000Z")
    const operation = { operationId: "purchase:pg", to: target, data: "0x1234", value: 0n }
    const prepared = await coordinator.prepare(operation)
    expect(await coordinator.prepare(operation)).toEqual(prepared)
    await coordinator.broadcastExact(prepared.signedTransaction)
    expect(broadcasts).toBe(1)
  })

  test("database and adapter reject cross-cycle and append-only violations", async () => {
    const wrongCycle = new RewardTicketCycleJournal(clientFactory, "cycle_b")
    const row = await database.unsafe(
      "SELECT transaction_hash FROM reward_ticket_evm_submissions WHERE operation_id = 'purchase:pg'",
    ) as { transaction_hash: string }[]
    const transactionHash = String(row[0]?.transaction_hash)
    await expect(wrongCycle.requirePreparedByHash(transactionHash)).rejects.toThrow(
      "not durably prepared for this cycle",
    )
    await expect(wrongCycle.markBroadcast(transactionHash, new Date().toISOString())).rejects.toThrow(
      "crossed cycle boundary",
    )
    await database.unsafe(`
      INSERT INTO reward_ticket_automation_evidence (
        reward_ticket_automation_evidence_id, reward_ticket_automation_cycle_id,
        sequence_number, evidence_kind, evidence_json, evidence_hash, observed_at
      ) VALUES ('evidence_pg', 'cycle_a', 0, 'cycle_started', '{}'::jsonb, $1, NOW())
    `, ["3".repeat(64)])
    await expect(database.unsafe(
      "DELETE FROM reward_ticket_automation_evidence WHERE reward_ticket_automation_evidence_id = 'evidence_pg'",
    )).rejects.toThrow("append-only")
  })
})
