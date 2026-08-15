import { describe, expect, test } from "bun:test"
import { Interface, id } from "ethers"

import {
  buildRewardTicketCommitment,
  buildRewardTicketCommitmentBatchPublication,
  buildRewardTicketCommitmentBatch,
  encodeRewardTicketCommitmentPublication,
} from "./reward-ticket-freeze-commit"
import {
  buildRewardTicketSafeClaimCall,
  classifyRewardTicketClaimSubmissionError,
  verifyRewardTicketClaimAccounting,
  verifyRewardTicketClaimReceipt,
} from "./reward-ticket-claim-worker"
import { planRewardTicketSweep } from "./reward-ticket-sweep-worker"
import { buildMegapotPurchaseCall, rewardTicketPurchaseReservationCents } from "./megapot-purchase-call"
import { MEGAPOT_DEPLOYMENTS } from "./megapot-config"
import { platformMegapotReferralScheme } from "./megapot-referrals"
import {
  runRewardTicketCreditWorker,
  runRewardTicketFreezeCommitBatchWorker,
  runRewardTicketFreezeCommitWorker,
  type RewardTicketWorkerStore,
} from "./reward-ticket-worker-orchestration"

const hash = (character: string) => character.repeat(64)

describe("reward ticket workers", () => {
  test("journals a commitment before publishing and records evidence afterward", async () => {
    const events: string[] = []
    const store = {
      persistFrozenCommitment: async () => { events.push("persist_frozen") },
      markCommitmentPublished: async () => { events.push("persist_published") },
      openIncident: async () => { events.push("incident") },
    } as unknown as RewardTicketWorkerStore
    await runRewardTicketFreezeCommitWorker({
      commitment: {
        chainId: 84532,
        jackpotAddress: "0x1111111111111111111111111111111111111111",
        drawingId: 7n,
        poolId: "pool",
        termsHash: hash("a"),
        beneficiaries: [{
          rewardIdentityId: "identity",
          userId: "user",
          qualificationEvidenceHash: hash("b"),
        }],
      },
      store,
      publisher: {
        prepare: async () => {
          events.push("durable_prepare")
          return { nonce: 4, signedTransaction: "0xsigned", transactionHash: `0x${hash("c")}` }
        },
        broadcastExact: async () => { events.push("broadcast") },
      },
      publicationOperationId: "publication-7",
      commitmentRegistryAddress: "0x2222222222222222222222222222222222222222",
      awaitReceipt: async () => {
        events.push("receipt")
        return { status: 1, blockNumber: 10, blockHash: `0x${hash("d")}` }
      },
    })
    expect(events).toEqual([
      "persist_frozen", "durable_prepare", "broadcast", "receipt", "persist_published",
    ])
  })

  test("publishes one aggregated root for multiple pool snapshots", async () => {
    const events: string[] = []
    const commitment = {
      chainId: 84532,
      jackpotAddress: "0x1111111111111111111111111111111111111111",
      drawingId: 7n,
      poolId: "pool-a",
      termsHash: hash("a"),
      beneficiaries: [{
        rewardIdentityId: "identity-a",
        userId: "user-a",
        qualificationEvidenceHash: hash("b"),
      }],
    } as const
    const store = {
      persistFrozenCommitmentBatch: async () => { events.push("persist_batch") },
      markCommitmentPublished: async () => { events.push("persist_published") },
      openIncident: async () => { events.push("incident") },
    } as unknown as RewardTicketWorkerStore
    await runRewardTicketFreezeCommitBatchWorker({
      commitments: [commitment, { ...commitment, poolId: "pool-b", termsHash: hash("c") }],
      store: store as never,
      publisher: {
        prepare: async ({ data }) => {
          expect(data.slice(0, 10)).toBe(id("publish(address,uint256,bytes32,uint32,bytes32)").slice(0, 10))
          events.push("durable_prepare")
          return { nonce: 4, signedTransaction: "0xsigned", transactionHash: `0x${hash("d")}` }
        },
        broadcastExact: async () => { events.push("broadcast") },
      },
      publicationOperationId: "publication-7",
      commitmentRegistryAddress: "0x2222222222222222222222222222222222222222",
      awaitReceipt: async () => {
        events.push("receipt")
        return { status: 1, blockNumber: 10, blockHash: `0x${hash("e")}` }
      },
    })
    expect(events).toEqual(["persist_batch", "durable_prepare", "broadcast", "receipt", "persist_published"])
  })

  test("credit worker reconciles uniqueness and retries only transient database failures", async () => {
    const store = (code: string) => ({
      commitAllocationAndCredits: async () => { throw { code } },
      openIncident: async () => undefined,
    }) as unknown as RewardTicketWorkerStore
    expect(await runRewardTicketCreditWorker(store("23505")))
      .toEqual({ disposition: "reconcile_as_applied" })
    expect(await runRewardTicketCreditWorker(store("40001")))
      .toEqual({ disposition: "retry_later" })
    expect(await runRewardTicketCreditWorker(store("23514")))
      .toEqual({ disposition: "fail_closed" })
  })

  test("builds a Safe claim-module call with a deterministic operation ID", () => {
    const call = buildRewardTicketSafeClaimCall({
      moduleAddress: "0x8888888888888888888888888888888888888888",
      operationId: "claim:pool:7",
      ticketIds: [101n, 102n],
    })
    expect(call.to).toBe("0x8888888888888888888888888888888888888888")
    expect(call.value).toBe(0n)
    expect(call.data.slice(0, 10)).toBe(id("claim(bytes32,uint256[])").slice(0, 10))
  })

  test("reserves the full ticket-count ceiling and builds the exact purchase call", () => {
    expect(rewardTicketPurchaseReservationCents({ ticketCount: 7, maxTicketCents: 125n })).toBe(875n)
    const config = {
      deployment: MEGAPOT_DEPLOYMENTS.testnet,
      rpcUrl: "https://rpc.invalid",
      purchaseSafetyMarginSeconds: 60,
      minimumConfirmations: 2,
      custodyAddress: "0x3333333333333333333333333333333333333333",
      purchaseOperatorAddress: "0x4444444444444444444444444444444444444444",
      platformRevenueAddress: "0x5555555555555555555555555555555555555555",
      purchaseEscrowAddress: "0x6666666666666666666666666666666666666666",
      commitmentRegistryAddress: "0x7777777777777777777777777777777777777777",
      claimModuleAddress: "0x8888888888888888888888888888888888888888",
      purchaseEscrowCodeHash: `0x${hash("9")}`,
      commitmentRegistryCodeHash: `0x${hash("8")}`,
      claimModuleCodeHash: `0x${hash("7")}`,
    } as const
    const call = buildMegapotPurchaseCall({
      config,
      operationId: `0x${hash("e")}`,
      ticketCount: 7,
      intendedDrawingId: 7n,
      expectedTicketPriceAtomic: 125n,
      referralScheme: platformMegapotReferralScheme(config.platformRevenueAddress),
      source: "pirate",
    })
    expect(call.to).toBe(config.purchaseEscrowAddress)
    expect(call.value).toBe(0n)
    expect(call.data.slice(0, 10)).toBe(id("purchase(bytes32,uint256,uint256,uint256,bytes32)").slice(0, 10))
  })

  test("freezes a deterministic dense beneficiary snapshot with reproducible proofs", () => {
    const input = {
      chainId: 84532,
      jackpotAddress: "0x1111111111111111111111111111111111111111",
      drawingId: 42n,
      poolId: "pool-1",
      termsHash: hash("a"),
      beneficiaries: [
        { rewardIdentityId: "identity-b", userId: "user-b", qualificationEvidenceHash: hash("b") },
        { rewardIdentityId: "identity-a", userId: "user-a", qualificationEvidenceHash: hash("c") },
        { rewardIdentityId: "identity-c", userId: "user-c", qualificationEvidenceHash: hash("d") },
      ],
    } as const
    const first = buildRewardTicketCommitment(input)
    const second = buildRewardTicketCommitment({ ...input, beneficiaries: [...input.beneficiaries].reverse() })
    expect(first).toEqual(second)
    expect(first.beneficiaries.map((row) => [row.rewardIdentityId, row.canonicalPosition])).toEqual([
      ["identity-a", 0], ["identity-b", 1], ["identity-c", 2],
    ])
    expect(first.proof).toHaveLength(0)
    const batch = buildRewardTicketCommitmentBatch([
      { poolDrawingId: "drawing-b", leafHash: hash("1") },
      { poolDrawingId: "drawing-a", leafHash: first.leafHash },
    ])
    expect(batch.poolLeaves.map((leaf) => leaf.poolDrawingId)).toEqual(["drawing-a", "drawing-b"])
    expect(batch.proofs).toHaveLength(2)
    expect(encodeRewardTicketCommitmentPublication({
      jackpotAddress: input.jackpotAddress,
      drawingId: input.drawingId,
      rootHash: first.rootHash,
      leafCount: 1,
      termsHash: input.termsHash,
    }).startsWith("0x")).toBe(true)

    const publication = buildRewardTicketCommitmentBatchPublication([
      input,
      { ...input, poolId: "pool-2", termsHash: hash("e") },
    ])
    expect(publication.leafCount).toBe(2)
    expect(publication.commitments.every((commitment) => commitment.rootHash === publication.rootHash)).toBe(true)
    expect(publication.commitments.map((commitment) => commitment.proof.length).sort()).toEqual([1, 1])
  })

  test("sweep applies Megapot's nonpaying tier exclusions and requires complete inventory", async () => {
    const result = await planRewardTicketSweep({
      nowSeconds: 101n,
      drawingResolvesAtSeconds: 100n,
      expectedTicketCount: 3,
      confirmedEventTicketCount: 3,
      tickets: [0n, 1n, 2n].map((ticketId) => ({
        inventoryId: `inventory-${ticketId}`,
        ticketId,
        status: "held" as const,
      })),
      readTierIds: async () => [0, 2, 3],
    })
    expect(result.inventoryComplete).toBe(true)
    expect(result.sweepComplete).toBe(true)
    expect(result.updates.map((row) => row.status)).toEqual(["no_win", "no_win", "winning"])
    await expect(planRewardTicketSweep({
      nowSeconds: 101n,
      drawingResolvesAtSeconds: 100n,
      expectedTicketCount: 4,
      confirmedEventTicketCount: 4,
      tickets: [],
      readTierIds: async () => [],
    })).rejects.toThrow("reward_ticket_inventory_incomplete")
  })

  test("claim verification derives proceeds only from USDC transfers into custody", () => {
    const usdc = "0x2222222222222222222222222222222222222222"
    const custody = "0x3333333333333333333333333333333333333333"
    const transfer = new Interface(["event Transfer(address indexed from,address indexed to,uint256 value)"])
      .encodeEventLog("Transfer", ["0x4444444444444444444444444444444444444444", custody, 77n])
    expect(verifyRewardTicketClaimReceipt({
      receipt: {
        status: 1,
        blockNumber: 12,
        blockHash: `0x${hash("e")}`,
        logs: [{ address: usdc, topics: transfer.topics, data: transfer.data }],
      },
      usdcAddress: usdc,
      custodyAddress: custody,
      protocolReportedWinningsAtomic: 77n,
    })).toEqual({ disposition: "confirmed", receivedAmountAtomic: 77n })
    expect(classifyRewardTicketClaimSubmissionError({ data: id("NoTicketsToClaim()").slice(0, 10) }))
      .toEqual({ disposition: "no_claimable_value" })
    expect(classifyRewardTicketClaimSubmissionError({ errorName: "NotTicketOwner" }))
      .toEqual({ disposition: "needs_review" })
    expect(verifyRewardTicketClaimAccounting({
      grossTierPayoutAtomic: 11_112n,
      claimEventWinningsAtomic: 10_001n,
      custodyTransferAtomic: 10_001n,
      referralAccrualDeltaAtomic: 1_111n,
    })).toEqual({
      beneficiaryProceedsAtomic: 10_001n,
      platformReferralRevenueAtomic: 1_111n,
    })
  })
})
