import { describe, expect, test } from "bun:test"

import type { Env } from "../../env"
import type { UserRepository } from "../auth/repositories"
import { HttpError } from "../errors"
import type { Client, InStatement, QueryResult } from "../sql-client"
import {
  prepareProfileFollowWrite,
  readEfpFollowWeeklyAdoptionReport,
  reconcilePendingFollowWrites,
  recordEfpFollowAdoptionSnapshot,
} from "./follow-write-service"

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
  standing?: {
    attachment_kind: string
    source_provider: string
    verification_state: string
  }
}): Client & { inserts: InStatement[] } {
  const inserts: InStatement[] = []
  return {
    inserts,
    async execute(statement): Promise<QueryResult> {
      const query = typeof statement === "string" ? statement : statement.sql
      if (query.includes("FROM wallet_attachments")) {
        return {
          rows: [input?.standing ?? {
            attachment_kind: "embedded",
            source_provider: "privy",
            verification_state: "verified",
          }],
        }
      }
      if (query.includes("COUNT(*) AS write_count")) return { rows: [{ write_count: 0 }] }
      if (query.includes("WHERE actor_user_id = ?1 AND idempotency_key")) return { rows: [] }
      if (query.includes("status IN ('prepared', 'submitting', 'submitted', 'confirmed', 'manual_review')")) {
        return { rows: input?.resumableRow ? [input.resumableRow] : [] }
      }
      if (query.includes("FROM efp_effective_follows")) {
        return { rows: input?.reflected ? [{ edge: 1 }] : [] }
      }
      if (query.includes("INSERT INTO efp_follow_write_intents")) {
        inserts.push(statement as InStatement)
        return { rows: [{ follow_write_intent_id: "inserted" }], rowsAffected: 1 }
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
  test("allows sponsorship for an unverified embedded Privy wallet", async () => {
    const result = await prepareProfileFollowWrite({
      actorUserId: "viewer",
      client: client({
        standing: {
          attachment_kind: "embedded",
          source_provider: "privy",
          verification_state: "unverified",
        },
      }),
      desiredFollowing: true,
      env: ENV,
      idempotencyKey: "idem-unverified",
      targetPublicUserId: "usr_target",
      targetUserId: "target",
      users: users(),
      resolvePrimaryList: async () => ({ kind: "none" }),
    })

    expect(result.sponsorship.eligible).toBe(true)
    expect(result.transactions).toHaveLength(2)
  })

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
    expect(db.inserts[0]?.args?.[2]).toBe("viewer:target:follow")
    expect(db.inserts[0]?.args?.[8]).toBe("none")
    expect(db.inserts[0]?.args?.[12]).toBe(2)
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
          prepared_transaction_count: 2,
          status: "prepared",
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

  test("reuses the earliest active semantic attempt even with a fresh idempotency key", async () => {
    const transactions = [
      { chain_id: 8453, data: "0x01", to: VIEWER },
      { chain_id: 8453, data: "0x02", to: TARGET },
    ]
    const result = await prepareProfileFollowWrite({
      actorUserId: "viewer",
      client: client({
        resumableRow: {
          expires_at: "2026-07-28T01:00:00.000Z",
          follow_write_intent_id: "efw_22222222222222222222222222222222",
          prepared_transaction_count: 2,
          prepared_transactions_json: transactions,
          sponsored_transaction_count: 0,
          sponsorship_reserved_transaction_count: 0,
          status: "prepared",
        },
      }),
      desiredFollowing: true,
      env: ENV,
      idempotencyKey: "different-client-attempt",
      now: new Date("2026-07-28T00:00:00.000Z"),
      targetPublicUserId: "usr_target",
      targetUserId: "target",
      users: users(),
      resolvePrimaryList: async () => {
        throw new Error("resolver must not mint a duplicate slot")
      },
    })

    expect(result.intent_id).toBe("efw_22222222222222222222222222222222")
    expect(result.transactions).toEqual(transactions)
  })
})

describe("readEfpFollowWeeklyAdoptionReport", () => {
  test("returns the current totals and seven-day deltas from one query", async () => {
    const executed: InStatement[] = []
    const client = {
      async execute(statement: string | InStatement): Promise<QueryResult> {
        if (typeof statement === "string") throw new Error("Expected a parameterized statement")
        executed.push(statement)
        return {
          rows: [{
            snapshot_date: "2026-08-10T00:00:00.000Z",
            attached_wallets_in_graph: "12",
            edges_by_attached_wallets: "19",
            attached_wallets_weekly_delta: "3",
            edges_weekly_delta: "7",
          }],
        }
      },
      async batch() { return [] },
      async transaction() { throw new Error("not used") },
    } satisfies Client

    await expect(readEfpFollowWeeklyAdoptionReport({
      client,
      now: new Date("2026-08-10T00:01:00.000Z"),
    })).resolves.toEqual({
      snapshot_date: "2026-08-10",
      attached_wallets_in_graph: 12,
      edges_by_attached_wallets: 19,
      attached_wallets_weekly_delta: 3,
      edges_weekly_delta: 7,
    })
    expect(executed).toHaveLength(1)
    expect(executed[0]?.sql).toContain("INTERVAL '7 days'")
  })

  test("keeps weekly deltas unknown until a prior snapshot exists", async () => {
    const client = {
      async execute(): Promise<QueryResult> {
        return { rows: [{
          snapshot_date: "2026-08-10",
          attached_wallets_in_graph: 2,
          edges_by_attached_wallets: 1,
          attached_wallets_weekly_delta: null,
          edges_weekly_delta: null,
        }] }
      },
      async batch() { return [] },
      async transaction() { throw new Error("not used") },
    } satisfies Client

    const report = await readEfpFollowWeeklyAdoptionReport({ client })
    expect(report?.attached_wallets_weekly_delta).toBeNull()
    expect(report?.edges_weekly_delta).toBeNull()
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

describe("recordEfpFollowAdoptionSnapshot", () => {
  function snapshotClient(storedDates: Set<string>, opts?: { guardMissDate?: string }) {
    const executed: string[] = []
    const client = {
      executed,
      async execute(statement: string | InStatement): Promise<QueryResult> {
        const query = typeof statement === "string" ? statement : statement.sql
        const args = typeof statement === "string" ? [] : (statement.args ?? [])
        executed.push(query)
        const snapshotDate = String(args[0]).slice(0, 10)
        if (query.includes("FROM efp_follow_adoption_daily")) {
          const present = storedDates.has(snapshotDate) && snapshotDate !== opts?.guardMissDate
          return { rows: present ? [{ present: 1 }] : [] }
        }
        if (query.includes("INSERT INTO efp_follow_adoption_daily")) {
          // Emulate ON CONFLICT DO NOTHING RETURNING: a row comes back only
          // when this statement actually inserts.
          if (storedDates.has(snapshotDate)) return { rows: [], rowsAffected: 0 }
          storedDates.add(snapshotDate)
          return { rows: [{ snapshot_date: snapshotDate }], rowsAffected: 1 }
        }
        throw new Error(`Unexpected SQL: ${query}`)
      },
      async batch() { return [] },
      async transaction() { throw new Error("not used") },
    } satisfies Client & { executed: string[] }
    return client
  }

  test("records on the first run of a UTC date", async () => {
    const db = snapshotClient(new Set())
    const result = await recordEfpFollowAdoptionSnapshot({
      client: db,
      now: new Date("2026-08-03T00:01:00.000Z"),
    })
    expect(result).toEqual({ recorded: true })
    expect(db.executed.some((sql) => sql.includes("INSERT INTO efp_follow_adoption_daily"))).toBe(true)
  })

  test("skips the aggregation when today's row already exists", async () => {
    const db = snapshotClient(new Set())
    const now = new Date("2026-08-03T00:01:00.000Z")
    await recordEfpFollowAdoptionSnapshot({ client: db, now })
    const insertsBefore = db.executed.filter((sql) => sql.includes("INSERT INTO efp_follow_adoption_daily")).length

    const second = await recordEfpFollowAdoptionSnapshot({
      client: db,
      now: new Date("2026-08-03T00:02:00.000Z"),
    })
    expect(second).toEqual({ recorded: false })
    const insertsAfter = db.executed.filter((sql) => sql.includes("INSERT INTO efp_follow_adoption_daily")).length
    expect(insertsBefore).toBe(1)
    expect(insertsAfter).toBe(1)
  })

  test("records again on the next UTC date", async () => {
    const db = snapshotClient(new Set())
    await recordEfpFollowAdoptionSnapshot({ client: db, now: new Date("2026-08-03T23:59:00.000Z") })
    const next = await recordEfpFollowAdoptionSnapshot({ client: db, now: new Date("2026-08-04T00:00:00.000Z") })
    expect(next).toEqual({ recorded: true })
  })

  test("stays idempotent under a concurrent same-day insert", async () => {
    const db = snapshotClient(new Set())
    await recordEfpFollowAdoptionSnapshot({ client: db, now: new Date("2026-08-03T00:01:00.000Z") })
    const insert = db.executed.find((sql) => sql.includes("INSERT INTO efp_follow_adoption_daily"))
    expect(insert).toContain("ON CONFLICT (snapshot_date) DO NOTHING")
    expect(insert).toContain("RETURNING snapshot_date")
  })

  test("reports recorded: false when a concurrent tick wins the insert race", async () => {
    // The guard sees no row (concurrent tick has not committed yet), but the
    // conflicting insert returns no RETURNING row, so the log must not claim
    // a recording that did not happen.
    const db = snapshotClient(new Set(["2026-08-03"]), { guardMissDate: "2026-08-03" })
    const result = await recordEfpFollowAdoptionSnapshot({
      client: db,
      now: new Date("2026-08-03T00:01:00.000Z"),
    })
    expect(result).toEqual({ recorded: false })
  })
})
