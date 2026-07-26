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

for (const item of EFP_KNOWN_HOSTED_DIVERGENCES) {
  const slot = slots[item.listId]
  if (slot == null) throw new Error(`No slot recorded for list ${item.listId}`)

  // Contract storage is the independent source of the terminal operation.
  const allOps = await client.readContract({
    address: records,
    abi,
    functionName: "getAllListOps",
    args: [slot],
  })
  const targetOps = allOps
    .map(decodeAddressOp)
    .filter((op): op is NonNullable<typeof op> => op?.target === item.target)
  const terminal = targetOps.at(-1)
  if (terminal?.opcode !== 1) {
    throw new Error(`List ${item.listId} -> ${item.target} terminal opcode is ${terminal?.opcode ?? "missing"}`)
  }

  // The receipt independently binds that terminal add to the reviewed tx hash.
  const receipt = await client.getTransactionReceipt({ hash: item.finalAddTransactionHash })
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
