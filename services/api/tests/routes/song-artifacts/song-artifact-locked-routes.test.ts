import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import app from "../../../src/index"
import { createRouteTestContext, json, resetRuntimeCaches } from "../../helpers"
import { setStoryAccessProofSignerForTests } from "../../../src/lib/story/story-access-proof-service"
import { setStoryAssetPublisherForTests } from "../../../src/lib/story/story-publish-service"
import { setStoryRoyaltyRegistrarForTests } from "../../../src/lib/story/story-royalty-registration-service"
import { setStoryRoyaltyPurchaseSettlementExecutorForTests } from "../../../src/lib/story/story-royalty-settlement-service"
import { setStoryCdrUploaderForTests } from "../../../src/lib/story/story-cdr"
import { setStoryRuntimeFundingAssertionForTests } from "../../../src/lib/story/story-runtime-funding"
import { setStoryPurchaseSettlementExecutorForTests } from "../../../src/lib/story/story-settlement-service"
import { setCommunityCommerceBuyerFundingVerifierForTests } from "../../../src/lib/communities/commerce/funding-proof-service"
import { updateSongArtifactBundlePreview } from "../../../src/lib/song-artifacts/song-artifact-bundle-repository"
import { getControlPlaneClient } from "../../../src/lib/runtime-deps"
import type { Env } from "../../../src/types"
import {
  completeUniqueHumanVerification,
  exchangeJwt,
  requestJson,
} from "./song-artifact-test-helpers"
import {
  attachPrimaryWallet,
  createOpenSongCommunity,
  installLockedSongFetchMocks,
  uploadSongArtifact,
} from "./song-artifact-locked-test-helpers"
import { setCommunityCommerceCharityPayoutExecutorForTests } from "../../../src/lib/communities/commerce/charity-payout-service"

let cleanup: (() => Promise<void>) | null = null
let originalFetch: typeof fetch

const routedCheckoutQuoteFields = {
  funding_asset: {
    asset_symbol: "USDC",
    chain_namespace: "eip155",
    chain_id: 84532,
    display_name: "USDC on Base Sepolia",
  },
  source_chain: {
    chain_namespace: "eip155",
    chain_id: 84532,
    display_name: "Base Sepolia",
  },
  route_provider: "pirate_checkout",
  client_estimated_slippage_bps: 0,
  client_estimated_hop_count: 1,
}

async function markGeneratedPreviewReady(input: {
  env: Env
  communityId: string
  songArtifactBundleId: string
  previewStorageRef: string
  previewSizeBytes: number
}): Promise<void> {
  await updateSongArtifactBundlePreview({
    client: getControlPlaneClient(input.env),
    communityId: input.communityId,
    songArtifactBundleId: input.songArtifactBundleId,
    previewAudio: {
      storage_ref: input.previewStorageRef,
      mime_type: "audio/mpeg",
      size_bytes: input.previewSizeBytes,
      content_hash: null,
      duration_ms: 30_000,
    },
    previewStatus: "completed",
    previewError: null,
    updatedAt: new Date().toISOString(),
  })
}

beforeEach(() => {
  resetRuntimeCaches()
  originalFetch = globalThis.fetch
  setCommunityCommerceBuyerFundingVerifierForTests(async (input) => ({
    txRef: input.fundingTxRef,
    fromAddress: input.buyerAddress,
    toAddress: input.quote.funding_destination_address ?? "0x5000000000000000000000000000000000000005",
    tokenAddress: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
    amountAtomic: String(BigInt(Math.round(input.quote.final_price_usd * 1_000_000))),
    chainRef: "eip155:84532",
  }))
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  if (cleanup) {
    await cleanup()
    cleanup = null
  }
})

describe("song artifact locked routes", () => {
  test("publishes a locked song, sells access, and decrypts the purchased asset", async () => {
    const storedObjects = new Map<string, { body: Uint8Array; contentType: string }>()
    const storySettlementCalls: Array<{
      purchaseRef: string
      buyerAddress: string
      entitlementTokenId: string
      payoutRecipient: string
      amountWei: string
    }> = []
    const royaltySettlementCalls: Array<{
      purchaseRef: string
      buyerAddress: string
      receiverIpId: string
      entitlementTokenId: string | null
      amount: string
    }> = []
    const charityPayoutCalls: Array<{
      idempotencyKey: string
      donationPartnerId: string
      payoutDestinationRef: string
      amountUsd: number
      amountAtomic: string
      settlementToken: string
    }> = []
    let writeAccessAuxData: `0x${string}` | null = null
    setStoryRuntimeFundingAssertionForTests(async () => {})
    setStoryPurchaseSettlementExecutorForTests(async (input) => {
      storySettlementCalls.push({
        purchaseRef: input.purchaseRef,
        buyerAddress: input.buyerAddress,
        entitlementTokenId: String(input.entitlementTokenId),
        payoutRecipient: input.payoutRecipient,
        amountWei: String(input.amountWei),
      })
      return {
        settlementTxHash: "0xstorysettlementpaid0001",
      }
    })
    setStoryRoyaltyRegistrarForTests(async (input) => {
      expect(input.rightsBasis).toBe("original")
      return {
        storyIpId: "0x1010101010101010101010101010101010101010",
        storyIpNftContract: "0x2020202020202020202020202020202020202020",
        storyIpNftTokenId: "42",
        storyLicenseTermsId: "4",
        storyLicenseTemplate: null,
        storyRoyaltyPolicy: "0xBe54FB168b3c982b7AaE60dB6CF75Bd8447b390E",
        storyDerivativeParentIpIds: null,
        storyRevenueToken: "0x1514000000000000000000000000000000000000",
        storyRoyaltyRegistrationStatus: "registered",
        storyDerivativeRegisteredAt: null,
      }
    })
    setStoryRoyaltyPurchaseSettlementExecutorForTests(async (input) => {
      royaltySettlementCalls.push({
        purchaseRef: input.purchaseRef,
        buyerAddress: input.buyerAddress,
        receiverIpId: input.receiverIpId,
        entitlementTokenId: input.entitlementTokenId == null ? null : String(input.entitlementTokenId),
        amount: String(input.amount),
      })
      return {
        royaltyTxHash: "0xroyalty-paid-song",
        entitlementTxHash: "0xentitlement-paid-song",
        settlementTxHash: "0xroyalty-paid-song",
      }
    })
    setCommunityCommerceCharityPayoutExecutorForTests(async (input) => {
      charityPayoutCalls.push({
        idempotencyKey: input.idempotencyKey,
        donationPartnerId: input.donationPartnerId,
        payoutDestinationRef: input.payoutDestinationRef,
        amountUsd: input.amountUsd,
        amountAtomic: input.amountAtomic,
        settlementToken: input.settlementToken,
      })
      return {
        settlementRef: "endaoment:settlement:donation-0001",
        providerReceiptRef: "endaoment:receipt:donation-0001",
        taxReceiptRef: "endaoment:tax:donation-0001",
      }
    })
    setStoryCdrUploaderForTests(async (input) => {
      writeAccessAuxData = input.buildAccessAuxData
        ? await input.buildAccessAuxData(4242)
        : (input.accessAuxData ?? null)
      return {
        cdrVaultUuid: 4242,
        writerAddress: "0x0000000000000000000000000000000000000cd1",
        txHashes: {
          allocate: "0xalloc",
          write: "0xwrite",
        },
      }
    })
    setStoryAssetPublisherForTests(async () => ({
      entitlementConfiguredTxHash: "0xconfigure",
      publishTxHash: "0xpublish",
    }))
    setStoryAccessProofSignerForTests(async (input) => ({
      digest: "0xd1e57",
      signature: `0x${"11".repeat(65)}` as `0x${string}`,
      signerAddress: "0x0000000000000000000000000000000000000acc",
      proof: {
        vaultUuid: input.vaultUuid,
        caller: input.callerAddress,
        accessRef: input.accessRef,
        scope: input.scope === "asset.owner"
          ? "0xb8c1a2b531e7c9d996686b1cc6dcd49d2d7037be365b6d380ebaf489440d4f18"
          : "0x2e3cf0f4f202b4d5d9581a50ca154fd30d982d3e5b85f49252f774117e2a1f7c",
        expiry: input.expiry,
        namespace: input.namespace,
      },
    }))

    installLockedSongFetchMocks({
      originalFetch,
      storedObjects,
    })

    const ctx = await createRouteTestContext({
      FILEBASE_S3_ACCESS_KEY: "test-filebase-access",
      FILEBASE_S3_SECRET_KEY: "test-filebase-secret",
      FILEBASE_S3_ENDPOINT: "https://s3.filebase.test",
      FILEBASE_S3_BUCKET_MUSIC: "pirate-song-media",
      OPENROUTER_API_KEY: "test-openrouter-key",
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      OPENROUTER_MODEL: "google/gemini-3.1-flash-lite-preview",
      ACRCLOUD_ACCESS_KEY: "test-acrcloud-access",
      ACRCLOUD_ACCESS_SECRET: "test-acrcloud-secret",
      ACRCLOUD_HOST: "acrcloud.test",
      ELEVENLABS_API_KEY: "test-elevenlabs-key",
      ELEVENLABS_FORCE_ALIGNMENT_URL: "https://elevenlabs.test/forced-alignment",
      STORY_CONTRACT_OWNER_PRIVATE_KEY: "0x1000000000000000000000000000000000000000000000000000000000000001",
      STORY_OPERATOR_PRIVATE_KEY: "0x2000000000000000000000000000000000000000000000000000000000000002",
      STORY_CDR_WRITER_PRIVATE_KEY: "0x3000000000000000000000000000000000000000000000000000000000000003",
      STORY_ACCESS_CONTROLLER_PRIVATE_KEY: "0x4000000000000000000000000000000000000000000000000000000000000004",
      MUSIC_PURCHASE_STORY_SETTLEMENT_PRIVATE_KEY: "0x5000000000000000000000000000000000000000000000000000000000000005",
      IPFS_GATEWAY_URL: "https://ipfs.test/ipfs",
    })
    cleanup = ctx.cleanup

    const author = await exchangeJwt(ctx.env, "song-author-locked")
    const buyer = await exchangeJwt(ctx.env, "song-buyer-locked")
    await attachPrimaryWallet({
      client: ctx.client,
      userId: author.userId,
      walletAttachmentId: "wal_song_author_locked",
      walletAddress: "0xaaa0000000000000000000000000000000000000",
    })
    await attachPrimaryWallet({
      client: ctx.client,
      userId: buyer.userId,
      walletAttachmentId: "wal_song_buyer_locked",
      walletAddress: "0xbbb0000000000000000000000000000000000000",
    })
    await completeUniqueHumanVerification(ctx.env, author.accessToken)
    await completeUniqueHumanVerification(ctx.env, buyer.accessToken)

    const communityId = await createOpenSongCommunity(ctx.env, author.accessToken, "Paid Song Club")
    const donationPolicyUpdate = await app.request(
      `http://pirate.test/communities/${communityId}/donation-policy`,
      {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${author.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          donation_policy_mode: "optional_creator_sidecar",
          donation_partner_id: "don_charity_water",
          donation_partner: {
            donation_partner_id: "don_charity_water",
            display_name: "charity: water",
            provider: "endaoment",
            provider_partner_ref: "charity-water",
            image_url: "https://images.test/charity-water.png",
          },
        }),
      },
      ctx.env,
    )
    expect(donationPolicyUpdate.status).toBe(200)

    const joinBuyer = await requestJson(
      `http://pirate.test/communities/${communityId}/join`,
      {},
      ctx.env,
      buyer.accessToken,
    )
    expect(joinBuyer.status).toBe(200)

    const primaryBytes = new Uint8Array([21, 22, 23, 24, 25, 26, 27, 28])
    const previewBytes = new Uint8Array([1, 2, 3, 4])

    const primaryUploadIntentBody = await uploadSongArtifact({
      env: ctx.env,
      communityId,
      accessToken: author.accessToken,
      artifactKind: "primary_audio",
      mimeType: "audio/mpeg",
      filename: "paid-anthem.mp3",
      bytes: primaryBytes,
    })

    const previewStorageRef = `http://pirate.test/generated-preview/${communityId}/paid-anthem.mp3`

    const bundleCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/song-artifacts`,
      {
        primary_audio: {
          song_artifact_upload_id: primaryUploadIntentBody.song_artifact_upload_id,
        },
        preview_window: {
          start_ms: 0,
          duration_ms: 30_000,
        },
        lyrics: "Paid line",
      },
      ctx.env,
      author.accessToken,
    )
    expect(bundleCreate.status).toBe(201)
    const bundleBody = await json(bundleCreate) as {
      song_artifact_bundle_id: string
    }
    await markGeneratedPreviewReady({
      env: ctx.env,
      communityId,
      songArtifactBundleId: bundleBody.song_artifact_bundle_id,
      previewStorageRef,
      previewSizeBytes: previewBytes.byteLength,
    })

    const lockedPostCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/posts`,
      {
        idempotency_key: "song-post-locked-1",
        post_type: "song",
        identity_mode: "public",
        title: "Paid anthem",
        access_mode: "locked",
        song_mode: "original",
        rights_basis: "original",
        song_artifact_bundle_id: bundleBody.song_artifact_bundle_id,
      },
      ctx.env,
      author.accessToken,
    )
    expect(lockedPostCreate.status).toBe(201)
    expect(writeAccessAuxData).toBe("0x")
    const lockedPostBody = await json(lockedPostCreate) as {
      asset_id?: string | null
      access_mode?: string | null
      media_refs?: Array<{ storage_ref: string }>
    }
    expect(lockedPostBody.access_mode).toBe("locked")
    expect(typeof lockedPostBody.asset_id === "string" && lockedPostBody.asset_id.length > 0).toBe(true)
    expect(lockedPostBody.media_refs?.[0]?.storage_ref).toBe(previewStorageRef)

    const assetId = lockedPostBody.asset_id as string

    const authorAssetRead = await app.request(
      `http://pirate.test/communities/${communityId}/assets/${assetId}`,
      {
        headers: {
          authorization: `Bearer ${author.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(authorAssetRead.status).toBe(200)
    const authorAssetBody = await json(authorAssetRead) as {
      asset_id: string
      access_mode: string
      locked_delivery_status: string
      primary_content_ref: string
      story_ip_id: string | null
      story_royalty_registration_status: string | null
    }
    expect(authorAssetBody.asset_id).toBe(assetId)
    expect(authorAssetBody.access_mode).toBe("locked")
    expect(authorAssetBody.locked_delivery_status).toBe("ready")
    expect(authorAssetBody.primary_content_ref).toBe(primaryUploadIntentBody.storage_ref)
    expect(authorAssetBody.story_ip_id).toBe("0x1010101010101010101010101010101010101010")
    expect(authorAssetBody.story_royalty_registration_status).toBe("registered")

    const buyerAssetRead = await app.request(
      `http://pirate.test/communities/${communityId}/assets/${assetId}`,
      {
        headers: {
          authorization: `Bearer ${buyer.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(buyerAssetRead.status).toBe(200)
    const buyerAssetBody = await json(buyerAssetRead) as {
      primary_content_ref: string
    }
    expect(buyerAssetBody.primary_content_ref).toBe(`locked:${assetId}`)

    const buyerAccessBeforePurchase = await app.request(
      `http://pirate.test/communities/${communityId}/assets/${assetId}/access`,
      {
        headers: {
          authorization: `Bearer ${buyer.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(buyerAccessBeforePurchase.status).toBe(200)
    const buyerAccessBeforePurchaseBody = await json(buyerAccessBeforePurchase) as {
      access_granted: boolean
      decision_reason: string
    }
    expect(buyerAccessBeforePurchaseBody.access_granted).toBe(false)
    expect(buyerAccessBeforePurchaseBody.decision_reason).toBe("purchase_required")

    const buyerCiphertextBeforePurchase = await app.request(
      `http://pirate.test/communities/${communityId}/assets/${assetId}/content`,
      {
        headers: {
          authorization: `Bearer ${buyer.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(buyerCiphertextBeforePurchase.status).toBe(200)
    expect(buyerCiphertextBeforePurchase.headers.get("content-type")).toBe("application/octet-stream")
    const ciphertextBeforePurchase = new Uint8Array(await buyerCiphertextBeforePurchase.arrayBuffer())
    expect(ciphertextBeforePurchase).not.toEqual(primaryBytes)

    const listingCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/listings`,
      {
        asset_id: assetId,
        price_usd: 4.99,
        regional_pricing_enabled: false,
        donation_partner_id: "don_charity_water",
        donation_share_pct: 10,
        status: "active",
      },
      ctx.env,
      author.accessToken,
    )
    expect(listingCreate.status).toBe(201)
    const listingBody = await json(listingCreate) as {
      listing_id: string
      donation_partner_id: string | null
      donation_share_pct: number | null
    }
    expect(listingBody.donation_partner_id).toBe("don_charity_water")
    expect(listingBody.donation_share_pct).toBe(10)

    const quoteCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/purchase-quotes`,
      {
        listing_id: listingBody.listing_id,
        ...routedCheckoutQuoteFields,
      },
      ctx.env,
      buyer.accessToken,
    )
    expect(quoteCreate.status).toBe(201)
    const quoteBody = await json(quoteCreate) as {
      quote_id: string
      final_price_usd: number
      settlement_mode: string
      allocation_snapshot: Array<{
        recipient_type: string
        recipient_ref: string | null
        share_bps: number
        amount_usd: number
        settlement_strategy: string
      }>
    }
    expect(quoteBody.final_price_usd).toBe(4.99)
    expect(quoteBody.settlement_mode).toBe("royalty_native_story_payment")
    expect(quoteBody.allocation_snapshot).toEqual([
      {
        recipient_type: "charity",
        recipient_ref: "don_charity_water",
        waterfall_position: 60,
        share_bps: 1000,
        amount_usd: 0.5,
        settlement_strategy: "provider_payout",
      },
      {
        recipient_type: "creator",
        recipient_ref: null,
        waterfall_position: 70,
        share_bps: 9000,
        amount_usd: 4.49,
        settlement_strategy: "story_payout",
      },
    ])
    const settlementWalletAttachmentId = "wal_song_buyer_locked"

    const purchaseSettle = await requestJson(
      `http://pirate.test/communities/${communityId}/purchase-settlements`,
      {
        quote_id: quoteBody.quote_id,
        settlement_wallet_attachment_id: settlementWalletAttachmentId,
        funding_tx_ref: "0xfunding-paid-song-1",
        settlement_tx_ref: "tx-paid-song-1",
      },
      ctx.env,
      buyer.accessToken,
    )
    expect(purchaseSettle.status).toBe(201)
    const purchaseBody = await json(purchaseSettle) as {
      purchase_id: string
      entitlement_kind: string
      entitlement_target_ref: string
      settlement_mode: string
      settlement_tx_ref: string
      allocations: Array<{
        recipient_type: string
        status: string
        settlement_ref: string | null
      }>
      donation_partner_id: string | null
      donation_share_pct: number | null
      donation_amount_usd: number | null
    }
    expect(purchaseBody.entitlement_kind).toBe("asset_access")
    expect(purchaseBody.entitlement_target_ref).toBe(assetId)
    expect(purchaseBody.settlement_mode).toBe("royalty_native_story_payment")
    expect(purchaseBody.settlement_tx_ref).toBe("0xroyalty-paid-song")
    expect(purchaseBody.allocations).toEqual([
      {
        amount_usd: 0.5,
        failure_reason: null,
        recipient_ref: "don_charity_water",
        recipient_type: "charity",
        status: "confirmed",
        settlement_ref: "endaoment:settlement:donation-0001",
        settlement_strategy: "provider_payout",
        share_bps: 1000,
        waterfall_position: 60,
      },
      {
        amount_usd: 4.49,
        failure_reason: null,
        recipient_ref: null,
        recipient_type: "creator",
        status: "confirmed",
        settlement_ref: "0xroyalty-paid-song",
        settlement_strategy: "story_payout",
        share_bps: 9000,
        waterfall_position: 70,
      },
    ])
    expect(purchaseBody.donation_partner_id).toBe("don_charity_water")
    expect(purchaseBody.donation_share_pct).toBe(10)
    expect(purchaseBody.donation_amount_usd).toBe(0.5)
    expect(charityPayoutCalls).toHaveLength(1)
    expect(charityPayoutCalls[0]?.donationPartnerId).toBe("don_charity_water")
    expect(charityPayoutCalls[0]?.payoutDestinationRef).toBe("charity-water")
    expect(charityPayoutCalls[0]?.amountUsd).toBe(0.5)
    expect(charityPayoutCalls[0]?.amountAtomic).toBe("500000000000000000")
    expect(charityPayoutCalls[0]?.settlementToken).toBe("WIP")
    expect(charityPayoutCalls[0]?.idempotencyKey).toContain(`${quoteBody.quote_id}:charity:don_charity_water:60`)
    expect(storySettlementCalls).toHaveLength(0)
    expect(royaltySettlementCalls).toHaveLength(1)
    expect({
      amount: royaltySettlementCalls[0]?.amount,
      buyerAddress: royaltySettlementCalls[0]?.buyerAddress,
      receiverIpId: royaltySettlementCalls[0]?.receiverIpId,
    }).toEqual({
      amount: "4490000000000000000",
      buyerAddress: "0xbbb0000000000000000000000000000000000000",
      receiverIpId: "0x1010101010101010101010101010101010101010",
    })
    expect(royaltySettlementCalls[0]?.purchaseRef).toMatch(/^0x[0-9a-f]{64}$/)
    expect(BigInt(royaltySettlementCalls[0]?.entitlementTokenId ?? "0") > 0n).toBe(true)

    const purchaseRecord = await app.request(
      `http://pirate.test/communities/${communityId}/purchases/${purchaseBody.purchase_id}`,
      {
        headers: {
          authorization: `Bearer ${buyer.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(purchaseRecord.status).toBe(200)
    const purchaseRecordBody = await json(purchaseRecord) as {
      allocations: Array<{
        recipient_type: string
        status: string
        settlement_ref: string | null
      }>
      donation_partner_id: string | null
      donation_share_pct: number | null
      donation_amount_usd: number | null
    }
    expect(purchaseRecordBody.allocations).toEqual([
      {
        amount_usd: 0.5,
        failure_reason: null,
        recipient_ref: "don_charity_water",
        recipient_type: "charity",
        status: "confirmed",
        settlement_ref: "endaoment:settlement:donation-0001",
        settlement_strategy: "provider_payout",
        share_bps: 1000,
        waterfall_position: 60,
      },
      {
        amount_usd: 4.49,
        failure_reason: null,
        recipient_ref: null,
        recipient_type: "creator",
        status: "confirmed",
        settlement_ref: "0xroyalty-paid-song",
        settlement_strategy: "story_payout",
        share_bps: 9000,
        waterfall_position: 70,
      },
    ])
    expect(purchaseRecordBody.donation_partner_id).toBe("don_charity_water")
    expect(purchaseRecordBody.donation_share_pct).toBe(10)
    expect(purchaseRecordBody.donation_amount_usd).toBe(0.5)

    const buyerAccessAfterPurchase = await app.request(
      `http://pirate.test/communities/${communityId}/assets/${assetId}/access`,
      {
        headers: {
          authorization: `Bearer ${buyer.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(buyerAccessAfterPurchase.status).toBe(200)
    const buyerAccessAfterPurchaseBody = await json(buyerAccessAfterPurchase) as {
      access_granted: boolean
      decision_reason: string
      delivery_kind: string | null
      story_cdr_access?: {
        ciphertext_ref: string
        vault_uuid: number
        access_scope: string
        read_condition_address: string
        access_aux_data_hex: string
      } | null
    }
    expect(buyerAccessAfterPurchaseBody.access_granted).toBe(true)
    expect(buyerAccessAfterPurchaseBody.decision_reason).toBe("purchase_entitlement")
    expect(buyerAccessAfterPurchaseBody.delivery_kind).toBe("story_cdr_ref")
    expect(buyerAccessAfterPurchaseBody.story_cdr_access?.ciphertext_ref).toBe(
      `/communities/${communityId}/assets/${assetId}/content`,
    )
    expect(buyerAccessAfterPurchaseBody.story_cdr_access?.vault_uuid).toBe(4242)
    expect(buyerAccessAfterPurchaseBody.story_cdr_access?.access_scope).toBe("asset.share")
    expect(buyerAccessAfterPurchaseBody.story_cdr_access?.read_condition_address).toBe(
      "0x29a859d9012ffc73443af5e3264c1605d44f6bcc",
    )
    expect(buyerAccessAfterPurchaseBody.story_cdr_access?.access_aux_data_hex).toBe("0x")

    const buyerCiphertextAfterPurchase = await app.request(
      `http://pirate.test/communities/${communityId}/assets/${assetId}/content`,
      {
        headers: {
          authorization: `Bearer ${buyer.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(buyerCiphertextAfterPurchase.status).toBe(200)
    expect(buyerCiphertextAfterPurchase.headers.get("content-type")).toBe("application/octet-stream")
    expect(new Uint8Array(await buyerCiphertextAfterPurchase.arrayBuffer())).toEqual(ciphertextBeforePurchase)
  })



  test("rejects activating commerce for an asset before Story royalty registration is ready", async () => {
    const storedObjects = new Map<string, { body: Uint8Array; contentType: string }>()

    installLockedSongFetchMocks({
      originalFetch,
      storedObjects,
    })

    const ctx = await createRouteTestContext({
      FILEBASE_S3_ACCESS_KEY: "test-filebase-access",
      FILEBASE_S3_SECRET_KEY: "test-filebase-secret",
      FILEBASE_S3_ENDPOINT: "https://s3.filebase.test",
      FILEBASE_S3_BUCKET_MUSIC: "pirate-song-media",
      OPENROUTER_API_KEY: "test-openrouter-key",
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      OPENROUTER_MODEL: "google/gemini-3.1-flash-lite-preview",
      ACRCLOUD_ACCESS_KEY: "test-acrcloud-access",
      ACRCLOUD_ACCESS_SECRET: "test-acrcloud-secret",
      ACRCLOUD_HOST: "acrcloud.test",
      ELEVENLABS_API_KEY: "test-elevenlabs-key",
      ELEVENLABS_FORCE_ALIGNMENT_URL: "https://elevenlabs.test/forced-alignment",
    })
    cleanup = ctx.cleanup

    const author = await exchangeJwt(ctx.env, "song-author-derivative-commerce")
    await attachPrimaryWallet({
      client: ctx.client,
      userId: author.userId,
      walletAttachmentId: "wal_song_author_derivative",
      walletAddress: "0xaaa0000000000000000000000000000000000000",
    })
    await completeUniqueHumanVerification(ctx.env, author.accessToken)

    const communityId = await createOpenSongCommunity(ctx.env, author.accessToken, "Derivative Commerce Club")

    const primaryBytes = new Uint8Array([31, 32, 33, 34, 35, 36, 37, 38])
    const previewBytes = new Uint8Array([11, 12, 13, 14])

    const primaryUploadIntentBody = await uploadSongArtifact({
      env: ctx.env,
      communityId,
      accessToken: author.accessToken,
      artifactKind: "primary_audio",
      mimeType: "audio/mpeg",
      filename: "derivative-commerce.mp3",
      bytes: primaryBytes,
    })

    const previewStorageRef = `http://pirate.test/generated-preview/${communityId}/derivative-commerce.mp3`

    const bundleCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/song-artifacts`,
      {
        primary_audio: {
          song_artifact_upload_id: primaryUploadIntentBody.song_artifact_upload_id,
        },
        preview_window: {
          start_ms: 0,
          duration_ms: 30_000,
        },
        lyrics: "Derivative line",
      },
      ctx.env,
      author.accessToken,
    )
    expect(bundleCreate.status).toBe(201)
    const bundleBody = await json(bundleCreate) as {
      song_artifact_bundle_id: string
    }
    await markGeneratedPreviewReady({
      env: ctx.env,
      communityId,
      songArtifactBundleId: bundleBody.song_artifact_bundle_id,
      previewStorageRef,
      previewSizeBytes: previewBytes.byteLength,
    })

    const derivativePostCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/posts`,
      {
        idempotency_key: "song-post-derivative-commerce-1",
        post_type: "song",
        identity_mode: "public",
        title: "Derivative commerce song",
        access_mode: "public",
        song_mode: "remix",
        rights_basis: "derivative",
        upstream_asset_refs: ["acr:custom-file:source-track"],
        song_artifact_bundle_id: bundleBody.song_artifact_bundle_id,
      },
      ctx.env,
      author.accessToken,
    )
    expect(derivativePostCreate.status).toBe(201)
    const derivativePostBody = await json(derivativePostCreate) as {
      asset_id?: string | null
    }
    const assetId = derivativePostBody.asset_id as string

    const assetRead = await app.request(
      `http://pirate.test/communities/${communityId}/assets/${assetId}`,
      {
        headers: {
          authorization: `Bearer ${author.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(assetRead.status).toBe(200)
    const assetBody = await json(assetRead) as {
      story_royalty_policy_id: string | null
      story_derivative_parent_ip_ids: string[] | null
      story_royalty_registration_status: string | null
    }
    expect(assetBody.story_royalty_policy_id).toBeNull()
    expect(assetBody.story_derivative_parent_ip_ids).toBeNull()
    expect(assetBody.story_royalty_registration_status).toBe("pending")

    const listingCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/listings`,
      {
        asset_id: assetId,
        price_usd: 4.99,
        regional_pricing_enabled: false,
        status: "active",
      },
      ctx.env,
      author.accessToken,
    )
    expect(listingCreate.status).toBe(400)
    const listingBody = await json(listingCreate) as { message?: string }
    expect(listingBody.message).toBe("Asset is not ready for Story royalty commerce")
  })

  test("allows commerce for a locked derivative asset once Story royalty registration metadata is present", async () => {
    const storedObjects = new Map<string, { body: Uint8Array; contentType: string }>()
    const royaltySettlementCalls: Array<{
      purchaseRef: string
      buyerAddress: string
      receiverIpId: string
      entitlementTokenId: string
      amount: string
    }> = []
    const charityPayoutCalls: Array<{
      idempotencyKey: string
      donationPartnerId: string
      amountUsd: number
      amountAtomic: string
    }> = []
    setStoryRuntimeFundingAssertionForTests(async () => {})
    setStoryCdrUploaderForTests(async () => ({
      cdrVaultUuid: 5150,
      writerAddress: "0x0000000000000000000000000000000000000cd1",
      txHashes: {
        allocate: "0xalloc-derivative",
        write: "0xwrite-derivative",
      },
    }))
    setStoryAssetPublisherForTests(async () => ({
      entitlementConfiguredTxHash: "0xconfigure-derivative",
      publishTxHash: "0xpublish-derivative",
    }))
    setStoryRoyaltyRegistrarForTests(async (input) => {
      expect(input.rightsBasis).toBe("derivative")
      expect(input.upstreamAssetRefs).toEqual(["story:ip:parent-track-1"])
      return {
        storyIpId: "0x1111111111111111111111111111111111111111",
        storyIpNftContract: "0x2222222222222222222222222222222222222222",
        storyIpNftTokenId: "77",
        storyLicenseTermsId: "5",
        storyLicenseTemplate: null,
        storyRoyaltyPolicy: "0xBe54FB168b3c982b7AaE60dB6CF75Bd8447b390E",
        storyDerivativeParentIpIds: ["0x3333333333333333333333333333333333333333"],
        storyRevenueToken: "0x1514000000000000000000000000000000000000",
        storyRoyaltyRegistrationStatus: "registered",
        storyDerivativeRegisteredAt: "2026-04-21T00:00:00.000Z",
      }
    })
    setStoryRoyaltyPurchaseSettlementExecutorForTests(async (input) => {
      royaltySettlementCalls.push({
        purchaseRef: input.purchaseRef,
        buyerAddress: input.buyerAddress,
        receiverIpId: input.receiverIpId,
        entitlementTokenId: String(input.entitlementTokenId),
        amount: String(input.amount),
      })
      return {
        royaltyTxHash: "0xroyalty-derivative",
        entitlementTxHash: "0xentitlement-derivative",
        settlementTxHash: "0xroyalty-derivative",
      }
    })
    setCommunityCommerceCharityPayoutExecutorForTests(async (input) => {
      charityPayoutCalls.push({
        idempotencyKey: input.idempotencyKey,
        donationPartnerId: input.donationPartnerId,
        amountUsd: input.amountUsd,
        amountAtomic: input.amountAtomic,
      })
      return {
        settlementRef: "endaoment:settlement:derivative-donation-0001",
        providerReceiptRef: "endaoment:receipt:derivative-donation-0001",
        taxReceiptRef: "endaoment:tax:derivative-donation-0001",
      }
    })

    installLockedSongFetchMocks({ originalFetch, storedObjects })

    const ctx = await createRouteTestContext({
      FILEBASE_S3_ACCESS_KEY: "test-filebase-access",
      FILEBASE_S3_SECRET_KEY: "test-filebase-secret",
      FILEBASE_S3_ENDPOINT: "https://s3.filebase.test",
      FILEBASE_S3_BUCKET_MUSIC: "pirate-song-media",
      STORY_CDR_WRITER_PRIVATE_KEY: "0x3000000000000000000000000000000000000000000000000000000000000003",
      STORY_ROYALTY_SPG_NFT_CONTRACT: "0x4444444444444444444444444444444444444444",
      STORY_ROYALTY_COMMERCIAL_REV_SHARE_PCT: "10",
    })
    cleanup = ctx.cleanup

    const author = await exchangeJwt(ctx.env, "song-author-derivative-registered")
    const buyer = await exchangeJwt(ctx.env, "song-buyer-derivative-registered")
    await attachPrimaryWallet({
      client: ctx.client,
      userId: author.userId,
      walletAttachmentId: "wal_song_author_derivative_registered",
      walletAddress: "0xaaa0000000000000000000000000000000000000",
    })
    await attachPrimaryWallet({
      client: ctx.client,
      userId: buyer.userId,
      walletAttachmentId: "wal_song_buyer_derivative_registered",
      walletAddress: "0xbbb0000000000000000000000000000000000000",
    })
    await completeUniqueHumanVerification(ctx.env, author.accessToken)
    await completeUniqueHumanVerification(ctx.env, buyer.accessToken)

    const communityId = await createOpenSongCommunity(ctx.env, author.accessToken, "Derivative Registered Club")

    const donationPolicyUpdate = await app.request(
      `http://pirate.test/communities/${communityId}/donation-policy`,
      {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${author.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          donation_policy_mode: "optional_creator_sidecar",
          donation_partner_id: "don_derivative_charity",
          donation_partner: {
            donation_partner_id: "don_derivative_charity",
            display_name: "Heal Palestine Inc",
            provider: "endaoment",
            provider_partner_ref: "heal-palestine",
            image_url: "https://images.test/heal-palestine.png",
          },
        }),
      },
      ctx.env,
    )
    expect(donationPolicyUpdate.status).toBe(200)

    const joinBuyer = await requestJson(
      `http://pirate.test/communities/${communityId}/join`,
      {},
      ctx.env,
      buyer.accessToken,
    )
    expect(joinBuyer.status).toBe(200)

    const primaryBytes = new Uint8Array([31, 32, 33, 34, 35, 36, 37, 38])
    const previewBytes = new Uint8Array([9, 10, 11, 12])

    const primaryUploadIntentBody = await uploadSongArtifact({
      env: ctx.env,
      communityId,
      accessToken: author.accessToken,
      artifactKind: "primary_audio",
      mimeType: "audio/mpeg",
      filename: "derivative-registered.mp3",
      bytes: primaryBytes,
    })

    const previewStorageRef = `http://pirate.test/generated-preview/${communityId}/derivative-registered.mp3`

    const bundleCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/song-artifacts`,
      {
        primary_audio: {
          song_artifact_upload_id: primaryUploadIntentBody.song_artifact_upload_id,
        },
        preview_window: {
          start_ms: 0,
          duration_ms: 30_000,
        },
        lyrics: "Derivative registered line",
      },
      ctx.env,
      author.accessToken,
    )
    expect(bundleCreate.status).toBe(201)
    const bundleBody = await json(bundleCreate) as {
      song_artifact_bundle_id: string
    }
    await markGeneratedPreviewReady({
      env: ctx.env,
      communityId,
      songArtifactBundleId: bundleBody.song_artifact_bundle_id,
      previewStorageRef,
      previewSizeBytes: previewBytes.byteLength,
    })

    const derivativePostCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/posts`,
      {
        idempotency_key: "song-post-derivative-registered-1",
        post_type: "song",
        identity_mode: "public",
        title: "Derivative registered song",
        access_mode: "locked",
        song_mode: "remix",
        rights_basis: "derivative",
        upstream_asset_refs: ["story:ip:parent-track-1"],
        song_artifact_bundle_id: bundleBody.song_artifact_bundle_id,
      },
      ctx.env,
      author.accessToken,
    )
    expect(derivativePostCreate.status).toBe(201)
    const derivativePostBody = await json(derivativePostCreate) as {
      asset_id?: string | null
    }
    const assetId = derivativePostBody.asset_id as string

    const assetRead = await app.request(
      `http://pirate.test/communities/${communityId}/assets/${assetId}`,
      {
        headers: {
          authorization: `Bearer ${author.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(assetRead.status).toBe(200)
    const assetBody = await json(assetRead) as {
      story_ip_id: string | null
      story_royalty_policy_id: string | null
      story_derivative_parent_ip_ids: string[] | null
      story_royalty_registration_status: string | null
      locked_delivery_status: string | null
    }
    expect(assetBody.story_ip_id).toBe("0x1111111111111111111111111111111111111111")
    expect(assetBody.story_royalty_policy_id).toBe("0xBe54FB168b3c982b7AaE60dB6CF75Bd8447b390E")
    expect(assetBody.story_derivative_parent_ip_ids).toEqual(["0x3333333333333333333333333333333333333333"])
    expect(assetBody.story_royalty_registration_status).toBe("registered")
    expect(assetBody.locked_delivery_status).toBe("ready")

    const listingCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/listings`,
      {
        asset_id: assetId,
        price_usd: 3.99,
        regional_pricing_enabled: false,
        donation_partner_id: "don_derivative_charity",
        donation_share_pct: 10,
        status: "active",
      },
      ctx.env,
      author.accessToken,
    )
    expect(listingCreate.status).toBe(201)
    const listingBody = await json(listingCreate) as {
      listing_id: string
      status: string
    }
    expect(listingBody.status).toBe("active")

    const quoteCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/purchase-quotes`,
      {
        listing_id: listingBody.listing_id,
        ...routedCheckoutQuoteFields,
      },
      ctx.env,
      buyer.accessToken,
    )
    expect(quoteCreate.status).toBe(201)
    const quoteBody = await json(quoteCreate) as {
      quote_id: string
      final_price_usd: number
      settlement_mode: string
      allocation_snapshot: Array<{
        recipient_type: string
        recipient_ref: string | null
        waterfall_position: number
        share_bps: number
        amount_usd: number
        settlement_strategy: string
      }>
    }
    expect(quoteBody.final_price_usd).toBe(3.99)
    expect(quoteBody.settlement_mode).toBe("royalty_native_story_payment")
    expect(quoteBody.allocation_snapshot).toEqual([
      {
        recipient_type: "charity",
        recipient_ref: "don_derivative_charity",
        waterfall_position: 60,
        share_bps: 1000,
        amount_usd: 0.4,
        settlement_strategy: "provider_payout",
      },
      {
        recipient_type: "creator",
        recipient_ref: null,
        waterfall_position: 70,
        share_bps: 9000,
        amount_usd: 3.59,
        settlement_strategy: "story_payout",
      },
    ])

    const purchaseSettle = await requestJson(
      `http://pirate.test/communities/${communityId}/purchase-settlements`,
      {
        quote_id: quoteBody.quote_id,
        settlement_wallet_attachment_id: "wal_song_buyer_derivative_registered",
        funding_tx_ref: "0xfunding-derivative-1",
        settlement_tx_ref: "ignored-client-ref",
      },
      ctx.env,
      buyer.accessToken,
    )
    expect(purchaseSettle.status).toBe(201)
    const purchaseBody = await json(purchaseSettle) as {
      settlement_mode: string
      settlement_tx_ref: string
      allocations: Array<{
        recipient_type: string
        status: string
        settlement_ref: string | null
      }>
    }
    expect(purchaseBody.settlement_mode).toBe("royalty_native_story_payment")
    expect(purchaseBody.settlement_tx_ref).toBe("0xroyalty-derivative")
    expect(purchaseBody.allocations).toEqual([
      {
        amount_usd: 0.4,
        failure_reason: null,
        recipient_ref: "don_derivative_charity",
        recipient_type: "charity",
        settlement_ref: "endaoment:settlement:derivative-donation-0001",
        settlement_strategy: "provider_payout",
        share_bps: 1000,
        status: "confirmed",
        waterfall_position: 60,
      },
      {
        amount_usd: 3.59,
        failure_reason: null,
        recipient_ref: null,
        recipient_type: "creator",
        settlement_ref: "0xroyalty-derivative",
        settlement_strategy: "story_payout",
        share_bps: 9000,
        status: "confirmed",
        waterfall_position: 70,
      },
    ])
    expect(charityPayoutCalls).toHaveLength(1)
    expect(charityPayoutCalls[0]?.donationPartnerId).toBe("don_derivative_charity")
    expect(charityPayoutCalls[0]?.amountUsd).toBe(0.4)
    expect(charityPayoutCalls[0]?.amountAtomic).toBe("400000000000000000")
    expect(charityPayoutCalls[0]?.idempotencyKey).toContain(`${quoteBody.quote_id}:charity:don_derivative_charity:60`)
    expect(royaltySettlementCalls).toHaveLength(1)
    expect(royaltySettlementCalls[0]?.buyerAddress).toBe("0xbbb0000000000000000000000000000000000000")
    expect(royaltySettlementCalls[0]?.receiverIpId).toBe("0x1111111111111111111111111111111111111111")
    expect(royaltySettlementCalls[0]?.amount).toBe("3590000000000000000")
  })


})
