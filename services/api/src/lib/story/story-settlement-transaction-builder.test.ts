import { describe, expect, test } from "bun:test"
import { StoryClient } from "@story-protocol/core-sdk"
import { custom, decodeFunctionData, encodeAbiParameters, parseAbi, zeroAddress } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import {
  buildStoryEntitlementMintCall,
  buildStoryParentVaultTransferCall,
  buildStoryRoyaltyPaymentCalls,
} from "./story-settlement-transaction-builder"
import { resolveStorySettlementProtocolAddresses } from "./story-settlement-protocol-addresses"

const WIP_ABI = parseAbi([
  "function deposit() payable",
  "function approve(address spender, uint256 amount) returns (bool)",
])
const ROYALTY_MODULE_ABI = parseAbi([
  "function payRoyaltyOnBehalf(address receiverIpId, address payerIpId, address token, uint256 amount)",
])
const ROYALTY_POLICY_ABI = parseAbi([
  "function transferToVault(address ipId, address ancestorIpId, address token) returns (uint256)",
])
const ENTITLEMENT_ABI = parseAbi([
  "function mintEntitlement(address to, uint256 tokenId, bytes32 purchaseRef) returns (bool)",
])

const RECEIVER = "0x1111111111111111111111111111111111111111"
const PARENT = "0x2222222222222222222222222222222222222222"
const BUYER = "0x3333333333333333333333333333333333333333"
const ENTITLEMENT = "0x4444444444444444444444444444444444444444"
const PURCHASE_REF = `0x${"55".repeat(32)}` as const

describe("Story settlement transaction builder", () => {
  test("pins the Aeneid and mainnet protocol targets", () => {
    expect(resolveStorySettlementProtocolAddresses(1315)).toEqual({
      wipToken: "0x1514000000000000000000000000000000000000",
      royaltyModule: "0xD2f60c40fEbccf6311f8B47c4f2Ec6b040400086",
      royaltyPolicyLap: "0xBe54FB168b3c982b7AaE60dB6CF75Bd8447b390E",
    })
    expect(resolveStorySettlementProtocolAddresses(1514)).toEqual(resolveStorySettlementProtocolAddresses(1315))
    expect(() => resolveStorySettlementProtocolAddresses(1)).toThrow("unsupported_story_settlement_chain:1")
  })

  test("builds exact deficit wrap, exact approval, then royalty payment", () => {
    const addresses = resolveStorySettlementProtocolAddresses(1315)
    const calls = buildStoryRoyaltyPaymentCalls({
      chainId: 1315,
      receiverIpId: RECEIVER,
      amount: 100n,
      wipBalance: 30n,
      wipAllowance: 20n,
    })
    expect(calls.map((call) => call.kind)).toEqual(["wip_wrap", "wip_approve", "story_royalty_payment"])
    expect(calls[0]).toMatchObject({ target: addresses.wipToken, value: 70n })
    expect(calls[0]!.calldata.slice(0, 10)).toBe("0xd0e30db0")
    expect(decodeFunctionData({ abi: WIP_ABI, data: calls[0]!.calldata }).functionName).toBe("deposit")
    expect(calls[1]!.calldata.slice(0, 10)).toBe("0x095ea7b3")
    expect(decodeFunctionData({ abi: WIP_ABI, data: calls[1]!.calldata })).toEqual({
      functionName: "approve",
      args: [addresses.royaltyModule, 100n],
    })
    expect(decodeFunctionData({ abi: ROYALTY_MODULE_ABI, data: calls[2]!.calldata })).toEqual({
      functionName: "payRoyaltyOnBehalf",
      args: [RECEIVER, zeroAddress, addresses.wipToken, 100n],
    })
    expect(calls[2]!.calldata.slice(0, 10)).toBe("0xd2577f3b")
  })

  test("omits prerequisites already satisfied by the ordered state snapshot", () => {
    expect(buildStoryRoyaltyPaymentCalls({
      chainId: 1315,
      receiverIpId: RECEIVER,
      payerIpId: PARENT,
      amount: 100n,
      wipBalance: 100n,
      wipAllowance: 100n,
    }).map((call) => call.kind)).toEqual(["story_royalty_payment"])
  })

  test("matches the SDK royalty calldata while the mock transport prohibits writes", async () => {
    const rpcMethods: string[] = []
    const storyClient = StoryClient.newClient({
      account: privateKeyToAccount(`0x${"11".repeat(32)}`),
      chainId: "aeneid",
      transport: custom({
        async request({ method }) {
          rpcMethods.push(method)
          if (method === "eth_call") return encodeAbiParameters([{ type: "bool" }], [true])
          throw new Error(`unexpected_rpc_method:${method}`)
        },
      }),
    })
    const sdkResult = await storyClient.royalty.payRoyaltyOnBehalf({
      receiverIpId: RECEIVER,
      payerIpId: zeroAddress,
      token: resolveStorySettlementProtocolAddresses(1315).wipToken,
      amount: 100n,
      txOptions: { encodedTxDataOnly: true },
    })
    if (!("encodedTxData" in sdkResult) || !sdkResult.encodedTxData) throw new Error("sdk_encoded_calldata_missing")
    const localPayment = buildStoryRoyaltyPaymentCalls({
      chainId: 1315,
      receiverIpId: RECEIVER,
      amount: 100n,
      wipBalance: 100n,
      wipAllowance: 100n,
    })[0]!
    expect(localPayment.calldata).toBe(sdkResult.encodedTxData.data)
    expect(localPayment.target).toBe(sdkResult.encodedTxData.to)
    expect(rpcMethods).toEqual(["eth_call"])
  })

  test("encodes LAP parent transfer locally without a wallet", () => {
    const addresses = resolveStorySettlementProtocolAddresses(1315)
    const call = buildStoryParentVaultTransferCall({
      chainId: 1315,
      childIpId: RECEIVER,
      parentIpId: PARENT,
    })
    expect(call).toMatchObject({ kind: "story_parent_vault_transfer", target: addresses.royaltyPolicyLap, value: 0n })
    expect(call.calldata.slice(0, 10)).toBe("0xb6a92a53")
    expect(decodeFunctionData({ abi: ROYALTY_POLICY_ABI, data: call.calldata })).toEqual({
      functionName: "transferToVault",
      args: [RECEIVER, PARENT, addresses.wipToken],
    })
  })

  test("encodes entitlement mint locally and requires a bytes32 purchase reference", () => {
    const call = buildStoryEntitlementMintCall({
      entitlementTokenAddress: ENTITLEMENT,
      buyerAddress: BUYER,
      entitlementTokenId: 42n,
      purchaseRef: PURCHASE_REF,
    })
    expect(call).toMatchObject({ kind: "story_entitlement_mint", target: ENTITLEMENT, value: 0n })
    expect(call.calldata.slice(0, 10)).toBe("0xe883fe8f")
    expect(decodeFunctionData({ abi: ENTITLEMENT_ABI, data: call.calldata })).toEqual({
      functionName: "mintEntitlement",
      args: [BUYER, 42n, PURCHASE_REF],
    })
    expect(() => buildStoryEntitlementMintCall({
      entitlementTokenAddress: ENTITLEMENT,
      buyerAddress: BUYER,
      entitlementTokenId: 42n,
      purchaseRef: "0x12",
    })).toThrow("purchase_ref_must_be_bytes32")
  })
})
