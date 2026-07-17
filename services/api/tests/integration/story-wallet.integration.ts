import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"
import { getAddress, keccak256, type Hex } from "viem"
import { privateKeyToAccount } from "viem/accounts"

import { deriveStorySettlementCallIdentity } from "../../src/lib/story/story-settlement-call-identity"
import {
  setStorySettlementChainPrimitivesForTests,
  type StorySettlementChainPrimitives,
  type StorySettlementPlanRequest,
  type StoryTransactionObservation,
} from "../../src/lib/story/story-settlement-wallet-coordinator-do"

const SIGNING_ACCOUNT = privateKeyToAccount(`0x${"11".repeat(32)}`)
const WRONG_SIGNING_ACCOUNT = privateKeyToAccount(`0x${"12".repeat(32)}`)
const SIGNER = SIGNING_ACCOUNT.address
const TOKEN = "0x2222222222222222222222222222222222222222"
const BUYER = "0x3333333333333333333333333333333333333333"
const PURCHASE_REF = `0x${"44".repeat(32)}` as Hex
const BLOCK_A = `0x${"aa".repeat(32)}` as Hex
const BLOCK_B = `0x${"bb".repeat(32)}` as Hex

type Stub = ReturnType<typeof env.STORY_SETTLEMENT_WALLET_COORDINATOR.getByName>
let sequence = 0

interface ChainHarness {
  pendingNonce: number
  latestNonce: number
  observation: StoryTransactionObservation
  signed: Hex[]
  broadcasts: Hex[]
  signInputs: Array<{
    nonce: number
    target: string
    value: bigint
    calldata: Hex
    gas: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; gasLimit: bigint }
  }>
  faultOnce?: string
  signError?: string
  wrongSigner?: boolean
}

function freshStub(): Stub {
  return env.STORY_SETTLEMENT_WALLET_COORDINATOR.getByName(`story-wallet-test-${sequence++}`)
}

async function injectChain(stub: Stub, harness: ChainHarness): Promise<void> {
  await runInDurableObject(stub, () => {
    const primitives: StorySettlementChainPrimitives = {
      pendingNonce: async () => harness.pendingNonce,
      latestNonce: async () => harness.latestNonce,
      gasParameters: async () => ({ maxFeePerGas: 100n, maxPriorityFeePerGas: 2n, gasLimit: 500_000n }),
      signTransaction: async (_env, input) => {
        if (harness.signError) throw new Error(harness.signError)
        harness.signInputs.push(input)
        const signed = await (harness.wrongSigner ? WRONG_SIGNING_ACCOUNT : SIGNING_ACCOUNT).signTransaction({
          type: "eip1559",
          chainId: input.chainId,
          nonce: input.nonce,
          to: input.target,
          value: input.value,
          data: input.calldata,
          gas: input.gas.gasLimit,
          maxFeePerGas: input.gas.maxFeePerGas,
          maxPriorityFeePerGas: input.gas.maxPriorityFeePerGas,
        })
        harness.signed.push(signed)
        return signed
      },
      broadcastExactTransaction: async (_env, input) => { harness.broadcasts.push(input.signedTransaction) },
      observeTransaction: async () => harness.observation,
      fault: async (point) => {
        if (harness.faultOnce === point) {
          harness.faultOnce = undefined
          throw new Error(`fault:${point}`)
        }
      },
    }
    setStorySettlementChainPrimitivesForTests(primitives)
  })
}

function plan(over: Partial<StorySettlementPlanRequest> = {}, stepCount = 1): StorySettlementPlanRequest {
  const base = {
    chainId: over.chainId ?? 1315,
    signerAddress: over.signerAddress ?? SIGNER,
    communityId: over.communityId ?? "community_story",
    quoteId: over.quoteId ?? "quote_story",
    purchaseId: over.purchaseId ?? "purchase_story",
    feePolicyVersion: over.feePolicyVersion ?? "story-eip1559-capped-v1",
    finalityPolicyVersion: over.finalityPolicyVersion ?? "story-safe-depth-v1",
  }
  const steps = Array.from({ length: stepCount }, (_, ordinal) => {
    const identityInput = {
      ...base,
      effectKind: "story_entitlement_mint" as const,
      effectKey: `entitlement:${ordinal}`,
      stepKind: "story_entitlement_mint" as const,
      ordinal,
      target: TOKEN,
      nativeValue: 0n,
      calldata: `0xe883fe8f${ordinal.toString(16).padStart(64, "0")}` as Hex,
      entitlementToken: TOKEN,
      buyerAddress: BUYER,
      purchaseRef: PURCHASE_REF,
    }
    return { ...identityInput, callIdentity: deriveStorySettlementCallIdentity(identityInput) }
  })
  return { ...base, ...over, steps: over.steps ?? steps }
}

function harness(over: Partial<ChainHarness> = {}): ChainHarness {
  return {
    pendingNonce: 7,
    latestNonce: 7,
    observation: { kind: "pending" },
    signed: [],
    broadcasts: [],
    signInputs: [],
    ...over,
  }
}

async function storedSteps(stub: Stub): Promise<Array<Record<string, unknown>>> {
  return runInDurableObject(stub, (_instance, state) => state.storage.sql.exec(
    `SELECT ordinal,state,version,nonce,signed_transaction,transaction_hash,block_hash,
     repair_state,repair_signed_transaction,repair_transaction_hash,last_error_code FROM steps ORDER BY ordinal`,
  ).toArray())
}

async function forceAlarm(stub: Stub): Promise<void> {
  await runInDurableObject(stub, (instance) => instance.alarm())
}

async function storedAlarm(stub: Stub): Promise<number | null> {
  return runInDurableObject(stub, (_instance, state) => state.storage.getAlarm())
}

beforeEach(() => setStorySettlementChainPrimitivesForTests(null))

describe("StorySettlementWalletCoordinatorDO (real workerd + SQLite)", () => {
  it("re-arms a fired alarm when the next step is not runnable yet", async () => {
    const stub = freshStub()
    await injectChain(stub, harness())
    await stub.admit(plan())
    const future = Date.now() + 60_000
    await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec("UPDATE steps SET next_attempt_at=?1", future)
      await state.storage.setAlarm(Date.now() - 1)
      await instance.alarm()
    })
    expect(await storedAlarm(stub)).toBe(future)
  })

  it("admits immutable calls, derives the signed hash, and finality-gates serial nonces", async () => {
    const stub = freshStub()
    const state = harness()
    await injectChain(stub, state)
    const admitted = await stub.admit(plan({}, 2))
    expect(admitted.steps.map((step) => step.state)).toEqual(["planned", "planned"])

    await runDurableObjectAlarm(stub)
    let result = (await stub.lookup(admitted.planRef))!
    expect(result.steps.map((step) => [step.state, step.nonce])).toEqual([["broadcast", 7], ["planned", null]])
    const [first] = await storedSteps(stub)
    expect(first!.transaction_hash).toBe(keccak256(first!.signed_transaction as Hex))
    expect(state.signInputs[0]!.gas).toEqual({ maxFeePerGas: 100n, maxPriorityFeePerGas: 2n, gasLimit: 500_000n })

    state.observation = { kind: "mined", status: "success", blockNumber: 10n, blockHash: BLOCK_A, final: false }
    await injectChain(stub, state)
    await stub.reconcile(admitted.planRef)
    await forceAlarm(stub)
    expect((await stub.lookup(admitted.planRef))!.steps[1]!.nonce).toBeNull()

    state.observation = { kind: "mined", status: "success", blockNumber: 10n, blockHash: BLOCK_A, final: true }
    await injectChain(stub, state)
    await stub.reconcile(admitted.planRef)
    await forceAlarm(stub)
    await runDurableObjectAlarm(stub)
    result = (await stub.lookup(admitted.planRef))!
    expect(result.steps.map((step) => [step.state, step.nonce])).toEqual([["confirmed", 7], ["broadcast", 8]])
  })

  it("rejects a caller-supplied call identity that does not match exact call bytes", async () => {
    const stub = freshStub()
    await injectChain(stub, harness())
    const request = plan()
    request.steps[0]!.callIdentity = `0x${"ff".repeat(32)}`
    await expect(stub.admit(request)).rejects.toThrow()
  })

  it("binds fee/finality policy versions into plan identity and one signer domain per object", async () => {
    const stub = freshStub()
    await injectChain(stub, harness())
    const first = await stub.admit(plan())
    expect((await stub.admit(plan())).planRef).toBe(first.planRef)
    await expect(stub.admit(plan({ finalityPolicyVersion: "story-safe-depth-v2" }))).rejects.toThrow()

    await expect(stub.admit(plan({
      signerAddress: "0x9999999999999999999999999999999999999999",
      quoteId: "quote_wrong_domain",
      purchaseId: "purchase_wrong_domain",
    }))).rejects.toThrow()
  })

  it("retries a crash after signing with the same nonce and no broadcast of lost bytes", async () => {
    const stub = freshStub()
    const state = harness({ faultOnce: "after_signed_before_persist" })
    await injectChain(stub, state)
    const admitted = await stub.admit(plan())
    await runDurableObjectAlarm(stub)
    let [row] = await storedSteps(stub)
    expect(row).toMatchObject({ state: "failed_prebroadcast", nonce: 7, signed_transaction: null, transaction_hash: null })
    expect(state.broadcasts).toEqual([])

    await stub.reconcile(admitted.planRef)
    await runDurableObjectAlarm(stub)
    ;[row] = await storedSteps(stub)
    expect(row).toMatchObject({ state: "broadcast", nonce: 7 })
    expect(state.signInputs.map((input) => input.nonce)).toEqual([7, 7])
    expect(state.broadcasts).toEqual([row!.signed_transaction])
  })

  it("rejects signed bytes from a key outside the coordinator signer domain", async () => {
    const stub = freshStub()
    const state = harness({ wrongSigner: true })
    await injectChain(stub, state)
    const admitted = await stub.admit(plan())
    await runDurableObjectAlarm(stub)
    expect((await stub.lookup(admitted.planRef))!.steps[0]).toMatchObject({
      state: "failed_prebroadcast",
      nonce: 7,
      transactionHash: null,
      lastErrorCode: "transaction_signing_error",
    })
    expect(state.broadcasts).toEqual([])
  })

  it("recovers the same reserved nonce after a crash before signing", async () => {
    const stub = freshStub()
    const state = harness({ faultOnce: "after_nonce_reserved" })
    await injectChain(stub, state)
    const admitted = await stub.admit(plan())
    await runDurableObjectAlarm(stub)
    let [row] = await storedSteps(stub)
    expect(row).toMatchObject({ state: "reserving", nonce: 7, signed_transaction: null })

    await stub.reconcile(admitted.planRef)
    await forceAlarm(stub)
    ;[row] = await storedSteps(stub)
    expect(row).toMatchObject({ state: "broadcast", nonce: 7 })
    expect(state.signInputs.map((input) => input.nonce)).toEqual([7])
  })

  it("broadcasts persisted bytes without re-signing after a crash at the prepared CAS", async () => {
    const stub = freshStub()
    const state = harness({ faultOnce: "after_prepared_persisted" })
    await injectChain(stub, state)
    const admitted = await stub.admit(plan())
    await runDurableObjectAlarm(stub)
    const [prepared] = await storedSteps(stub)
    expect(prepared).toMatchObject({ state: "prepared", nonce: 7 })
    expect(state.broadcasts).toEqual([])

    await stub.reconcile(admitted.planRef)
    await forceAlarm(stub)
    expect(state.signed).toHaveLength(1)
    expect(state.broadcasts).toEqual([prepared!.signed_transaction])
  })

  it("rebroadcasts exact persisted bytes after a crash following send", async () => {
    const stub = freshStub()
    const state = harness({ faultOnce: "after_broadcast_before_persist" })
    await injectChain(stub, state)
    const admitted = await stub.admit(plan())
    await runDurableObjectAlarm(stub)
    const [prepared] = await storedSteps(stub)
    expect(prepared).toMatchObject({ state: "prepared", nonce: 7 })
    expect(state.broadcasts).toEqual([prepared!.signed_transaction])

    await stub.reconcile(admitted.planRef)
    await runDurableObjectAlarm(stub)
    if (state.broadcasts.length === 1) {
      await stub.reconcile(admitted.planRef)
      await runDurableObjectAlarm(stub)
    }
    expect(state.signed).toHaveLength(1)
    expect(state.broadcasts).toEqual([prepared!.signed_transaction, prepared!.signed_transaction])
  })

  it("rebroadcasts an absent hash only while its nonce remains unused", async () => {
    const stub = freshStub()
    const state = harness()
    await injectChain(stub, state)
    const admitted = await stub.admit(plan())
    await runDurableObjectAlarm(stub)
    const [stored] = await storedSteps(stub)
    const signed = stored!.signed_transaction as Hex
    state.observation = { kind: "absent" }
    await injectChain(stub, state)
    await stub.reconcile(admitted.planRef)
    await forceAlarm(stub)
    expect(state.broadcasts).toEqual([signed, signed])
    expect((await stub.lookup(admitted.planRef))!.steps[0]!.state).toBe("broadcast")
  })

  it("keeps a live signing lease fenced and resumes it after expiry", async () => {
    const stub = freshStub()
    const state = harness({ faultOnce: "after_nonce_reserved" })
    await injectChain(stub, state)
    const admitted = await stub.admit(plan())
    await runDurableObjectAlarm(stub)
    const liveUntil = Date.now() + 60_000
    await runInDurableObject(stub, (_instance, durableState) => {
      durableState.storage.sql.exec(
        "UPDATE steps SET claim_token='live-lease',claim_expires_at=?1 WHERE plan_ref=?2",
        liveUntil, admitted.planRef,
      )
    })
    await forceAlarm(stub)
    expect(state.signed).toEqual([])

    await runInDurableObject(stub, (_instance, durableState) => {
      durableState.storage.sql.exec("UPDATE steps SET claim_expires_at=1 WHERE plan_ref=?1", admitted.planRef)
    })
    await stub.reconcile(admitted.planRef)
    await forceAlarm(stub)
    expect(state.signInputs.map((input) => input.nonce)).toEqual([7])
  })

  it("alerts and fences a mined block-identity change as reconciliation_required", async () => {
    const stub = freshStub()
    const state = harness()
    await injectChain(stub, state)
    const admitted = await stub.admit(plan())
    await runDurableObjectAlarm(stub)
    state.observation = { kind: "mined", status: "success", blockNumber: 10n, blockHash: BLOCK_A, final: false }
    await injectChain(stub, state)
    await stub.reconcile(admitted.planRef)
    await forceAlarm(stub)
    state.observation = { kind: "mined", status: "success", blockNumber: 11n, blockHash: BLOCK_B, final: false }
    await injectChain(stub, state)
    await stub.reconcile(admitted.planRef)
    await forceAlarm(stub)
    expect((await stub.lookup(admitted.planRef))!.steps[0]).toMatchObject({
      state: "reconciliation_required",
      lastErrorCode: "mined_block_identity_changed",
    })
  })

  it("persists receipt evidence only after a crash-safe retry", async () => {
    const stub = freshStub()
    const state = harness()
    await injectChain(stub, state)
    const admitted = await stub.admit(plan())
    await runDurableObjectAlarm(stub)
    state.observation = { kind: "mined", status: "success", blockNumber: 20n, blockHash: BLOCK_A, final: false }
    state.faultOnce = "after_receipt_before_persist"
    await injectChain(stub, state)
    await stub.reconcile(admitted.planRef)
    await forceAlarm(stub)
    expect((await stub.lookup(admitted.planRef))!.steps[0]).toMatchObject({ state: "broadcast", receipt: null })

    await stub.reconcile(admitted.planRef)
    await forceAlarm(stub)
    expect((await stub.lookup(admitted.planRef))!.steps[0]).toMatchObject({
      state: "mined",
      receipt: { status: "success", blockNumber: 20n, blockHash: BLOCK_A },
    })
  })

  it("closes an abandoned reserved nonce with a separately journaled zero-value self transaction", async () => {
    const stub = freshStub()
    const state = harness({ signError: "terminal signer configuration" })
    await injectChain(stub, state)
    const admitted = await stub.admit(plan())
    await runDurableObjectAlarm(stub)
    const failed = (await stub.lookup(admitted.planRef))!.steps[0]!
    expect(failed).toMatchObject({ state: "failed_prebroadcast", nonce: 7 })

    state.signError = undefined
    await injectChain(stub, state)
    const abandoning = await stub.requestAbandonedNonceRepair({
      planRef: admitted.planRef,
      stepRef: failed.stepRef,
      expectedVersion: failed.version,
      reasonCode: "terminal_configuration",
      authorizationRef: "incident:story-settlement:test-terminal-configuration",
    })
    expect(abandoning.state).toBe("abandoning")
    await forceAlarm(stub) // durable repair bytes
    await stub.reconcile(admitted.planRef)
    await forceAlarm(stub) // exact-byte broadcast
    state.observation = { kind: "mined", status: "success", blockNumber: 12n, blockHash: BLOCK_A, final: true }
    await injectChain(stub, state)
    await stub.reconcile(admitted.planRef)
    await forceAlarm(stub) // final repair evidence

    const repaired = (await stub.lookup(admitted.planRef))!
    expect(repaired.state).toBe("abandoned")
    expect(repaired.steps[0]!.repairState).toBe("confirmed")
    expect(state.signInputs.at(-1)).toMatchObject({ nonce: 7, target: getAddress(SIGNER), value: 0n, calldata: "0x" })
    const [row] = await storedSteps(stub)
    expect(row!.repair_transaction_hash).toBe(keccak256(row!.repair_signed_transaction as Hex))
  })

  it("prioritizes a nonce-gap repair over a concurrently admitted plan", async () => {
    const stub = freshStub()
    const state = harness({ signError: "rights hold froze the abandoned plan" })
    await injectChain(stub, state)
    const abandoned = await stub.admit(plan())
    await runDurableObjectAlarm(stub)
    const failed = (await stub.lookup(abandoned.planRef))!.steps[0]!
    await stub.requestAbandonedNonceRepair({
      planRef: abandoned.planRef,
      stepRef: failed.stepRef,
      expectedVersion: failed.version,
      reasonCode: "rights_hold",
      authorizationRef: "rights-hold:story-settlement:test-concurrent-plan",
    })
    const concurrent = await stub.admit(plan({
      communityId: "community_other",
      quoteId: "quote_other",
      purchaseId: "purchase_other",
    }))

    state.signError = undefined
    await injectChain(stub, state)
    await forceAlarm(stub)
    expect((await stub.lookup(concurrent.planRef))!.steps[0]!.nonce).toBeNull()
    await forceAlarm(stub)
    state.observation = { kind: "mined", status: "success", blockNumber: 30n, blockHash: BLOCK_A, final: true }
    await injectChain(stub, state)
    await stub.reconcile(abandoned.planRef)
    await forceAlarm(stub)
    expect((await stub.lookup(abandoned.planRef))!.state).toBe("abandoned")

    state.observation = { kind: "pending" }
    await injectChain(stub, state)
    await forceAlarm(stub)
    expect((await stub.lookup(concurrent.planRef))!.steps[0]!.nonce).toBe(8)
  })

  it("marks an absent transaction replaced when another transaction consumed its nonce", async () => {
    const stub = freshStub()
    const state = harness()
    await injectChain(stub, state)
    const admitted = await stub.admit(plan())
    await runDurableObjectAlarm(stub)
    state.observation = { kind: "absent" }
    state.latestNonce = 8
    await injectChain(stub, state)
    await stub.reconcile(admitted.planRef)
    await runDurableObjectAlarm(stub)
    expect((await stub.lookup(admitted.planRef))!.steps[0]!.state).toBe("replaced")
  })

  it("makes a reverted receipt terminal and never allocates its dependent step", async () => {
    const stub = freshStub()
    const state = harness()
    await injectChain(stub, state)
    const admitted = await stub.admit(plan({}, 2))
    await runDurableObjectAlarm(stub)
    state.observation = { kind: "mined", status: "reverted", blockNumber: 40n, blockHash: BLOCK_A, final: true }
    await injectChain(stub, state)
    await stub.reconcile(admitted.planRef)
    await forceAlarm(stub)
    const result = (await stub.lookup(admitted.planRef))!
    expect(result.state).toBe("failed")
    expect(result.steps.map((step) => [step.state, step.nonce])).toEqual([["reverted", 7], ["planned", null]])
  })

  it("fences a consumed nonce discovered after pre-finality mining before replacement", async () => {
    const stub = freshStub()
    const state = harness()
    await injectChain(stub, state)
    const admitted = await stub.admit(plan())
    await runDurableObjectAlarm(stub)
    state.observation = { kind: "mined", status: "success", blockNumber: 50n, blockHash: BLOCK_A, final: false }
    await injectChain(stub, state)
    await stub.reconcile(admitted.planRef)
    await forceAlarm(stub)

    state.observation = { kind: "absent" }
    state.latestNonce = 8
    await injectChain(stub, state)
    await stub.reconcile(admitted.planRef)
    await forceAlarm(stub)
    let step = (await stub.lookup(admitted.planRef))!.steps[0]!
    if (step.state === "reconciliation_required") {
      await stub.reconcile(admitted.planRef)
      await forceAlarm(stub)
      step = (await stub.lookup(admitted.planRef))!.steps[0]!
    }
    expect(step).toMatchObject({ state: "replaced", lastErrorCode: "pre_finality_reorg_nonce_consumed" })
  })
})
