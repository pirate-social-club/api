import { env, runInDurableObject } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"

import {
  setOperatorChainPrimitivesForTests,
  type OperatorSettleRequest,
} from "../../src/lib/bookings/operator-signing-coordinator-do"

// Real workerd + real DO SQLite storage + real RPC input gates. The chain seam is injected INSIDE
// the DO isolate via runInDurableObject so the signer/RPC is faked while everything else (nonce
// reservation transactionSync, signing claim, version-CAS, identity routing) runs for real.

type Liveness = "success" | "failed" | "pending" | "absent"
interface ChainConfig { pending: number; latest: number; liveness: Record<string, Liveness> }

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
      broadcast: async () => {},
      txLiveness: async (_e, hash) => config.liveness[hash] ?? "absent",
    })
  })
}

async function effects(stub: Stub): Promise<Array<Record<string, unknown>>> {
  return runInDurableObject(stub, (_instance, state) =>
    state.storage.sql.exec("SELECT idempotency_key, nonce, tx_hash, state, version FROM effects ORDER BY nonce").toArray(),
  )
}

function req(over: Partial<OperatorSettleRequest> = {}): OperatorSettleRequest {
  return { communityId: "c1", bookingId: "bkg1", effectKind: "booking_refund", amountCents: 5000, recipientAddress: "0x0000000000000000000000000000000000000222", ...over }
}

beforeEach(() => { setOperatorChainPrimitivesForTests(null) })

describe("OperatorSigningCoordinatorDO (real workerd isolate)", () => {
  it("two concurrent same-effect RPC calls allocate one nonce and one signed tx", async () => {
    const stub = freshStub()
    await injectChain(stub, { pending: 4, latest: 4, liveness: {} })
    const [a, b] = await Promise.all([stub.settle(req()), stub.settle(req())])
    const rows = await effects(stub)
    expect(rows.length).toBe(1) // one effect row
    expect(rows[0].nonce).toBe(4) // one nonce
    expect(rows[0].tx_hash).toBe("0xhash_4") // one signed tx
    expect(a.nonce).toBe(4)
    expect(b.nonce).toBe(4)
  })

  it("distinct effects receive distinct nonces", async () => {
    const stub = freshStub()
    await injectChain(stub, { pending: 10, latest: 10, liveness: {} })
    const [x, y] = await Promise.all([stub.settle(req({ bookingId: "bkgA" })), stub.settle(req({ bookingId: "bkgB" }))])
    expect(new Set([x.nonce, y.nonce])).toEqual(new Set([10, 11]))
    expect((await effects(stub)).map((r) => r.nonce).sort()).toEqual([10, 11])
  })

  it("deterministic wallet+chain routing: a fresh stub for the same name reuses the persisted nonce state (NOT an eviction test)", async () => {
    // Note: this proves getByName routing determinism + DO SQLite persistence across stubs. It does
    // NOT force an isolate eviction (vitest-pool-workers does not expose that); the persistence
    // guarantee here is supplied by DO SQLite, which also backs post-eviction re-instantiation.
    const name = `op-signer-route-${seq++}`
    const s1 = env.OPERATOR_SIGNING_COORDINATOR.getByName(name)
    await injectChain(s1, { pending: 20, latest: 20, liveness: {} })
    const first = await s1.settle(req())
    expect(first.nonce).toBe(20)
    // a fresh stub for the same name routes to the same object + persisted nonce_state
    const s2 = env.OPERATOR_SIGNING_COORDINATOR.getByName(name)
    await injectChain(s2, { pending: 20, latest: 20, liveness: {} }) // chain re-reports 20, but local next_nonce persisted at 21
    const second = await s2.settle(req({ bookingId: "bkg2" }))
    expect(second.nonce).toBe(21) // continued from persisted state, not reset to chain pending
  })

  it("confirm transitions to confirmed on a successful receipt; failed receipt is terminal", async () => {
    const ok = freshStub()
    await injectChain(ok, { pending: 1, latest: 1, liveness: { "0xhash_1": "success" } })
    const s = await ok.settle(req())
    expect(s.state).toBe("broadcast")
    expect((await ok.confirm(req(), "0xhash_1")).state).toBe("confirmed")

    const bad = freshStub()
    await injectChain(bad, { pending: 5, latest: 5, liveness: { "0xhash_5": "failed" } })
    await bad.settle(req())
    expect((await bad.confirm(req(), "0xhash_5")).state).toBe("failed_onchain")
  })

  it("reconcile: pending stays, dropped rebroadcasts, replaced when a different tx consumed the nonce", async () => {
    // pending → stays broadcast
    const pend = freshStub()
    await injectChain(pend, { pending: 2, latest: 2, liveness: { "0xhash_2": "pending" } })
    await pend.settle(req())
    expect((await pend.reconcile(req())).state).toBe("broadcast")

    // dropped (absent, nonce not consumed on chain) → rebroadcast, stays broadcast
    const drop = freshStub()
    await injectChain(drop, { pending: 3, latest: 3, liveness: { "0xhash_3": "absent" } })
    await drop.settle(req())
    expect((await drop.reconcile(req())).state).toBe("broadcast")

    // replaced (absent, latest advanced past our nonce) → replaced
    const repl = freshStub()
    await injectChain(repl, { pending: 6, latest: 6, liveness: { "0xhash_6": "absent" } })
    await repl.settle(req())
    await injectChain(repl, { pending: 6, latest: 8, liveness: { "0xhash_6": "absent" } }) // a different tx consumed nonce 6
    expect((await repl.reconcile(req())).state).toBe("replaced")
  })

  it("signing recovery after an expired claim on a reserving row", async () => {
    const stub = freshStub()
    await injectChain(stub, { pending: 1, latest: 1, liveness: {} })
    await stub.settle(req()) // creates a broadcast effect
    // simulate a crashed signer: force the row back to reserving with a STALE (expired) claim
    await runInDurableObject(stub, (_i, state) => {
      state.storage.sql.exec("UPDATE effects SET state='reserving', signed_tx=NULL, tx_hash=NULL, claim_token='crashed', claim_expires_at=1")
    })
    const r = await stub.reconcile(req()) // expired claim → re-claim + sign + broadcast
    expect(r.state).toBe("broadcast")
    expect((await effects(stub))[0].tx_hash).toBe("0xhash_1")
  })

  it("immutable-data mismatch is rejected through every RPC", async () => {
    const stub = freshStub()
    await injectChain(stub, { pending: 0, latest: 0, liveness: { "0xhash_0": "success" } })
    await stub.settle(req())
    const bad = req({ amountCents: 9999 })
    await expect(stub.settle(bad)).rejects.toThrow()
    await expect(stub.confirm(bad, "0xhash_0")).rejects.toThrow()
    await expect(stub.reconcile(bad)).rejects.toThrow()
    await expect(stub.lookup(bad)).rejects.toThrow()
  })
})
