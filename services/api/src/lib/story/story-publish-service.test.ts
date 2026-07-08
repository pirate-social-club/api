import { describe, expect, test } from "bun:test"
import { Interface, Transaction, Wallet } from "ethers"
import {
  configureStoryEntitlementClass,
  publishedAssetVersionMatches,
  type PublishedAssetVersionSnapshot,
} from "./story-publish-service"

const expected = {
  publisherAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  cdrVaultUuid: 5151,
  namespace: `0x${"11".repeat(32)}`,
  contentHash: `0x${"22".repeat(32)}`,
  storageRefHash: `0x${"33".repeat(32)}`,
  entitlementTokenId: 12345n,
  readConditionAddress: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  writeConditionAddress: "0xcccccccccccccccccccccccccccccccccccccccc",
}

function existing(overrides: Partial<PublishedAssetVersionSnapshot> = {}): PublishedAssetVersionSnapshot {
  return {
    publisher: expected.publisherAddress,
    cdrVaultUuid: BigInt(expected.cdrVaultUuid),
    namespace: expected.namespace.toUpperCase(),
    contentHash: expected.contentHash.toUpperCase(),
    storageRefHash: expected.storageRefHash.toUpperCase(),
    entitlementTokenId: expected.entitlementTokenId,
    readCondition: expected.readConditionAddress,
    writeCondition: expected.writeConditionAddress,
    active: true,
    exists: true,
    ...overrides,
  }
}

describe("publishedAssetVersionMatches", () => {
  test("accepts an already-published asset version only when every coordinate matches", () => {
    expect(publishedAssetVersionMatches({
      existing: existing(),
      expected,
    })).toBe(true)
  })

  test("rejects missing or different published-version coordinates", () => {
    expect(publishedAssetVersionMatches({
      existing: existing({ exists: false }),
      expected,
    })).toBe(false)
    expect(publishedAssetVersionMatches({
      existing: existing({ cdrVaultUuid: 5152n }),
      expected,
    })).toBe(false)
    expect(publishedAssetVersionMatches({
      existing: existing({ storageRefHash: `0x${"44".repeat(32)}` }),
      expected,
    })).toBe(false)
    expect(publishedAssetVersionMatches({
      existing: existing({ readCondition: "0xdddddddddddddddddddddddddddddddddddddddd" }),
      expected,
    })).toBe(false)
  })
})

describe("configureStoryEntitlementClass", () => {
  test("treats an already-known configurer tx as retryable and waits with the configured timeout", async () => {
    const wallet = Wallet.createRandom()
    const iface = new Interface(["function configureEntitlementClass(uint256 tokenId, bytes32 assetVersionId, uint32 cdrVaultUuid, bool active)"])
    const rawTransaction = await wallet.signTransaction({
      chainId: 1315,
      type: 2,
      nonce: 12,
      to: "0xdddddddddddddddddddddddddddddddddddddddd",
      data: iface.encodeFunctionData("configureEntitlementClass", [
        12345n,
        `0x${"aa".repeat(32)}`,
        5151,
        true,
      ]),
      value: 0n,
      gasLimit: 90_000n,
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    })
    const expectedHash = Transaction.from(rawTransaction).hash
    const waited: Array<{ hash: string; confirms?: number; timeout?: number }> = []
    const provider = {
      getFeeData: async () => ({
        maxFeePerGas: 1_000_000_000n,
        maxPriorityFeePerGas: 1_000_000_000n,
      }),
      estimateGas: async () => 75_000n,
      waitForTransaction: async (hash: string, confirms?: number, timeout?: number) => {
        waited.push({ hash, confirms, timeout })
        return { status: 1, hash }
      },
    }
    const signer = {
      address: wallet.address,
      sendTransaction: async () => {
        throw {
          message: "could not coalesce error",
          error: {
            code: -32000,
            message: "already known",
          },
          payload: {
            params: [rawTransaction],
          },
        }
      },
    }

    const response = await configureStoryEntitlementClass({
      provider: provider as never,
      signer: signer as never,
      configurerContractAddress: "0xdddddddddddddddddddddddddddddddddddddddd",
      entitlementTokenId: 12345n,
      assetVersionId: `0x${"aa".repeat(32)}`,
      cdrVaultUuid: 5151,
      gasPolicy: {
        maxFeePerGasCapWei: 2_000_000_000n,
        maxPriorityFeePerGasCapWei: 2_000_000_000n,
        gasLimitCap: 150_000n,
        gasEstimateBufferBps: 10_000n,
      },
      txWaitTimeoutMs: 45_000,
    })

    expect(response.hash).toBe(expectedHash)
    expect(waited).toEqual([{ hash: expectedHash, confirms: 1, timeout: 45_000 }])
  })
})
