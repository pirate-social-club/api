import { afterEach, describe, expect, test } from "bun:test"

import type { Env } from "../../../env"
import { conflictError, retryableConflictError } from "../../errors"
import { setControlPlanePostgresPoolFactoryForTests } from "../../runtime-deps"
import {
  classifyHandleClaimFinalizationError,
  reconcileFundedHandleClaimIntents,
} from "./handle-claim-finalization-reconciler"

afterEach(() => setControlPlanePostgresPoolFactoryForTests(null))

describe("handle claim finalization error classification", () => {
  test("routes deterministic conflicts and label uniqueness races to refunds", () => {
    expect(classifyHandleClaimFinalizationError(conflictError("reservation is gone"))).toEqual({
      kind: "terminal",
      reason: "reservation is gone",
    })
    expect(classifyHandleClaimFinalizationError(new Error("UNIQUE constraint failed: namespace, label")))
      .toMatchObject({ kind: "terminal" })
  })

  test("retains transient transport and explicitly retryable errors for reconciliation", () => {
    expect(classifyHandleClaimFinalizationError(new Error("shard binding unavailable")))
      .toMatchObject({ kind: "retryable" })
    expect(classifyHandleClaimFinalizationError(retryableConflictError("try again")))
      .toMatchObject({ kind: "retryable" })
  })

  test("closes the selection Postgres adapter before invoking a shard finalizer", async () => {
    const pools: Array<{ ended: boolean; endCalls: number }> = []
    let poolNumber = 0
    setControlPlanePostgresPoolFactoryForTests(() => {
      poolNumber += 1
      const state = { ended: false, endCalls: 0 }
      pools.push(state)
      const transactionClient = {
        query: async (text: string) => {
          if (text.includes("UPDATE community_handle_claim_intents")) {
            return { rows: [{ community_handle_claim_intent_id: "hci_pg" }], rowCount: 1 }
          }
          return { rows: [], rowCount: 0 }
        },
        release: () => undefined,
      }
      return {
        query: async (text: string) => {
          if (state.ended) throw new Error("query used a closed pool")
          if (text.includes("UPDATE community_handle_token_allocations")) {
            return { rows: [], rowCount: 0 }
          }
          if (!text.includes("FROM community_handle_claim_intents")) throw new Error("unexpected query")
          return {
            rows: [{
              community_handle_claim_intent_id: "hci_pg",
              community_id: "cmt_pg",
              actor_user_id: "usr_pg",
              namespace_id: "ns_pg",
              namespace_normalized_label: "example",
              label_normalized: "card",
              label_display: "card",
              price_cents: 500,
              pricing_model: "flat",
              pricing_tier: "standard",
              settlement_wallet_attachment_id: "wa_pg",
              protocol_owner_wallet_attachment_id: null,
              protocol_owner_script_pubkey_hex: null,
              protocol_issuance_required: false,
              latest_quote_id: "hcq_pg",
              funding_tx_hash: `0x${"11".repeat(32)}`,
            }],
            rowCount: 1,
          }
        },
        connect: async () => transactionClient,
        end: async () => {
          state.endCalls += 1
          state.ended = true
        },
      } as never
    })
    const env = {
      CONTROL_PLANE_DATABASE_URL: "postgres://test:test@control-plane.invalid/test",
      ENVIRONMENT: "test",
    } as Env

    const summary = await reconcileFundedHandleClaimIntents({
      env,
      finalize: async () => {
        expect(pools.every((pool) => pool.ended)).toBe(true)
        return { kind: "completed", handleId: "ch_pg" }
      },
    })

    expect(summary).toMatchObject({ scanned: 1, completed: 1, errors: 0 })
    expect(pools).toHaveLength(2)
    expect(pools.every((pool) => pool.ended && pool.endCalls === 1)).toBe(true)
  })
})
