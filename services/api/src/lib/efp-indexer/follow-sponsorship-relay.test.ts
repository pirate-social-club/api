import { describe, expect, test } from "bun:test"

import type { Env } from "../../env"
import type { Client, InStatement, QueryResult, Transaction } from "../sql-client"
import {
  reconcilePendingPrivyFollowSubmissions,
  relaySponsoredFollowTransaction,
} from "./follow-sponsorship-relay"

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
  test("sponsors without an alert webhook and reserves both bootstrap transactions first", async () => {
    const client = relayClient()
    const result = await relaySponsoredFollowTransaction({
      actorUserId: "viewer",
      client,
      env: {
        PRIVY_APP_ID: "app",
        PRIVY_APP_SECRET: "secret",
        EFP_FOLLOW_SPONSOR_DAILY_TRANSACTION_LIMIT: "100",
        EFP_FOLLOW_SPONSOR_ESTIMATED_USD_MICROS_PER_TRANSACTION: "800",
      } as Env,
      now: new Date("2026-07-28T12:00:00.000Z"),
      request: {
        authorizationSignature: "signature",
        requestExpiry: String(new Date("2026-07-28T12:15:00.000Z").getTime()),
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
          reference_id: `efw_${"b".repeat(32)}-0`,
          sponsor: true,
          params: { transaction: { data: DATA_ONE, to: RECORDS } },
        })
        expect(new Headers(init?.headers).get("privy-request-expiry")).toBe(
          String(new Date("2026-07-28T12:15:00.000Z").getTime()),
        )
        expect(new Headers(init?.headers).get("privy-idempotency-key")).toBe(
          `efw_${"b".repeat(32)}-0`,
        )
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

  test("polls an accepted sponsored transaction until Privy exposes its on-chain hash", async () => {
    const client = relayClient()
    let calls = 0
    const result = await relaySponsoredFollowTransaction({
      actorUserId: "viewer",
      client,
      env: {
        PRIVY_APP_ID: "app",
        PRIVY_APP_SECRET: "secret",
        EFP_FOLLOW_SPONSOR_DAILY_TRANSACTION_LIMIT: "100",
        EFP_FOLLOW_SPONSOR_ESTIMATED_USD_MICROS_PER_TRANSACTION: "800",
      } as Env,
      now: new Date("2026-07-28T12:00:00.000Z"),
      request: {
        authorizationSignature: "signature",
        requestExpiry: String(new Date("2026-07-28T12:15:00.000Z").getTime()),
        intentId: `efw_${"b".repeat(32)}`,
        transactionIndex: 0,
        privyWalletId: "wallet-id",
        walletAddress: VIEWER,
        transaction: { data: DATA_ONE, to: RECORDS },
      },
      fetcher: async (url) => {
        calls += 1
        if (String(url).includes("/rpc")) {
          return Response.json({
            data: { hash: "", transaction_id: "privy-transaction-id", user_operation_hash: HASH },
          })
        }
        expect(String(url)).toContain("/v1/transactions/privy-transaction-id")
        return Response.json({ status: "broadcasted", transaction_hash: HASH })
      },
    })
    expect(calls).toBe(2)
    expect(result.txHash).toBe(HASH)
  })

  test("recovers an ambiguously accepted send by deterministic Privy reference id", async () => {
    const client = relayClient()
    client.execute = async (statement): Promise<QueryResult> => {
      const query = typeof statement === "string" ? statement : statement.sql
      expect(query).toContain("status = 'submitting'")
      return {
        rows: [{
          actor_user_id: "viewer",
          follow_write_intent_id: `efw_${"b".repeat(32)}`,
          sponsored_transaction_count: 0,
        }],
      }
    }
    const urls: string[] = []
    const result = await reconcilePendingPrivyFollowSubmissions({
      client,
      env: {
        PRIVY_APP_ID: "app",
        PRIVY_APP_SECRET: "secret",
        EFP_FOLLOW_SPONSOR_DAILY_TRANSACTION_LIMIT: "100",
        EFP_FOLLOW_SPONSOR_ESTIMATED_USD_MICROS_PER_TRANSACTION: "800",
      } as Env,
      now: new Date("2026-07-28T12:01:00.000Z"),
      fetcher: async (url) => {
        urls.push(String(url))
        return Response.json({
          data: [{
            reference_id: `efw_${"b".repeat(32)}-0`,
            transaction_hash: HASH,
          }],
        })
      },
    })
    expect(result).toEqual({ examined: 1, recovered: 1 })
    expect(urls[0]).toContain(
      `reference_id=${encodeURIComponent(`efw_${"b".repeat(32)}-0`)}`,
    )
  })
})
