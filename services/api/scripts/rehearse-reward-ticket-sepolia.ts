import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

import { Contract, Interface, JsonRpcProvider, Transaction, Wallet, encodeBytes32String } from "ethers"

import { MEGAPOT_RANDOM_BUYER_ABI } from "../src/lib/reward-ticket-pools/megapot-abi"
import { createMegapotChainReader } from "../src/lib/reward-ticket-pools/megapot-chain-reader"
import { MEGAPOT_DEPLOYMENTS, type MegapotRuntimeConfig } from "../src/lib/reward-ticket-pools/megapot-config"
import { verifyMegapotEnvironmentAtStartup } from "../src/lib/reward-ticket-pools/megapot-environment"
import { buildMegapotPurchaseCall } from "../src/lib/reward-ticket-pools/megapot-purchase-call"
import { revalidateMegapotPurchase } from "../src/lib/reward-ticket-pools/megapot-purchase-preflight"
import { platformMegapotReferralScheme } from "../src/lib/reward-ticket-pools/megapot-referrals"
import { buildRewardTicketCommitment, encodeRewardTicketCommitmentPublication } from "../src/lib/reward-ticket-pools/reward-ticket-freeze-commit"

type JournalEntry = {
  kind: "commitment" | "purchase"
  drawingId: string
  nonce: number
  signedTransaction: string
  transactionHash: string
  state: "prepared" | "broadcast" | "confirmed" | "reverted"
  blockNumber?: number
  blockHash?: string
  ticketIds?: string[]
}
type Journal = { entries: JournalEntry[] }

function required(name: string): string {
  const value = String(process.env[name] ?? "").trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

async function loadJournal(path: string): Promise<Journal> {
  try { return JSON.parse(await readFile(path, "utf8")) as Journal } catch { return { entries: [] } }
}

async function saveJournal(path: string, journal: Journal): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.tmp`
  await writeFile(temporary, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, path)
}

async function prepareAndBroadcast(input: {
  journalPath: string
  journal: Journal
  wallet: Wallet
  provider: JsonRpcProvider
  kind: JournalEntry["kind"]
  drawingId: bigint
  to: string
  data: string
}): Promise<JournalEntry> {
  let entry = input.journal.entries.find((candidate) =>
    candidate.kind === input.kind && candidate.drawingId === input.drawingId.toString()
      && candidate.state !== "reverted"
  )
  if (!entry) {
    const nonce = await input.provider.getTransactionCount(input.wallet.address, "pending")
    const fee = await input.provider.getFeeData()
    const request = {
      chainId: 84532,
      type: 2,
      nonce,
      to: input.to,
      data: input.data,
      value: 0n,
      gasLimit: (await input.provider.estimateGas({
        from: input.wallet.address,
        to: input.to,
        data: input.data,
      }) * 125n) / 100n,
      maxFeePerGas: fee.maxFeePerGas ?? fee.gasPrice ?? 1n,
      maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? 1n,
    }
    const signedTransaction = await input.wallet.signTransaction(request)
    const transactionHash = Transaction.from(signedTransaction).hash
    if (!transactionHash) throw new Error("signed transaction has no hash")
    entry = {
      kind: input.kind,
      drawingId: input.drawingId.toString(),
      nonce,
      signedTransaction,
      transactionHash,
      state: "prepared",
    }
    input.journal.entries.push(entry)
    await saveJournal(input.journalPath, input.journal)
    if (
      input.kind === "purchase"
      && String(process.env.REWARD_TICKET_REHEARSAL_STOP_AFTER_PURCHASE_PREPARE ?? "") === "true"
    ) {
      console.log(JSON.stringify({
        status: "stopped_after_durable_prepare",
        drawingId: entry.drawingId,
        nonce: entry.nonce,
        transactionHash: entry.transactionHash,
      }))
      process.exit(75)
    }
  }
  if (entry.state === "confirmed") return entry
  const pending = await input.provider.getTransaction(entry.transactionHash)
  if (!pending) await input.provider.broadcastTransaction(entry.signedTransaction)
  entry.state = "broadcast"
  await saveJournal(input.journalPath, input.journal)
  const receipt = await input.provider.waitForTransaction(entry.transactionHash, 3, 120_000)
  if (!receipt) throw new Error(`${input.kind} transaction receipt unavailable`)
  if (receipt.status !== 1) {
    entry.state = "reverted"
    entry.blockNumber = receipt.blockNumber
    entry.blockHash = receipt.blockHash
    await saveJournal(input.journalPath, input.journal)
    throw new Error(`${input.kind} transaction failed conclusively`)
  }
  entry.state = "confirmed"
  entry.blockNumber = receipt.blockNumber
  entry.blockHash = receipt.blockHash
  if (input.kind === "purchase") {
    const parser = new Interface(MEGAPOT_RANDOM_BUYER_ABI)
    const events = receipt.logs.flatMap((log) => {
      try {
        const parsed = parser.parseLog(log)
        return parsed?.name === "RandomTicketsBought" ? [parsed] : []
      } catch { return [] }
    })
    if (events.length !== 1) throw new Error("purchase receipt event missing or ambiguous")
    entry.ticketIds = Array.from(events[0]?.args.ticketIds as readonly bigint[], String)
  }
  await saveJournal(input.journalPath, input.journal)
  return entry
}

const journalPath = resolve(process.argv[2] ?? "/tmp/reward-ticket-sepolia-rehearsal/journal.json")
const rpcUrl = required("BASE_SEPOLIA_RPC_URL")
const provider = new JsonRpcProvider(rpcUrl)
const wallet = new Wallet(required("PRIVATE_KEY"), provider)
const config: MegapotRuntimeConfig = {
  deployment: MEGAPOT_DEPLOYMENTS.testnet,
  rpcUrl,
  purchaseSafetyMarginSeconds: 120,
  minimumConfirmations: 3,
  custodyAddress: required("REWARD_TICKET_CUSTODY_ADDRESS"),
  purchaseOperatorAddress: required("REWARD_TICKET_PURCHASE_OPERATOR_ADDRESS"),
  platformRevenueAddress: required("REWARD_TICKET_PLATFORM_REVENUE_ADDRESS"),
  purchaseEscrowAddress: required("REWARD_TICKET_PURCHASE_ESCROW_ADDRESS"),
  commitmentRegistryAddress: required("REWARD_TICKET_COMMITMENT_REGISTRY_ADDRESS"),
  claimModuleAddress: required("REWARD_TICKET_CLAIM_MODULE_ADDRESS"),
  purchaseEscrowCodeHash: required("REWARD_TICKET_PURCHASE_ESCROW_CODE_HASH"),
  commitmentRegistryCodeHash: required("REWARD_TICKET_COMMITMENT_REGISTRY_CODE_HASH"),
  claimModuleCodeHash: required("REWARD_TICKET_CLAIM_MODULE_CODE_HASH"),
}
if (wallet.address.toLowerCase() !== config.purchaseOperatorAddress.toLowerCase()) {
  throw new Error("purchase operator key/address mismatch")
}
const reader = createMegapotChainReader(config)
await verifyMegapotEnvironmentAtStartup({ config, reader })
const snapshot = await reader.readPurchaseSnapshot()
const preflight = await revalidateMegapotPurchase({
  config,
  reader,
  intendedDrawingId: snapshot.activeDrawingId,
  ticketCount: 1,
  maxTicketPriceAtomic: 10_000n,
  referrerCount: 1,
})
if (preflight.disposition !== "ready") {
  console.log(JSON.stringify({ status: "waiting", reason: preflight.reason, drawingId: snapshot.activeDrawingId.toString() }))
  process.exit(2)
}
const journal = await loadJournal(journalPath)
const commitment = buildRewardTicketCommitment({
  chainId: 84532,
  jackpotAddress: config.deployment.jackpot.address,
  drawingId: snapshot.activeDrawingId,
  poolId: `sepolia-rehearsal-${snapshot.activeDrawingId}`,
  termsHash: "11".repeat(32),
  beneficiaries: [{
    rewardIdentityId: "sepolia-rehearsal-identity",
    userId: "sepolia-rehearsal-user",
    qualificationEvidenceHash: "22".repeat(32),
  }],
})
const rehearsalTermsHash = "11".repeat(32)
const publication = await prepareAndBroadcast({
  journalPath, journal, wallet, provider, kind: "commitment", drawingId: snapshot.activeDrawingId,
  to: config.commitmentRegistryAddress,
  data: encodeRewardTicketCommitmentPublication({
    jackpotAddress: config.deployment.jackpot.address,
    drawingId: snapshot.activeDrawingId,
    rootHash: commitment.rootHash,
    leafCount: 1,
    termsHash: rehearsalTermsHash,
  }),
})
const secondPreflight = await revalidateMegapotPurchase({
  config, reader, intendedDrawingId: snapshot.activeDrawingId, ticketCount: 1,
  maxTicketPriceAtomic: 10_000n, referrerCount: 1,
})
if (secondPreflight.disposition !== "ready") throw new Error(`post-publication preflight blocked: ${secondPreflight.reason}`)
const call = buildMegapotPurchaseCall({
  config,
  operationId: `sepolia-rehearsal-${snapshot.activeDrawingId}`,
  ticketCount: 1,
  intendedDrawingId: snapshot.activeDrawingId,
  expectedTicketPriceAtomic: secondPreflight.ticketPriceAtomic,
  referralScheme: platformMegapotReferralScheme(config.platformRevenueAddress),
  source: "pirate-rehearsal",
})
const purchase = await prepareAndBroadcast({
  journalPath, journal, wallet, provider, kind: "purchase", drawingId: snapshot.activeDrawingId,
  to: call.to, data: call.data,
})
const allowance = await new Contract(config.deployment.usdc.address, [
  "function allowance(address,address) view returns(uint256)",
], provider).allowance(config.purchaseEscrowAddress, config.deployment.randomTicketBuyer.address)
console.log(JSON.stringify({
  status: "purchased",
  drawingId: snapshot.activeDrawingId.toString(),
  commitmentTx: publication.transactionHash,
  purchaseTx: purchase.transactionHash,
  ticketIds: purchase.ticketIds,
  remainingAllowanceAtomic: String(allowance),
  custodyAddress: config.custodyAddress,
  escrowAddress: config.purchaseEscrowAddress,
  registryAddress: config.commitmentRegistryAddress,
  source: encodeBytes32String("pirate-rehearsal"),
}))
