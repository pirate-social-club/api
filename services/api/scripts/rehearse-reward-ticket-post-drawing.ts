import { readFile } from "node:fs/promises"

import { Contract, Interface, JsonRpcProvider, Wallet } from "ethers"

import { MEGAPOT_CLAIM_ERRORS_ABI, REWARD_TICKET_SAFE_CLAIM_MODULE_ABI } from "../src/lib/reward-ticket-pools/megapot-abi"
import { buildRewardTicketSafeClaimCall } from "../src/lib/reward-ticket-pools/reward-ticket-claim-worker"
import { isPayingMegapotTier } from "../src/lib/reward-ticket-pools/megapot-claim-policy"

const journalPath = process.argv[2]
if (!journalPath) throw new Error("journal path is required")
const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
  entries: Array<{ kind: string; drawingId: string; ticketIds?: string[]; purchaseTx?: string }>
}
const purchase = journal.entries.find((entry) => entry.kind === "purchase" && entry.ticketIds?.length === 1)
if (!purchase?.ticketIds?.[0]) throw new Error("confirmed purchase entry with one ticket is required")

const rpcUrl = String(process.env.BASE_SEPOLIA_RPC_URL ?? "").trim()
const privateKey = String(process.env.PRIVATE_KEY ?? "").trim()
if (!rpcUrl || !privateKey) throw new Error("BASE_SEPOLIA_RPC_URL and PRIVATE_KEY are required")

const provider = new JsonRpcProvider(rpcUrl)
const wallet = new Wallet(privateKey, provider)
const jackpotAddress = "0x465dA3c859f193A3807386387bEE941B2A4c3279"
const usdcAddress = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
const safeAddress = "0x1cd289B6b232E1378d606ba550019E553685ad4C"
const moduleAddress = "0x02c949d00b7fDCfd379F2F93aacbC1249Fa52486"
const ticketId = BigInt(purchase.ticketIds[0])
const drawingId = BigInt(purchase.drawingId)

const jackpot = new Contract(jackpotAddress, [
  "function getDrawingState(uint256) view returns((uint256 prizePool,uint256 ticketPrice,uint256 edgePerTicket,uint256 referralWinShare,uint256 referralFee,uint256 globalTicketsBought,uint256 lpEarnings,uint256 drawingTime,uint256 winningTicket,uint8 ballMax,uint8 bonusballMax,address payoutCalculator,bool jackpotLock))",
  "function getTicketTierIds(uint256[] ticketIds) view returns(uint256[] tierIds)",
  "function getDrawingTierPayouts(uint256 drawingId) view returns(uint256[12])",
], provider)
const state = await jackpot.getDrawingState(drawingId)
const nowSeconds = Math.floor(Date.now() / 1000)
if (BigInt(state.drawingTime) > BigInt(nowSeconds)) {
  console.log(JSON.stringify({
    status: "waiting",
    drawingId: drawingId.toString(),
    secondsUntil: Number(state.drawingTime) - nowSeconds,
  }))
  process.exit(2)
}

const tiers = await jackpot.getTicketTierIds([ticketId]) as readonly bigint[]
if (tiers.length !== 1) throw new Error("Megapot returned an invalid tier response")
const tierId = BigInt(tiers[0] as bigint)
if (!isPayingMegapotTier(tierId)) {
  console.log(JSON.stringify({
    status: "no_win",
    drawingId: drawingId.toString(),
    ticketId: ticketId.toString(),
    tierId: tierId.toString(),
    allocation: "none",
  }))
  process.exit(0)
}

const claimCall = buildRewardTicketSafeClaimCall({
  moduleAddress,
  operationId: `sepolia-rehearsal-claim-${drawingId}`,
  ticketIds: [ticketId],
})
const tx = await wallet.sendTransaction(claimCall)
const receipt = await tx.wait(3)
if (!receipt || receipt.status !== 1) throw new Error("Safe claim transaction failed")
const transfer = new Interface(["event Transfer(address indexed from,address indexed to,uint256 value)"])
let receivedAtomic = 0n
for (const log of receipt.logs) {
  if (log.address.toLowerCase() !== usdcAddress.toLowerCase()) continue
  try {
    const parsed = transfer.parseLog(log)
    if (parsed?.name === "Transfer" && String(parsed.args.to).toLowerCase() === safeAddress.toLowerCase()) {
      receivedAtomic += BigInt(parsed.args.value)
    }
  } catch { /* unrelated log */ }
}
const payouts = await jackpot.getDrawingTierPayouts(drawingId) as readonly bigint[]
console.log(JSON.stringify({
  status: "claimed",
  drawingId: drawingId.toString(),
  ticketId: ticketId.toString(),
  tierId: tierId.toString(),
  grossTierPayoutAtomic: String(payouts[Number(tierId)] ?? 0n),
  custodyReceiptAtomic: String(receivedAtomic),
  claimTx: receipt.hash,
  blockNumber: receipt.blockNumber,
  safeAddress,
  claimErrors: MEGAPOT_CLAIM_ERRORS_ABI,
  moduleAbi: REWARD_TICKET_SAFE_CLAIM_MODULE_ABI,
}))
