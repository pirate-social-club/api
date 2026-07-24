import { afterEach, describe, expect, test } from "bun:test"

import type { Env } from "../../env"
import type { Client, InStatement } from "../sql-client"
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
})
