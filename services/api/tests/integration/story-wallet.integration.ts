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
const FEE_REPLACEMENT_OPERATOR = {
  operatorCredentialId: "opc_story_fee_replace",
  operatorActorId: "svc_story_fee_replace",
} as const

type Stub = ReturnType<typeof env.STORY_SETTLEMENT_WALLET_COORDINATOR.getByName>
let sequence = 0

interface ChainHarness {
  pendingNonce: number
  latestNonce: number
  observation: StoryTransactionObservation
  observations?: Map<Hex, StoryTransactionObservation>
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
      nativeBalance: async () => 10n ** 18n,
      wipBalance: async () => 0n,
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
      observeTransaction: async (_env, input) => harness.observations?.get(input.transactionHash) ?? harness.observation,
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

async function storedCandidates(stub: Stub): Promise<Array<Record<string, unknown>>> {
  return runInDurableObject(stub, (_instance, state) => state.storage.sql.exec(
    `SELECT candidate_ref,step_ref,generation,kind,parent_candidate_ref,is_active,state,nonce,
     max_fee_per_gas,max_priority_fee_per_gas,signed_transaction,transaction_hash,
     receipt_status,block_number,block_hash,authorization_ref
     FROM story_settlement_transaction_candidates ORDER BY generation`,
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

  it("keeps generation-zero-only reconciliation behavior unchanged", async () => {
    const stub = freshStub()
    const state = harness()
    await injectChain(stub, state)
    const admitted = await stub.admit(plan())
    await runDurableObjectAlarm(stub)
    const before = (await stub.lookup(admitted.planRef))!.steps[0]!
    const [original] = await storedCandidates(stub)
    expect(original).toMatchObject({
      generation: 0,
      kind: "original",
      is_active: 1,
      state: "broadcast",
      nonce: 7,
      transaction_hash: before.transactionHash,
    })

    state.observation = { kind: "mined", status: "success", blockNumber: 10n, blockHash: BLOCK_A, final: true }
    await injectChain(stub, state)
    await stub.reconcile(admitted.planRef)
    await forceAlarm(stub)
    await stub.reconcile(admitted.planRef)
    await forceAlarm(stub)
    expect((await stub.lookup(admitted.planRef))!.steps[0]).toMatchObject({
      state: "confirmed",
      transactionHash: before.transactionHash,
      receipt: { status: "success", blockNumber: 10n, blockHash: BLOCK_A },
    })
    expect(state.broadcasts).toEqual([original!.signed_transaction])
  })

  it("rejects replacement before an original signed candidate exists", async () => {
    const stub = freshStub()
    await injectChain(stub, harness())
    const admitted = await stub.admit(plan({}, 2))
    await expect(stub.requestFeeReplacement({
      ...FEE_REPLACEMENT_OPERATOR,
      planRef: admitted.planRef,
      stepRef: admitted.steps[1]!.stepRef,
      expectedVersion: admitted.steps[1]!.version,
      expectedActiveCandidateHash: `0x${"55".repeat(32)}`,
      maxFeePerGas: 110n,
      maxPriorityFeePerGas: 3n,
      authorizationRef: "operator:fee-replace:unsigned",
    })).rejects.toThrow("no active broadcast candidate")
    expect((await storedCandidates(stub)).filter((candidate) => candidate.step_ref === admitted.steps[1]!.stepRef)).toEqual([])
  })

  it("enforces rounded per-field bumps and supports a linear pending supersession chain", async () => {
    const stub = freshStub()
    const state = harness()
    await injectChain(stub, state)
    const admitted = await stub.admit(plan())
    await runDurableObjectAlarm(stub)
    const originalStep = (await stub.lookup(admitted.planRef))!.steps[0]!

    await expect(stub.requestFeeReplacement({
      ...FEE_REPLACEMENT_OPERATOR,
      planRef: admitted.planRef,
      stepRef: originalStep.stepRef,
      expectedVersion: originalStep.version,
      expectedActiveCandidateHash: originalStep.transactionHash!,
      maxFeePerGas: 109n,
      maxPriorityFeePerGas: 2n,
      authorizationRef: "operator:fee-replace:underpriced",
    })).rejects.toThrow("max_fee_bump_too_small")
    await expect(stub.requestFeeReplacement({
      ...FEE_REPLACEMENT_OPERATOR,
      planRef: admitted.planRef,
      stepRef: originalStep.stepRef,
      expectedVersion: originalStep.version,
      expectedActiveCandidateHash: originalStep.transactionHash!,
      maxFeePerGas: 110n,
      maxPriorityFeePerGas: 2n,
      authorizationRef: "operator:fee-replace:priority-underpriced",
    })).rejects.toThrow("priority_fee_bump_too_small")
    expect(state.signed).toHaveLength(1)

    const firstRequest = {
      ...FEE_REPLACEMENT_OPERATOR,
      planRef: admitted.planRef,
      stepRef: originalStep.stepRef,
      expectedVersion: originalStep.version,
      expectedActiveCandidateHash: originalStep.transactionHash!,
      maxFeePerGas: 110n,
      maxPriorityFeePerGas: 3n,
      authorizationRef: "operator:fee-replace:generation-1",
    }
    const first = await stub.requestFeeReplacement(firstRequest)
    expect(first).toMatchObject({ generation: 1, state: "prepared" })
    expect(await stub.requestFeeReplacement(firstRequest)).toEqual(first)
    expect(state.signed).toHaveLength(2)
    await forceAlarm(stub)
    expect(state.broadcasts.at(-1)).toBe((await storedCandidates(stub))[1]!.signed_transaction)

    const currentStep = (await stub.lookup(admitted.planRef))!.steps[0]!
    const second = await stub.requestFeeReplacement({
      ...FEE_REPLACEMENT_OPERATOR,
      planRef: admitted.planRef,
      stepRef: currentStep.stepRef,
      expectedVersion: currentStep.version,
      expectedActiveCandidateHash: first.transactionHash,
      maxFeePerGas: 121n,
      maxPriorityFeePerGas: 4n,
      authorizationRef: "operator:fee-replace:generation-2",
    })
    expect(second).toMatchObject({ generation: 2, state: "prepared" })
    const candidates = await storedCandidates(stub)
    expect(candidates.map((candidate) => [candidate.generation, candidate.parent_candidate_ref, candidate.is_active])).toEqual([
      [0, null, 0],
      [1, candidates[0]!.candidate_ref, 0],
      [2, candidates[1]!.candidate_ref, 1],
    ])
  })

  it("follows the nonce-consuming replacement hash and supersedes every sibling", async () => {
    const stub = freshStub()
    const state = harness()
    await injectChain(stub, state)
    const admitted = await stub.admit(plan())
    await runDurableObjectAlarm(stub)
    const original = (await stub.lookup(admitted.planRef))!.steps[0]!
    const replacement = await stub.requestFeeReplacement({
      ...FEE_REPLACEMENT_OPERATOR,
      planRef: admitted.planRef,
      stepRef: original.stepRef,
      expectedVersion: original.version,
      expectedActiveCandidateHash: original.transactionHash!,
      maxFeePerGas: 110n,
      maxPriorityFeePerGas: 3n,
      authorizationRef: "operator:fee-replace:winner",
    })
    await forceAlarm(stub)
    state.observations = new Map([
      [original.transactionHash!, { kind: "absent" }],
      [replacement.transactionHash, { kind: "mined", status: "success", blockNumber: 42n, blockHash: BLOCK_B, final: true }],
    ])
    await injectChain(stub, state)
    await stub.reconcile(admitted.planRef)
    await forceAlarm(stub)
    expect((await stub.lookup(admitted.planRef))!.steps[0]).toMatchObject({
      state: "confirmed",
      transactionHash: replacement.transactionHash,
      receipt: { status: "success", blockNumber: 42n, blockHash: BLOCK_B },
    })
    expect((await storedCandidates(stub)).map((candidate) => candidate.state)).toEqual(["superseded", "confirmed"])
  })

  it("does not broadcast a prepared replacement after the original consumes the nonce", async () => {
    const stub = freshStub()
    const state = harness()
    await injectChain(stub, state)
    const admitted = await stub.admit(plan())
    await runDurableObjectAlarm(stub)
    const original = (await stub.lookup(admitted.planRef))!.steps[0]!
    const replacement = await stub.requestFeeReplacement({
      ...FEE_REPLACEMENT_OPERATOR,
      planRef: admitted.planRef,
      stepRef: original.stepRef,
      expectedVersion: original.version,
      expectedActiveCandidateHash: original.transactionHash!,
      maxFeePerGas: 110n,
      maxPriorityFeePerGas: 3n,
      authorizationRef: "operator:fee-replace:original-won",
    })
    state.observations = new Map([
      [original.transactionHash!, { kind: "mined", status: "success", blockNumber: 51n, blockHash: BLOCK_A, final: true }],
      [replacement.transactionHash, { kind: "absent" }],
    ])
    await injectChain(stub, state)
    await forceAlarm(stub)
    expect(state.broadcasts).toHaveLength(1)
    expect((await stub.lookup(admitted.planRef))!.steps[0]).toMatchObject({
      state: "confirmed",
      transactionHash: original.transactionHash,
    })
    expect((await storedCandidates(stub)).map((candidate) => candidate.state)).toEqual(["confirmed", "superseded"])
  })

  it("makes a reverted replacement the authoritative terminal nonce consumer", async () => {
    const stub = freshStub()
    const state = harness()
    await injectChain(stub, state)
    const admitted = await stub.admit(plan())
    await runDurableObjectAlarm(stub)
    const original = (await stub.lookup(admitted.planRef))!.steps[0]!
    const replacement = await stub.requestFeeReplacement({
      ...FEE_REPLACEMENT_OPERATOR,
      planRef: admitted.planRef,
      stepRef: original.stepRef,
      expectedVersion: original.version,
      expectedActiveCandidateHash: original.transactionHash!,
      maxFeePerGas: 110n,
      maxPriorityFeePerGas: 3n,
      authorizationRef: "operator:fee-replace:reverted-winner",
    })
    await forceAlarm(stub)
    state.observations = new Map([
      [original.transactionHash!, { kind: "absent" }],
      [replacement.transactionHash, { kind: "mined", status: "reverted", blockNumber: 52n, blockHash: BLOCK_B, final: true }],
    ])
    await injectChain(stub, state)
    await stub.reconcile(admitted.planRef)
    await forceAlarm(stub)
    expect((await stub.lookup(admitted.planRef))!.steps[0]).toMatchObject({
      state: "reverted",
      transactionHash: replacement.transactionHash,
      receipt: { status: "reverted", blockNumber: 52n, blockHash: BLOCK_B },
    })
    expect((await storedCandidates(stub)).map((candidate) => candidate.state)).toEqual(["superseded", "reverted"])
  })

  it("serializes concurrent operator bumps to one active child", async () => {
    const stub = freshStub()
    const state = harness()
    await injectChain(stub, state)
    const admitted = await stub.admit(plan())
    await runDurableObjectAlarm(stub)
    const original = (await stub.lookup(admitted.planRef))!.steps[0]!
    const base = {
      planRef: admitted.planRef,
      stepRef: original.stepRef,
      expectedVersion: original.version,
      expectedActiveCandidateHash: original.transactionHash!,
    }
    const outcomes = await Promise.allSettled([
      stub.requestFeeReplacement({
      ...FEE_REPLACEMENT_OPERATOR,
        ...base,
        maxFeePerGas: 110n,
        maxPriorityFeePerGas: 3n,
        authorizationRef: "operator:fee-replace:race-a",
      }),
      stub.requestFeeReplacement({
      ...FEE_REPLACEMENT_OPERATOR,
        ...base,
        maxFeePerGas: 120n,
        maxPriorityFeePerGas: 4n,
        authorizationRef: "operator:fee-replace:race-b",
      }),
    ])
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1)
    const candidates = await storedCandidates(stub)
    expect(candidates).toHaveLength(2)
    expect(candidates.filter((candidate) => candidate.is_active === 1)).toHaveLength(1)
  })

  it("fails closed when all known hashes are absent but the nonce was consumed", async () => {
    const stub = freshStub()
    const state = harness()
    await injectChain(stub, state)
    const admitted = await stub.admit(plan())
    await runDurableObjectAlarm(stub)
    const original = (await stub.lookup(admitted.planRef))!.steps[0]!
    const replacement = await stub.requestFeeReplacement({
      ...FEE_REPLACEMENT_OPERATOR,
      planRef: admitted.planRef,
      stepRef: original.stepRef,
      expectedVersion: original.version,
      expectedActiveCandidateHash: original.transactionHash!,
      maxFeePerGas: 110n,
      maxPriorityFeePerGas: 3n,
      authorizationRef: "operator:fee-replace:unknown-consumer",
    })
    await forceAlarm(stub)
    state.observations = new Map([
      [original.transactionHash!, { kind: "absent" }],
      [replacement.transactionHash, { kind: "absent" }],
    ])
    state.latestNonce = 8
    await injectChain(stub, state)
    await stub.reconcile(admitted.planRef)
    await forceAlarm(stub)
    expect((await stub.lookup(admitted.planRef))!.steps[0]).toMatchObject({
      state: "reconciliation_required",
      lastErrorCode: "nonce_consumed_by_unknown_candidate",
    })
    expect((await storedCandidates(stub)).map((candidate) => candidate.state)).toEqual([
      "reconciliation_required",
      "reconciliation_required",
    ])
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

  it("recovers a transient generation-zero candidate mirror write failure", async () => {
    const stub = freshStub()
    const state = harness({ faultOnce: "after_prepared_persisted" })
    await injectChain(stub, state)
    const admitted = await stub.admit(plan())
    await runDurableObjectAlarm(stub)
    const [prepared] = await storedSteps(stub)
    expect(prepared).toMatchObject({ state: "prepared", nonce: 7 })
    expect(await storedCandidates(stub)).toEqual([])

    await runInDurableObject(stub, (_instance, durableState) => {
      durableState.storage.sql.exec(`CREATE TRIGGER fail_original_candidate_once
        BEFORE INSERT ON story_settlement_transaction_candidates
        BEGIN SELECT RAISE(FAIL, 'injected candidate mirror write failure'); END`)
    })
    await stub.reconcile(admitted.planRef)
    await forceAlarm(stub)
    expect((await stub.lookup(admitted.planRef))!.steps[0]).toMatchObject({ state: "prepared" })
    expect(state.broadcasts).toEqual([])

    await runInDurableObject(stub, (_instance, durableState) => {
      durableState.storage.sql.exec("DROP TRIGGER fail_original_candidate_once")
    })
    await stub.reconcile(admitted.planRef)
    await forceAlarm(stub)
    expect((await stub.lookup(admitted.planRef))!.steps[0]).toMatchObject({ state: "broadcast" })
    expect(state.signed).toHaveLength(1)
    expect(state.broadcasts).toEqual([prepared!.signed_transaction])
    expect(await storedCandidates(stub)).toHaveLength(1)
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
    expect(await stub.health()).toMatchObject({ failedPlans: 1, revertedSteps: 1, pendingPlans: 0 })
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
