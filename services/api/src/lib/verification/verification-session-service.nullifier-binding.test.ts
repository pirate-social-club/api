import { describe, expect, test } from "bun:test"
import type { Client, InStatement } from "../sql-client"
import {
  isActiveIdentityNullifierUniqueConflict,
  writeVerificationBatchWithNullifierRetry,
  type ActiveIdentityNullifier,
  type IdentityNullifierInput,
} from "./verification-session-service"

const identityNullifier: IdentityNullifierInput = {
  provider: "self",
  mechanism: "zk-nullifier",
  nullifierHash: "a".repeat(64),
}

function conflict(constraint = "idx_identity_nullifiers_active_unique") {
  return Object.assign(new Error(`duplicate key value violates unique constraint "${constraint}"`), {
    code: "23505",
    constraint,
  })
}

describe("active identity nullifier conflict classification", () => {
  test("accepts only the known partial unique index or its SQLite field set", () => {
    expect(isActiveIdentityNullifierUniqueConflict(conflict())).toBe(true)
    expect(isActiveIdentityNullifierUniqueConflict(Object.assign(
      new Error("UNIQUE constraint failed: identity_nullifiers.provider, identity_nullifiers.mechanism, identity_nullifiers.nullifier_hash"),
      { code: "SQLITE_CONSTRAINT_UNIQUE" },
    ))).toBe(true)
    expect(isActiveIdentityNullifierUniqueConflict(conflict("user_attestations_pkey"))).toBe(false)
    expect(isActiveIdentityNullifierUniqueConflict(new Error("network unavailable"))).toBe(false)
  })
})

describe("writeVerificationBatchWithNullifierRetry", () => {
  test("resolves the winning nullifier and replays once through the reuse branch", async () => {
    const winner: ActiveIdentityNullifier = { identityNullifierId: "nul_winner", userId: "usr_1" }
    const builtFor: Array<ActiveIdentityNullifier | null> = []
    let batchCalls = 0
    let resolveCalls = 0
    const client = {
      batch: async () => {
        batchCalls += 1
        if (batchCalls === 1) throw conflict()
        return []
      },
      execute: async () => {
        resolveCalls += 1
        return { rows: [{ identity_nullifier_id: winner.identityNullifierId, user_id: winner.userId }] }
      },
    } as unknown as Client

    await writeVerificationBatchWithNullifierRetry({
      client,
      userId: "usr_1",
      identityNullifier,
      activeNullifier: null,
      buildBatchStatements: (active) => {
        builtFor.push(active)
        return [{ sql: "SELECT 1" }]
      },
    })

    expect(batchCalls).toBe(2)
    expect(resolveCalls).toBe(1)
    expect(builtFor).toEqual([null, winner])
  })

  test("does not retry unrelated uniqueness failures", async () => {
    const error = conflict("user_attestations_pkey")
    let resolveCalls = 0
    const client = {
      batch: async () => { throw error },
      execute: async () => {
        resolveCalls += 1
        return { rows: [] }
      },
    } as unknown as Client

    await expect(writeVerificationBatchWithNullifierRetry({
      client,
      userId: "usr_1",
      identityNullifier,
      activeNullifier: null,
      buildBatchStatements: (): InStatement[] => [{ sql: "SELECT 1" }],
    })).rejects.toBe(error)
    expect(resolveCalls).toBe(0)
  })

  test("bounds the active-nullifier conflict retry to one replay", async () => {
    let batchCalls = 0
    const secondError = conflict()
    const client = {
      batch: async () => {
        batchCalls += 1
        throw batchCalls === 1 ? conflict() : secondError
      },
      execute: async () => ({
        rows: [{ identity_nullifier_id: "nul_winner", user_id: "usr_1" }],
      }),
    } as unknown as Client

    await expect(writeVerificationBatchWithNullifierRetry({
      client,
      userId: "usr_1",
      identityNullifier,
      activeNullifier: null,
      buildBatchStatements: (): InStatement[] => [{ sql: "SELECT 1" }],
    })).rejects.toBe(secondError)
    expect(batchCalls).toBe(2)
  })

  test("rejects a race won by another user without replaying their binding", async () => {
    let batchCalls = 0
    const client = {
      batch: async () => {
        batchCalls += 1
        throw conflict()
      },
      execute: async () => ({
        rows: [{ identity_nullifier_id: "nul_other", user_id: "usr_other" }],
      }),
    } as unknown as Client

    await expect(writeVerificationBatchWithNullifierRetry({
      client,
      userId: "usr_1",
      identityNullifier,
      activeNullifier: null,
      buildBatchStatements: (): InStatement[] => [{ sql: "SELECT 1" }],
    })).rejects.toMatchObject({ status: 403 })
    expect(batchCalls).toBe(1)
  })
})
