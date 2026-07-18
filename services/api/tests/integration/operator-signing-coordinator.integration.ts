import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"

import {
  setOperatorChainPrimitivesForTests,
  type OperatorSettleRequest,
} from "../../src/lib/communities/bookings/operator-signing-coordinator-do"

// Real workerd + real DO SQLite storage + real RPC input gates. The chain seam is injected INSIDE
// the DO isolate via runInDurableObject so the signer/RPC is faked while everything else (nonce
// inbox transactionSync, alarm-owned nonce reservation, signing claim, version-CAS, and identity
// routing) runs for real.

type Liveness = "success" | "failed" | "pending" | "absent"
interface ChainConfig {
  pending: number
  latest: number
  liveness: Record<string, Liveness>
  broadcastError?: string
}

type Stub = ReturnType<typeof env.OPERATOR_SIGNING_COORDINATOR.getByName>

let seq = 0
function freshStub(): Stub { return env.OPERATOR_SIGNING_COORDINATOR.getByName(`op-signer-test-${seq++}`) }

async function injectChain(stub: Stub, config: ChainConfig): Promise<void> {
  await runInDurableObject(stub, () => {
    setOperatorChainPrimitivesForTests({
      pendingNonce: async () => config.pending,
      latestNonce: async () => config.latest,
      gasParams: async () => ({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, gasLimit: 1n }),
      signVerifiedTransfer: async (_e, input) => ({ signedTx: `signed_${input.nonce}`, txHash: `0xhash_${input.nonce}` }),
      broadcast: async () => {
        if (config.broadcastError) throw new Error(config.broadcastError)
      },
      txLiveness: async (_e, hash) => config.liveness[hash] ?? "absent",
    })
  })
}

async function effects(stub: Stub): Promise<Array<Record<string, unknown>>> {
  return runInDurableObject(stub, (_instance, state) =>
    state.storage.sql.exec("SELECT idempotency_key, amount_cents, amount_atomic, nonce, tx_hash, state, version, attempt_count, next_attempt_at FROM effects ORDER BY nonce").toArray(),
  )
}

function req(over: Partial<OperatorSettleRequest> = {}): OperatorSettleRequest {
  return { communityId: "c1", bookingId: "bkg1", effectKind: "booking_refund", amountCents: 5000, recipientAddress: "0x0000000000000000000000000000000000000222", ...over }
}

function rewardsReq(over: Partial<OperatorSettleRequest> = {}): OperatorSettleRequest {
  return {
    operatorKind: "rewards",
    userId: "usr_reward",
    payoutEffectId: "rpe_reward",
    idempotencyKey: "reward-cashout:test",
    effectKind: "reward_cashout",
    amountCents: 100,
    recipientAddress: "0x0000000000000000000000000000000000000222",
    ...over,
  }
}

function rewardRefundReq(over: Partial<OperatorSettleRequest> = {}): OperatorSettleRequest {
  return {
    operatorKind: "rewards",
    fundingEffectId: "rcfe_refund",
    idempotencyKey: "rcfe_refund",
    effectKind: "reward_funding_refund",
    amountAtomic: "12345678",
    recipientAddress: "0x0000000000000000000000000000000000000222",
    ...over,
  }
}

beforeEach(() => { setOperatorChainPrimitivesForTests(null) })

describe("OperatorSigningCoordinatorDO (real workerd isolate)", () => {
  it("returns durable acceptance before alarm-owned execution completes", async () => {
    const stub = freshStub()
    await injectChain(stub, { pending: 7, latest: 7, liveness: {} })
    expect((await stub.settle(req())).state).toBe("reserving")
    expect((await effects(stub))).toHaveLength(1)
    await runDurableObjectAlarm(stub)
    expect((await stub.lookup(req())).state).toBe("broadcast")
  })

  it("two concurrent same-effect RPC calls allocate one nonce and one signed tx", async () => {
    const stub = freshStub()
    await injectChain(stub, { pending: 4, latest: 4, liveness: {} })
    const [a, b] = await Promise.all([stub.settle(req()), stub.settle(req())])
    expect(a.state).toBe("reserving")
    expect(b.state).toBe("reserving")
    expect(a.nonce).toBeNull()
    expect(b.nonce).toBeNull()
    await runDurableObjectAlarm(stub)
    const rows = await effects(stub)
    expect(rows.length).toBe(1) // one effect row
    expect(rows[0].nonce).toBe(4) // one nonce
    expect(rows[0].tx_hash).toBe("0xhash_4") // one signed tx
    expect((await stub.lookup(req())).nonce).toBe(4)
  })

  it("distinct effects receive distinct nonces", async () => {
    const stub = freshStub()
    await injectChain(stub, { pending: 10, latest: 10, liveness: { "0xhash_10": "success" } })
    await Promise.all([stub.settle(req({ bookingId: "bkgA" })), stub.settle(req({ bookingId: "bkgB" }))])
    await runDurableObjectAlarm(stub) // prepare + broadcast A
    await stub.confirm(req({ bookingId: "bkgA" }), "0xhash_10")
    await runDurableObjectAlarm(stub) // confirm A
    await runDurableObjectAlarm(stub) // prepare + broadcast B
    const x = await stub.lookup(req({ bookingId: "bkgA" }))
    const y = await stub.lookup(req({ bookingId: "bkgB" }))
    expect(new Set([x.nonce, y.nonce])).toEqual(new Set([10, 11]))
    expect((await effects(stub)).map((r) => r.nonce).sort()).toEqual([10, 11])
  })

  it("supports reward cashout effects with reward-shaped idempotency", async () => {
    const stub = freshStub()
    await injectChain(stub, { pending: 30, latest: 30, liveness: {} })
    const first = await stub.settle(rewardsReq())
    expect(first.state).toBe("reserving")
    await runDurableObjectAlarm(stub)
    const replay = await stub.settle(rewardsReq())
    expect(first.idempotencyKey).toBe(JSON.stringify(["reward_payout", "reward-cashout:test"]))
    expect(replay.idempotencyKey).toBe(first.idempotencyKey)
    expect(first.nonce).toBeNull()
    expect(replay.nonce).toBe(30)
    expect((await effects(stub)).map((row) => row.state)).toEqual(["broadcast"])

    await expect(stub.settle(rewardsReq({ amountCents: 101 }))).rejects.toThrow()
  })

  it("refunds the exact atomic custody amount through the rewards nonce domain", async () => {
    const stub = freshStub()
    await injectChain(stub, { pending: 31, latest: 31, liveness: {} })
    const first = await stub.settle(rewardRefundReq())
    expect(first.idempotencyKey).toBe(JSON.stringify(["reward_funding_refund", "rcfe_refund"]))
    await runDurableObjectAlarm(stub)

    const [row] = await effects(stub)
    expect(row).toMatchObject({
      amount_cents: 0,
      amount_atomic: "12345678",
      nonce: 31,
      state: "broadcast",
    })
    await expect(stub.settle(rewardRefundReq({ amountAtomic: "12345679" }))).rejects.toThrow()
    await expect(stub.settle(rewardRefundReq({ amountCents: 123, amountAtomic: undefined }))).rejects.toThrow()
  })

  it("does not let polling bypass alarm retry backoff", async () => {
    const stub = freshStub()
    await injectChain(stub, { pending: 1, latest: 1, liveness: {} })
    await stub.settle(req())
    const retryAt = Date.now() + 60_000
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE effects SET attempt_count=2, next_attempt_at=?1", retryAt)
    })

    await stub.settle(req())
    await stub.lookup(req())

    const [row] = await effects(stub)
    expect(row.attempt_count).toBe(2)
    expect(row.next_attempt_at).toBe(retryAt)
  })

  it("persists bounded retry state when broadcast fails transiently", async () => {
    const stub = freshStub()
    await injectChain(stub, { pending: 9, latest: 9, liveness: {}, broadcastError: "provider unavailable" })
    await stub.settle(req())

    await runDurableObjectAlarm(stub)

    const [row] = await effects(stub)
    expect(row.state).toBe("prepared")
    expect(row.nonce).toBe(9)
    expect(row.tx_hash).toBe("0xhash_9")
    expect(row.attempt_count).toBe(1)
    expect(Number(row.next_attempt_at)).toBeGreaterThan(Date.now())
  })

  it("reconciles an ambiguous broadcast timeout without signing a replacement", async () => {
    const stub = freshStub()
    await injectChain(stub, {
      pending: 9,
      latest: 9,
      liveness: { "0xhash_9": "pending" },
      broadcastError: "provider timeout after send",
    })
    await stub.settle(req())
    await runDurableObjectAlarm(stub)
    expect((await stub.lookup(req())).state).toBe("prepared")

    await injectChain(stub, {
      pending: 9,
      latest: 9,
      liveness: { "0xhash_9": "pending" },
      broadcastError: "already known",
    })
    await stub.reconcile(req())
    await runDurableObjectAlarm(stub)

    const [row] = await effects(stub)
    expect(row.state).toBe("broadcast")
    expect(row.nonce).toBe(9)
    expect(row.tx_hash).toBe("0xhash_9")
  })

  it("deterministic wallet+chain routing: a fresh stub for the same name reuses the persisted nonce state (NOT an eviction test)", async () => {
    // Note: this proves getByName routing determinism + DO SQLite persistence across stubs. It does
    // NOT force an isolate eviction (vitest-pool-workers does not expose that); the persistence
    // guarantee here is supplied by DO SQLite, which also backs post-eviction re-instantiation.
    const name = `op-signer-route-${seq++}`
    const s1 = env.OPERATOR_SIGNING_COORDINATOR.getByName(name)
    await injectChain(s1, { pending: 20, latest: 20, liveness: { "0xhash_20": "success" } })
    await s1.settle(req())
    await runDurableObjectAlarm(s1)
    expect((await s1.lookup(req())).nonce).toBe(20)
    await s1.confirm(req(), "0xhash_20")
    await runDurableObjectAlarm(s1) // confirm the first effect so the next operation can drain
    // a fresh stub for the same name routes to the same object + persisted nonce_state
    const s2 = env.OPERATOR_SIGNING_COORDINATOR.getByName(name)
    await injectChain(s2, { pending: 20, latest: 20, liveness: {} }) // chain re-reports 20, but local next_nonce persisted at 21
    await s2.settle(req({ bookingId: "bkg2" }))
    await runDurableObjectAlarm(s2)
    expect((await s2.lookup(req({ bookingId: "bkg2" }))).nonce).toBe(21) // continued from persisted state, not reset to chain pending
  })

  it("confirm transitions to confirmed on a successful receipt; failed receipt is terminal", async () => {
    const ok = freshStub()
    await injectChain(ok, { pending: 1, latest: 1, liveness: { "0xhash_1": "success" } })
    await ok.settle(req())
    await runDurableObjectAlarm(ok)
    expect((await ok.confirm(req(), "0xhash_1")).state).toBe("broadcast")
    await runDurableObjectAlarm(ok)
    expect((await ok.lookup(req())).state).toBe("confirmed")

    const bad = freshStub()
    await injectChain(bad, { pending: 5, latest: 5, liveness: { "0xhash_5": "failed" } })
    await bad.settle(req())
    await runDurableObjectAlarm(bad)
    await bad.confirm(req(), "0xhash_5")
    await runDurableObjectAlarm(bad)
    expect((await bad.lookup(req())).state).toBe("failed_onchain")
  })

  it("reconcile: pending stays, dropped rebroadcasts, replaced when a different tx consumed the nonce", async () => {
    // pending → stays broadcast
    const pend = freshStub()
    await injectChain(pend, { pending: 2, latest: 2, liveness: { "0xhash_2": "pending" } })
    await pend.settle(req())
    await runDurableObjectAlarm(pend)
    await pend.reconcile(req())
    await runDurableObjectAlarm(pend)
    expect((await pend.lookup(req())).state).toBe("broadcast")

    // dropped (absent, nonce not consumed on chain) → rebroadcast, stays broadcast
    const drop = freshStub()
    await injectChain(drop, { pending: 3, latest: 3, liveness: { "0xhash_3": "absent" } })
    await drop.settle(req())
    await runDurableObjectAlarm(drop)
    await drop.reconcile(req())
    await runDurableObjectAlarm(drop)
    expect((await drop.lookup(req())).state).toBe("broadcast")

    // replaced (absent, latest advanced past our nonce) → replaced
    const repl = freshStub()
    await injectChain(repl, { pending: 6, latest: 6, liveness: { "0xhash_6": "absent" } })
    await repl.settle(req())
    await runDurableObjectAlarm(repl)
    await injectChain(repl, { pending: 6, latest: 8, liveness: { "0xhash_6": "absent" } }) // a different tx consumed nonce 6
    await repl.reconcile(req())
    await runDurableObjectAlarm(repl)
    expect((await repl.lookup(req())).state).toBe("replaced")
  })

  it("signing recovery after an expired claim on a reserving row", async () => {
    const stub = freshStub()
    await injectChain(stub, { pending: 1, latest: 1, liveness: {} })
    await stub.settle(req())
    await runDurableObjectAlarm(stub) // creates a broadcast effect
    // simulate a crashed signer: force the row back to reserving with a STALE (expired) claim
    await runInDurableObject(stub, (_i, state) => {
      state.storage.sql.exec("UPDATE effects SET state='reserving', signed_tx=NULL, tx_hash=NULL, claim_token='crashed', claim_expires_at=1")
    })
    await stub.reconcile(req())
    await runDurableObjectAlarm(stub) // expired claim → re-claim + sign + broadcast
    expect((await stub.lookup(req())).state).toBe("broadcast")
    expect((await effects(stub))[0].tx_hash).toBe("0xhash_1")
  })

  it("waits for a live signing claim instead of hot-looping the alarm", async () => {
    const stub = freshStub()
    await injectChain(stub, { pending: 1, latest: 1, liveness: {} })
    await stub.settle(req())
    const claimExpiresAt = Date.now() + 60_000
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE effects SET nonce=1, claim_token='active-signer', claim_expires_at=?1 WHERE state='reserving'",
        claimExpiresAt,
      )
    })

    await runDurableObjectAlarm(stub)

    const alarmAt = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm())
    expect(alarmAt).toBe(claimExpiresAt)
    expect((await stub.lookup(req())).state).toBe("reserving")
  })

  it("immutable-data mismatch is rejected through every RPC", async () => {
    const stub = freshStub()
    await injectChain(stub, { pending: 0, latest: 0, liveness: { "0xhash_0": "success" } })
    await stub.settle(req())
    await runDurableObjectAlarm(stub)
    const bad = req({ amountCents: 9999 })
    await expect(stub.settle(bad)).rejects.toThrow()
    await expect(stub.confirm(bad, "0xhash_0")).rejects.toThrow()
    await expect(stub.reconcile(bad)).rejects.toThrow()
    await expect(stub.lookup(bad)).rejects.toThrow()
  })
})
