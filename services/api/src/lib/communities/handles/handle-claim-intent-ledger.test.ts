import { afterEach, describe, expect, test } from "bun:test"
import { createClient, type Client } from "@libsql/client"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { BuyerFundingReceipt } from "../commerce/funding-proof-service"
import {
  completeFundedHandleClaimIntent,
  consumeAuthorizedFreeHandleClaimIntent,
  fundAuthorizedHandleClaimIntent,
  markFundedHandleClaimIntentRefundPending,
  releaseExpiredHandleClaimTokenAllocations,
} from "./handle-claim-intent-ledger"

const INTENT_ID = "hci_test"
const AUTHORIZATION_ID = "hcaa_test"
const QUOTE_ID = "hcq_test"
const NOW = "2026-08-13T12:10:00.000Z"
const DEADLINE = "2026-08-13T12:00:00.000Z"
const TOKEN = "0x1111111111111111111111111111111111111111"
const SENDER = "0x2222222222222222222222222222222222222222"
const RECIPIENT = "0x3333333333333333333333333333333333333333"
const TX_HASH = `0x${"44".repeat(32)}`
const BLOCK_HASH = `0x${"55".repeat(32)}`

const clients: Client[] = []
const tempDirectories: string[] = []

async function createLedgerClient(): Promise<Client> {
  const directory = mkdtempSync(join(tmpdir(), "handle-claim-ledger-"))
  tempDirectories.push(directory)
  const client = createClient({ url: `file:${join(directory, "control-plane.db")}` })
  clients.push(client)
  await client.batch([
    `CREATE TABLE observed_funding_receipts (
      observed_funding_receipt_id TEXT PRIMARY KEY,
      chain_id INTEGER NOT NULL,
      token_address TEXT NOT NULL,
      tx_hash TEXT NOT NULL,
      log_index INTEGER NOT NULL,
      block_number INTEGER NOT NULL,
      block_hash TEXT NOT NULL,
      block_timestamp INTEGER,
      sender_address TEXT NOT NULL,
      recipient_address TEXT NOT NULL,
      amount_atomic TEXT NOT NULL,
      observed_source TEXT NOT NULL,
      finality_status TEXT NOT NULL,
      match_status TEXT NOT NULL,
      consumer_rail TEXT,
      consumer_id TEXT,
      quote_id TEXT,
      observed_at TEXT NOT NULL,
      canonical_at TEXT,
      claimed_at TEXT,
      updated_at TEXT NOT NULL,
      UNIQUE (chain_id, token_address, tx_hash, log_index)
    )`,
    `CREATE UNIQUE INDEX observed_funding_receipts_consumer_unique
      ON observed_funding_receipts (consumer_rail, consumer_id)
      WHERE consumer_rail IS NOT NULL AND consumer_id IS NOT NULL`,
    `CREATE TABLE community_handle_claim_intents (
      community_handle_claim_intent_id TEXT PRIMARY KEY,
      actor_user_id TEXT NOT NULL DEFAULT 'usr_test',
      community_id TEXT NOT NULL DEFAULT 'cmt_test',
      status TEXT NOT NULL,
      action_authorization_id TEXT,
      latest_quote_id TEXT NOT NULL DEFAULT '${QUOTE_ID}',
      price_cents INTEGER NOT NULL DEFAULT 500,
      payment_not_after TEXT NOT NULL,
      observed_funding_receipt_id TEXT,
      funding_tx_hash TEXT,
      funded_at TEXT,
      completed_at TEXT,
      finalization_attempt_count INTEGER NOT NULL DEFAULT 0,
      finalization_last_error TEXT,
      finalization_next_attempt_at TEXT,
      settlement_wallet_attachment_id TEXT,
      refund_pending_at TEXT,
      refund_reason TEXT,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE community_handle_token_allocations (
      community_handle_token_allocation_id TEXT PRIMARY KEY,
      community_handle_claim_intent_id TEXT NOT NULL,
      status TEXT NOT NULL,
      expires_at TEXT NOT NULL DEFAULT '2026-08-14T12:00:00.000Z',
      consumed_at TEXT,
      released_at TEXT,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE community_handle_action_authorizations (
      community_handle_action_authorization_id TEXT PRIMARY KEY,
      community_handle_claim_intent_id TEXT NOT NULL,
      consumed_at TEXT,
      consumed_by_intent_id TEXT
    )`,
    {
      sql: `INSERT INTO community_handle_claim_intents (
        community_handle_claim_intent_id, status, action_authorization_id,
        payment_not_after, updated_at
      ) VALUES (?1, 'authorized', ?2, ?3, ?4)`,
      args: [INTENT_ID, AUTHORIZATION_ID, DEADLINE, NOW],
    },
    {
      sql: `INSERT INTO community_handle_action_authorizations (
        community_handle_action_authorization_id, community_handle_claim_intent_id
      ) VALUES (?1, ?2)`,
      args: [AUTHORIZATION_ID, INTENT_ID],
    },
  ], "write")
  return client
}

function receipt(blockTimestamp?: number): BuyerFundingReceipt {
  return {
    amountAtomic: "5000000",
    chainRef: "eip155:8453",
    fromAddress: SENDER,
    observation: {
      blockHash: BLOCK_HASH,
      blockNumber: 123,
      chainId: 8453,
      logIndex: 7,
      ...(blockTimestamp == null ? {} : { blockTimestamp }),
    },
    toAddress: RECIPIENT,
    tokenAddress: TOKEN,
    txRef: TX_HASH,
  }
}

async function fund(client: Client, blockTimestamp?: number) {
  return await fundAuthorizedHandleClaimIntent({
    authorizationId: AUTHORIZATION_ID,
    client,
    env: {} as never,
    fallbackSenderAddress: SENDER,
    intentId: INTENT_ID,
    now: NOW,
    paymentClockSkewSeconds: 30,
    quoteId: QUOTE_ID,
    receipt: receipt(blockTimestamp),
    settlementWalletAttachmentId: "wa_test",
  })
}

async function state(client: Client) {
  const intent = await client.execute({
    sql: "SELECT * FROM community_handle_claim_intents WHERE community_handle_claim_intent_id = ?1",
    args: [INTENT_ID],
  })
  const authorization = await client.execute({
    sql: "SELECT * FROM community_handle_action_authorizations WHERE community_handle_action_authorization_id = ?1",
    args: [AUTHORIZATION_ID],
  })
  const observed = await client.execute("SELECT * FROM observed_funding_receipts")
  return { intent: intent.rows[0], authorization: authorization.rows[0], observed: observed.rows[0] }
}

afterEach(() => {
  for (const client of clients.splice(0)) client.close()
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { force: true, recursive: true })
})

describe("funded handle-claim intent ledger", () => {
  test("claims a late receipt and records the refund obligation atomically", async () => {
    const client = await createLedgerClient()

    await expect(fund(client, Date.parse("2026-08-13T12:01:00.000Z") / 1000)).resolves.toEqual({
      status: "refund_pending",
      reason: "funding_included_after_deadline",
    })

    const persisted = await state(client)
    expect(persisted.intent).toMatchObject({
      status: "refund_pending",
      funding_tx_hash: TX_HASH,
      refund_reason: "funding_included_after_deadline",
      finalization_next_attempt_at: null,
    })
    expect(persisted.authorization).toMatchObject({
      consumed_at: NOW,
      consumed_by_intent_id: INTENT_ID,
    })
    expect(persisted.observed).toMatchObject({
      match_status: "claimed",
      consumer_rail: "community_handle_intent",
      consumer_id: INTENT_ID,
      quote_id: QUOTE_ID,
    })
  })

  test("claims a timestamp-less receipt into refund_pending instead of orphaning it", async () => {
    const client = await createLedgerClient()

    await expect(fund(client)).resolves.toEqual({
      status: "refund_pending",
      reason: "funding_block_timestamp_missing",
    })

    const persisted = await state(client)
    expect(persisted.intent).toMatchObject({
      status: "refund_pending",
      refund_reason: "funding_block_timestamp_missing",
    })
    expect(persisted.observed?.match_status).toBe("claimed")
  })

  test("moves an on-time receipt to funded finalization", async () => {
    const client = await createLedgerClient()

    await expect(fund(client, Date.parse("2026-08-13T11:59:30.000Z") / 1000)).resolves.toEqual({
      status: "funded_pending_finalization",
    })

    const persisted = await state(client)
    expect(persisted.intent).toMatchObject({
      status: "funded_pending_finalization",
      finalization_next_attempt_at: NOW,
      refund_pending_at: null,
      refund_reason: null,
    })
  })

  test("classifies a released shard reservation after custody binding", async () => {
    const client = await createLedgerClient()
    await fund(client, Date.parse("2026-08-13T11:59:30.000Z") / 1000)

    await expect(markFundedHandleClaimIntentRefundPending({
      client,
      intentId: INTENT_ID,
      now: NOW,
      reason: "handle_label_reservation_expired",
    })).resolves.toBe(true)

    const persisted = await state(client)
    expect(persisted.intent).toMatchObject({
      status: "refund_pending",
      refund_reason: "handle_label_reservation_expired",
      finalization_next_attempt_at: null,
    })
    expect(persisted.observed).toMatchObject({
      match_status: "claimed",
      consumer_rail: "community_handle_intent",
      consumer_id: INTENT_ID,
    })
  })

  test("refunds an on-time payment when its card entitlement lease was released", async () => {
    const client = await createLedgerClient()
    await client.execute({
      sql: `INSERT INTO community_handle_token_allocations (
        community_handle_token_allocation_id, community_handle_claim_intent_id, status, updated_at
      ) VALUES ('hcta_released', ?1, 'released', ?2)`,
      args: [INTENT_ID, NOW],
    })

    await expect(fund(client, Date.parse("2026-08-13T11:59:30.000Z") / 1000)).resolves.toEqual({
      status: "refund_pending",
      reason: "token_entitlement_reservation_expired",
    })

    const persisted = await state(client)
    expect(persisted.intent).toMatchObject({
      status: "refund_pending",
      refund_reason: "token_entitlement_reservation_expired",
    })
  })

  test("replays the same late receipt idempotently without duplicating observations", async () => {
    const client = await createLedgerClient()
    const includedAt = Date.parse("2026-08-13T12:01:00.000Z") / 1000

    await fund(client, includedAt)
    await expect(fund(client, includedAt)).resolves.toEqual({
      status: "refund_pending",
      reason: "funding_included_after_deadline",
    })

    const receipts = await client.execute("SELECT COUNT(*) AS count FROM observed_funding_receipts")
    expect(Number(receipts.rows[0]?.count)).toBe(1)
  })

  test("consumes and completes a free authorization without entering the funding saga", async () => {
    const client = await createLedgerClient()
    const freeNow = "2026-08-13T11:50:00.000Z"
    await client.execute({
      sql: "UPDATE community_handle_claim_intents SET price_cents = 0 WHERE community_handle_claim_intent_id = ?1",
      args: [INTENT_ID],
    })

    await consumeAuthorizedFreeHandleClaimIntent({
      actorUserId: "usr_test",
      authorizationId: AUTHORIZATION_ID,
      client,
      communityId: "cmt_test",
      intentId: INTENT_ID,
      now: freeNow,
      quoteId: QUOTE_ID,
    })
    await completeFundedHandleClaimIntent({ client, intentId: INTENT_ID, now: freeNow })

    const persisted = await state(client)
    expect(persisted.intent).toMatchObject({ status: "completed" })
    expect(persisted.authorization).toMatchObject({
      consumed_at: freeNow,
      consumed_by_intent_id: INTENT_ID,
    })
    expect(persisted.observed).toBeUndefined()
  })

  test("releases abandoned entitlement leases but never a funded intent lease", async () => {
    const client = await createLedgerClient()
    await client.execute({
      sql: `INSERT INTO community_handle_token_allocations (
        community_handle_token_allocation_id, community_handle_claim_intent_id,
        status, expires_at, updated_at
      ) VALUES ('hcta_expired', ?1, 'reserved', '2026-08-13T11:00:00.000Z', ?2)`,
      args: [INTENT_ID, NOW],
    })
    await expect(releaseExpiredHandleClaimTokenAllocations({ client, now: NOW })).resolves.toBe(1)

    await client.batch([
      {
        sql: "UPDATE community_handle_claim_intents SET status = 'funded_pending_finalization' WHERE community_handle_claim_intent_id = ?1",
        args: [INTENT_ID],
      },
      {
        sql: "UPDATE community_handle_token_allocations SET status = 'reserved', released_at = NULL WHERE community_handle_token_allocation_id = 'hcta_expired'",
      },
    ], "write")
    await expect(releaseExpiredHandleClaimTokenAllocations({ client, now: NOW })).resolves.toBe(0)

    const allocation = await client.execute(
      "SELECT status FROM community_handle_token_allocations WHERE community_handle_token_allocation_id = 'hcta_expired'",
    )
    expect(allocation.rows[0]?.status).toBe("reserved")
  })
})
