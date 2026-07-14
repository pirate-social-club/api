import { Wallet, getAddress } from "ethers"

export const REWARD_SETTLEMENT_PRIVATE_KEY_ENV = "PIRATE_REWARDS_SETTLEMENT_OPERATOR_PRIVATE_KEY"
export const REWARD_SETTLEMENT_PRIVATE_KEY_SECRET = "PIRATE_REWARDS_SETTLEMENT_OPERATOR_PRIVATE_KEY"

export function deriveRewardSettlementAddress(privateKey: string): string {
  const normalized = privateKey.trim()
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error(`${REWARD_SETTLEMENT_PRIVATE_KEY_ENV}_must_be_a_32_byte_hex_private_key`)
  }
  return new Wallet(normalized).address
}

export function assertRewardSettlementAddress(input: {
  privateKey: string
  expectedAddress: string
}): string {
  let expected: string
  try {
    expected = getAddress(input.expectedAddress.trim())
  } catch {
    throw new Error("expected_reward_settlement_address_is_invalid")
  }
  const actual = deriveRewardSettlementAddress(input.privateKey)
  if (actual !== expected) throw new Error("reward_settlement_private_key_does_not_match_versioned_address")
  return actual
}

