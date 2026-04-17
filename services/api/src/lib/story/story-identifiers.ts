import { AbiCoder, keccak256, toUtf8Bytes } from "ethers"

const abiCoder = AbiCoder.defaultAbiCoder()

export function hashBytes32FromParts(...parts: Array<string | null | undefined>): `0x${string}` {
  const canonical = parts.map((part) => String(part || "").trim()).join(":")
  return keccak256(toUtf8Bytes(canonical)) as `0x${string}`
}

export function deriveStoryAssetVersionId(input: {
  communityId: string
  assetId: string
  bundleId: string
  primaryContentHash: string
}): `0x${string}` {
  return hashBytes32FromParts(
    "pirate-v2",
    "asset-version",
    input.communityId,
    input.assetId,
    input.bundleId,
    input.primaryContentHash,
  )
}

export function deriveStoryNamespace(assetVersionId: `0x${string}`): `0x${string}` {
  return hashBytes32FromParts("pirate-v2", "asset-namespace", assetVersionId)
}

export function deriveEntitlementTokenId(assetVersionId: string): bigint {
  return BigInt(assetVersionId)
}

export function derivePurchaseRef(input: {
  communityId: string
  purchaseId: string
  assetId: string
}): `0x${string}` {
  return hashBytes32FromParts("pirate-v2", "purchase-ref", input.communityId, input.purchaseId, input.assetId)
}

export function deriveStorageRefHash(storageRef: string): `0x${string}` {
  return keccak256(toUtf8Bytes(storageRef.trim())) as `0x${string}`
}

export function encodeTokenGateConditionData(input: {
  entitlementTokenAddress: string
  tokenId: bigint
  minBalance?: bigint
}): `0x${string}` {
  return abiCoder.encode(
    ["address", "uint256", "uint256"],
    [input.entitlementTokenAddress, input.tokenId, input.minBalance ?? 1n],
  ) as `0x${string}`
}

export function encodeWriteConditionOperatorData(operatorAddress: string): `0x${string}` {
  return abiCoder.encode(["address"], [operatorAddress]) as `0x${string}`
}

export function encodeSignedAccessNamespace(namespace: `0x${string}`): `0x${string}` {
  return abiCoder.encode(["bytes32"], [namespace]) as `0x${string}`
}
