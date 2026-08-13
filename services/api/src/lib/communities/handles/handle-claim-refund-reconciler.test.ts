import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test"
import { Wallet } from "ethers"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { Env } from "../../../env"
import {
  getControlPlaneClient,
  setControlPlanePostgresPoolFactoryForTests,
  withBackgroundControlPlaneClients,
} from "../../runtime-deps"
import {
  reconcileHandleClaimRefunds,
  setHandleClaimRefundCoordinatorForTests,
} from "./handle-claim-refund-reconciler"

const directory = mkdtempSync(join(tmpdir(), "handle-refund-reconciler-"))
const privateKey = `0x${"11".repeat(32)}`
const operatorAddress = new Wallet(privateKey).address
const senderAddress = "0x2222222222222222222222222222222222222222"
const tokenAddress = "0x036cbd53842c5426634e7929541ec2318f3dcf7e"
const fundingTxHash = `0x${"33".repeat(32)}`
const refundTxHash = `0x${"44".repeat(32)}`

const env = {
  CONTROL_PLANE_DATABASE_URL: `file:${join(directory, "control-plane.db")}`,
  COMMUNITY_HANDLE_CLAIM_INTENTS_ENABLED: "true",
  COMMUNITY_HANDLE_CLAIM_REFUNDS_ENABLED: "true",
  PIRATE_CHECKOUT_CUSTODY_KEY_EPOCH: "epoch_test",
  PIRATE_CHECKOUT_OPERATOR_ADDRESS: operatorAddress,
  PIRATE_CHECKOUT_OPERATOR_PRIVATE_KEY: privateKey,
  PIRATE_CHECKOUT_RPC_URL: "https://rpc.invalid",
  PIRATE_CHECKOUT_SOURCE_CHAIN_ID: "84532",
  PIRATE_CHECKOUT_USDC_TOKEN_ADDRESS: tokenAddress,
} as Env

async function controlPlane<T>(operation: (client: ReturnType<typeof getControlPlaneClient>) => Promise<T>) {
  return await withBackgroundControlPlaneClients(async () => await operation(getControlPlaneClient(env)))
}

beforeAll(async () => {
  await controlPlane(async (client) => {
    await client.batch([
      { sql: `CREATE TABLE observed_funding_receipts (
        observed_funding_receipt_id TEXT PRIMARY KEY,
        amount_atomic TEXT NOT NULL,
        sender_address TEXT NOT NULL,
        recipient_address TEXT NOT NULL
      )` },
      { sql: `CREATE TABLE community_handle_claim_intents (
        community_handle_claim_intent_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        chain_id INTEGER NOT NULL,
        token_address TEXT NOT NULL,
        funding_destination_address TEXT NOT NULL,
        custody_account_id TEXT NOT NULL,
        custody_key_epoch TEXT NOT NULL,
        funding_tx_hash TEXT NOT NULL,
        observed_funding_receipt_id TEXT NOT NULL,
        refund_coordinator_ref TEXT,
        refund_coordinator_state TEXT,
        refund_tx_hash TEXT,
        refund_attempt_count INTEGER NOT NULL DEFAULT 0,
        refund_last_error TEXT,
        refunded_at TEXT,
        updated_at TEXT NOT NULL
      )` },
    ], "write")
  })
})

afterEach(async () => {
  setHandleClaimRefundCoordinatorForTests(null)
  setControlPlanePostgresPoolFactoryForTests(null)
  await controlPlane(async (client) => {
    await client.batch([
      { sql: "DELETE FROM community_handle_claim_intents" },
      { sql: "DELETE FROM observed_funding_receipts" },
    ], "write")
  })
})

afterAll(() => rmSync(directory, { force: true, recursive: true }))

async function seed(intentId: string): Promise<void> {
  await controlPlane(async (client) => {
    await client.batch([
      {
        sql: `INSERT INTO observed_funding_receipts (
          observed_funding_receipt_id, amount_atomic, sender_address, recipient_address
        ) VALUES (?1, '5000000', ?2, ?3)`,
        args: [`ofr_${intentId}`, senderAddress, operatorAddress.toLowerCase()],
      },
      {
        sql: `INSERT INTO community_handle_claim_intents (
          community_handle_claim_intent_id, status, chain_id, token_address,
          funding_destination_address, custody_account_id, custody_key_epoch,
          funding_tx_hash, observed_funding_receipt_id, updated_at
        ) VALUES (?1, 'refund_pending', 84532, ?2, ?3, ?4, 'epoch_test', ?5, ?6, ?7)`,
        args: [
          intentId,
          tokenAddress,
          operatorAddress.toLowerCase(),
          `pirate_checkout:${operatorAddress.toLowerCase()}`,
          fundingTxHash,
          `ofr_${intentId}`,
          "2026-08-13T12:00:00.000Z",
        ],
      },
    ], "write")
  })
}

describe("handle claim refund reconciler", () => {
  test("reports a disabled backlog without dispatching value", async () => {
    await seed("hci_disabled")
    const settle = mock(async () => { throw new Error("must not dispatch") })
    setHandleClaimRefundCoordinatorForTests({ settle })

    const summary = await reconcileHandleClaimRefunds({
      env: { ...env, COMMUNITY_HANDLE_CLAIM_REFUNDS_ENABLED: "false" },
    })

    expect(summary).toMatchObject({ enabled: false, queued: 1, scanned: 0 })
    expect(settle).not.toHaveBeenCalled()
  })

  test("drains refunds while new-intent admission is disabled", async () => {
    await seed("hci_admission_paused")
    const settle = mock(async () => ({
      idempotencyKey: JSON.stringify(["handle_claim_refund", "hci_admission_paused"]),
      state: "confirmed" as const,
      txHash: refundTxHash,
      nonce: 9,
    }))
    setHandleClaimRefundCoordinatorForTests({ settle })
    const verify = mock(async () => ({
      kind: "verified" as const,
      senderAddress,
      txRef: fundingTxHash,
    }))

    const summary = await reconcileHandleClaimRefunds({
      env: { ...env, COMMUNITY_HANDLE_CLAIM_INTENTS_ENABLED: "false" },
      verify,
    })

    expect(summary).toMatchObject({
      enabled: true,
      queued: 1,
      scanned: 1,
      enqueued: 1,
      confirmed: 1,
      errors: 0,
    })
    expect(settle).toHaveBeenCalledTimes(1)
  })

  test("verifies, dispatches, and records a confirmed refund idempotently", async () => {
    await seed("hci_confirmed")
    const settle = mock(async () => ({
      idempotencyKey: JSON.stringify(["handle_claim_refund", "hci_confirmed"]),
      state: "confirmed" as const,
      txHash: refundTxHash,
      nonce: 8,
    }))
    setHandleClaimRefundCoordinatorForTests({ settle })
    const verify = mock(async () => ({
      kind: "verified" as const,
      senderAddress,
      txRef: fundingTxHash,
    }))

    const summary = await reconcileHandleClaimRefunds({ env, verify })

    expect(summary).toMatchObject({
      enabled: true,
      queued: 1,
      scanned: 1,
      enqueued: 1,
      confirmed: 1,
      errors: 0,
    })
    expect(settle).toHaveBeenCalledWith(expect.objectContaining({
      operatorKind: "checkout",
      effectKind: "handle_claim_refund",
      fundingEffectId: "hci_confirmed",
      recipientAddress: senderAddress,
      amountAtomic: "5000000",
    }))
    const persisted = await controlPlane(async (client) => await client.execute(
      "SELECT * FROM community_handle_claim_intents WHERE community_handle_claim_intent_id = 'hci_confirmed'",
    ))
    expect(persisted.rows[0]).toMatchObject({
      status: "refunded",
      refund_tx_hash: refundTxHash,
      refund_coordinator_state: "confirmed",
    })
  })

  test("keeps failed on-chain refunds pending and surfaces operator attention", async () => {
    await seed("hci_failed")
    setHandleClaimRefundCoordinatorForTests({
      settle: async () => ({
        idempotencyKey: JSON.stringify(["handle_claim_refund", "hci_failed"]),
        state: "failed_onchain",
        txHash: refundTxHash,
        nonce: 10,
      }),
    })

    const summary = await reconcileHandleClaimRefunds({
      env,
      verify: async () => ({ kind: "verified", senderAddress, txRef: fundingTxHash }),
    })

    expect(summary).toMatchObject({ confirmed: 0, operator_attention: 1, errors: 0 })
    const persisted = await controlPlane(async (client) => await client.execute(
      "SELECT * FROM community_handle_claim_intents WHERE community_handle_claim_intent_id = 'hci_failed'",
    ))
    expect(persisted.rows[0]).toMatchObject({
      status: "refund_pending",
      refund_coordinator_state: "failed_onchain",
      refund_last_error: "failed_onchain",
    })
  })

  test("releases each Postgres adapter before RPC verification and coordinator dispatch", async () => {
    const pools: Array<{ ended: boolean; endCalls: number }> = []
    let poolNumber = 0
    setControlPlanePostgresPoolFactoryForTests(() => {
      poolNumber += 1
      const state = { ended: false, endCalls: 0 }
      pools.push(state)
      return {
        query: async (text: string) => {
          if (state.ended) throw new Error("query used a closed pool")
          if (text.includes("COUNT(*) AS queued")) return { rows: [{ queued: "1" }], rowCount: 1 }
          if (text.includes("JOIN observed_funding_receipts")) {
            return {
              rows: [{
                community_handle_claim_intent_id: "hci_pg",
                chain_id: 84532,
                token_address: tokenAddress,
                funding_destination_address: operatorAddress.toLowerCase(),
                custody_account_id: `pirate_checkout:${operatorAddress.toLowerCase()}`,
                custody_key_epoch: "epoch_test",
                funding_tx_hash: fundingTxHash,
                amount_atomic: "5000000",
                sender_address: senderAddress,
                recipient_address: operatorAddress.toLowerCase(),
                refund_coordinator_ref: null,
                refund_tx_hash: null,
              }],
              rowCount: 1,
            }
          }
          if (text.includes("UPDATE community_handle_claim_intents")) {
            return { rows: [{ status: "refunded" }], rowCount: 1 }
          }
          throw new Error(`unexpected query in pool ${poolNumber}`)
        },
        connect: async () => { throw new Error("transaction not expected") },
        end: async () => {
          state.endCalls += 1
          state.ended = true
        },
      } as never
    })
    const postgresEnv = { ...env, CONTROL_PLANE_DATABASE_URL: "postgres://test:test@control-plane.invalid/test" }
    const assertNoPinnedPool = () => expect(pools.every((pool) => pool.ended)).toBe(true)
    const verify = mock(async () => {
      assertNoPinnedPool()
      return { kind: "verified" as const, senderAddress, txRef: fundingTxHash }
    })
    const settle = mock(async () => {
      assertNoPinnedPool()
      return {
        idempotencyKey: JSON.stringify(["handle_claim_refund", "hci_pg"]),
        state: "confirmed" as const,
        txHash: refundTxHash,
        nonce: 9,
      }
    })
    setHandleClaimRefundCoordinatorForTests({ settle })

    await expect(reconcileHandleClaimRefunds({ env: postgresEnv, verify })).resolves.toMatchObject({
      confirmed: 1,
      errors: 0,
    })

    expect(pools).toHaveLength(3)
    expect(pools.every((pool) => pool.ended && pool.endCalls === 1)).toBe(true)
  })
})
