import { Transaction, getAddress, keccak256 } from "ethers"

import type { RewardTicketTransactionCoordinator } from "./reward-ticket-worker-orchestration"
import { RewardTicketCycleJournal } from "./reward-ticket-cycle-journal"

type FeeData = Readonly<{
  maxFeePerGas: bigint | null
  maxPriorityFeePerGas: bigint | null
  gasPrice: bigint | null
}>

export type RewardTicketCoordinatorProvider = Readonly<{
  getTransactionCount(address: string, blockTag: "pending"): Promise<number>
  getFeeData(): Promise<FeeData>
  estimateGas(request: Readonly<Record<string, unknown>>): Promise<bigint>
  broadcastTransaction(signedTransaction: string): Promise<unknown>
  getTransaction(transactionHash: string): Promise<unknown | null>
}>

export type RewardTicketCoordinatorSigner = Readonly<{
  getAddress(): Promise<string>
  signTransaction(request: Readonly<Record<string, unknown>>): Promise<string>
}>

export class DurableRewardTicketTransactionCoordinator implements RewardTicketTransactionCoordinator {
  constructor(
    private readonly journal: RewardTicketCycleJournal,
    private readonly provider: RewardTicketCoordinatorProvider,
    private readonly signer: RewardTicketCoordinatorSigner,
    private readonly operationKind: "commitment_publication" | "ticket_purchase" | "winnings_claim",
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async prepare(input: Readonly<{
    operationId: string
    to: string
    data: string
    value: bigint
  }>): Promise<Readonly<{ nonce: number; signedTransaction: string; transactionHash: string }>> {
    const existing = await this.journal.findSubmission(input.operationId)
    if (existing) return existing

    const signerAddress = getAddress(await this.signer.getAddress())
    const targetAddress = getAddress(input.to)
    const [pendingNonce, journalNonce, fee, gasEstimate] = await Promise.all([
      this.provider.getTransactionCount(signerAddress, "pending"),
      this.journal.nextNonceFloor(signerAddress),
      this.provider.getFeeData(),
      this.provider.estimateGas({
        from: signerAddress,
        to: targetAddress,
        data: input.data,
        value: input.value,
      }),
    ])
    const nonce = Math.max(pendingNonce, journalNonce)
    const signedTransaction = await this.signer.signTransaction({
      chainId: 84532,
      type: 2,
      nonce,
      to: targetAddress,
      data: input.data,
      value: input.value,
      gasLimit: (gasEstimate * 125n) / 100n,
      maxFeePerGas: fee.maxFeePerGas ?? fee.gasPrice ?? 1n,
      maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? 1n,
    })
    const transactionHash = Transaction.from(signedTransaction).hash
    if (!transactionHash) throw new Error("signed reward ticket transaction has no hash")
    return this.journal.persistPrepared({
      operationId: input.operationId,
      operationKind: this.operationKind,
      signerAddress,
      targetAddress,
      callDataHash: keccak256(input.data),
      valueWei: input.value,
      nonce,
      signedTransaction,
      transactionHash,
    })
  }

  async broadcastExact(signedTransaction: string): Promise<void> {
    const transactionHash = Transaction.from(signedTransaction).hash
    if (!transactionHash) throw new Error("signed reward ticket transaction has no hash")
    const prepared = await this.journal.requirePreparedByHash(transactionHash)
    if (prepared.signedTransaction !== signedTransaction) {
      throw new Error("reward ticket signed transaction does not match durable journal")
    }
    try {
      await this.provider.broadcastTransaction(signedTransaction)
    } catch (error) {
      if (!await this.provider.getTransaction(transactionHash)) throw error
    }
    await this.journal.markBroadcast(transactionHash, this.now())
  }
}
