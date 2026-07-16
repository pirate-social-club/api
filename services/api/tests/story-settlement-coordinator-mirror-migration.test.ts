import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { createClient } from "@libsql/client"
import { splitSqlStatements, toSqliteCompatibleStatements } from "../shared/sql-migration"

const MIGRATION_URL = new URL(
  "../test-fixtures/db/community-template/migrations/1134_story_settlement_coordinator_mirror.sql",
  import.meta.url,
)

async function applyMigration(client: ReturnType<typeof createClient>): Promise<void> {
  const sql = await readFile(fileURLToPath(MIGRATION_URL), "utf8")
  for (const statement of splitSqlStatements(sql)) {
    for (const sqliteStatement of toSqliteCompatibleStatements(statement)) {
      await client.execute(sqliteStatement)
    }
  }
}

function transactionInsert(overrides: {
  id: string
  effect: string
  step: string
  coordinatorStep: string
  nonce?: number | null
}) {
  return {
    sql: `
      INSERT INTO purchase_settlement_transactions (
        purchase_settlement_transaction_id,
        purchase_settlement_effect_id,
        step_key,
        step_kind,
        ordinal,
        call_identity_hash,
        coordinator_step_ref,
        state,
        chain_id,
        signer_address,
        nonce,
        updated_at
      ) VALUES (?1, ?2, ?3, 'royalty_payment', 0, ?4, ?5, 'reserving', 1315, ?6, ?7, ?8)
    `,
    args: [
      overrides.id,
      overrides.effect,
      overrides.step,
      `call:${overrides.id}`,
      overrides.coordinatorStep,
      "0x1111111111111111111111111111111111111111",
      overrides.nonce ?? null,
      "2026-07-16T00:00:00.000Z",
    ],
  }
}

describe("1134 Story settlement coordinator mirror migration", () => {
  test("adds the mirror schema and fences every transaction identity", async () => {
    const client = createClient({ url: ":memory:" })
    try {
      await client.execute(`
        CREATE TABLE purchase_settlement_effects (
          purchase_settlement_effect_id TEXT PRIMARY KEY
        )
      `)
      await applyMigration(client)

      const effectColumns = await client.execute("PRAGMA table_info('purchase_settlement_effects')")
      expect(effectColumns.rows.map((row) => row.name)).toEqual(
        expect.arrayContaining([
          "request_fingerprint",
          "coordinator_plan_ref",
          "coordinator_state",
          "coordinator_version",
          "reconciliation_reason",
          "last_reconciled_at",
          "finality_confirmed_at",
        ]),
      )

      const indexes = await client.execute(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'purchase_settlement_transactions'",
      )
      expect(indexes.rows.map((row) => row.name)).toEqual(
        expect.arrayContaining([
          "idx_purchase_settlement_transactions_effect_step",
          "idx_purchase_settlement_transactions_coordinator_step",
          "idx_purchase_settlement_transactions_signer_nonce",
        ]),
      )

      await client.execute("INSERT INTO purchase_settlement_effects (purchase_settlement_effect_id) VALUES ('effect-1')")
      await client.execute("INSERT INTO purchase_settlement_effects (purchase_settlement_effect_id) VALUES ('effect-2')")
      await client.execute(
        transactionInsert({
          id: "tx-1",
          effect: "effect-1",
          step: "payment",
          coordinatorStep: "coordinator-step-1",
          nonce: 7,
        }),
      )

      await expect(
        client.execute(
          transactionInsert({
            id: "tx-duplicate-effect-step",
            effect: "effect-1",
            step: "payment",
            coordinatorStep: "coordinator-step-2",
            nonce: 8,
          }),
        ),
      ).rejects.toThrow(/UNIQUE constraint failed/)

      await expect(
        client.execute(
          transactionInsert({
            id: "tx-duplicate-coordinator-step",
            effect: "effect-2",
            step: "parent-1",
            coordinatorStep: "coordinator-step-1",
            nonce: 8,
          }),
        ),
      ).rejects.toThrow(/UNIQUE constraint failed/)

      await expect(
        client.execute(
          transactionInsert({
            id: "tx-duplicate-signer-nonce",
            effect: "effect-2",
            step: "parent-2",
            coordinatorStep: "coordinator-step-3",
            nonce: 7,
          }),
        ),
      ).rejects.toThrow(/UNIQUE constraint failed/)

      await client.execute(
        transactionInsert({
          id: "tx-unreserved-nonce",
          effect: "effect-2",
          step: "parent-3",
          coordinatorStep: "coordinator-step-4",
        }),
      )
    } finally {
      client.close()
    }
  })
})
