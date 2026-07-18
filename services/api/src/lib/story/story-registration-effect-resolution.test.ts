import { describe, expect, test } from "bun:test"
import {
  encodeAbiParameters,
  encodeEventTopics,
  parseAbi,
  parseAbiParameters,
  type Address,
  type Hash,
  type Hex,
} from "viem"
import { WIP_TOKEN_ADDRESS } from "@story-protocol/core-sdk"
import type { Env } from "../../env"
import { sha256Hex } from "../crypto"
import {
  resolveStoryRoyaltyPolicyAddress,
  type StoryRoyaltyRegistrationResult,
} from "./story-royalty-registration-service"
import {
  parseStoryRegistrationResolutionResult,
  verifyStoryRegistrationReceipt,
  verifyStoryRegistrationRevertedReceipt,
  type StoryRegistrationReceiptClient,
} from "./story-registration-effect-resolution"
import type { StoryRegistrationEffect } from "./story-registration-effect-store"

const TX_HASH = `0x${"ab".repeat(32)}` as Hash
const BLOCK_HASH = `0x${"cd".repeat(32)}` as Hash
const SIGNER = "0x9999999999999999999999999999999999999999" as Address
const IP_ID = "0x1111111111111111111111111111111111111111" as Address
const SPG = "0x2222222222222222222222222222222222222222" as Address
const REGISTRY = "0x77319B4031e6eF1250907aa00018B8B1c67a244b" as Address
const METADATA_MODULE = "0x6E81a25C99C6e8430aeC7353325EB138aFE5DC16" as Address
const LICENSING_MODULE = "0x04fbd8a2e56dd85CFD5500A4A4DfA955B9f1dE6f" as Address
const ROYALTY_MODULE = "0xD2f60c40fEbccf6311f8B47c4f2Ec6b040400086" as Address

const IP_REGISTERED_ABI = parseAbi([
  "event IPRegistered(address ipId, uint256 indexed chainId, address indexed tokenContract, uint256 indexed tokenId, string name, string uri, uint256 registrationDate)",
])

const RECOVERY_ABI = parseAbi([
  "event MetadataURISet(address indexed ipId, string metadataURI, bytes32 metadataHash)",
  "event NFTTokenURISet(address indexed ipId, string nftTokenURI, bytes32 nftMetadataHash)",
  "event LicenseTermsAttached(address indexed caller, address indexed ipId, address licenseTemplate, uint256 licenseTermsId)",
  "event IpRoyaltyVaultDeployed(address ipId, address ipRoyaltyVault)",
])

const METADATA_BODY = JSON.stringify({
  community_id: "cmt_effect",
  asset_id: "ast_effect",
  primary_content_hash: `0x${"44".repeat(32)}`,
  rights_basis: "original",
  creator_wallet_address: "0x3333333333333333333333333333333333333333",
})
const METADATA_HASH = `0x${await sha256Hex(METADATA_BODY)}`

const effect: StoryRegistrationEffect = {
  operationId: "sro_receipt",
  registrationKind: "original",
  chainId: 1315,
  signerAddress: SIGNER,
  creatorWalletAddress: "0x3333333333333333333333333333333333333333",
  primaryContentHash: `0x${"44".repeat(32)}`,
  callDataHash: `0x${"55".repeat(32)}`,
  durableRequestJson: JSON.stringify({ version: 1 }),
  status: "reconciliation_required",
  providerTxRef: TX_HASH,
  errorCode: "story_registration_post_broadcast_error",
  resultJson: null,
  attemptCount: 1,
}

const result: StoryRoyaltyRegistrationResult = {
  storyIpId: IP_ID,
  storyIpNftContract: SPG,
  storyIpNftTokenId: "42",
  storyIpMetadataUri: "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3gq",
  storyIpMetadataHash: METADATA_HASH,
  storyNftMetadataUri: "ipfs://nft-metadata",
  storyNftMetadataHash: `0x${"77".repeat(32)}`,
  ipRoyaltyVault: "0x4444444444444444444444444444444444444444",
  storyLicenseTermsId: "1",
  storyLicenseTemplate: null,
  storyRoyaltyPolicy: resolveStoryRoyaltyPolicyAddress({}),
  storyDerivativeParentIpIds: null,
  storyRevenueToken: WIP_TOKEN_ADDRESS,
  storyRoyaltyRegistrationStatus: "registered",
  storyDerivativeRegisteredAt: null,
  royaltyDistributionTxHash: TX_HASH,
}

function registrationLog() {
  return {
    address: REGISTRY,
    topics: encodeEventTopics({
      abi: IP_REGISTERED_ABI,
      eventName: "IPRegistered",
      args: { chainId: 1315n, tokenContract: SPG, tokenId: 42n },
    }) as readonly Hex[],
    data: encodeAbiParameters(
      parseAbiParameters("address, string, string, uint256"),
      [IP_ID, "Pirate song", "ipfs://nft-metadata", 1_700_000_000n],
    ),
  }
}

function recoveryLogs() {
  return [
    {
      address: METADATA_MODULE,
      topics: encodeEventTopics({
        abi: RECOVERY_ABI,
        eventName: "MetadataURISet",
        args: { ipId: IP_ID },
      }) as readonly Hex[],
      data: encodeAbiParameters(
        parseAbiParameters("string, bytes32"),
        [result.storyIpMetadataUri, result.storyIpMetadataHash as Hex],
      ),
    },
    {
      address: METADATA_MODULE,
      topics: encodeEventTopics({
        abi: RECOVERY_ABI,
        eventName: "NFTTokenURISet",
        args: { ipId: IP_ID },
      }) as readonly Hex[],
      data: encodeAbiParameters(
        parseAbiParameters("string, bytes32"),
        [result.storyNftMetadataUri, result.storyNftMetadataHash as Hex],
      ),
    },
    {
      address: LICENSING_MODULE,
      topics: encodeEventTopics({
        abi: RECOVERY_ABI,
        eventName: "LicenseTermsAttached",
        args: { caller: SIGNER, ipId: IP_ID },
      }) as readonly Hex[],
      data: encodeAbiParameters(
        parseAbiParameters("address, uint256"),
        ["0x8888888888888888888888888888888888888888", 1n],
      ),
    },
    {
      address: ROYALTY_MODULE,
      topics: encodeEventTopics({
        abi: RECOVERY_ABI,
        eventName: "IpRoyaltyVaultDeployed",
      }) as readonly Hex[],
      data: encodeAbiParameters(
        parseAbiParameters("address, address"),
        [IP_ID, result.ipRoyaltyVault as Address],
      ),
    },
  ]
}

function receiptClient(overrides: {
  chainId?: number
  from?: Address
  status?: "success" | "reverted"
  logs?: ReturnType<typeof registrationLog>[]
  latestBlockNumber?: bigint
  canonicalBlockHash?: Hash
} = {}): StoryRegistrationReceiptClient {
  return {
    getChainId: async () => overrides.chainId ?? 1315,
    getBlockNumber: async () => overrides.latestBlockNumber ?? 127n,
    getBlock: async () => ({ hash: overrides.canonicalBlockHash ?? BLOCK_HASH }),
    getTransaction: async () => ({ from: overrides.from ?? SIGNER }),
    getTransactionReceipt: async () => ({
      blockHash: BLOCK_HASH,
      blockNumber: 123n,
      logs: overrides.logs ?? [registrationLog(), ...recoveryLogs()],
      status: overrides.status ?? "success",
      transactionHash: TX_HASH,
    }),
  }
}

const env = { STORY_ROYALTY_SPG_NFT_CONTRACT: SPG } as Env

describe("Story registration effect receipt resolution", () => {
  test("accepts only a successful canonical registration matching the journal result", async () => {
    await expect(verifyStoryRegistrationReceipt({
      env,
      effect,
      communityId: "cmt_effect",
      assetId: "ast_effect",
      providerTxRef: TX_HASH,
      result,
      client: receiptClient(),
      fetchImpl: async () => new Response(METADATA_BODY, { headers: { "content-type": "application/json" } }),
    })).resolves.toEqual({
      blockHash: BLOCK_HASH,
      blockNumber: "123",
      providerTxRef: TX_HASH,
      storyIpId: IP_ID,
      storyIpNftContract: SPG,
      storyIpNftTokenId: "42",
    })
  })

  test("fails closed for signer, chain, receipt, event, and result mismatches", async () => {
    await expect(verifyStoryRegistrationReceipt({
      env, effect, communityId: "cmt_effect", assetId: "ast_effect", providerTxRef: TX_HASH, result,
      client: receiptClient({ from: "0x7777777777777777777777777777777777777777" }),
    })).rejects.toMatchObject({ code: "story_signer_mismatch" })
    await expect(verifyStoryRegistrationReceipt({
      env, effect, communityId: "cmt_effect", assetId: "ast_effect", providerTxRef: TX_HASH, result,
      client: receiptClient({ chainId: 1514 }),
    })).rejects.toMatchObject({ code: "story_chain_mismatch" })
    await expect(verifyStoryRegistrationReceipt({
      env, effect, communityId: "cmt_effect", assetId: "ast_effect", providerTxRef: TX_HASH, result,
      client: receiptClient({ status: "reverted" }),
    })).rejects.toMatchObject({ code: "story_receipt_not_successful" })
    await expect(verifyStoryRegistrationReceipt({
      env, effect, communityId: "cmt_effect", assetId: "ast_effect", providerTxRef: TX_HASH, result,
      client: receiptClient({ logs: [] }),
    })).rejects.toMatchObject({ code: "story_ip_registration_event_mismatch" })
    await expect(verifyStoryRegistrationReceipt({
      env, effect, communityId: "cmt_effect", assetId: "ast_effect", providerTxRef: TX_HASH,
      result: { ...result, storyIpNftTokenId: "43" },
      client: receiptClient(),
    })).rejects.toMatchObject({ code: "story_ip_registration_result_mismatch" })
  })

  test("requires canonical finality and metadata bound to the journal asset", async () => {
    await expect(verifyStoryRegistrationReceipt({
      env, effect, communityId: "cmt_effect", assetId: "ast_effect", providerTxRef: TX_HASH, result,
      client: receiptClient({ latestBlockNumber: 126n }),
      fetchImpl: async () => new Response(METADATA_BODY),
    })).rejects.toMatchObject({ code: "story_receipt_not_final" })
    await expect(verifyStoryRegistrationReceipt({
      env, effect, communityId: "cmt_effect", assetId: "ast_effect", providerTxRef: TX_HASH, result,
      client: receiptClient({ canonicalBlockHash: `0x${"ee".repeat(32)}` }),
      fetchImpl: async () => new Response(METADATA_BODY),
    })).rejects.toMatchObject({ code: "story_receipt_reorged" })
    await expect(verifyStoryRegistrationReceipt({
      env, effect, communityId: "cmt_other", assetId: "ast_effect", providerTxRef: TX_HASH, result,
      client: receiptClient(),
      fetchImpl: async () => new Response(METADATA_BODY),
    })).rejects.toMatchObject({ code: "story_metadata_identity_mismatch" })
  })

  test("separately proves a reverted receipt is safe to retry", async () => {
    await expect(verifyStoryRegistrationRevertedReceipt({
      env,
      effect,
      providerTxRef: TX_HASH,
      client: receiptClient({ status: "reverted", logs: [] }),
    })).resolves.toEqual({
      blockHash: BLOCK_HASH,
      blockNumber: "123",
      providerTxRef: TX_HASH,
      outcome: "reverted",
    })
    await expect(verifyStoryRegistrationRevertedReceipt({
      env,
      effect,
      providerTxRef: TX_HASH,
      client: receiptClient(),
    })).rejects.toMatchObject({ code: "story_receipt_not_reverted" })
  })

  test("validates original and derivative result shapes before any RPC read", () => {
    expect(parseStoryRegistrationResolutionResult(result, "original")).toEqual(result)
    expect(() => parseStoryRegistrationResolutionResult({
      ...result,
      storyDerivativeParentIpIds: [IP_ID],
      storyDerivativeRegisteredAt: "2026-07-16T10:00:00.000Z",
    }, "original")).toThrow("original recovery cannot contain derivative fields")
    expect(() => parseStoryRegistrationResolutionResult(result, "derivative"))
      .toThrow("derivative recovery requires parents and registration time")
  })
})
