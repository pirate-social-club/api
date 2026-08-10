import { describe, expect, test } from "bun:test"

import type {
  Client,
  InStatement,
  QueryResult,
  Transaction,
} from "../../src/lib/sql-client"
import { archiveRehearsalFixtureCampaign } from "./archive-fixture"

const CAMPAIGN_ID = "rcp_c6a44d69e1c04ccd86259b022f666b56"

function fakeClient(overrides: { paidCents?: number; countersMatch?: boolean } = {}) {
  const statements: InStatement[] = []
  let committed = false
  const transaction: Transaction = {
    async execute(statement): Promise<QueryResult> {
      const normalized = typeof statement === "string" ? { sql: statement } : statement
      statements.push(normalized)
      const sql = normalized.sql
      if (sql.includes("FROM reward_campaigns")) {
        return { rows: [{
          creation_idempotency_key: `rehearsal-baseline:${CAMPAIGN_ID}`,
          status: "ended",
          funded_cents: 50,
          reserved_cents: 0,
          credited_cents: 50,
          paid_cents: overrides.paidCents ?? 50,
          refunded_cents: 0,
        }] }
      }
      if (sql.includes("FROM reward_campaign_funding_effects")) return { rows: [{ count: 0 }] }
      if (sql.includes("FROM reward_campaign_reservations")) {
        return { rows: [{ reservation_count: 1, credited_cents: 50, invalid_count: 0 }] }
      }
      if (sql.includes("FROM reward_payout_allocations")) {
        return { rows: [{ payout_count: 1, confirmed_cents: 50, invalid_count: 0 }] }
      }
      if (sql.includes("FROM reward_song_pools")) return { rows: [{ count: 0 }] }
      if (sql.includes("FROM reward_campaign_incidents") && sql.includes("COUNT(*)")) {
        return { rows: [{ count: 0 }] }
      }
      if (sql.includes("FROM reward_campaign_fixture_archives")) return { rows: [] }
      if (sql.includes("FROM reward_campaign_accounting_reconciliation")) {
        return { rows: [{ counters_match: overrides.countersMatch ?? true }] }
      }
      return { rows: [], rowsAffected: 1 }
    },
    async batch(): Promise<QueryResult[]> {
      throw new Error("unexpected batch")
    },
    async commit() {
      committed = true
    },
    async rollback() {},
    close() {},
  }
  const client: Client = {
    async execute(): Promise<QueryResult> {
      throw new Error("expected transaction")
    },
    async batch(): Promise<QueryResult[]> {
      throw new Error("expected transaction")
    },
    async transaction() {
      return transaction
    },
  }
  return { client, statements, committed: () => committed }
}

describe("archiveRehearsalFixtureCampaign", () => {
  test("previews a fully settled rehearsal fixture without writing", async () => {
    const fake = fakeClient()
    const result = await archiveRehearsalFixtureCampaign({
      client: fake.client,
      campaignId: CAMPAIGN_ID,
      apply: false,
      now: "2026-08-10T10:00:00.000Z",
    })

    expect(result).toMatchObject({
      campaign_id: CAMPAIGN_ID,
      outcome: "eligible",
      archive_reason: "fixture_without_funding_provenance",
      evidence: {
        funded_cents: 50,
        credited_cents: 50,
        paid_cents: 50,
        real_funding_effect_count: 0,
      },
    })
    expect(fake.statements.some(({ sql }) => sql.includes("INSERT INTO"))).toBe(false)
    expect(fake.committed()).toBe(true)
  })

  test("archives atomically and proves accounting convergence", async () => {
    const fake = fakeClient()
    const result = await archiveRehearsalFixtureCampaign({
      client: fake.client,
      campaignId: CAMPAIGN_ID,
      apply: true,
      now: "2026-08-10T10:00:00.000Z",
    })

    expect(result.outcome).toBe("archived")
    expect(fake.statements.some(({ sql }) => (
      sql.includes("INSERT INTO reward_campaign_fixture_funding_effects")
    ))).toBe(true)
    expect(fake.statements.some(({ sql }) => (
      sql.includes("INSERT INTO reward_campaign_fixture_archives")
    ))).toBe(true)
    expect(fake.statements.some(({ sql }) => (
      sql.includes("UPDATE reward_campaign_incidents")
      && normalizedArgs(sql, fake.statements).includes("fixture_without_funding_provenance")
    ))).toBe(true)
    expect(fake.committed()).toBe(true)
  })

  test("refuses a fixture whose credited liability is not fully settled", async () => {
    const fake = fakeClient({ paidCents: 0 })
    await expect(archiveRehearsalFixtureCampaign({
      client: fake.client,
      campaignId: CAMPAIGN_ID,
      apply: true,
    })).rejects.toThrow(`fixture_archive_invariants_failed:${CAMPAIGN_ID}`)
    expect(fake.statements.some(({ sql }) => sql.includes("INSERT INTO"))).toBe(false)
  })
})

function normalizedArgs(sql: string, statements: InStatement[]): string {
  const statement = statements.find((candidate) => candidate.sql === sql)
  return JSON.stringify(statement?.args ?? [])
}
