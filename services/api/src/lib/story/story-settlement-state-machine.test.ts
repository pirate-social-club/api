import { describe, expect, test } from "bun:test"
import { zeroAddress, type Hex } from "viem"
import { deriveStorySettlementCallIdentity, type StorySettlementCallIdentityInput } from "./story-settlement-call-identity"
import {
  canTransitionStorySettlementStep,
  isTerminalStorySettlementStepState,
  transitionStorySettlementStep,
  type StorySettlementStepSnapshot,
  type StorySettlementStepState,
} from "./story-settlement-step-state-machine"

const HASH = `0x${"11".repeat(32)}` as Hex
const BLOCK_HASH = `0x${"22".repeat(32)}` as Hex
const ADDRESS_A = "0x1111111111111111111111111111111111111111"
const ADDRESS_B = "0x2222222222222222222222222222222222222222"

const identityInput: StorySettlementCallIdentityInput = {
  chainId: 1315,
  signerAddress: ADDRESS_A,
  communityId: "community_1",
  quoteId: "quote_1",
  purchaseId: "purchase_1",
  effectKind: "story_royalty_payment",
  effectKey: "asset_1",
  stepKind: "story_royalty_payment",
  ordinal: 2,
  target: ADDRESS_B,
  nativeValue: 0n,
  calldata: "0x12345678",
  settlementToken: ADDRESS_A,
  amount: 100n,
  receiverIpId: ADDRESS_A,
  payerIpId: zeroAddress,
}

const planned: StorySettlementStepSnapshot = {
  state: "planned",
  version: 1,
  nonce: null,
  signedTransactionStored: false,
  transactionHash: null,
  receipt: null,
}

describe("Story settlement call identity", () => {
  test("is deterministic across address casing and changes for a non-zero payer", () => {
    const canonical = deriveStorySettlementCallIdentity(identityInput)
    expect(deriveStorySettlementCallIdentity({
      ...identityInput,
      signerAddress: "0x1111111111111111111111111111111111111111",
      target: "0x2222222222222222222222222222222222222222",
    })).toBe(canonical)
    expect(deriveStorySettlementCallIdentity({ ...identityInput, payerIpId: ADDRESS_B })).not.toBe(canonical)
    const wrapIdentity = {
      ...identityInput,
      stepKind: "wip_wrap" as const,
      ordinal: 0,
      target: ADDRESS_A,
      nativeValue: 100n,
      calldata: "0xd0e30db0" as Hex,
    }
    expect(deriveStorySettlementCallIdentity({ ...wrapIdentity, payerIpId: ADDRESS_B }))
      .not.toBe(deriveStorySettlementCallIdentity(wrapIdentity))
    expect(deriveStorySettlementCallIdentity({
      ...identityInput,
      signerAddress: "0xd2f60c40febccf6311f8b47c4f2ec6b040400086",
    })).toBe(deriveStorySettlementCallIdentity({
      ...identityInput,
      signerAddress: "0xD2f60c40fEbccf6311f8B47c4f2Ec6b040400086",
    }))
  })

  test("binds business identity and exact call fields", () => {
    const canonical = deriveStorySettlementCallIdentity(identityInput)
    for (const changed of [
      { quoteId: "quote_2" },
      { purchaseId: "purchase_2" },
      { effectKey: "asset_2" },
      { ordinal: 3 },
      { nativeValue: 1n },
      { calldata: "0x12345679" as Hex },
      { amount: 101n },
      { receiverIpId: ADDRESS_B },
    ]) {
      expect(deriveStorySettlementCallIdentity({ ...identityInput, ...changed })).not.toBe(canonical)
    }
  })

  test("requires explicit zero/non-zero payer identity for royalty calls", () => {
    expect(() => deriveStorySettlementCallIdentity({ ...identityInput, payerIpId: null }))
      .toThrow("payer_ip_id_missing")
    expect(() => deriveStorySettlementCallIdentity({
      ...identityInput,
      effectKind: "story_entitlement_mint",
    })).toThrow("step_kind_does_not_match_effect_kind")
    expect(() => deriveStorySettlementCallIdentity({ ...identityInput, settlementToken: null }))
      .toThrow("settlement_token_missing")
  })
})

describe("Story settlement step state machine", () => {
  const states: StorySettlementStepState[] = [
    "planned", "reserving", "failed_prebroadcast", "prepared", "broadcast", "mined",
    "confirmed", "reverted", "replaced", "reconciliation_required",
  ]
  const expected: Record<StorySettlementStepState, StorySettlementStepState[]> = {
    planned: ["reserving"],
    reserving: ["prepared", "failed_prebroadcast"],
    failed_prebroadcast: ["reserving"],
    prepared: ["broadcast", "reconciliation_required"],
    broadcast: ["broadcast", "mined", "reverted", "replaced", "reconciliation_required"],
    mined: ["mined", "confirmed", "broadcast", "reconciliation_required"],
    confirmed: [],
    reverted: [],
    replaced: [],
    reconciliation_required: ["broadcast", "mined", "confirmed", "reverted", "replaced"],
  }

  test("matches the reviewed transition matrix exactly", () => {
    for (const from of states) {
      expect(states.filter((to) => canTransitionStorySettlementStep(from, to)).sort())
        .toEqual([...expected[from]].sort())
    }
    expect(states.filter(isTerminalStorySettlementStepState)).toEqual(["confirmed", "reverted", "replaced"])
  })

  test("fences versions and requires durable signed evidence before broadcast states", () => {
    expect(() => transitionStorySettlementStep(planned, { expectedVersion: 2, to: "reserving", nonce: 7 }))
      .toThrow("story_settlement_step_version_conflict")
    const reserving = transitionStorySettlementStep(planned, { expectedVersion: 1, to: "reserving", nonce: 7 })
    expect(reserving).toMatchObject({ state: "reserving", version: 2, nonce: 7 })
    expect(() => transitionStorySettlementStep(reserving, { expectedVersion: 2, to: "prepared" }))
      .toThrow("prepared_step_requires_durable_signed_transaction")
    const prepared = transitionStorySettlementStep(reserving, {
      expectedVersion: 2,
      to: "prepared",
      signedTransactionStored: true,
      transactionHash: HASH,
    })
    expect(transitionStorySettlementStep(prepared, { expectedVersion: 3, to: "broadcast" }))
      .toMatchObject({ state: "broadcast", version: 4, nonce: 7, transactionHash: HASH })
  })

  test("reuses a reserved nonce after proven prebroadcast failure", () => {
    const reserving = transitionStorySettlementStep(planned, { expectedVersion: 1, to: "reserving", nonce: 7 })
    const failed = transitionStorySettlementStep(reserving, { expectedVersion: 2, to: "failed_prebroadcast" })
    expect(() => transitionStorySettlementStep(failed, { expectedVersion: 3, to: "reserving", nonce: 8 }))
      .toThrow("story_settlement_step_nonce_is_immutable")
    expect(transitionStorySettlementStep(failed, { expectedVersion: 3, to: "reserving" }))
      .toMatchObject({ state: "reserving", nonce: 7 })
  })

  test("requires receipt outcomes and clears pre-finality receipt on reorg to broadcast", () => {
    const mined: StorySettlementStepSnapshot = {
      state: "mined",
      version: 8,
      nonce: 7,
      signedTransactionStored: true,
      transactionHash: HASH,
      receipt: { status: "success", blockNumber: 100n, blockHash: BLOCK_HASH },
    }
    expect(transitionStorySettlementStep(mined, { expectedVersion: 8, to: "confirmed" }).state).toBe("confirmed")
    expect(transitionStorySettlementStep(mined, { expectedVersion: 8, to: "broadcast" }).receipt).toBeNull()
    expect(() => transitionStorySettlementStep({ ...mined, state: "broadcast", receipt: null }, {
      expectedVersion: 8,
      to: "reverted",
      receipt: { status: "success", blockNumber: 101n, blockHash: BLOCK_HASH },
    })).toThrow("reverted_step_requires_reverted_receipt")
  })

  test("never permits terminal transitions", () => {
    for (const state of ["confirmed", "reverted", "replaced"] as const) {
      expect(() => transitionStorySettlementStep({
        state,
        version: 10,
        nonce: 7,
        signedTransactionStored: true,
        transactionHash: HASH,
        receipt: state === "replaced" ? null : { status: state === "reverted" ? "reverted" : "success", blockNumber: 1n, blockHash: BLOCK_HASH },
      }, { expectedVersion: 10, to: "reconciliation_required" }))
        .toThrow(`illegal_story_settlement_step_transition:${state}:reconciliation_required`)
    }
  })
})
