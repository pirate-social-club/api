import { afterEach, describe, expect, test } from "bun:test"

import type { Env } from "../../env"
import type { Client, InStatement } from "../sql-client"
import {
  assertManualRewardInvalidatedBroadcastEvidence,
  assertManualRewardNoBroadcastEvidence,
} from "../communities/bookings/operator-signing-coordinator-do"
import {
  resolveRewardSettlementManually,
  setRewardSettlementManualResolutionCoordinatorForTests,
} from "./reward-settlement-manual-resolution"

const TX_HASH = `0x${"11".repeat(32)}`
const COORDINATOR_REF = JSON.stringify(["reward_payout", "user:test:reward_payout:key"])

afterEach(() => setRewardSettlementManualResolutionCoordinatorForTests(null))

function client(row: Record<string, unknown>): Client {
  return {
    execute: async (_statement: InStatement | string) => ({ rows: [row] }),
    batch: async () => [],
    transaction: async () => { throw new Error("not used") },
  }
}

describe("manual reward settlement resolution", () => {
  test("requires both an absent transaction and an unchanged pending nonce", () => {
    expect(() => assertManualRewardNoBroadcastEvidence({
      liveness: "absent",
      pendingNonce: 1,
      expectedNonce: 1,
    })).not.toThrow()
    expect(() => assertManualRewardNoBroadcastEvidence({
      liveness: "pending",
      pendingNonce: 1,
      expectedNonce: 1,
    })).toThrow("absent transaction")
    expect(() => assertManualRewardNoBroadcastEvidence({
      liveness: "absent",
      pendingNonce: 2,
      expectedNonce: 1,
    })).toThrow("unchanged pending nonce")
  })

  test("requires a mined replacement before an ambiguous broadcast can fail", () => {
    expect(() => assertManualRewardInvalidatedBroadcastEvidence({
      liveness: "absent",
      latestNonce: 3,
      pendingNonce: 3,
      expectedNonce: 2,
    })).not.toThrow()
    expect(() => assertManualRewardInvalidatedBroadcastEvidence({
      liveness: "absent",
      latestNonce: 2,
      pendingNonce: 3,
      expectedNonce: 2,
    })).toThrow("nonce is mined by a replacement")
    expect(() => assertManualRewardInvalidatedBroadcastEvidence({
      liveness: "pending",
      latestNonce: 3,
      pendingNonce: 3,
      expectedNonce: 2,
    })).toThrow("nonce is mined by a replacement")
  })

  test("requires the mirror to be reconciliation-required with exact tx evidence", async () => {
    await expect(resolveRewardSettlementManually({
      env: {} as Env,
      client: client({
        coordinator_ref: COORDINATOR_REF,
        coordinator_state: "broadcast",
        tx_hash: TX_HASH,
      }),
      effectKind: "cashout",
      effectId: "rpe_test",
      expectedTxHash: TX_HASH,
      resolution: "confirmed",
      reason: "Receipt and event verified.",
      operatorActorId: "reward-operator",
    })).rejects.toThrow("not awaiting manual reconciliation")
  })

  test("passes the durable coordinator key and exact evidence to the DO", async () => {
    let received: Record<string, unknown> | null = null
    setRewardSettlementManualResolutionCoordinatorForTests({
      resolveRewardNoBroadcast: async () => { throw new Error("not used") },
      resolveRewardInvalidatedBroadcast: async () => { throw new Error("not used") },
      resolveRewardReconciliation: async (value) => {
        received = value
        return {
          idempotencyKey: value.idempotencyKey,
          txHash: value.expectedTxHash,
          nonce: 4,
          state: value.resolution,
        }
      },
    })
    const result = await resolveRewardSettlementManually({
      env: {} as Env,
      client: client({
        coordinator_ref: COORDINATOR_REF,
        coordinator_state: "reconciliation_required",
        tx_hash: TX_HASH,
      }),
      effectKind: "cashout",
      effectId: "rpe_test",
      expectedTxHash: TX_HASH,
      resolution: "confirmed",
      reason: "Receipt and event independently verified.",
      operatorActorId: "reward-operator",
    })
    expect(result.state).toBe("confirmed")
    expect(received).toEqual({
      idempotencyKey: COORDINATOR_REF,
      expectedTxHash: TX_HASH,
      resolution: "confirmed",
      reason: "Receipt and event independently verified.",
      operatorActorId: "reward-operator",
    })
  })

  test("terminalizes an evidenced pre-broadcast effect and releases its allocation", async () => {
    const statements: string[] = []
    let committed = false
    let received: Record<string, unknown> | null = null
    setRewardSettlementManualResolutionCoordinatorForTests({
      resolveRewardReconciliation: async () => { throw new Error("not used") },
      resolveRewardInvalidatedBroadcast: async () => { throw new Error("not used") },
      resolveRewardNoBroadcast: async (value) => {
        received = value
        return {
          idempotencyKey: value.idempotencyKey,
          txHash: value.expectedTxHash,
          nonce: value.expectedNonce,
          state: "preparation_parked",
        }
      },
    })
    const tx = {
      execute: async (statement: InStatement | string) => {
        const sql = typeof statement === "string" ? statement : statement.sql
        statements.push(sql)
        return { rows: sql.includes("UPDATE reward_payout_effects") ? [{ reward_payout_effect_id: "rpe_test" }] : [] }
      },
      batch: async () => [],
      commit: async () => { committed = true },
      rollback: async () => undefined,
      close: () => undefined,
    }
    const prebroadcastClient = {
      execute: async () => ({
        rows: [{
          coordinator_ref: COORDINATOR_REF,
          coordinator_state: "prepared",
          tx_hash: TX_HASH,
          broadcast_nonce: 1,
        }],
      }),
      batch: async () => [],
      transaction: async () => tx,
    } as Client

    const result = await resolveRewardSettlementManually({
      env: {} as Env,
      client: prebroadcastClient,
      effectKind: "cashout",
      effectId: "rpe_test",
      expectedTxHash: TX_HASH,
      expectedNonce: 1,
      resolution: "failed_prebroadcast",
      reason: "Transaction absent and operator nonce unchanged.",
      operatorActorId: "reward-operator",
    })

    expect(result.state).toBe("preparation_parked")
    expect(received).toMatchObject({ expectedTxHash: TX_HASH, expectedNonce: 1 })
    expect(committed).toBe(true)
    expect(statements.some((sql) => sql.includes("UPDATE reward_payout_effects"))).toBe(true)
    expect(statements.some((sql) => sql.includes("UPDATE reward_payout_allocations"))).toBe(true)
  })

  test("terminalizes a parked ambiguous broadcast only through nonce-invalidation recovery", async () => {
    const statements: InStatement[] = []
    let received: Record<string, unknown> | null = null
    setRewardSettlementManualResolutionCoordinatorForTests({
      resolveRewardReconciliation: async () => { throw new Error("not used") },
      resolveRewardNoBroadcast: async () => { throw new Error("not used") },
      resolveRewardInvalidatedBroadcast: async (value) => {
        received = value
        return {
          idempotencyKey: value.idempotencyKey,
          txHash: value.expectedTxHash,
          nonce: value.expectedNonce,
          state: "preparation_parked",
          manualResolution: {
            resolution: "failed_nonce_invalidated",
            reason: value.reason,
            operatorActorId: value.operatorActorId,
            resolvedAt: Date.now(),
          },
        }
      },
    })
    const tx = {
      execute: async (statement: InStatement | string) => {
        const normalized = typeof statement === "string" ? { sql: statement, args: [] } : statement
        statements.push(normalized)
        return {
          rows: normalized.sql.includes("UPDATE reward_payout_effects")
            ? [{ reward_payout_effect_id: "rpe_test" }]
            : [],
        }
      },
      batch: async () => [],
      commit: async () => undefined,
      rollback: async () => undefined,
      close: () => undefined,
    }
    const invalidatedClient = {
      execute: async () => ({
        rows: [{
          coordinator_ref: COORDINATOR_REF,
          coordinator_state: "preparation_parked",
          tx_hash: TX_HASH,
          broadcast_nonce: 2,
        }],
      }),
      batch: async () => [],
      transaction: async () => tx,
    } as Client

    await resolveRewardSettlementManually({
      env: {} as Env,
      client: invalidatedClient,
      effectKind: "cashout",
      effectId: "rpe_test",
      expectedTxHash: TX_HASH,
      expectedNonce: 2,
      resolution: "failed_nonce_invalidated",
      reason: "Replacement transaction mined at the same nonce.",
      operatorActorId: "reward-operator",
    })

    expect(received).toMatchObject({ expectedTxHash: TX_HASH, expectedNonce: 2 })
    expect(statements[0]?.args).toContain("failed_nonce_invalidated")
    expect(statements[0]?.args).toContain("preparation_parked")
  })
})
