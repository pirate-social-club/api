import type { Address } from "viem"

export type StorySettlementProtocolAddresses = {
  wipToken: Address
  royaltyModule: Address
  royaltyPolicyLap: Address
}

export const STORY_SETTLEMENT_PROTOCOL_ADDRESSES: Readonly<Record<1315 | 1514, StorySettlementProtocolAddresses>> = {
  1315: {
    wipToken: "0x1514000000000000000000000000000000000000",
    royaltyModule: "0xD2f60c40fEbccf6311f8B47c4f2Ec6b040400086",
    royaltyPolicyLap: "0xBe54FB168b3c982b7AaE60dB6CF75Bd8447b390E",
  },
  1514: {
    wipToken: "0x1514000000000000000000000000000000000000",
    royaltyModule: "0xD2f60c40fEbccf6311f8B47c4f2Ec6b040400086",
    royaltyPolicyLap: "0xBe54FB168b3c982b7AaE60dB6CF75Bd8447b390E",
  },
}

export function findStorySettlementProtocolAddresses(chainId: number): StorySettlementProtocolAddresses | null {
  if (chainId !== 1315 && chainId !== 1514) return null
  return STORY_SETTLEMENT_PROTOCOL_ADDRESSES[chainId]
}

export function resolveStorySettlementProtocolAddresses(chainId: number): StorySettlementProtocolAddresses {
  const addresses = findStorySettlementProtocolAddresses(chainId)
  if (!addresses) throw new Error(`unsupported_story_settlement_chain:${chainId}`)
  return addresses
}

