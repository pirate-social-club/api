import {
  encodeFunctionData,
  getAddress,
  parseAbi,
  zeroAddress,
  type Address,
  type Hex,
} from "viem"
import { resolveStorySettlementProtocolAddresses } from "./story-settlement-protocol-addresses"

const WIP_ABI = parseAbi([
  "function deposit() payable",
  "function approve(address spender, uint256 amount) returns (bool)",
])

const ROYALTY_MODULE_ABI = parseAbi([
  "function payRoyaltyOnBehalf(address receiverIpId, address payerIpId, address token, uint256 amount)",
])

// Story SDK 1.4.4 uses the LRP ABI for every native royalty policy. LAP exposes
// the same transferToVault call surface.
const ROYALTY_POLICY_ABI = parseAbi([
  "function transferToVault(address ipId, address ancestorIpId, address token) returns (uint256)",
])

const PURCHASE_ENTITLEMENT_TOKEN_ABI = parseAbi([
  "function mintEntitlement(address to, uint256 tokenId, bytes32 purchaseRef) returns (bool)",
])

export type StorySettlementCallKind =
  | "wip_wrap"
  | "wip_approve"
  | "story_royalty_payment"
  | "story_parent_vault_transfer"
  | "story_entitlement_mint"

export type UnsignedStorySettlementCall = {
  kind: StorySettlementCallKind
  target: Address
  value: bigint
  calldata: Hex
}

export function buildStoryRoyaltyPaymentCalls(input: {
  chainId: number
  receiverIpId: string
  payerIpId?: string | null
  amount: bigint
}): UnsignedStorySettlementCall[] {
  if (input.amount <= 0n) throw new Error("story_royalty_amount_must_be_positive")

  const addresses = resolveStorySettlementProtocolAddresses(input.chainId)
  const receiverIpId = getAddress(input.receiverIpId)
  const payerIpId = input.payerIpId ? getAddress(input.payerIpId) : zeroAddress
  return [
    {
      kind: "wip_wrap",
      target: addresses.wipToken,
      value: input.amount,
      calldata: encodeFunctionData({ abi: WIP_ABI, functionName: "deposit" }),
    },
    {
      kind: "wip_approve",
      target: addresses.wipToken,
      value: 0n,
      calldata: encodeFunctionData({
        abi: WIP_ABI,
        functionName: "approve",
        args: [addresses.royaltyModule, input.amount],
      }),
    },
    {
      kind: "story_royalty_payment",
      target: addresses.royaltyModule,
      value: 0n,
      calldata: encodeFunctionData({
        abi: ROYALTY_MODULE_ABI,
        functionName: "payRoyaltyOnBehalf",
        args: [receiverIpId, payerIpId, addresses.wipToken, input.amount],
      }),
    },
  ]
}

export function buildStoryParentVaultTransferCall(input: {
  chainId: number
  childIpId: string
  parentIpId: string
  royaltyPolicyAddress?: string | null
}): UnsignedStorySettlementCall {
  const addresses = resolveStorySettlementProtocolAddresses(input.chainId)
  const royaltyPolicyAddress = getAddress(input.royaltyPolicyAddress || addresses.royaltyPolicyLap)
  return {
    kind: "story_parent_vault_transfer",
    target: royaltyPolicyAddress,
    value: 0n,
    calldata: encodeFunctionData({
      abi: ROYALTY_POLICY_ABI,
      functionName: "transferToVault",
      args: [getAddress(input.childIpId), getAddress(input.parentIpId), addresses.wipToken],
    }),
  }
}

export function buildStoryEntitlementMintCall(input: {
  entitlementTokenAddress: string
  buyerAddress: string
  entitlementTokenId: bigint
  purchaseRef: Hex
}): UnsignedStorySettlementCall {
  if (input.entitlementTokenId < 0n) throw new Error("entitlement_token_id_must_be_non_negative")
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.purchaseRef)) throw new Error("purchase_ref_must_be_bytes32")
  return {
    kind: "story_entitlement_mint",
    target: getAddress(input.entitlementTokenAddress),
    value: 0n,
    calldata: encodeFunctionData({
      abi: PURCHASE_ENTITLEMENT_TOKEN_ABI,
      functionName: "mintEntitlement",
      args: [getAddress(input.buyerAddress), input.entitlementTokenId, input.purchaseRef],
    }),
  }
}
