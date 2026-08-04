import {
  createPublicClient,
  decodeEventLog,
  http,
  parseAbi,
  parseAbiItem,
  type Address,
  type Hex,
} from "viem"
import { base } from "viem/chains"

import { EFP_KNOWN_HOSTED_DIVERGENCES } from "../src/lib/efp-indexer/known-divergences"

const records = "0x41aa48ef3c0446b46a5b1cc6337ff3d3716e2a33" as const
const slots: Readonly<Record<string, bigint>> = {
  "44277": 54670081249311657625998100661819970789429463178427852858057521453210050836863n,
  "44325": 15634162992771092378632950733538247919230039652282154416614989783872031228088n,
  "44460": 54917782871367386374288390094991056598276297311282565402875838868102129282053n,
  "44718": 3877663022907282833665657175409414836846049142733944183787241766840047011849n,
  "44777": 19174320568872570188446949450861254115702896556467280951552075330508400142896n,
  "44": 43714227397119390255221130232978897971665900639907565564650239239015493909951n,
  "71": 37341490270897753127758777299192831355088625985082093449402334781013799768994n,
  "5874": 33682681199177578012550194185187908291060800373140208224567177330741821511230n,
  "9": 43584480144492100776978212805921347316393085888746481819758223385894809496166n,
}
const abi = parseAbi(["function getAllListOps(uint256 slot) view returns (bytes[])"])
const event = parseAbiItem("event ListOp(uint256 indexed slot, bytes op)")

function decodeAddressOp(raw: Hex): { opcode: number; target: Address } | null {
  if (!/^0x[0-9a-f]+$/iu.test(raw) || raw.length < 50) return null
  const bytes = raw.slice(2)
  if (bytes.slice(0, 2) !== "01" || bytes.slice(4, 8) !== "0101") return null
  const opcode = Number.parseInt(bytes.slice(2, 4), 16)
  return {
    opcode,
    target: `0x${bytes.slice(8, 48)}`.toLowerCase() as Address,
  }
}

const rpcUrl = process.env.BASE_MAINNET_RPC_URL
if (!rpcUrl) throw new Error("BASE_MAINNET_RPC_URL is required")

const client = createPublicClient({ chain: base, transport: http(rpcUrl) })
const listOpsBySlot = new Map<bigint, Awaited<ReturnType<typeof readListOps>>>()
const receiptsByHash = new Map<Hex, Awaited<ReturnType<typeof readReceipt>>>()

async function withRateLimitRetry<T>(operation: () => Promise<T>): Promise<T> {
  let delayMs = 500
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
      if (!message.includes("rate limit") || attempt === 4) throw error
      await Bun.sleep(delayMs)
      delayMs *= 2
    }
  }
  throw new Error("Unreachable retry state")
}

async function readListOps(slot: bigint) {
  return withRateLimitRetry(() => client.readContract({
    address: records,
    abi,
    functionName: "getAllListOps",
    args: [slot],
  }))
}

async function readReceipt(hash: Hex) {
  return withRateLimitRetry(() => client.getTransactionReceipt({ hash }))
}

for (const item of EFP_KNOWN_HOSTED_DIVERGENCES) {
  const slot = slots[item.listId]
  if (slot == null) throw new Error(`No slot recorded for list ${item.listId}`)

  // Contract storage is the independent source of the terminal operation.
  let allOps = listOpsBySlot.get(slot)
  if (!allOps) {
    allOps = await readListOps(slot)
    listOpsBySlot.set(slot, allOps)
  }
  const targetOps = allOps
    .map(decodeAddressOp)
    .filter((op): op is NonNullable<typeof op> => op?.target === item.target)
  const terminal = targetOps.at(-1)
  if (terminal?.opcode !== 1) {
    throw new Error(`List ${item.listId} -> ${item.target} terminal opcode is ${terminal?.opcode ?? "missing"}`)
  }

  // The receipt independently binds that terminal add to the reviewed tx hash.
  let receipt = receiptsByHash.get(item.finalAddTransactionHash)
  if (!receipt) {
    receipt = await readReceipt(item.finalAddTransactionHash)
    receiptsByHash.set(item.finalAddTransactionHash, receipt)
  }
  const matchingLog = receipt.logs.some((log) => {
    if (log.address.toLowerCase() !== records) return false
    try {
      const decoded = decodeEventLog({ abi: [event], data: log.data, topics: log.topics })
      return decoded.args.slot === slot
        && decodeAddressOp(decoded.args.op)?.opcode === 1
        && decodeAddressOp(decoded.args.op)?.target === item.target
        && decoded.args.op === allOps.filter((op) => decodeAddressOp(op)?.target === item.target).at(-1)
    } catch {
      return false
    }
  })
  if (!matchingLog) {
    throw new Error(`Final add receipt does not match list ${item.listId} -> ${item.target}`)
  }

  console.log(JSON.stringify({
    listId: item.listId,
    target: item.target,
    finalAddTransactionHash: item.finalAddTransactionHash,
    terminalOpcode: terminal.opcode,
    receiptStatus: receipt.status,
  }))
}
