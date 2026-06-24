import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"

import {
  OperatorSigningCoordinatorDO,
  setOperatorChainPrimitivesForTests,
  type OperatorSettleRequest,
} from "../../../../src/lib/communities/bookings/operator-signing-coordinator-do"
import type { Env } from "../../../../src/env"

// --- bun:sqlite-backed fake DurableObjectState (synchronous → supports transactionSync + RETURNING).
class FakeSqlStorage {
  constructor(private db: Database) {}
  exec<T = Record<string, unknown>>(sql: string, ...args: unknown[]) {
    const rows = this.db.query(sql).all(...(args as never[])) as T[]
    return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() }
  }
}
class FakeStorage {
  sql: FakeSqlStorage
  constructor(public db: Database) { this.sql = new FakeSqlStorage(db) }
  transactionSync<T>(cb: () => T): T { return this.db.transaction(cb)() }
}
function makeDO() {
  const db = new Database(":memory:")
  const storage = new FakeStorage(db)
  const ctx = { storage, blockConcurrencyWhile: async <T>(cb: () => Promise<T>): Promise<T> => cb() }
  const do_ = new OperatorSigningCoordinatorDO(ctx as never, {} as Env)
  return { do_, db }
}

// --- controllable fake chain (replaces the real signer/RPC entirely).
type Liveness = "success" | "failed" | "pending" | "absent"
function makeChain(opts: { pending?: number; latest?: number } = {}) {
  const state = {
    pending: opts.pending ?? 0,
    latest: opts.latest ?? 0,
    signCalls: 0,
    signed: [] as { nonce: number; to: string; amount: number }[],
    broadcasts: [] as string[],
    liveness: new Map<string, Liveness>(),
    signError: null as Error | null,
    firstSignHangs: false,
    broadcastGate: null as Promise<void> | null,
  }
  setOperatorChainPrimitivesForTests({
    pendingNonce: async () => state.pending,
    latestNonce: async () => state.latest,
    gasParams: async () => ({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, gasLimit: 1n }),
    signVerifiedTransfer: async (_env, input) => {
      state.signCalls++
      if (state.firstSignHangs && state.signCalls === 1) return new Promise(() => {}) // never resolves (crash)
      if (state.signError) throw state.signError
      const txHash = `0xhash_${input.nonce}`
      state.signed.push({ nonce: input.nonce, to: input.to, amount: input.amountCents })
      return { signedTx: `signed_${input.nonce}`, txHash }
    },
    broadcast: async (_env, input) => { if (state.broadcastGate) await state.broadcastGate; state.broadcasts.push(input.signedTx) },
    txLiveness: async (_env, hash) => state.liveness.get(hash) ?? "absent",
  })
  return state
}

afterEach(() => setOperatorChainPrimitivesForTests(null))

function req(over: Partial<OperatorSettleRequest> = {}): OperatorSettleRequest {
  return { communityId: "c1", bookingId: "bkg1", effectKind: "booking_refund", amountCents: 5000, recipientAddress: "0x0000000000000000000000000000000000000222", ...over }
}

describe("OperatorSigningCoordinatorDO", () => {
  test("two concurrent settle() for the SAME effect → one nonce, one signed tx", async () => {
    const { do_ } = makeDO()
    const chain = makeChain({ pending: 4 })
    const [a, b] = await Promise.all([do_.settle(req()), do_.settle(req())])
    expect(chain.signed.length).toBe(1) // signing happened exactly once
    expect(chain.signed[0].nonce).toBe(4)
    // exactly one of the two callers drove it to broadcast; both observe the single effect
    expect([a.state, b.state].filter((s) => s === "broadcast").length).toBeGreaterThanOrEqual(1)
    expect(a.nonce).toBe(4)
    expect(b.nonce).toBe(4)
  })

  test("different effects receive distinct nonces", async () => {
    const { do_ } = makeDO()
    const chain = makeChain({ pending: 10 })
    const [x, y] = await Promise.all([do_.settle(req({ bookingId: "bkgA" })), do_.settle(req({ bookingId: "bkgB" }))])
    expect(new Set([x.nonce, y.nonce]).size).toBe(2)
    expect([x.nonce, y.nonce].sort()).toEqual([10, 11])
    expect(new Set(chain.signed.map((s) => s.nonce)).size).toBe(2)
  })

  test("signing recovery after claim expiry", async () => {
    const { do_, db } = makeDO()
    const chain = makeChain({ pending: 1 })
    chain.signError = new Error("transient sign failure")
    await expect(do_.settle(req())).rejects.toThrow() // first attempt fails preparation
    // simulate a crashed signer that left a STALE claim on the reserving row
    db.query("UPDATE effects SET state='reserving', claim_token='crashed', claim_expires_at=1").run()
    chain.signError = null
    const r = await do_.reconcile(req()) // claim is expired → re-claim + sign + broadcast
    expect(r.state).toBe("broadcast")
    expect(chain.signed.length).toBe(1)
    expect(chain.signed[0].nonce).toBe(1)
  })

  test("a delayed broadcast cannot regress a confirmed effect (version CAS)", async () => {
    const { do_ } = makeDO()
    const chain = makeChain({ pending: 2 })
    // Gate the broadcast so settle's broadcastRow is mid-flight (row at 'prepared', version V) while
    // a confirmation lands and advances the version. The stale CAS to 'broadcast' must then fail.
    let release!: () => void
    chain.broadcastGate = new Promise<void>((r) => { release = r })
    const txHash = "0xhash_2"
    chain.liveness.set(txHash, "success")
    const settlePromise = do_.settle(req()) // blocks inside broadcast(), holding version V
    await new Promise((r) => setTimeout(r, 10))
    const confirmed = await do_.confirm(req(), txHash) // prepared → confirmed, bumps version
    expect(confirmed.state).toBe("confirmed")
    release() // broadcast completes; broadcastRow's CAS (stale version) must NOT regress to 'broadcast'
    const settled = await settlePromise
    expect(settled.state).toBe("confirmed")
    expect(chain.broadcasts.length).toBe(1)
  })

  test("failed on-chain receipt is terminal (failed_onchain), never rebroadcast", async () => {
    const { do_ } = makeDO()
    const chain = makeChain({ pending: 3 })
    const settled = await do_.settle(req())
    chain.liveness.set(settled.txHash!, "failed")
    const confirmed = await do_.confirm(req(), settled.txHash!)
    expect(confirmed.state).toBe("failed_onchain")
    const broadcastsBefore = chain.broadcasts.length
    const reconciled = await do_.reconcile(req()) // terminal → no rebroadcast
    expect(reconciled.state).toBe("failed_onchain")
    expect(chain.broadcasts.length).toBe(broadcastsBefore)
  })

  test("immutable-data mismatch is rejected through every RPC", async () => {
    const { do_ } = makeDO()
    makeChain({ pending: 0 })
    const settled = await do_.settle(req())
    const bad = req({ amountCents: 9999 }) // same key (community/booking/effect), different amount
    await expect(do_.settle(bad)).rejects.toThrow()
    await expect(do_.confirm(bad, settled.txHash!)).rejects.toThrow()
    await expect(do_.reconcile(bad)).rejects.toThrow()
    expect(() => do_.lookup(bad)).toThrow()
  })
})
