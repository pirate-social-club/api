import { describe, expect, test } from "bun:test"

import type { Env } from "../../env"
import type { Client, InStatement, QueryResult, Transaction } from "../sql-client"
import { relaySponsoredFollowTransaction } from "./follow-sponsorship-relay"

const VIEWER = "0x1111111111111111111111111111111111111111"
const TARGET = "0x2222222222222222222222222222222222222222"
const RECORDS = "0x41aa48ef3c0446b46a5b1cc6337ff3d3716e2a33"
const DATA_ONE = "0x1234"
const DATA_TWO = "0xabcd"
const HASH = `0x${"a".repeat(64)}` as `0x${string}`

function relayClient(): Client & { statements: InStatement[] } {
  const statements: InStatement[] = []
  let transactionNumber = 0
  const transaction = async (): Promise<Transaction> => {
    transactionNumber += 1
    return {
      async execute(statement): Promise<QueryResult> {
        const normalized = typeof statement === "string" ? { sql: statement } : statement
        statements.push(normalized)
        if (normalized.sql.includes("SELECT i.*")) {
          return {
            rows: [{
              actor_wallet_address: VIEWER,
              attachment_kind: "embedded",
              source_provider: "privy",
              verification_state: "verified",
              expires_at: "2026-07-29T00:00:00.000Z",
              status: "prepared",
              sponsored_transaction_count: 0,
              sponsorship_reserved_transaction_count: 0,
              prepared_transaction_count: 2,
              prepared_transactions_json: [
                { chain_id: 8453, data: DATA_ONE, to: RECORDS },
                { chain_id: 8453, data: DATA_TWO, to: RECORDS },
              ],
            }],
          }
        }
        if (normalized.sql.includes("SELECT transaction_limit")) {
          return { rows: [{ transaction_limit: 100, reserved_transactions: 0, consumed_transactions: 0 }] }
        }
        if (normalized.sql.includes("SELECT prepared_transaction_count")) {
          expect(transactionNumber).toBe(2)
          return {
            rows: [{
              prepared_transaction_count: 2,
              sponsored_transaction_count: 0,
              sponsorship_reserved_transaction_count: 2,
              actor_wallet_address: VIEWER,
              target_wallet_address: TARGET,
              transaction_hashes_json: [],
            }],
          }
        }
        return { rows: [], rowsAffected: 1 }
      },
      async batch() { return [] },
      async commit() {},
      async rollback() {},
      close() {},
    }
  }
  return {
    statements,
    async execute() { throw new Error("not used") },
    async batch() { return [] },
    transaction,
  }
}

describe("relaySponsoredFollowTransaction", () => {
  test("reserves both bootstrap transactions before relaying the first", async () => {
    const client = relayClient()
    const result = await relaySponsoredFollowTransaction({
      actorUserId: "viewer",
      client,
      env: {
        PRIVY_APP_ID: "app",
        PRIVY_APP_SECRET: "secret",
        OPS_ALERT_WEBHOOK_URL: "https://pager.invalid",
        EFP_FOLLOW_SPONSOR_DAILY_TRANSACTION_LIMIT: "100",
        EFP_FOLLOW_SPONSOR_ESTIMATED_USD_MICROS_PER_TRANSACTION: "800",
      } as Env,
      now: new Date("2026-07-28T12:00:00.000Z"),
      request: {
        authorizationSignature: "signature",
        intentId: `efw_${"b".repeat(32)}`,
        transactionIndex: 0,
        privyWalletId: "wallet-id",
        walletAddress: VIEWER,
        transaction: { data: DATA_ONE, to: RECORDS },
      },
      fetcher: async (_url, init) => {
        const body = JSON.parse(String(init?.body))
        expect(body).toMatchObject({
          caip2: "eip155:8453",
          chain_type: "ethereum",
          sponsor: true,
          params: { transaction: { data: DATA_ONE, to: RECORDS } },
        })
        return Response.json({ data: { hash: HASH } })
      },
    })
    expect(result.txHash).toBe(HASH)
    const budgetReservation = client.statements.find((statement) =>
      statement.sql.includes("reserved_transactions = reserved_transactions + ?2")
    )
    expect(budgetReservation?.args?.[1]).toBe(2)
    const intentReservation = client.statements.find((statement) =>
      statement.sql.includes("CASE WHEN sponsorship_reserved_transaction_count = 0")
    )
    expect(intentReservation?.args?.[1]).toBe(2)
    const finalizedIntent = client.statements.find((statement) =>
      statement.sql.includes("sponsorship_reserved_transaction_count = ?6")
    )
    expect(finalizedIntent?.args?.[5]).toBe(1)
  })
})
