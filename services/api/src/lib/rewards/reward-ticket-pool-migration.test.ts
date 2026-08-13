import { Database } from "bun:sqlite"
import { readFile } from "node:fs/promises"
import { describe, expect, test } from "bun:test"

const MIGRATION = new URL(
  "../../../test-fixtures/db/control-plane/migrations/0224_control_plane_reward_ticket_pools.sql",
  import.meta.url,
)

async function createDrawingTable(): Promise<Database> {
  const sql = await readFile(MIGRATION, "utf8")
  const start = sql.indexOf("CREATE TABLE reward_ticket_pool_drawings (")
  const end = sql.indexOf("\nCREATE INDEX reward_ticket_pool_drawings_work_idx", start)
  if (start < 0 || end < 0) throw new Error("reward ticket drawing table was not found in migration")
  const database = new Database(":memory:")
  // SQLite does not implement PostgreSQL's regex operator; remove only that
  // unrelated address-shape clause so the migration's state CHECKs execute
  // verbatim in this lightweight invariant test.
  const sqliteSql = sql.slice(start, end)
    .replace(/jackpot_address TEXT NOT NULL CHECK \(jackpot_address ~ '[^']+'\),/u, "jackpot_address TEXT NOT NULL,")
    .replace(/snapshot_hash TEXT CHECK \(snapshot_hash IS NULL OR snapshot_hash ~ '[^']+'\),/u, "snapshot_hash TEXT,")
    .replaceAll("DEFAULT NOW()", "DEFAULT CURRENT_TIMESTAMP")
  database.exec(sqliteSql)
  return database
}

const baseInsert = `
  reward_ticket_pool_drawing_id, reward_ticket_pool_id, chain_id, jackpot_address,
  drawing_id, status, entry_opens_at, entry_cutoff_at, drawing_resolves_at,
  snapshot_hash, frozen_at, ticket_count
`
const baseValues = `
  'rtd_1', 'rtp_1', 84532, '0x465dA3c859f193A3807386387bEE941B2A4c3279',
  141, 'purchase_pending', '2026-08-13T00:00:00Z',
  '2026-08-13T23:00:00Z', '2026-08-14T00:00:00Z',
  '${"11".repeat(64)}', '2026-08-13T23:01:00Z', 1
`

describe("reward ticket pool migration invariants", () => {
  test("rejects purchase_pending without a published commitment", async () => {
    const database = await createDrawingTable()
    try {
      expect(() => database.run(`INSERT INTO reward_ticket_pool_drawings (${baseInsert}) VALUES (${baseValues})`))
        .toThrow()
    } finally {
      database.close()
    }
  })

  test("accepts purchase_pending only with the complete published commitment shape", async () => {
    const database = await createDrawingTable()
    try {
      database.run(`
        INSERT INTO reward_ticket_pool_drawings (
          ${baseInsert}, commitment_batch_id, commitment_leaf_index,
          commitment_inclusion_proof_json, committed_at
        ) VALUES (
          ${baseValues}, 'rtcb_1', 0, '["${"22".repeat(32)}"]', '2026-08-13T23:02:00Z'
        )
      `)
      expect(database.query("SELECT status FROM reward_ticket_pool_drawings").get()).toEqual({
        status: "purchase_pending",
      })
    } finally {
      database.close()
    }
  })
})
