import {
  encodePacked,
  fromHex,
  isAddress,
  type Address,
  type Hex,
} from "viem"

export const accountMetadataAbi = [{
  inputs: [
    { internalType: "address", name: "addr", type: "address" },
    { internalType: "string", name: "key", type: "string" },
  ],
  name: "getValue",
  outputs: [{ internalType: "bytes", name: "", type: "bytes" }],
  stateMutability: "view",
  type: "function",
}] as const

export const listRegistryAbi = [{
  inputs: [{ internalType: "uint256", name: "tokenId", type: "uint256" }],
  name: "getListStorageLocation",
  outputs: [{ internalType: "bytes", name: "", type: "bytes" }],
  stateMutability: "view",
  type: "function",
}] as const

export const listRecordsAbi = [
  {
    inputs: [{ internalType: "uint256", name: "slot", type: "uint256" }],
    name: "getListUser",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "uint256", name: "slot", type: "uint256" },
      { internalType: "bytes[]", name: "ops", type: "bytes[]" },
    ],
    name: "applyListOps",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "uint256", name: "slot", type: "uint256" },
      {
        components: [
          { internalType: "string", name: "key", type: "string" },
          { internalType: "bytes", name: "value", type: "bytes" },
        ],
        internalType: "struct IEFPListMetadata.KeyValue[]",
        name: "records",
        type: "tuple[]",
      },
      { internalType: "bytes[]", name: "ops", type: "bytes[]" },
    ],
    name: "setMetadataValuesAndApplyListOps",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const

export const listMinterAbi = [{
  inputs: [{ internalType: "bytes", name: "listStorageLocation", type: "bytes" }],
  name: "mintPrimaryListNoMeta",
  outputs: [],
  stateMutability: "payable",
  type: "function",
}] as const

export interface FollowWriteTransaction {
  abi: typeof listMinterAbi | typeof listRecordsAbi
  address: Address
  args: readonly unknown[]
  chainId: number
  functionName: "mintPrimaryListNoMeta" | "applyListOps" | "setMetadataValuesAndApplyListOps"
}

export function normalizeAddress(value: string | null | undefined): Address | null {
  if (!value) return null
  const trimmed = value.trim()
  return isAddress(trimmed) ? trimmed.toLowerCase() as Address : null
}

export function decodePrimaryListId(value: Hex): string | null {
  if (!value || value === "0x") return null
  try {
    const listId = fromHex(value, "bigint")
    return listId > 0n ? listId.toString() : null
  } catch {
    return null
  }
}

export function decodeStorageLocation(storageLocation: Hex): { chainId: number; slot: bigint } {
  if (storageLocation.length < 134) throw new Error("Invalid EFP list storage location")
  return {
    chainId: fromHex(`0x${storageLocation.slice(6, 70)}`, "number"),
    slot: BigInt(`0x${storageLocation.slice(-64)}`),
  }
}

function createListOp(targetAddress: Address, followed: boolean): Hex {
  return encodePacked(
    ["uint8", "uint8", "uint8", "address"],
    [1, followed ? 1 : 2, 1, targetAddress],
  )
}

function randomListSlot(): bigint {
  const entropy = new Uint8Array(32)
  crypto.getRandomValues(entropy)
  return BigInt(`0x${Array.from(entropy, (byte) => byte.toString(16).padStart(2, "0")).join("")}`)
    & ((1n << 255n) - 1n)
}

function storageLocation(chainId: number, records: Address, slot: bigint): Hex {
  return encodePacked(
    ["uint8", "uint8", "uint256", "address", "uint256"],
    [1, 1, BigInt(chainId), records, slot],
  )
}

export function buildFollowTransactions(input: {
  existingStorage?: { chainId: number; slot: bigint } | null
  followed: boolean
  listMinter: Address
  listRecordsAddress: Address
  listRecordsByChain: Record<number, Address>
  primaryListChainId: number
  targetAddress: Address
  viewerAddress: Address
}): FollowWriteTransaction[] {
  const op = createListOp(input.targetAddress, input.followed)
  if (input.existingStorage) {
    const records = input.listRecordsByChain[input.existingStorage.chainId]
    if (!records) throw new Error(`Unsupported EFP list-records chain (${input.existingStorage.chainId})`)
    return [{
      abi: listRecordsAbi,
      address: records,
      args: [input.existingStorage.slot, [op]],
      chainId: input.existingStorage.chainId,
      functionName: "applyListOps",
    }]
  }
  const slot = randomListSlot()
  return [
    {
      abi: listRecordsAbi,
      address: input.listRecordsAddress,
      args: [slot, [{ key: "user", value: input.viewerAddress }], [op]],
      chainId: input.primaryListChainId,
      functionName: "setMetadataValuesAndApplyListOps",
    },
    {
      abi: listMinterAbi,
      address: input.listMinter,
      args: [storageLocation(input.primaryListChainId, input.listRecordsAddress, slot)],
      chainId: input.primaryListChainId,
      functionName: "mintPrimaryListNoMeta",
    },
  ]
}
