import { describe, expect, test } from "bun:test"

import type { Env } from "../../env"
import type { UserRepository } from "../auth/repositories"
import { HttpError } from "../errors"
import type { Client, InStatement, QueryResult } from "../sql-client"
import { prepareProfileFollowWrite, reconcilePendingFollowWrites } from "./follow-write-service"

const VIEWER = "0x1111111111111111111111111111111111111111"
const TARGET = "0x2222222222222222222222222222222222222222"

function users(): UserRepository {
  return {
    async getUserById() { return null },
    async getWalletAttachmentById() { return null },
    async setIdentityWallet() { return null },
    async getWalletAttachmentsByUserId(userId) {
      return [{
        wallet_attachment: `wal_${userId}`,
        chain_namespace: "eip155",
        wallet_address: userId === "viewer" ? VIEWER : TARGET,
        is_primary: true,
      }]
    },
  }
}

function client(input?: {
  reflected?: boolean
  resumableRow?: Record<string, unknown>
}): Client & { inserts: InStatement[] } {
  const inserts: InStatement[] = []
  return {
    inserts,
    async execute(statement): Promise<QueryResult> {
      const query = typeof statement === "string" ? statement : statement.sql
      if (query.includes("FROM wallet_attachments")) {
        return { rows: [{ attachment_kind: "embedded", source_provider: "privy", verification_state: "verified" }] }
      }
      if (query.includes("COUNT(*) AS write_count")) return { rows: [{ write_count: 0 }] }
      if (query.includes("WHERE actor_user_id = ?1 AND idempotency_key")) return { rows: [] }
      if (query.includes("sponsored_transaction_count > 0")) {
        return { rows: input?.resumableRow ? [input.resumableRow] : [] }
      }
      if (query.includes("FROM efp_effective_follows")) {
        return { rows: input?.reflected ? [{ edge: 1 }] : [] }
      }
      if (query.includes("INSERT INTO efp_follow_write_intents")) {
        inserts.push(statement as InStatement)
        return { rows: [], rowsAffected: 1 }
      }
      throw new Error(`Unexpected SQL: ${query}`)
    },
    async batch() { return [] },
    async transaction() { throw new Error("not used") },
  }
}

const ENV = {
  BASE_MAINNET_RPC_URL: "https://base.invalid",
  EFP_FOLLOW_ACCOUNT_HOURLY_LIMIT: "20",
} as Env

describe("prepareProfileFollowWrite", () => {
  test("returns idempotent success without preparing a transaction when already reflected", async () => {
    const result = await prepareProfileFollowWrite({
      actorUserId: "viewer",
      client: client({ reflected: true }),
      desiredFollowing: true,
      env: ENV,
      idempotencyKey: "idem-1",
      targetPublicUserId: "usr_target",
      targetUserId: "target",
      users: users(),
      resolvePrimaryList: async () => {
        throw new Error("resolver must not run")
      },
    })
    expect(result.consistency.status).toBe("already_reflected")
    expect(result.transactions).toEqual([])
  })

  test("fails closed when primary-list state is unresolved", async () => {
    const write = prepareProfileFollowWrite({
      actorUserId: "viewer",
      client: client(),
      desiredFollowing: true,
      env: ENV,
      idempotencyKey: "idem-2",
      targetPublicUserId: "usr_target",
      targetUserId: "target",
      users: users(),
      resolvePrimaryList: async () => ({ kind: "unresolved" }),
    })
    await expect(write).rejects.toThrow("Unable to load your follow list right now")
    await write.catch((error) => {
      expect(error).toBeInstanceOf(HttpError)
      expect((error as HttpError).retryable).toBe(true)
    })
  })

  test("prepares and records both Base transactions only for a proven absent list", async () => {
    const db = client()
    const result = await prepareProfileFollowWrite({
      actorUserId: "viewer",
      client: db,
      desiredFollowing: true,
      env: ENV,
      idempotencyKey: "idem-3",
      now: new Date("2026-07-28T00:00:00.000Z"),
      targetPublicUserId: "usr_target",
      targetUserId: "target",
      users: users(),
      resolvePrimaryList: async () => ({ kind: "none" }),
    })
    expect(result.consistency.status).toBe("accepted_not_yet_reflected")
    expect(result.sponsorship.eligible).toBe(true)
    expect(result.transactions).toHaveLength(2)
    expect(result.transactions.every((transaction) => transaction.chain_id === 8453)).toBe(true)
    expect(db.inserts).toHaveLength(1)
    expect(db.inserts[0]?.args?.[7]).toBe("none")
    expect(db.inserts[0]?.args?.[11]).toBe(2)
  })

  test("resumes only the unsent suffix of an incomplete bootstrap", async () => {
    const transactions = [
      { chain_id: 8453, data: "0x01", to: VIEWER },
      { chain_id: 8453, data: "0x02", to: TARGET },
    ]
    const result = await prepareProfileFollowWrite({
      actorUserId: "viewer",
      client: client({
        resumableRow: {
          expires_at: "2026-07-28T01:00:00.000Z",
          follow_write_intent_id: "efw_11111111111111111111111111111111",
          prepared_transactions_json: transactions,
          sponsored_transaction_count: 1,
          sponsorship_reserved_transaction_count: 1,
        },
      }),
      desiredFollowing: true,
      env: ENV,
      idempotencyKey: "idem-resume",
      now: new Date("2026-07-28T00:00:00.000Z"),
      targetPublicUserId: "usr_target",
      targetUserId: "target",
      users: users(),
      resolvePrimaryList: async () => {
        throw new Error("resolver must not run for a resumable write")
      },
    })

    expect(result.intent_id).toBe("efw_11111111111111111111111111111111")
    expect(result.prepared_transaction_count).toBe(2)
    expect(result.transaction_index_offset).toBe(1)
    expect(result.transactions).toEqual([transactions[1]])
    expect(result.sponsorship.reserved_transaction_count).toBe(1)
  })
})

describe("reconcilePendingFollowWrites", () => {
  test("selects the ordering expression so PostgreSQL accepts DISTINCT ordering", async () => {
    let pendingQuery = ""
    const db = {
      async execute(statement: string | InStatement) {
        pendingQuery = typeof statement === "string" ? statement : statement.sql
        return { rows: [] }
      },
      async batch() { return [] },
      async transaction() { throw new Error("not used") },
    } satisfies Client

    await expect(reconcilePendingFollowWrites({ client: db })).resolves.toEqual({
      examined: 0,
      reflected: 0,
    })
    expect(pendingQuery).toContain("i.updated_at AS intent_updated_at")
    expect(pendingQuery).toContain("ORDER BY intent_updated_at ASC")
  })
})
