import { beforeEach, describe, expect, test } from "bun:test"
import { NativeRoyaltyPolicy, WIP_TOKEN_ADDRESS } from "@story-protocol/core-sdk"
import type { Env } from "../src/types"

type Hex = `0x${string}`

function hex(value: string): Hex {
  return value as Hex
}

const settlementPrivateKey = hex("0x5000000000000000000000000000000000000000000000000000000000000005")
const aaaAddress = hex("0xAAa0000000000000000000000000000000000000")
const bbbAddress = hex("0xbBb0000000000000000000000000000000000000")
const cccAddress = hex("0xCcc0000000000000000000000000000000000000")
const purchaseRef = hex(`0x${"ab".repeat(32)}`)
const buyerAddress = hex("0xaaa0000000000000000000000000000000000000")
const receiverIpId = hex("0xbbb0000000000000000000000000000000000000")
const zeroAddress = hex("0x0000000000000000000000000000000000000000")
const mockRoyaltyTxHash = hex("0xmockroyaltytx")
const mockTransferTxHash = hex("0xmocktransfertx")
const mockEntitlementTxHash = hex("0xmockentitlementtxhash")

const captured = {
  storyClientOptions: null as unknown,
  payRoyaltyOnBehalf: null as unknown,
  transferToVault: null as unknown,
  sendContractTxWithPolicy: null as unknown,
  ensureStoryEntitlementMinterAuthorized: null as unknown,
  waitForTransactionArgs: null as unknown,
  entitlementTxHash: mockEntitlementTxHash as string,
  waitForTransactionResult: { status: 1 } as unknown,
  payRoyaltyTxHash: mockRoyaltyTxHash as string,
  transferVaultTxHash: mockTransferTxHash as string,
  events: [] as string[],
}

function resetCaptured(): void {
  captured.storyClientOptions = null
  captured.payRoyaltyOnBehalf = null
  captured.transferToVault = null
  captured.sendContractTxWithPolicy = null
  captured.ensureStoryEntitlementMinterAuthorized = null
  captured.waitForTransactionArgs = null
  captured.payRoyaltyTxHash = mockRoyaltyTxHash
  captured.transferVaultTxHash = mockTransferTxHash
  captured.entitlementTxHash = mockEntitlementTxHash
  captured.waitForTransactionResult = { status: 1 }
  captured.events = []
}

const mockWaitForTransaction = async (...args: unknown[]) => {
  captured.waitForTransactionArgs = args
  return captured.waitForTransactionResult
}

import {
  payStoryRoyaltyOnBehalfForPurchase,
  transferStoryRoyaltyToParentVault,
  mintStoryRoyaltyPurchaseEntitlement,
  setStoryRoyaltySettlementAdapterDepsForTests,
  setStoryRoyaltyPurchaseSettlementExecutorForTests,
  setStoryRoyaltyEntitlementMinterForTests,
  setStoryParentRoyaltyVaultTransferExecutorForTests,
} from "../src/lib/story/story-royalty-settlement-service"

function installAdapterDeps(): void {
  setStoryRoyaltySettlementAdapterDepsForTests({
    newStoryClient: (options: never) => {
      captured.storyClientOptions = options
      return {
        royalty: {
          payRoyaltyOnBehalf: async (params: unknown) => {
            captured.payRoyaltyOnBehalf = params
            return { txHash: captured.payRoyaltyTxHash }
          },
          transferToVault: async (params: unknown) => {
            captured.transferToVault = params
            return { txHash: captured.transferVaultTxHash }
          },
        },
      } as never
    },
    createJsonRpcProvider: () => ({
      waitForTransaction: mockWaitForTransaction,
    } as never),
    createWallet: (privateKey, provider) => ({
      privateKey,
      provider,
      address: "0x5000000000000000000000000000000000000005",
    } as never),
    sendContractTxWithPolicy: async (params: unknown) => {
      captured.events.push("sendContractTxWithPolicy")
      captured.sendContractTxWithPolicy = params
      return { hash: captured.entitlementTxHash } as never
    },
    ensureStoryEntitlementMinterAuthorized: async (params: unknown) => {
      captured.events.push("ensureStoryEntitlementMinterAuthorized")
      captured.ensureStoryEntitlementMinterAuthorized = params
    },
  })
}

function buildEnv(overrides: Partial<Env> = {}): Env {
  return {
    MUSIC_PURCHASE_STORY_SETTLEMENT_PRIVATE_KEY: settlementPrivateKey,
    STORY_CHAIN_ID: "1315",
    ...overrides,
  } as Env
}

beforeEach(() => {
  resetCaptured()
  setStoryRoyaltyPurchaseSettlementExecutorForTests(null)
  setStoryRoyaltyEntitlementMinterForTests(null)
  setStoryParentRoyaltyVaultTransferExecutorForTests(null)
  installAdapterDeps()
})

describe("payStoryRoyaltyOnBehalfForPurchase adapter", () => {
  test("throws when settlement private key is missing", async () => {
    await expect(payStoryRoyaltyOnBehalfForPurchase({
      env: buildEnv({ MUSIC_PURCHASE_STORY_SETTLEMENT_PRIVATE_KEY: undefined }),
      purchaseRef: purchaseRef,
      buyerAddress: buyerAddress,
      receiverIpId: receiverIpId,
      amount: 1000n,
    })).rejects.toThrow("MUSIC_PURCHASE_STORY_SETTLEMENT_PRIVATE_KEY missing/invalid")
  })

  test("throws when settlement private key is invalid", async () => {
    await expect(payStoryRoyaltyOnBehalfForPurchase({
      env: buildEnv({ MUSIC_PURCHASE_STORY_SETTLEMENT_PRIVATE_KEY: "not-a-key" }),
      purchaseRef: purchaseRef,
      buyerAddress: buyerAddress,
      receiverIpId: receiverIpId,
      amount: 1000n,
    })).rejects.toThrow("MUSIC_PURCHASE_STORY_SETTLEMENT_PRIVATE_KEY missing/invalid")
  })

  test("throws when buyer address is missing", async () => {
    await expect(payStoryRoyaltyOnBehalfForPurchase({
      env: buildEnv(),
      purchaseRef: purchaseRef,
      buyerAddress: "",
      receiverIpId: receiverIpId,
      amount: 1000n,
    })).rejects.toThrow("buyerAddress missing/invalid")
  })

  test("throws when receiver IP ID is missing", async () => {
    await expect(payStoryRoyaltyOnBehalfForPurchase({
      env: buildEnv(),
      purchaseRef: purchaseRef,
      buyerAddress: buyerAddress,
      receiverIpId: "",
      amount: 1000n,
    })).rejects.toThrow("receiverIpId missing/invalid")
  })

  test("throws when amount is zero", async () => {
    await expect(payStoryRoyaltyOnBehalfForPurchase({
      env: buildEnv(),
      purchaseRef: purchaseRef,
      buyerAddress: buyerAddress,
      receiverIpId: receiverIpId,
      amount: 0n,
    })).rejects.toThrow("royalty settlement amount must be positive")
  })

  test("throws when amount is negative", async () => {
    await expect(payStoryRoyaltyOnBehalfForPurchase({
      env: buildEnv(),
      purchaseRef: purchaseRef,
      buyerAddress: buyerAddress,
      receiverIpId: receiverIpId,
      amount: -100n,
    })).rejects.toThrow("royalty settlement amount must be positive")
  })

  test("passes correct args to StoryClient payRoyaltyOnBehalf", async () => {
    const result = await payStoryRoyaltyOnBehalfForPurchase({
      env: buildEnv(),
      purchaseRef: purchaseRef,
      buyerAddress: buyerAddress,
      receiverIpId: bbbAddress,
      payerIpId: cccAddress,
      amount: 5000n,
    })

    expect(result.royaltyTxHash).toBe(mockRoyaltyTxHash)
    expect(result.entitlementTxHash).toBeNull()
    expect(result.settlementTxHash).toBe(mockRoyaltyTxHash)
    expect(result.entitlementHandled).toBe(false)

    expect(captured.storyClientOptions).toMatchObject({
      chainId: "aeneid",
    })
    expect(typeof (captured.storyClientOptions as any).account).toBe("object")
    expect(typeof (captured.storyClientOptions as any).transport).toBe("function")
    expect(captured.payRoyaltyOnBehalf).toEqual({
      receiverIpId: bbbAddress,
      payerIpId: cccAddress,
      token: WIP_TOKEN_ADDRESS,
      amount: 5000n,
      options: {
        wipOptions: {
          enableAutoWrapIp: true,
          enableAutoApprove: true,
        },
      },
    })
  })

  test("uses zero address when payer IP ID is null", async () => {
    await payStoryRoyaltyOnBehalfForPurchase({
      env: buildEnv(),
      purchaseRef: purchaseRef,
      buyerAddress: buyerAddress,
      receiverIpId: receiverIpId,
      payerIpId: null,
      amount: 1000n,
    })

    expect((captured.payRoyaltyOnBehalf as any).payerIpId).toBe(zeroAddress)
  })

  test("throws story_royalty_payment_missing_tx_hash when tx hash is empty", async () => {
    captured.payRoyaltyTxHash = ""

    try {
      await expect(payStoryRoyaltyOnBehalfForPurchase({
        env: buildEnv(),
        purchaseRef: purchaseRef,
        buyerAddress: buyerAddress,
        receiverIpId: receiverIpId,
        amount: 1000n,
      })).rejects.toThrow("story_royalty_payment_missing_tx_hash")
    } finally {
      captured.payRoyaltyTxHash = mockRoyaltyTxHash
    }
  })
})

describe("transferStoryRoyaltyToParentVault adapter", () => {
  test("throws when settlement private key is missing", async () => {
    await expect(transferStoryRoyaltyToParentVault({
      env: buildEnv({ MUSIC_PURCHASE_STORY_SETTLEMENT_PRIVATE_KEY: undefined }),
      childIpId: buyerAddress,
      parentIpId: receiverIpId,
    })).rejects.toThrow("MUSIC_PURCHASE_STORY_SETTLEMENT_PRIVATE_KEY missing/invalid")
  })

  test("throws when child IP ID is invalid", async () => {
    await expect(transferStoryRoyaltyToParentVault({
      env: buildEnv(),
      childIpId: "",
      parentIpId: receiverIpId,
    })).rejects.toThrow("childIpId missing/invalid")
  })

  test("throws when parent IP ID is invalid", async () => {
    await expect(transferStoryRoyaltyToParentVault({
      env: buildEnv(),
      childIpId: buyerAddress,
      parentIpId: "not-an-address",
    })).rejects.toThrow("parentIpId missing/invalid")
  })

  test("passes explicit royalty policy address through", async () => {
    const result = await transferStoryRoyaltyToParentVault({
      env: buildEnv(),
      childIpId: buyerAddress,
      parentIpId: receiverIpId,
      royaltyPolicy: "0xBe54FB168b3c982b7AaE60dB6CF75Bd8447b390E",
    })

    expect(result.transferTxHash).toBe(mockTransferTxHash)
    expect(captured.transferToVault).toMatchObject({
      ipId: aaaAddress,
      ancestorIpId: bbbAddress,
      royaltyPolicy: "0xBe54FB168b3c982b7AaE60dB6CF75Bd8447b390E",
      token: WIP_TOKEN_ADDRESS,
    })
  })

  test("falls back to NativeRoyaltyPolicy.LAP when no royalty policy provided", async () => {
    await transferStoryRoyaltyToParentVault({
      env: buildEnv(),
      childIpId: buyerAddress,
      parentIpId: receiverIpId,
      royaltyPolicy: null,
    })

    expect((captured.transferToVault as any).royaltyPolicy).toBe(NativeRoyaltyPolicy.LAP)
  })

  test("throws story_parent_royalty_vault_transfer_missing_tx_hash when tx hash is empty", async () => {
    captured.transferVaultTxHash = ""

    try {
      await expect(transferStoryRoyaltyToParentVault({
        env: buildEnv(),
        childIpId: buyerAddress,
        parentIpId: receiverIpId,
      })).rejects.toThrow("story_parent_royalty_vault_transfer_missing_tx_hash")
    } finally {
      captured.transferVaultTxHash = mockTransferTxHash
    }
  })
})

describe("mintStoryRoyaltyPurchaseEntitlement adapter", () => {
  test("throws when settlement private key is missing", async () => {
    await expect(mintStoryRoyaltyPurchaseEntitlement({
      env: buildEnv({ MUSIC_PURCHASE_STORY_SETTLEMENT_PRIVATE_KEY: undefined }),
      purchaseRef: purchaseRef,
      buyerAddress: buyerAddress,
      entitlementTokenId: 42n,
    })).rejects.toThrow("MUSIC_PURCHASE_STORY_SETTLEMENT_PRIVATE_KEY missing/invalid")
  })

  test("throws when buyer address is invalid", async () => {
    await expect(mintStoryRoyaltyPurchaseEntitlement({
      env: buildEnv(),
      purchaseRef: purchaseRef,
      buyerAddress: "",
      entitlementTokenId: 42n,
    })).rejects.toThrow("buyerAddress missing/invalid")
  })

  test("throws when entitlement token ID is null", async () => {
    await expect(mintStoryRoyaltyPurchaseEntitlement({
      env: buildEnv(),
      purchaseRef: purchaseRef,
      buyerAddress: buyerAddress,
      entitlementTokenId: null as unknown as bigint,
    })).rejects.toThrow("entitlementTokenId missing/invalid")
  })

  test("calls ensureStoryEntitlementMinterAuthorized before sendContractTxWithPolicy", async () => {
    await mintStoryRoyaltyPurchaseEntitlement({
      env: buildEnv(),
      purchaseRef: purchaseRef,
      buyerAddress: buyerAddress,
      entitlementTokenId: 42n,
    })

    expect(captured.events).toEqual([
      "ensureStoryEntitlementMinterAuthorized",
      "sendContractTxWithPolicy",
    ])
  })

  test("calls sendContractTxWithPolicy with mintEntitlement args", async () => {
    await mintStoryRoyaltyPurchaseEntitlement({
      env: buildEnv(),
      purchaseRef: purchaseRef,
      buyerAddress: buyerAddress,
      entitlementTokenId: 42n,
    })

    expect(captured.sendContractTxWithPolicy).toMatchObject({
      functionName: "mintEntitlement",
      args: [
        aaaAddress,
        42n,
        purchaseRef,
      ],
    })
  })

  test("returns entitlement tx hash on success", async () => {
    captured.entitlementTxHash = "0xentitlementsuccess"

    const result = await mintStoryRoyaltyPurchaseEntitlement({
      env: buildEnv(),
      purchaseRef: purchaseRef,
      buyerAddress: buyerAddress,
      entitlementTokenId: 42n,
    })

    expect(result).toBe("0xentitlementsuccess")
  })

  test("throws story_royalty_entitlement_mint_failed when receipt status is 0", async () => {
    captured.waitForTransactionResult = { status: 0 }

    try {
      await expect(mintStoryRoyaltyPurchaseEntitlement({
        env: buildEnv(),
        purchaseRef: purchaseRef,
        buyerAddress: buyerAddress,
        entitlementTokenId: 42n,
      })).rejects.toThrow("story_royalty_entitlement_mint_failed")
    } finally {
      captured.waitForTransactionResult = { status: 1 }
    }
  })

  test("throws story_royalty_entitlement_mint_failed when receipt is null", async () => {
    captured.waitForTransactionResult = null

    try {
      await expect(mintStoryRoyaltyPurchaseEntitlement({
        env: buildEnv(),
        purchaseRef: purchaseRef,
        buyerAddress: buyerAddress,
        entitlementTokenId: 42n,
      })).rejects.toThrow("story_royalty_entitlement_mint_failed")
    } finally {
      captured.waitForTransactionResult = { status: 1 }
    }
  })

  test("throws story_royalty_entitlement_missing_tx_hash when tx hash is empty", async () => {
    captured.entitlementTxHash = ""

    try {
      await expect(mintStoryRoyaltyPurchaseEntitlement({
        env: buildEnv(),
        purchaseRef: purchaseRef,
        buyerAddress: buyerAddress,
        entitlementTokenId: 42n,
      })).rejects.toThrow("story_royalty_entitlement_missing_tx_hash")
    } finally {
      captured.entitlementTxHash = mockEntitlementTxHash
    }
  })

  test("propagates gas policy error before sending tx", async () => {
    await expect(mintStoryRoyaltyPurchaseEntitlement({
      env: buildEnv({ STORY_DIRECT_TX_MAX_FEE_PER_GAS_WEI: "not-a-number" }),
      purchaseRef: purchaseRef,
      buyerAddress: buyerAddress,
      entitlementTokenId: 42n,
    })).rejects.toThrow("Invalid STORY_DIRECT_TX_MAX_FEE_PER_GAS_WEI")

    expect(captured.sendContractTxWithPolicy).toBeNull()
  })
})
