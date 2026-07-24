import { keccak256, toUtf8Bytes } from "ethers"

import { badRequestError } from "../errors"

/**
 * Maps an existing rewards payout/refund effect ID to the vault's bytes32
 * operation ID. The source string remains the database join key; callers must
 * not normalize it before hashing.
 */
export function rewardOperationId(exactEffectId: string): `0x${string}` {
  if (typeof exactEffectId !== "string" || exactEffectId.length === 0) {
    throw badRequestError("Reward settlement effect ID is required")
  }
  return keccak256(toUtf8Bytes(exactEffectId)) as `0x${string}`
}
