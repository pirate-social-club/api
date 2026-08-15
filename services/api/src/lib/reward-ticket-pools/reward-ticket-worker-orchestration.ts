import { getAddress } from "ethers"

import type { MegapotRuntimeConfig } from "./megapot-config"
import { revalidateMegapotPurchase, type MegapotPurchasePreflight } from "./megapot-purchase-preflight"
import { buildMegapotPurchaseCall } from "./megapot-purchase-call"
import { platformMegapotReferralScheme } from "./megapot-referrals"
import {
  verifyMegapotPurchaseReceipt,
  type MegapotPurchaseReceipt,
  type MegapotPurchaseReceiptDecision,
} from "./megapot-purchase-receipt"
import { classifyRewardTicketLedgerWriteError } from "./reward-ticket-cashout-policy"
import {
  buildRewardTicketCommitment,
  buildRewardTicketCommitmentBatchPublication,
  encodeRewardTicketCommitmentPublication,
  type RewardTicketCommitmentInput,
  type RewardTicketCommitmentBatchPublication,
} from "./reward-ticket-freeze-commit"
import {
  classifyRewardTicketClaimSubmissionError,
  verifyRewardTicketClaimReceipt,
  type RewardTicketClaimReceipt,
} from "./reward-ticket-claim-worker"
import { planRewardTicketSweep, type RewardTicketSweepTicket } from "./reward-ticket-sweep-worker"
import type { MegapotChainReader } from "./megapot-chain-reader"

export type DurableEvmSubmission = Readonly<{
  nonce: number
  signedTransaction: string
  transactionHash: string
}>

/**
 * Every store method owns and closes its control-plane connection. Chain and
 * coordinator calls occur only between methods, so no connection crosses RPC.
 */
export interface RewardTicketWorkerStore {
  persistFrozenCommitment(input: ReturnType<typeof buildRewardTicketCommitment>): Promise<void>
  markCommitmentPublished(input: { transactionHash: string; blockNumber: number; blockHash: string }): Promise<void>
  reservePurchase(input: { totalCostAtomic: bigint; observedBlockNumber: number }): Promise<{ effectId: string }>
  markPurchasePrepared(input: DurableEvmSubmission): Promise<void>
  applyPurchaseDecision(decision: MegapotPurchaseReceiptDecision): Promise<void>
  applySweep(input: Awaited<ReturnType<typeof planRewardTicketSweep>>): Promise<void>
  markClaimPrepared(input: DurableEvmSubmission): Promise<void>
  applyClaimDecision(input: ReturnType<typeof verifyRewardTicketClaimReceipt>): Promise<void>
  markNoClaimableValue(): Promise<void>
  openIncident(reason: string): Promise<void>
  commitAllocationAndCredits(): Promise<void>
}

export interface RewardTicketCommitmentBatchStore extends RewardTicketWorkerStore {
  persistFrozenCommitmentBatch(input: RewardTicketCommitmentBatchPublication): Promise<void>
}

export interface RewardTicketTransactionCoordinator {
  prepare(input: Readonly<{ operationId: string; to: string; data: string; value: bigint }>): Promise<DurableEvmSubmission>
  broadcastExact(signedTransaction: string): Promise<void>
}

export async function runRewardTicketFreezeCommitWorker(input: Readonly<{
  commitment: RewardTicketCommitmentInput
  store: RewardTicketWorkerStore
  publisher: RewardTicketTransactionCoordinator
  publicationOperationId: string
  commitmentRegistryAddress: string
  awaitReceipt: (transactionHash: string) => Promise<Readonly<{
    status: number | null; blockNumber: number; blockHash: string
  }>>
}>): Promise<void> {
  const commitment = buildRewardTicketCommitment(input.commitment)
  await input.store.persistFrozenCommitment(commitment)
  const prepared = await input.publisher.prepare({
    operationId: input.publicationOperationId,
    to: input.commitmentRegistryAddress,
    data: encodeRewardTicketCommitmentPublication({
      jackpotAddress: input.commitment.jackpotAddress,
      drawingId: input.commitment.drawingId,
      rootHash: commitment.rootHash,
      leafCount: 1,
      termsHash: input.commitment.termsHash,
    }),
    value: 0n,
  })
  await input.publisher.broadcastExact(prepared.signedTransaction)
  const receipt = await input.awaitReceipt(prepared.transactionHash)
  if (receipt.status !== 1) {
    await input.store.openIncident("reward_ticket_commitment_publication_failed")
    return
  }
  await input.store.markCommitmentPublished({
    transactionHash: prepared.transactionHash,
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash,
  })
}

export async function runRewardTicketFreezeCommitBatchWorker(input: Readonly<{
  commitments: readonly RewardTicketCommitmentInput[]
  store: RewardTicketCommitmentBatchStore
  publisher: RewardTicketTransactionCoordinator
  publicationOperationId: string
  commitmentRegistryAddress: string
  awaitReceipt: (transactionHash: string) => Promise<Readonly<{
    status: number | null; blockNumber: number; blockHash: string
  }>>
}>): Promise<void> {
  const publication = buildRewardTicketCommitmentBatchPublication(input.commitments)
  await input.store.persistFrozenCommitmentBatch(publication)
  const first = input.commitments[0]
  if (!first) throw new Error("reward_ticket_commitment_batch_empty")
  const prepared = await input.publisher.prepare({
    operationId: input.publicationOperationId,
    to: input.commitmentRegistryAddress,
    data: encodeRewardTicketCommitmentPublication({
      jackpotAddress: first.jackpotAddress,
      drawingId: first.drawingId,
      rootHash: publication.rootHash,
      leafCount: publication.leafCount,
      termsHash: publication.termsVersionHash,
    }),
    value: 0n,
  })
  await input.publisher.broadcastExact(prepared.signedTransaction)
  const receipt = await input.awaitReceipt(prepared.transactionHash)
  if (receipt.status !== 1) {
    await input.store.openIncident("reward_ticket_commitment_publication_failed")
    return
  }
  await input.store.markCommitmentPublished({
    transactionHash: prepared.transactionHash,
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash,
  })
}

export async function runRewardTicketPurchaseWorker(input: Readonly<{
  config: MegapotRuntimeConfig
  reader: MegapotChainReader
  store: RewardTicketWorkerStore
  coordinator: RewardTicketTransactionCoordinator
  operationId: string
  intendedDrawingId: bigint
  ticketCount: number
  maxTicketPriceAtomic: bigint
  source: string
  awaitReceipt: (transactionHash: string) => Promise<MegapotPurchaseReceipt>
}>): Promise<MegapotPurchasePreflight | MegapotPurchaseReceiptDecision> {
  const preflight = await revalidateMegapotPurchase({
    config: input.config,
    reader: input.reader,
    intendedDrawingId: input.intendedDrawingId,
    ticketCount: input.ticketCount,
    maxTicketPriceAtomic: input.maxTicketPriceAtomic,
    referrerCount: 1,
  })
  if (preflight.disposition !== "ready") return preflight
  await input.store.reservePurchase({
    totalCostAtomic: preflight.totalCostAtomic,
    observedBlockNumber: preflight.observedBlockNumber,
  })
  const call = buildMegapotPurchaseCall({
    config: input.config,
    operationId: input.operationId,
    ticketCount: input.ticketCount,
    intendedDrawingId: input.intendedDrawingId,
    expectedTicketPriceAtomic: preflight.ticketPriceAtomic,
    referralScheme: platformMegapotReferralScheme(input.config.platformRevenueAddress),
    source: input.source,
  })
  const prepared = await input.coordinator.prepare({ operationId: input.operationId, ...call })
  await input.store.markPurchasePrepared(prepared)
  await input.coordinator.broadcastExact(prepared.signedTransaction)
  const receipt = await input.awaitReceipt(prepared.transactionHash)
  const decision = await verifyMegapotPurchaseReceipt({
    reader: input.reader,
    receipt,
    expected: {
      transactionHash: prepared.transactionHash,
      purchaseOperatorAddress: input.config.purchaseOperatorAddress,
      purchaseTargetAddress: input.config.purchaseEscrowAddress,
      randomTicketBuyerAddress: input.config.deployment.randomTicketBuyer.address,
      custodyAddress: input.config.custodyAddress,
      drawingId: input.intendedDrawingId,
      ticketCount: input.ticketCount,
      totalCostAtomic: preflight.totalCostAtomic,
      minimumConfirmations: input.config.minimumConfirmations,
    },
  })
  await input.store.applyPurchaseDecision(decision)
  if (decision.disposition === "needs_review") await input.store.openIncident(decision.reason)
  return decision
}

export async function runRewardTicketSweepWorker(input: Readonly<{
  store: RewardTicketWorkerStore
  nowSeconds: bigint
  drawingResolvesAtSeconds: bigint
  expectedTicketCount: number
  confirmedEventTicketCount: number
  tickets: readonly RewardTicketSweepTicket[]
  readTierIds: (ticketIds: readonly bigint[]) => Promise<readonly number[]>
}>): Promise<void> {
  const plan = await planRewardTicketSweep(input)
  try {
    await input.store.applySweep(plan)
  } catch (error) {
    const classified = classifyRewardTicketLedgerWriteError(error)
    if (classified.disposition === "retry_later") throw error
    await input.store.openIncident("reward_ticket_late_inventory_or_sweep_rejected")
  }
}

export async function runRewardTicketClaimWorker(input: Readonly<{
  store: RewardTicketWorkerStore
  coordinator: RewardTicketTransactionCoordinator
  operationId: string
  claimCall: Readonly<{ to: string; data: string; value: bigint }>
  claimModuleAddress: string
  usdcAddress: string
  custodyAddress: string
  protocolReportedWinningsAtomic: bigint
  awaitReceipt: (transactionHash: string) => Promise<RewardTicketClaimReceipt>
}>): Promise<void> {
  try {
    if (getAddress(input.claimCall.to) !== getAddress(input.claimModuleAddress) || input.claimCall.value !== 0n) {
      await input.store.openIncident("reward_ticket_claim_target_policy_mismatch")
      return
    }
  } catch {
    await input.store.openIncident("reward_ticket_claim_target_policy_mismatch")
    return
  }
  try {
    const prepared = await input.coordinator.prepare({ operationId: input.operationId, ...input.claimCall })
    await input.store.markClaimPrepared(prepared)
    await input.coordinator.broadcastExact(prepared.signedTransaction)
    const receipt = await input.awaitReceipt(prepared.transactionHash)
    const decision = verifyRewardTicketClaimReceipt({
      receipt,
      usdcAddress: input.usdcAddress,
      custodyAddress: input.custodyAddress,
      protocolReportedWinningsAtomic: input.protocolReportedWinningsAtomic,
    })
    await input.store.applyClaimDecision(decision)
    if (decision.disposition === "needs_review") await input.store.openIncident(decision.reason)
  } catch (error) {
    const decision = classifyRewardTicketClaimSubmissionError(error)
    if (decision.disposition === "no_claimable_value") await input.store.markNoClaimableValue()
    else if (decision.disposition === "needs_review") await input.store.openIncident("not_ticket_owner")
    else throw error
  }
}

export async function runRewardTicketCreditWorker(store: RewardTicketWorkerStore): Promise<Readonly<{
  disposition: "credited" | "reconcile_as_applied" | "retry_later" | "fail_closed"
}>> {
  try {
    await store.commitAllocationAndCredits()
    return { disposition: "credited" }
  } catch (error) {
    const classified = classifyRewardTicketLedgerWriteError(error)
    if (classified.disposition === "fail_closed") {
      await store.openIncident(`reward_ticket_credit_sqlstate_${classified.sqlState ?? "unknown"}`)
    }
    return { disposition: classified.disposition }
  }
}
