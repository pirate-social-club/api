import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import app from "../src/index"
import { createRouteTestContext, json, resetRuntimeCaches } from "./helpers"
import { setStoryAccessProofSignerForTests } from "../src/lib/story/story-access-proof-service"
import { setStoryAssetPublisherForTests } from "../src/lib/story/story-publish-service"
import { setStoryCdrUploaderForTests } from "../src/lib/story/story-cdr"
import { setStoryRuntimeFundingAssertionForTests } from "../src/lib/story/story-runtime-funding"
import { setStoryPurchaseSettlementExecutorForTests } from "../src/lib/story/story-settlement-service"
import {
  completeUniqueHumanVerification,
  exchangeJwt,
  requestJson,
} from "./song-artifact-test-helpers"
import { openCommunityDb } from "../src/lib/communities/community-db-factory"
import type { CommunityRepository } from "../src/lib/communities/db-community-repository"
import {
  attachPrimaryWallet,
  createOpenSongCommunity,
  installLockedSongFetchMocks,
  uploadSongArtifact,
} from "./song-artifact-locked-test-helpers"

let cleanup: (() => Promise<void>) | null = null
let originalFetch: typeof fetch

beforeEach(() => {
  resetRuntimeCaches()
  originalFetch = globalThis.fetch
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

    const previewUploadIntentBody = await uploadSongArtifact({
      env: ctx.env,
      communityId,
      accessToken: author.accessToken,
      artifactKind: "preview_audio",
      mimeType: "audio/mpeg",
      filename: "paid-anthem-preview.mp3",
      bytes: previewBytes,
    })

    const bundleCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/song-artifacts`,
      {
        primary_audio: {
          song_artifact_upload_id: primaryUploadIntentBody.song_artifact_upload_id,
        },
        preview_audio: {
          song_artifact_upload_id: previewUploadIntentBody.song_artifact_upload_id,
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
    expect(lockedPostBody.media_refs?.[0]?.storage_ref).toBe(previewUploadIntentBody.storage_ref)

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
    }
    expect(authorAssetBody.asset_id).toBe(assetId)
    expect(authorAssetBody.access_mode).toBe("locked")
    expect(authorAssetBody.locked_delivery_status).toBe("ready")
    expect(authorAssetBody.primary_content_ref).toBe(primaryUploadIntentBody.storage_ref)

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
        client_estimated_slippage_bps: 0,
        client_estimated_hop_count: 0,
      },
      ctx.env,
      buyer.accessToken,
    )
    expect(quoteCreate.status).toBe(201)
    const quoteBody = await json(quoteCreate) as {
      quote_id: string
      final_price_usd: number
      allocation_snapshot: Array<{
        recipient_type: string
        recipient_ref: string | null
        share_bps: number
        amount_usd: number
        settlement_strategy: string
      }>
    }
    expect(quoteBody.final_price_usd).toBe(4.99)
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
    expect(purchaseBody.settlement_tx_ref).toBe("0xstorysettlementpaid0001")
    expect(purchaseBody.allocations).toEqual([
      {
        amount_usd: 0.5,
        failure_reason: null,
        recipient_ref: "don_charity_water",
        recipient_type: "charity",
        status: "pending",
        settlement_ref: null,
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
        settlement_ref: "0xstorysettlementpaid0001",
        settlement_strategy: "story_payout",
        share_bps: 9000,
        waterfall_position: 70,
      },
    ])
    expect(purchaseBody.donation_partner_id).toBe("don_charity_water")
    expect(purchaseBody.donation_share_pct).toBe(10)
    expect(purchaseBody.donation_amount_usd).toBe(0.5)
    expect(storySettlementCalls).toHaveLength(1)
    expect({
      amountWei: storySettlementCalls[0]?.amountWei,
      buyerAddress: storySettlementCalls[0]?.buyerAddress,
      payoutRecipient: storySettlementCalls[0]?.payoutRecipient,
    }).toEqual({
      buyerAddress: "0xbbb0000000000000000000000000000000000000",
      payoutRecipient: "0xaaa0000000000000000000000000000000000000",
      amountWei: "4990000000000000000",
    })
    expect(storySettlementCalls[0]?.purchaseRef).toMatch(/^0x[0-9a-f]{64}$/)
    expect(BigInt(storySettlementCalls[0]?.entitlementTokenId ?? "0") > 0n).toBe(true)

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
        status: "pending",
        settlement_ref: null,
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
        settlement_ref: "0xstorysettlementpaid0001",
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

  test("rejects purchase quote when community donation policy is none", async () => {
    const storedObjects = new Map<string, { body: Uint8Array; contentType: string }>()
    setStoryRuntimeFundingAssertionForTests(async () => {})
    setStoryPurchaseSettlementExecutorForTests(async () => ({ settlementTxHash: "0xstory" }))

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
    await completeUniqueHumanVerification(ctx.env, author.accessToken)
    await completeUniqueHumanVerification(ctx.env, buyer.accessToken)

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

    const previewUploadIntentBody = await uploadSongArtifact({
      env: ctx.env,
      communityId,
      accessToken: author.accessToken,
      artifactKind: "preview_audio",
      mimeType: "audio/mpeg",
      filename: "no-donation-preview.mp3",
      bytes: previewBytes,
    })

    const bundleCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/song-artifacts`,
      {
        primary_audio: { song_artifact_upload_id: primaryUploadIntentBody.song_artifact_upload_id },
        preview_audio: { song_artifact_upload_id: previewUploadIntentBody.song_artifact_upload_id },
        lyrics: "No donation line",
      },
      ctx.env,
      author.accessToken,
    )
    expect(bundleCreate.status).toBe(201)
    const bundleBody = await json(bundleCreate) as { song_artifact_bundle_id: string }

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
        funding_asset: { asset_namespace: "eip155:1315/slip44:1" },
        source_chain: { chain_namespace: "eip155", chain_id: 1315 },
        route_provider: "stargate",
      },
      ctx.env,
      buyer.accessToken,
    )
    expect(quoteCreate.status).toBe(403)
    const quoteBody = await json(quoteCreate) as { message?: string }
    expect(quoteBody.message).toBe("Community donation policy does not permit donations")
  })

  test("rejects purchase quote when donation partner is paused", async () => {
    const storedObjects = new Map<string, { body: Uint8Array; contentType: string }>()
    setStoryRuntimeFundingAssertionForTests(async () => {})
    setStoryPurchaseSettlementExecutorForTests(async () => ({ settlementTxHash: "0xstory" }))

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
    await completeUniqueHumanVerification(ctx.env, author.accessToken)
    await completeUniqueHumanVerification(ctx.env, buyer.accessToken)

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

    const previewUploadIntentBody = await uploadSongArtifact({
      env: ctx.env,
      communityId,
      accessToken: author.accessToken,
      artifactKind: "preview_audio",
      mimeType: "audio/mpeg",
      filename: "paused-partner-preview.mp3",
      bytes: previewBytes,
    })

    const bundleCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/song-artifacts`,
      {
        primary_audio: { song_artifact_upload_id: primaryUploadIntentBody.song_artifact_upload_id },
        preview_audio: { song_artifact_upload_id: previewUploadIntentBody.song_artifact_upload_id },
        lyrics: "Paused partner line",
      },
      ctx.env,
      author.accessToken,
    )
    expect(bundleCreate.status).toBe(201)
    const bundleBody = await json(bundleCreate) as { song_artifact_bundle_id: string }

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

    const repo: CommunityRepository = {
      async getPrimaryCommunityDatabaseBinding() {
        return {
          community_database_binding_id: "cdb_test",
          community_id: communityId,
          database_url: `file:${ctx.communityDbRoot}/community-${communityId}.db`,
          binding_status: "active",
          binding_kind: "primary",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }
      },
      async getCommunityById() {
        return {
          community_id: communityId,
          creator_user_id: author.userId,
          display_name: "Paused Partner Club",
          description: null,
          avatar_ref: null,
          banner_ref: null,
          status: "active",
          route_slug: communityId,
          namespace_verification_id: null,
          pending_namespace_verification_session_id: null,
          provisioning_state: "active",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }
      },
      async getActiveCommunityDbCredential() {
        return null
      },
    } as unknown as CommunityRepository

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
        funding_asset: { asset_namespace: "eip155:1315/slip44:1" },
        source_chain: { chain_namespace: "eip155", chain_id: 1315 },
        route_provider: "stargate",
      },
      ctx.env,
      buyer.accessToken,
    )
    expect(quoteCreate.status).toBe(403)
    const quoteBody = await json(quoteCreate) as { message?: string }
    expect(quoteBody.message).toBe("Donation partner is not available")
  })
})
