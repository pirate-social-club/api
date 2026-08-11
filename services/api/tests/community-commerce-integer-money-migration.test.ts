import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { createClient } from "@libsql/client"

import { splitSqlStatements, toSqliteCompatibleStatements } from "../shared/sql-migration"
import { createCommunityDbThroughMigration } from "./community-db-test-harness"

const MIGRATION_NAME = "1154_commerce_integer_money.sql"

describe(MIGRATION_NAME, () => {
  test("converts every commerce money field to guarded integer cents and basis points", async () => {
    const client = createClient({ url: ":memory:" })
    try {
      await createCommunityDbThroughMigration(client, "1152_user_account_merge_receipts.sql")
      const now = "2026-08-11T00:00:00.000Z"
      await client.execute({
        sql: `
          INSERT INTO communities (
            community_id, display_name, status, artist_governance_state, membership_mode,
            default_age_gate_policy, allow_anonymous_identity, donation_policy_mode,
            donation_partner_status, governance_mode, created_by_user_id, created_at, updated_at
          ) VALUES (
            ?1, 'Integer Money', 'active', 'fan_run', 'open',
            'none', 0, 'none', 'unconfigured', 'centralized', ?2, ?3, ?3
          )
        `,
        args: ["cmt_integer_money", "usr_owner", now],
      })
      await client.execute({
        sql: `
          INSERT INTO listings (
            listing_id, community_id, asset_id, listing_mode, status, price_usd,
            created_by_user_id, created_at, updated_at
          ) VALUES (?1, ?2, ?3, 'fixed_price', 'active', 12.34, ?4, ?5, ?5)
        `,
        args: ["lst_integer_money", "cmt_integer_money", "ast_integer_money", "usr_owner", now],
      })
      await client.execute({
        sql: `
          INSERT INTO purchase_quotes (
            quote_id, community_id, listing_id, buyer_kind, buyer_user_id, asset_id,
            base_price_usd, final_price_usd, allocation_snapshot_json, funding_mode,
            route_policy_compliant, policy_origin, destination_settlement_chain_json,
            destination_settlement_token, quote_ttl_seconds, route_required,
            route_status_policy, route_hop_tolerance, settlement_mode, status,
            quoted_at, expires_at, created_at, updated_at
          ) VALUES (
            ?1, ?2, ?3, 'user', ?4, ?5,
            12.34, 10.01, ?6, 'direct',
            1, 'default', '{}', 'USDC', 300, 0,
            'fail', 0, 'delivery_only_story_settlement', 'active',
            ?7, ?8, ?7, ?7
          )
        `,
        args: [
          "qte_integer_money",
          "cmt_integer_money",
          "lst_integer_money",
          "usr_buyer",
          "ast_integer_money",
          JSON.stringify([{
            recipient_type: "creator",
            recipient_ref: "usr_owner",
            waterfall_position: 70,
            share_bps: 10_000,
            amount_usd: 10.01,
            settlement_strategy: "story_payout",
          }]),
          now,
          "2026-08-11T00:05:00.000Z",
        ],
      })
      await client.execute({
        sql: `
          INSERT INTO purchases (
            purchase_id, community_id, listing_id, asset_id, buyer_kind, buyer_user_id,
            settlement_wallet_attachment_id, purchase_price_usd, settlement_chain,
            settlement_token, settlement_tx_ref, donation_partner_id, donation_share_pct,
            donation_amount_usd, created_at, settlement_mode
          ) VALUES (
            ?1, ?2, ?3, ?4, 'user', ?5,
            ?6, 10.01, '{}', 'USDC', ?7, ?8, 12.5,
            1.25, ?9, 'delivery_only_story_settlement'
          )
        `,
        args: [
          "pur_integer_money",
          "cmt_integer_money",
          "lst_integer_money",
          "ast_integer_money",
          "usr_buyer",
          "wla_integer_money",
          "0xsettlement",
          "don_integer_money",
          now,
        ],
      })
      await client.execute({
        sql: `
          INSERT INTO purchase_allocation_legs (
            purchase_allocation_leg_id, purchase_id, quote_id, community_id,
            recipient_type, recipient_ref, waterfall_position, share_bps, amount_usd,
            settlement_strategy, status, created_at, updated_at
          ) VALUES (
            ?1, ?2, ?3, ?4,
            'creator', ?5, 70, 10000, 8.76,
            'story_payout', 'confirmed', ?6, ?6
          )
        `,
        args: [
          "pal_integer_money",
          "pur_integer_money",
          "qte_integer_money",
          "cmt_integer_money",
          "usr_owner",
          now,
        ],
      })

      const migrationPath = fileURLToPath(new URL(
        "../test-fixtures/db/community-template/migrations/1154_commerce_integer_money.sql",
        import.meta.url,
      ))
      const migrationSql = await readFile(migrationPath, "utf8")
      for (const statement of splitSqlStatements(migrationSql).flatMap(toSqliteCompatibleStatements)) {
        await client.execute(statement)
      }

      const listing = await client.execute("SELECT price_cents FROM listings")
      expect(listing.rows).toEqual([{ price_cents: 1234 }])

      const quote = await client.execute(
        "SELECT base_price_cents, final_price_cents, allocation_snapshot_json FROM purchase_quotes",
      )
      expect(quote.rows[0]?.base_price_cents).toBe(1234)
      expect(quote.rows[0]?.final_price_cents).toBe(1001)
      expect(JSON.parse(String(quote.rows[0]?.allocation_snapshot_json))).toEqual([{
        recipient_type: "creator",
        recipient_ref: "usr_owner",
        waterfall_position: 70,
        share_bps: 10_000,
        amount_cents: 1001,
        settlement_strategy: "story_payout",
      }])

      const purchase = await client.execute(
        "SELECT purchase_price_cents, donation_share_bps, donation_amount_cents FROM purchases",
      )
      expect(purchase.rows).toEqual([{
        purchase_price_cents: 1001,
        donation_share_bps: 1250,
        donation_amount_cents: 125,
      }])

      const allocation = await client.execute("SELECT amount_cents FROM purchase_allocation_legs")
      expect(allocation.rows).toEqual([{ amount_cents: 876 }])

      for (const [table, expectedColumns] of [
        ["listings", ["price_cents"]],
        ["purchase_quotes", ["base_price_cents", "final_price_cents"]],
        ["purchases", ["purchase_price_cents", "donation_share_bps", "donation_amount_cents"]],
        ["purchase_allocation_legs", ["amount_cents"]],
      ] as const) {
        const columns = await client.execute(`PRAGMA table_info(${table})`)
        for (const columnName of expectedColumns) {
          const column = columns.rows.find((row) => row.name === columnName)
          expect(column?.type).toBe("INTEGER")
        }
      }

      await expect(client.execute(
        "UPDATE listings SET price_cents = 1.5 WHERE listing_id = 'lst_integer_money'",
      )).rejects.toThrow()
      await expect(client.execute(
        "UPDATE purchase_allocation_legs SET share_bps = 12.5 WHERE purchase_allocation_leg_id = 'pal_integer_money'",
      )).rejects.toThrow()
    } finally {
      client.close()
    }
  }, 30_000)
})
