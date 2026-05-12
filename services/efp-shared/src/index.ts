import {
  encodePacked,
  isAddress,
  keccak256,
  toHex,
  type Address,
  type Hex,
} from "viem";

export const accountMetadataAbi = [
  {
    inputs: [
      { internalType: "address", name: "addr", type: "address" },
      { internalType: "string", name: "key", type: "string" },
    ],
    name: "getValue",
    outputs: [{ internalType: "bytes", name: "", type: "bytes" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export const listRegistryAbi = [
  {
    inputs: [{ internalType: "uint256", name: "tokenId", type: "uint256" }],
    name: "getListStorageLocation",
    outputs: [{ internalType: "bytes", name: "", type: "bytes" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export const listRecordsAbi = [
  {
    inputs: [{ internalType: "uint256", name: "slot", type: "uint256" }],
    name: "getAllListOps",
    outputs: [{ internalType: "bytes[]", name: "", type: "bytes[]" }],
    stateMutability: "view",
    type: "function",
  },
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
] as const;

export const listMinterAbi = [
  {
    inputs: [{ internalType: "bytes", name: "listStorageLocation", type: "bytes" }],
    name: "mintPrimaryListNoMeta",
    outputs: [],
    stateMutability: "payable",
    type: "function",
  },
] as const;

export type PirateSponsoredIntent =
  | {
      type: "pirate.follow.apply";
      followed: boolean;
      slot: string;
      targetAddress: Address;
    }
  | {
      type: "pirate.follow.create-list-records";
      followed: boolean;
      slot: string;
      targetAddress: Address;
    }
  | {
      type: "pirate.follow.mint-primary-list";
      slot: string;
    };

export interface FollowWriteTransaction {
  abi: typeof listMinterAbi | typeof listRecordsAbi;
  address: Address;
  args: readonly unknown[];
  chainId: number;
  functionName: "mintPrimaryListNoMeta" | "applyListOps" | "setMetadataValuesAndApplyListOps";
}

export function normalizeAddress(value: string | null | undefined): Address | null {
  if (!value) return null;
  const trimmed = value.trim();
  return isAddress(trimmed) ? (trimmed.toLowerCase() as Address) : null;
}

export function createFollowListOp(targetAddress: Address, followed: boolean): Hex {
  return encodePacked(
    ["uint8", "uint8", "uint8", "address"],
    [1, followed ? 1 : 2, 1, targetAddress],
  );
}

export function generateListNonce(): bigint {
  const entropy = `${Date.now()}-${Math.random()}-${Math.random()}`;
  const hash = keccak256(toHex(entropy));
  return BigInt(hash) & ((1n << 255n) - 1n);
}

export function createMintStorageLocation(input: {
  primaryListChainId: number;
  listRecordsAddress: Address;
  slot: bigint;
}): Hex {
  return encodePacked(
    ["uint8", "uint8", "uint256", "address", "uint256"],
    [1, 1, BigInt(input.primaryListChainId), input.listRecordsAddress, input.slot],
  );
}

export function buildFollowTransactions(input: {
  existingStorage?: { chainId: number; slot: bigint } | null;
  followed: boolean;
  listMinter: Address;
  listRecordsAddress: Address;
  listRecordsByChain: Record<number, Address>;
  primaryListChainId: number;
  slot?: bigint;
  targetAddress: Address;
  viewerAddress: Address;
}): FollowWriteTransaction[] {
  const op = createFollowListOp(input.targetAddress, input.followed);

  if (input.existingStorage) {
    const recordsAddress = input.listRecordsByChain[input.existingStorage.chainId];
    if (!recordsAddress) {
      throw new Error(`Unsupported EFP list-records chain (${input.existingStorage.chainId}).`);
    }

    return [
      {
        abi: listRecordsAbi,
        address: recordsAddress,
        args: [input.existingStorage.slot, [op]],
        chainId: input.existingStorage.chainId,
        functionName: "applyListOps",
      },
    ];
  }

  const slot = input.slot ?? generateListNonce();
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
      args: [
        createMintStorageLocation({
          primaryListChainId: input.primaryListChainId,
          listRecordsAddress: input.listRecordsAddress,
          slot,
        }),
      ],
      chainId: input.primaryListChainId,
      functionName: "mintPrimaryListNoMeta",
    },
  ];
}

export function buildSponsoredFollowIntent(
  transaction: FollowWriteTransaction,
  targetAddress: Address,
  followed: boolean,
): PirateSponsoredIntent {
  const slot = resolveFollowTransactionSlot(transaction).toString();
  if (transaction.functionName === "applyListOps") {
    return { type: "pirate.follow.apply", followed, slot, targetAddress };
  }
  if (transaction.functionName === "setMetadataValuesAndApplyListOps") {
    return { type: "pirate.follow.create-list-records", followed, slot, targetAddress };
  }
  return { type: "pirate.follow.mint-primary-list", slot };
}

export function resolveFollowTransactionSlot(transaction: FollowWriteTransaction): bigint {
  if (
    transaction.functionName === "applyListOps" ||
    transaction.functionName === "setMetadataValuesAndApplyListOps"
  ) {
    return transaction.args[0] as bigint;
  }

  const storageLocation = transaction.args[0] as Hex;
  return BigInt(`0x${storageLocation.slice(-64)}`);
}
