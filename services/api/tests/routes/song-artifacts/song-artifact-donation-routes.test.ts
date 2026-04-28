import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import app from "../../../src/index"
import { createRouteTestContext, json, resetRuntimeCaches } from "../../helpers"
import { setStoryRoyaltyRegistrarForTests } from "../../../src/lib/story/story-royalty-registration-service"
import { setStoryRoyaltyPurchaseSettlementExecutorForTests } from "../../../src/lib/story/story-royalty-settlement-service"
import { setStoryRuntimeFundingAssertionForTests } from "../../../src/lib/story/story-runtime-funding"
import { setStoryPurchaseSettlementExecutorForTests } from "../../../src/lib/story/story-settlement-service"
import { setCommunityCommerceBuyerFundingVerifierForTests } from "../../../src/lib/communities/commerce/funding-proof-service"
import { setCommunityCommerceCharityPayoutExecutorForTests } from "../../../src/lib/communities/commerce/charity-payout-service"
import { openCommunityDb } from "../../../src/lib/communities/community-db-factory"
import type { CommunityDatabaseBindingRepository } from "../../../src/lib/communities/db-community-repository"
import { updateSongArtifactBundlePreview } from "../../../src/lib/song-artifacts/song-artifact-repository"
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

let cleanup: (() => Promise<void>) | null = null
let originalFetch: typeof fetch
const testWithTimeout = test as unknown as (name: string, fn: () => Promise<void>, timeout: number) => void

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

async function verifyForLockedSongCommerce(env: Env, _userId: string, accessToken: string): Promise<void> {
  await completeUniqueHumanVerification(env, accessToken)
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

describe("song artifact donation routes", () => {
  testWithTimeout("rejects purchase quote when community donation policy is none", async () => {
    const storedObjects = new Map<string, { body: Uint8Array; contentType: string }>()
    setStoryRuntimeFundingAssertionForTests(async () => {})
    setStoryPurchaseSettlementExecutorForTests(async () => ({ settlementTxHash: "0xstory" }))
    setStoryRoyaltyRegistrarForTests(async (input) => {
      expect(input.rightsBasis).toBe("original")
      return {
        storyIpId: "0x1414141414141414141414141414141414141414",
        storyIpNftContract: "0x2424242424242424242424242424242424242424",
        storyIpNftTokenId: "44",
        storyLicenseTermsId: "7",
        storyLicenseTemplate: null,
        storyRoyaltyPolicy: "0xBe54FB168b3c982b7AaE60dB6CF75Bd8447b390E",
        storyDerivativeParentIpIds: null,
        storyRevenueToken: "0x1514000000000000000000000000000000000000",
        storyRoyaltyRegistrationStatus: "registered",
        storyDerivativeRegisteredAt: null,
      }
    })

    installLockedSongFetchMocks({ originalFetch, storedObjects })

    const ctx = await createRouteTestContext({
      FILEBASE_S3_ACCESS_KEY: "test-filebase-access",
      FILEBASE_S3_SECRET_KEY: "test-filebase-secret",
      FILEBASE_S3_ENDPOINT: "https://s3.filebase.test",
      FILEBASE_S3_BUCKET_MUSIC: "pirate-song-media",
    })
    cleanup = ctx.cleanup

    const author = await exchangeJwt(ctx.env, "song-author-no-donation")
    const buyer = await exchangeJwt(ctx.env, "song-buyer-no-donation")
    await attachPrimaryWallet({
      client: ctx.client,
      userId: author.userId,
      walletAttachmentId: "wal_author_no_donation",
      walletAddress: "0xaaa0000000000000000000000000000000000000",
    })
    await attachPrimaryWallet({
      client: ctx.client,
      userId: buyer.userId,
      walletAttachmentId: "wal_buyer_no_donation",
      walletAddress: "0xbbb0000000000000000000000000000000000000",
    })
    await verifyForLockedSongCommerce(ctx.env, author.userId, author.accessToken)
    await verifyForLockedSongCommerce(ctx.env, buyer.userId, buyer.accessToken)

    const communityId = await createOpenSongCommunity(ctx.env, author.accessToken, "No Donation Club")

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
      filename: "no-donation.mp3",
      bytes: primaryBytes,
    })

    const previewStorageRef = `http://pirate.test/generated-preview/${communityId}/no-donation.mp3`

    const bundleCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/song-artifacts`,
      {
        primary_audio: { song_artifact_upload_id: primaryUploadIntentBody.song_artifact_upload_id },
        preview_window: { start_ms: 0, duration_ms: 30_000 },
        lyrics: "No donation line",
      },
      ctx.env,
      author.accessToken,
    )
    expect(bundleCreate.status).toBe(201)
    const bundleBody = await json(bundleCreate) as { song_artifact_bundle_id: string }
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
        idempotency_key: "song-post-no-donation-1",
        post_type: "song",
        identity_mode: "public",
        title: "No donation anthem",
        access_mode: "locked",
        song_mode: "original",
        rights_basis: "original",
        license_preset: "non-commercial",
        song_artifact_bundle_id: bundleBody.song_artifact_bundle_id,
      },
      ctx.env,
      author.accessToken,
    )
    expect(lockedPostCreate.status).toBe(201)
    const lockedPostBody = await json(lockedPostCreate) as { asset_id?: string | null }
    const assetId = lockedPostBody.asset_id as string

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
    const listingBody = await json(listingCreate) as { listing_id: string }

    const disableDonation = await app.request(
      `http://pirate.test/communities/${communityId}/donation-policy`,
      {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${author.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          donation_policy_mode: "none",
          donation_partner_id: null,
          donation_partner: null,
        }),
      },
      ctx.env,
    )
    expect(disableDonation.status).toBe(200)

    const quoteCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/purchase-quotes`,
      {
        listing_id: listingBody.listing_id,
        ...routedCheckoutQuoteFields,
      },
      ctx.env,
      buyer.accessToken,
    )
    expect(quoteCreate.status).toBe(403)
    const quoteBody = await json(quoteCreate) as { message?: string }
    expect(quoteBody.message).toBe("Community donation policy does not permit donations")
  }, 15000)

  testWithTimeout("settles public Story royalty assets with charity before net Story payment", async () => {
    const storedObjects = new Map<string, { body: Uint8Array; contentType: string }>()
    const royaltySettlementCalls: Array<{
      receiverIpId: string
      entitlementTokenId: string | null
      amount: string
    }> = []
    const charityPayoutCalls: Array<{
      donationPartnerId: string
      amountUsd: number
      amountAtomic: string
    }> = []

    setStoryRoyaltyRegistrarForTests(async (input) => {
      expect(input.rightsBasis).toBe("original")
      return {
        storyIpId: "0x1212121212121212121212121212121212121212",
        storyIpNftContract: "0x2323232323232323232323232323232323232323",
        storyIpNftTokenId: "88",
        storyLicenseTermsId: "6",
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
        receiverIpId: input.receiverIpId,
        entitlementTokenId: input.entitlementTokenId == null ? null : String(input.entitlementTokenId),
        amount: String(input.amount),
      })
      return {
        royaltyTxHash: "0xroyalty-public",
        entitlementTxHash: null,
        settlementTxHash: "0xroyalty-public",
      }
    })
    setCommunityCommerceCharityPayoutExecutorForTests(async (input) => {
      charityPayoutCalls.push({
        donationPartnerId: input.donationPartnerId,
        amountUsd: input.amountUsd,
        amountAtomic: input.amountAtomic,
      })
      return {
        settlementRef: "endaoment:settlement:public-donation-0001",
        providerReceiptRef: "endaoment:receipt:public-donation-0001",
        taxReceiptRef: "endaoment:tax:public-donation-0001",
      }
    })

    installLockedSongFetchMocks({ originalFetch, storedObjects })

    const ctx = await createRouteTestContext({
      FILEBASE_S3_ACCESS_KEY: "test-filebase-access",
      FILEBASE_S3_SECRET_KEY: "test-filebase-secret",
      FILEBASE_S3_ENDPOINT: "https://s3.filebase.test",
      FILEBASE_S3_BUCKET_MUSIC: "pirate-song-media",
      STORY_ROYALTY_SPG_NFT_CONTRACT: "0x4444444444444444444444444444444444444444",
      STORY_ROYALTY_COMMERCIAL_REV_SHARE_PCT: "10",
    })
    cleanup = ctx.cleanup

    const author = await exchangeJwt(ctx.env, "song-author-public-royalty")
    const buyer = await exchangeJwt(ctx.env, "song-buyer-public-royalty")
    await attachPrimaryWallet({
      client: ctx.client,
      userId: author.userId,
      walletAttachmentId: "wal_song_author_public_royalty",
      walletAddress: "0xaaa0000000000000000000000000000000000000",
    })
    await attachPrimaryWallet({
      client: ctx.client,
      userId: buyer.userId,
      walletAttachmentId: "wal_song_buyer_public_royalty",
      walletAddress: "0xbbb0000000000000000000000000000000000000",
    })
    await verifyForLockedSongCommerce(ctx.env, author.userId, author.accessToken)
    await verifyForLockedSongCommerce(ctx.env, buyer.userId, buyer.accessToken)

    const communityId = await createOpenSongCommunity(ctx.env, author.accessToken, "Public Royalty Club")

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
          donation_partner_id: "don_public_charity",
          donation_partner: {
            donation_partner_id: "don_public_charity",
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

    const primaryUploadIntentBody = await uploadSongArtifact({
      env: ctx.env,
      communityId,
      accessToken: author.accessToken,
      artifactKind: "primary_audio",
      mimeType: "audio/mpeg",
      filename: "public-royalty.mp3",
      bytes: new Uint8Array([41, 42, 43, 44]),
    })
    const previewStorageRef = `http://pirate.test/generated-preview/${communityId}/public-royalty.mp3`
    const bundleCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/song-artifacts`,
      {
        primary_audio: {
          song_artifact_upload_id: primaryUploadIntentBody.song_artifact_upload_id,
        },
        preview_window: { start_ms: 0, duration_ms: 30_000 },
        lyrics: "Public royalty line",
      },
      ctx.env,
      author.accessToken,
    )
    expect(bundleCreate.status).toBe(201)
    const bundleBody = await json(bundleCreate) as { song_artifact_bundle_id: string }
    await markGeneratedPreviewReady({
      env: ctx.env,
      communityId,
      songArtifactBundleId: bundleBody.song_artifact_bundle_id,
      previewStorageRef,
      previewSizeBytes: 4,
    })

    const postCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/posts`,
      {
        idempotency_key: "song-post-public-royalty-1",
        post_type: "song",
        identity_mode: "public",
        title: "Public royalty song",
        access_mode: "public",
        song_mode: "original",
        rights_basis: "original",
        license_preset: "non-commercial",
        song_artifact_bundle_id: bundleBody.song_artifact_bundle_id,
      },
      ctx.env,
      author.accessToken,
    )
    expect(postCreate.status).toBe(201)
    const postBody = await json(postCreate) as { asset_id?: string | null }
    const assetId = postBody.asset_id as string

    const listingCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/listings`,
      {
        asset_id: assetId,
        price_usd: 2,
        regional_pricing_enabled: false,
        donation_partner_id: "don_public_charity",
        donation_share_pct: 10,
        status: "active",
      },
      ctx.env,
      author.accessToken,
    )
    expect(listingCreate.status).toBe(201)
    const listingBody = await json(listingCreate) as { listing_id: string }

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
    const quoteBody = await json(quoteCreate) as { quote_id: string; settlement_mode: string }
    expect(quoteBody.settlement_mode).toBe("royalty_native_story_payment")

    const purchaseSettle = await requestJson(
      `http://pirate.test/communities/${communityId}/purchase-settlements`,
      {
        quote_id: quoteBody.quote_id,
        settlement_wallet_attachment_id: "wal_song_buyer_public_royalty",
        funding_tx_ref: "0xfunding-public-1",
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
        amount_usd: number
        status: string
        settlement_ref: string | null
      }>
    }
    expect(purchaseBody.settlement_mode).toBe("royalty_native_story_payment")
    expect(purchaseBody.settlement_tx_ref).toBe("0xroyalty-public")
    expect(purchaseBody.allocations).toEqual([
      {
        amount_usd: 0.2,
        failure_reason: null,
        recipient_ref: "don_public_charity",
        recipient_type: "charity",
        settlement_ref: "endaoment:settlement:public-donation-0001",
        settlement_strategy: "provider_payout",
        share_bps: 1000,
        status: "confirmed",
        waterfall_position: 60,
      },
      {
        amount_usd: 1.8,
        failure_reason: null,
        recipient_ref: null,
        recipient_type: "creator",
        settlement_ref: "0xroyalty-public",
        settlement_strategy: "story_payout",
        share_bps: 9000,
        status: "confirmed",
        waterfall_position: 70,
      },
    ])
    expect(charityPayoutCalls).toEqual([
      {
        donationPartnerId: "don_public_charity",
        amountUsd: 0.2,
        amountAtomic: "200000000000000000",
      },
    ])
    expect(royaltySettlementCalls).toEqual([
      {
        receiverIpId: "0x1212121212121212121212121212121212121212",
        entitlementTokenId: null,
        amount: "1800000000000000000",
      },
    ])
  }, 15000)

  testWithTimeout("clears listing donation state when donation share is updated to zero", async () => {
    const storedObjects = new Map<string, { body: Uint8Array; contentType: string }>()
    setStoryRuntimeFundingAssertionForTests(async () => {})
    setStoryPurchaseSettlementExecutorForTests(async () => ({ settlementTxHash: "0xstory" }))
    setStoryRoyaltyRegistrarForTests(async (input) => {
      expect(input.rightsBasis).toBe("original")
      return {
        storyIpId: "0x1515151515151515151515151515151515151515",
        storyIpNftContract: "0x2525252525252525252525252525252525252525",
        storyIpNftTokenId: "45",
        storyLicenseTermsId: "8",
        storyLicenseTemplate: null,
        storyRoyaltyPolicy: "0xBe54FB168b3c982b7AaE60dB6CF75Bd8447b390E",
        storyDerivativeParentIpIds: null,
        storyRevenueToken: "0x1514000000000000000000000000000000000000",
        storyRoyaltyRegistrationStatus: "registered",
        storyDerivativeRegisteredAt: null,
      }
    })

    installLockedSongFetchMocks({ originalFetch, storedObjects })

    const ctx = await createRouteTestContext({
      FILEBASE_S3_ACCESS_KEY: "test-filebase-access",
      FILEBASE_S3_SECRET_KEY: "test-filebase-secret",
      FILEBASE_S3_ENDPOINT: "https://s3.filebase.test",
      FILEBASE_S3_BUCKET_MUSIC: "pirate-song-media",
    })
    cleanup = ctx.cleanup

    const author = await exchangeJwt(ctx.env, "song-author-clear-donation")
    const buyer = await exchangeJwt(ctx.env, "song-buyer-clear-donation")
    await attachPrimaryWallet({
      client: ctx.client,
      userId: author.userId,
      walletAttachmentId: "wal_author_clear_donation",
      walletAddress: "0xaaa0000000000000000000000000000000000000",
    })
    await attachPrimaryWallet({
      client: ctx.client,
      userId: buyer.userId,
      walletAttachmentId: "wal_buyer_clear_donation",
      walletAddress: "0xbbb0000000000000000000000000000000000000",
    })
    await verifyForLockedSongCommerce(ctx.env, author.userId, author.accessToken)
    await verifyForLockedSongCommerce(ctx.env, buyer.userId, buyer.accessToken)

    const communityId = await createOpenSongCommunity(ctx.env, author.accessToken, "Clear Donation Club")

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
      filename: "clear-donation.mp3",
      bytes: primaryBytes,
    })

    const previewStorageRef = `http://pirate.test/generated-preview/${communityId}/clear-donation.mp3`

    const bundleCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/song-artifacts`,
      {
        primary_audio: { song_artifact_upload_id: primaryUploadIntentBody.song_artifact_upload_id },
        preview_window: { start_ms: 0, duration_ms: 30_000 },
        lyrics: "Clear donation line",
      },
      ctx.env,
      author.accessToken,
    )
    expect(bundleCreate.status).toBe(201)
    const bundleBody = await json(bundleCreate) as { song_artifact_bundle_id: string }
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
        idempotency_key: "song-post-clear-donation-1",
        post_type: "song",
        identity_mode: "public",
        title: "Clear donation anthem",
        access_mode: "locked",
        song_mode: "original",
        rights_basis: "original",
        license_preset: "non-commercial",
        song_artifact_bundle_id: bundleBody.song_artifact_bundle_id,
      },
      ctx.env,
      author.accessToken,
    )
    expect(lockedPostCreate.status).toBe(201)
    const lockedPostBody = await json(lockedPostCreate) as { asset_id?: string | null }
    const assetId = lockedPostBody.asset_id as string

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

    const listingUpdate = await app.request(
      `http://pirate.test/communities/${communityId}/listings/${listingBody.listing_id}`,
      {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${author.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          donation_share_pct: 0,
        }),
      },
      ctx.env,
    )
    expect(listingUpdate.status).toBe(200)
    const listingUpdateBody = await json(listingUpdate) as {
      donation_partner_id: string | null
      donation_share_pct: number | null
    }
    expect(listingUpdateBody.donation_partner_id).toBeNull()
    expect(listingUpdateBody.donation_share_pct).toBeNull()

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
      allocation_snapshot: Array<{
        recipient_type: string
        recipient_ref: string | null
        share_bps: number
        amount_usd: number
        settlement_strategy: string
        waterfall_position: number
      }>
    }
    expect(quoteBody.allocation_snapshot).toEqual([
      {
        recipient_type: "creator",
        recipient_ref: null,
        waterfall_position: 70,
        share_bps: 10000,
        amount_usd: 4.99,
        settlement_strategy: "story_payout",
      },
    ])
  }, 15000)

  testWithTimeout("rejects purchase quote when donation partner is paused", async () => {
    const storedObjects = new Map<string, { body: Uint8Array; contentType: string }>()
    setStoryRuntimeFundingAssertionForTests(async () => {})
    setStoryPurchaseSettlementExecutorForTests(async () => ({ settlementTxHash: "0xstory" }))
    setStoryRoyaltyRegistrarForTests(async (input) => {
      expect(input.rightsBasis).toBe("original")
      return {
        storyIpId: "0x1616161616161616161616161616161616161616",
        storyIpNftContract: "0x2626262626262626262626262626262626262626",
        storyIpNftTokenId: "46",
        storyLicenseTermsId: "9",
        storyLicenseTemplate: null,
        storyRoyaltyPolicy: "0xBe54FB168b3c982b7AaE60dB6CF75Bd8447b390E",
        storyDerivativeParentIpIds: null,
        storyRevenueToken: "0x1514000000000000000000000000000000000000",
        storyRoyaltyRegistrationStatus: "registered",
        storyDerivativeRegisteredAt: null,
      }
    })

    installLockedSongFetchMocks({ originalFetch, storedObjects })

    const ctx = await createRouteTestContext({
      FILEBASE_S3_ACCESS_KEY: "test-filebase-access",
      FILEBASE_S3_SECRET_KEY: "test-filebase-secret",
      FILEBASE_S3_ENDPOINT: "https://s3.filebase.test",
      FILEBASE_S3_BUCKET_MUSIC: "pirate-song-media",
    })
    cleanup = ctx.cleanup

    const author = await exchangeJwt(ctx.env, "song-author-paused")
    const buyer = await exchangeJwt(ctx.env, "song-buyer-paused")
    await attachPrimaryWallet({
      client: ctx.client,
      userId: author.userId,
      walletAttachmentId: "wal_author_paused",
      walletAddress: "0xaaa0000000000000000000000000000000000000",
    })
    await attachPrimaryWallet({
      client: ctx.client,
      userId: buyer.userId,
      walletAttachmentId: "wal_buyer_paused",
      walletAddress: "0xbbb0000000000000000000000000000000000000",
    })
    await verifyForLockedSongCommerce(ctx.env, author.userId, author.accessToken)
    await verifyForLockedSongCommerce(ctx.env, buyer.userId, buyer.accessToken)

    const communityId = await createOpenSongCommunity(ctx.env, author.accessToken, "Paused Partner Club")

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
      filename: "paused-partner.mp3",
      bytes: primaryBytes,
    })

    const previewStorageRef = `http://pirate.test/generated-preview/${communityId}/paused-partner.mp3`

    const bundleCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/song-artifacts`,
      {
        primary_audio: { song_artifact_upload_id: primaryUploadIntentBody.song_artifact_upload_id },
        preview_window: { start_ms: 0, duration_ms: 30_000 },
        lyrics: "Paused partner line",
      },
      ctx.env,
      author.accessToken,
    )
    expect(bundleCreate.status).toBe(201)
    const bundleBody = await json(bundleCreate) as { song_artifact_bundle_id: string }
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
        idempotency_key: "song-post-paused-1",
        post_type: "song",
        identity_mode: "public",
        title: "Paused partner anthem",
        access_mode: "locked",
        song_mode: "original",
        rights_basis: "original",
        license_preset: "non-commercial",
        song_artifact_bundle_id: bundleBody.song_artifact_bundle_id,
      },
      ctx.env,
      author.accessToken,
    )
    expect(lockedPostCreate.status).toBe(201)
    const lockedPostBody = await json(lockedPostCreate) as { asset_id?: string | null }
    const assetId = lockedPostBody.asset_id as string

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
    const listingBody = await json(listingCreate) as { listing_id: string }

    const repo: CommunityDatabaseBindingRepository = {
      async getPrimaryCommunityDatabaseBinding() {
        return {
          community_database_binding_id: "cdb_test",
          community_id: communityId,
          binding_role: "primary",
          organization_slug: "local",
          group_name: "local",
          group_id: null,
          database_name: `community-${communityId}`,
          database_id: null,
          database_url: `file:${ctx.communityDbRoot}/community-${communityId}.db`,
          location: null,
          status: "active",
          transferred_at: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }
      },
      async getActiveCommunityDbCredential() {
        return null
      },
    }

    const communityDb = await openCommunityDb(ctx.env, repo, communityId)
    try {
      await communityDb.client.execute({
        sql: `
          UPDATE donation_partners
          SET status = 'paused',
              updated_at = ?2
          WHERE donation_partner_id = ?1
        `,
        args: ["don_charity_water", new Date().toISOString()],
      })
    } finally {
      communityDb.close()
    }

    const quoteCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/purchase-quotes`,
      {
        listing_id: listingBody.listing_id,
        ...routedCheckoutQuoteFields,
      },
      ctx.env,
      buyer.accessToken,
    )
    expect(quoteCreate.status).toBe(403)
    const quoteBody = await json(quoteCreate) as { message?: string }
    expect(quoteBody.message).toBe("Donation partner is not available")
  }, 15000)
})
