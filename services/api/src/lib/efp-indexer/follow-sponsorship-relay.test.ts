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

function relayClient(input?: {
  budgetDate?: string | null
  reservedCount?: number
  sponsoredCount?: number
}): Client & { statements: InStatement[] } {
  const statements: InStatement[] = []
  let transactionNumber = 0
  let currentBudgetDate = input?.budgetDate ?? null
  const transaction = async (): Promise<Transaction> => {
    transactionNumber += 1
    return {
      async execute(statement): Promise<QueryResult> {
        const normalized = typeof statement === "string" ? { sql: statement } : statement
        statements.push(normalized)
        if (normalized.sql.includes("sponsorship_budget_date = ?4")) {
          currentBudgetDate = String(normalized.args?.[3] ?? "")
        }
        if (normalized.sql.includes("SELECT i.*")) {
          return {
            rows: [{
              actor_wallet_address: VIEWER,
              attachment_kind: "embedded",
              source_provider: "privy",
              verification_state: "verified",
              expires_at: "2026-07-29T00:00:00.000Z",
              status: "prepared",
              sponsored_transaction_count: input?.sponsoredCount ?? 0,
              sponsorship_reserved_transaction_count: input?.reservedCount ?? 0,
              sponsorship_budget_date: input?.budgetDate ?? null,
              prepared_transaction_count: 2,
              prepared_transactions_json: [
                { chain_id: 8453, data: DATA_ONE, to: RECORDS },
                { chain_id: 8453, data: DATA_TWO, to: RECORDS },
              ],
            }],
          }
        }
        if (normalized.sql.includes("SELECT transaction_limit")) {
          return {
            rows: [{
              transaction_limit: 100,
              reserved_transactions: normalized.args?.[0] === input?.budgetDate
                ? input?.reservedCount ?? 0
                : 0,
              consumed_transactions: 0,
            }],
          }
        }
        if (normalized.sql.includes("SELECT prepared_transaction_count")) {
          return {
            rows: [{
              prepared_transaction_count: 2,
              sponsored_transaction_count: input?.sponsoredCount ?? 0,
              sponsorship_reserved_transaction_count: input?.reservedCount ?? 2,
              sponsorship_budget_date: currentBudgetDate ?? "2026-07-28",
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

  test("moves a remaining reservation to the UTC day that submits the second transaction", async () => {
    const client = relayClient({
      budgetDate: "2026-07-28",
      reservedCount: 1,
      sponsoredCount: 1,
    })
    const result = await relaySponsoredFollowTransaction({
      actorUserId: "viewer",
      client,
      env: {
        PRIVY_APP_ID: "app",
        PRIVY_APP_SECRET: "secret",
        EFP_FOLLOW_SPONSOR_DAILY_TRANSACTION_LIMIT: "100",
        EFP_FOLLOW_SPONSOR_ESTIMATED_USD_MICROS_PER_TRANSACTION: "800",
      } as Env,
      now: new Date("2026-07-29T12:00:00.000Z"),
      request: {
        authorizationSignature: "signature",
        requestExpiry: String(new Date("2026-07-29T12:15:00.000Z").getTime()),
        intentId: `efw_${"b".repeat(32)}`,
        transactionIndex: 1,
        privyWalletId: "wallet-id",
        walletAddress: VIEWER,
        transaction: { data: DATA_TWO, to: RECORDS },
      },
      fetcher: async () => Response.json({ data: { hash: HASH } }),
    })

    expect(result.txHash).toBe(HASH)
    const oldDayRelease = client.statements.find((statement) =>
      statement.sql.includes("reserved_transactions = reserved_transactions - ?2")
    )
    expect(oldDayRelease?.args).toEqual(["2026-07-28", 1, "2026-07-29T12:00:00.000Z"])
    const newDayReservation = client.statements.find((statement) =>
      statement.sql.includes("reserved_transactions = reserved_transactions + ?2")
    )
    expect(newDayReservation?.args).toEqual(["2026-07-29", 1, "2026-07-29T12:00:00.000Z"])
    const finalizedBudget = client.statements.find((statement) =>
      statement.sql.includes("consumed_transactions = consumed_transactions + 1")
    )
    expect(finalizedBudget?.args).toEqual(["2026-07-29", "2026-07-29T12:00:00.000Z"])
  })

  test("recovers an ambiguously accepted send from indexed chain evidence", async () => {
    const client = relayClient()
    client.execute = async (statement): Promise<QueryResult> => {
      const query = typeof statement === "string" ? statement : statement.sql
      if (query.includes("FROM efp_follow_write_intents") && query.includes("sponsorship_review_after, status")) {
        return {
          rows: [{
            actor_user_id: "viewer",
            actor_wallet_address: VIEWER,
            desired_following: 1,
            follow_write_intent_id: `efw_${"b".repeat(32)}`,
            list_chain_id: 8453,
            list_slot: "123",
            prepared_transactions_json: [
              { chain_id: 8453, data: DATA_ONE, to: RECORDS },
              { chain_id: 8453, data: DATA_TWO, to: RECORDS },
            ],
            sponsored_transaction_count: 0,
            sponsorship_review_after: "2026-07-29T12:00:00.000Z",
            status: "submitting",
            target_wallet_address: TARGET,
          }],
        }
      }
      if (query.includes("FROM efp_list_ops")) return { rows: [{ transaction_hash: HASH }] }
      if (query.includes("ROW_NUMBER() OVER")) return { rows: [] }
      if (query.includes("UPDATE efp_follow_write_intents") && query.includes("status = 'expired'")) {
        return { rows: [], rowsAffected: 0 }
      }
      throw new Error(`Unexpected SQL: ${query}`)
    }
    const result = await reconcilePendingPrivyFollowSubmissions({
      client,
      env: {
        PRIVY_APP_ID: "app",
        PRIVY_APP_SECRET: "secret",
        EFP_FOLLOW_SPONSOR_DAILY_TRANSACTION_LIMIT: "100",
        EFP_FOLLOW_SPONSOR_ESTIMATED_USD_MICROS_PER_TRANSACTION: "800",
      } as Env,
      now: new Date("2026-07-28T12:01:00.000Z"),
      fetcher: async () => { throw new Error("Privy lookup must not run when chain evidence exists") },
    })
    expect(result).toEqual({
      examined: 1,
      recovered: 1,
      expired: 0,
      manual_review: 0,
      superseded: 0,
    })
  })

  test("supersedes later partial duplicates deterministically and expires untouched intents", async () => {
    const statements: InStatement[] = []
    const db = {
      async execute(statement: string | InStatement): Promise<QueryResult> {
        const normalized = typeof statement === "string" ? { sql: statement } : statement
        statements.push(normalized)
        if (normalized.sql.includes("sponsorship_review_after, status")) return { rows: [] }
        if (normalized.sql.includes("ROW_NUMBER() OVER")) {
          expect(normalized.sql).toContain("ORDER BY created_at ASC, follow_write_intent_id ASC")
          return { rows: [{ follow_write_intent_id: `efw_${"c".repeat(32)}` }] }
        }
        if (normalized.sql.includes("status = 'expired'")) return { rows: [], rowsAffected: 7 }
        throw new Error(`Unexpected SQL: ${normalized.sql}`)
      },
      async batch() { return [] },
      async transaction(): Promise<Transaction> {
        return {
          async execute(statement): Promise<QueryResult> {
            const normalized = typeof statement === "string" ? { sql: statement } : statement
            statements.push(normalized)
            if (normalized.sql.includes("SELECT sponsorship_reserved_transaction_count")) {
              return {
                rows: [{
                  sponsorship_budget_date: "2026-07-30",
                  sponsorship_reserved_transaction_count: 1,
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
      },
    } satisfies Client

    const result = await reconcilePendingPrivyFollowSubmissions({
      client: db,
      env: {
        PRIVY_APP_ID: "app",
        PRIVY_APP_SECRET: "secret",
        EFP_FOLLOW_SPONSOR_DAILY_TRANSACTION_LIMIT: "100",
        EFP_FOLLOW_SPONSOR_ESTIMATED_USD_MICROS_PER_TRANSACTION: "800",
      } as Env,
      now: new Date("2026-08-03T12:00:00.000Z"),
    })

    expect(result).toEqual({
      examined: 0,
      recovered: 0,
      expired: 7,
      manual_review: 0,
      superseded: 1,
    })
    const failedDuplicate = statements.find((statement) =>
      statement.sql.includes("Superseded duplicate bootstrap")
    )
    expect(failedDuplicate?.args?.[0]).toBe(`efw_${"c".repeat(32)}`)
    const expiry = statements.find((statement) => statement.sql.includes("status = 'expired'"))
    expect(expiry?.sql).toContain("sponsored_transaction_count = 0")
    expect(expiry?.sql).toContain("sponsorship_reserved_transaction_count = 0")
  })

  test("recovers indexed evidence after manual review and refunds only the unbroadcast suffix", async () => {
    const statements: InStatement[] = []
    const intentId = `efw_${"d".repeat(32)}`
    const db = {
      async execute(statement: string | InStatement): Promise<QueryResult> {
        const normalized = typeof statement === "string" ? { sql: statement } : statement
        statements.push(normalized)
        if (normalized.sql.includes("sponsorship_review_after, status")) {
          return {
            rows: [{
              actor_user_id: "viewer",
              actor_wallet_address: VIEWER,
              desired_following: 1,
              follow_write_intent_id: intentId,
              list_chain_id: 8453,
              list_slot: "123",
              prepared_transactions_json: [
                { chain_id: 8453, data: DATA_ONE, to: RECORDS },
                { chain_id: 8453, data: DATA_TWO, to: RECORDS },
              ],
              sponsored_transaction_count: 0,
              sponsorship_review_after: null,
              status: "manual_review",
              target_wallet_address: TARGET,
            }],
          }
        }
        if (normalized.sql.includes("FROM efp_list_ops")) {
          expect(normalized.sql).toContain("lower(substr(raw_op, length(raw_op) - 39, 40))")
          return { rows: [{ transaction_hash: HASH }] }
        }
        if (normalized.sql.includes("ROW_NUMBER() OVER")) return { rows: [] }
        if (normalized.sql.includes("status = 'expired'")) return { rows: [], rowsAffected: 0 }
        throw new Error(`Unexpected SQL: ${normalized.sql}`)
      },
      async batch() { return [] },
      async transaction(): Promise<Transaction> {
        return {
          async execute(statement): Promise<QueryResult> {
            const normalized = typeof statement === "string" ? { sql: statement } : statement
            statements.push(normalized)
            if (normalized.sql.includes("status = 'manual_review'") && normalized.sql.includes("FOR UPDATE")) {
              return {
                rows: [{
                  actor_wallet_address: VIEWER,
                  created_at: "2026-07-30T12:02:11.088Z",
                  prepared_transaction_count: 2,
                  sponsored_transaction_count: 0,
                  sponsorship_budget_date: null,
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
      },
    } satisfies Client

    const result = await reconcilePendingPrivyFollowSubmissions({
      client: db,
      env: {
        PRIVY_APP_ID: "app",
        PRIVY_APP_SECRET: "secret",
        EFP_FOLLOW_SPONSOR_DAILY_TRANSACTION_LIMIT: "100",
        EFP_FOLLOW_SPONSOR_ESTIMATED_USD_MICROS_PER_TRANSACTION: "800",
      } as Env,
      now: new Date("2026-08-03T12:00:00.000Z"),
      fetcher: async () => { throw new Error("Privy lookup must not run when chain evidence exists") },
    })

    expect(result).toEqual({
      examined: 1,
      recovered: 1,
      expired: 0,
      manual_review: 0,
      superseded: 0,
    })
    const refund = statements.find((statement) =>
      statement.sql.includes("consumed_transactions = consumed_transactions - ?2")
    )
    expect(refund?.args).toEqual(["2026-07-30", 1, "2026-08-03T12:00:00.000Z"])
    const recovered = statements.find((statement) =>
      statement.sql.includes("Recovered sponsored transaction from indexed chain evidence")
    )
    expect(recovered?.args).toEqual([
      intentId,
      1,
      JSON.stringify([HASH]),
      "prepared",
      "2026-08-03T12:00:00.000Z",
    ])
  })
})
