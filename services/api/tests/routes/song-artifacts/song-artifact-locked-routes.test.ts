import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createClient } from "@libsql/client"
import { app } from "../../../src/index"
import { createRouteTestContext, json, resetRuntimeCaches } from "../../helpers"
import { getCommunityRepository } from "../../../src/lib/communities/db-community-repository"
import { buildLocalCommunityDbPath } from "../../../src/lib/communities/community-local-db"
import { reconcileStaleCommunityPurchaseSettlements } from "../../../src/lib/communities/commerce/settlement-service"
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
import { addCommunityMember } from "../communities/community-routes-test-helpers"

let cleanup: (() => Promise<void>) | null = null
let originalFetch: typeof fetch
const testWithTimeout = test as unknown as (name: string, fn: () => Promise<void>, timeout: number) => void

async function verifyForLockedCommerce(env: Env, _userId: string, accessToken: string): Promise<void> {
  await completeUniqueHumanVerification(env, accessToken)
}

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
  testWithTimeout("publishes a locked song, sells access, and decrypts the purchased asset", async () => {
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
      FILEBASE_MEDIA_BUCKET: "pirate-media",
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
    await verifyForLockedCommerce(ctx.env, author.userId, author.accessToken)
    await verifyForLockedCommerce(ctx.env, buyer.userId, buyer.accessToken)

    const communityId = await createOpenSongCommunity(ctx.env, author.accessToken, "Paid Song Club")
    const donationPolicyUpdate = await app.request(
      `http://pirate.test/communities/${communityId}/donation-policy`,
      {
        method: "POST",
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
    await addCommunityMember(String(ctx.env.LOCAL_COMMUNITY_DB_ROOT), communityId, buyer.userId)

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
          song_artifact_upload: primaryUploadIntentBody.id,
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
      id: string
    }
    await markGeneratedPreviewReady({
      env: ctx.env,
      communityId,
      songArtifactBundleId: bundleBody.id.replace(/^sab_/, ""),
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
        license_preset: "non-commercial",
        song_artifact_bundle: bundleBody.id,
      },
      ctx.env,
      author.accessToken,
    )
    expect(lockedPostCreate.status).toBe(201)
    expect(writeAccessAuxData).toBe("0x")
    const lockedPostBody = await json(lockedPostCreate) as {
      asset?: string | null
      access_mode?: string | null
      media_refs?: Array<{ storage_ref: string }>
    }
    expect(lockedPostBody.access_mode).toBe("locked")
    expect(typeof lockedPostBody.asset === "string" && lockedPostBody.asset.length > 0).toBe(true)
    expect(lockedPostBody.media_refs?.[0]?.storage_ref).toBe(previewStorageRef)

    const assetId = lockedPostBody.asset as string

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
      id: string
      access_mode: string
      display_title: string | null
      locked_delivery_status: string
      primary_content_ref: string
      story_ip: string | null
      story_royalty_registration_status: string | null
    }
    expect(authorAssetBody.id).toBe(assetId)
    expect(authorAssetBody.access_mode).toBe("locked")
    expect(authorAssetBody.display_title).toBe("Paid anthem")
    expect(authorAssetBody.locked_delivery_status).toBe("ready")
    expect(authorAssetBody.primary_content_ref).toBe(primaryUploadIntentBody.storage_ref)
    expect(authorAssetBody.story_ip).toBe("0x1010101010101010101010101010101010101010")
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
      decision_reason: string | null
      delivery_kind: string | null
    }
    expect(buyerAccessBeforePurchaseBody.access_granted).toBe(false)
    expect(buyerAccessBeforePurchaseBody.decision_reason).toBe("purchase_required")
    expect(buyerAccessBeforePurchaseBody.delivery_kind).toBeNull()

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
        asset: assetId,
        price_cents: 499,
        regional_pricing_enabled: false,
        donation_partner: "don_charity_water",
        donation_share_bps: 1000,
        status: "active",
      },
      ctx.env,
      author.accessToken,
    )
    expect(listingCreate.status).toBe(201)
    const listingBody = await json(listingCreate) as {
      id: string
      donation_partner: string | null
      donation_share_bps: number | null
    }
    expect(listingBody.donation_partner).toBe("don_charity_water")
    expect(listingBody.donation_share_bps).toBe(1000)

    const quoteCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/purchase-quotes`,
      {
        listing: listingBody.id,
        ...routedCheckoutQuoteFields,
      },
      ctx.env,
      buyer.accessToken,
    )
    expect(quoteCreate.status).toBe(201)
    const quoteBody = await json(quoteCreate) as {
      id: string
      final_price_cents: number
      settlement_mode: string
      allocation_snapshot: Array<{
        recipient_type: string
        recipient_ref: string | null
        share_bps: number
        amount_cents: number
        settlement_strategy: string
      }>
    }
    expect(quoteBody.final_price_cents).toBe(499)
    expect(quoteBody.settlement_mode).toBe("royalty_native_story_payment")
    expect(quoteBody.allocation_snapshot).toEqual([
      {
        recipient_type: "charity",
        recipient_ref: "don_charity_water",
        waterfall_position: 60,
        share_bps: 1000,
        amount_cents: 50,
        settlement_strategy: "provider_payout",
      },
      {
        recipient_type: "creator",
        recipient_ref: null,
        waterfall_position: 70,
        share_bps: 9000,
        amount_cents: 449,
        settlement_strategy: "story_payout",
      },
    ])
    const settlementWalletAttachmentId = "wal_song_buyer_locked"

    const purchaseSettle = await requestJson(
      `http://pirate.test/communities/${communityId}/purchase-settlements`,
      {
        quote: quoteBody.id,
        settlement_wallet_attachment: settlementWalletAttachmentId,
        funding_tx_ref: "0xfunding-paid-song-1",
        settlement_tx_ref: "tx-paid-song-1",
      },
      ctx.env,
      buyer.accessToken,
    )
    expect(purchaseSettle.status).toBe(201)
    const purchaseBody = await json(purchaseSettle) as {
      id: string
      entitlement_kind: string
      entitlement_target_ref: string
      settlement_mode: string
      settlement_tx_ref: string
      allocations: Array<{
        recipient_type: string
        status: string
        settlement_ref: string | null
      }>
      donation_partner: string | null
      donation_share_bps: number | null
      donation_amount_cents: number | null
    }
    expect(purchaseBody.entitlement_kind).toBe("asset_access")
    expect(purchaseBody.entitlement_target_ref).toBe(assetId)
    expect(purchaseBody.settlement_mode).toBe("royalty_native_story_payment")
    expect(purchaseBody.settlement_tx_ref).toBe("0xroyalty-paid-song")
    expect(purchaseBody.allocations).toEqual([
      {
        amount_cents: 50,
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
        amount_cents: 449,
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
    expect(purchaseBody.donation_partner).toBe("don_charity_water")
    expect(purchaseBody.donation_share_bps).toBe(1000)
    expect(purchaseBody.donation_amount_cents).toBe(50)
    expect(charityPayoutCalls).toHaveLength(1)
    expect(charityPayoutCalls[0]?.donationPartnerId).toBe("don_charity_water")
    expect(charityPayoutCalls[0]?.payoutDestinationRef).toBe("charity-water")
    expect(charityPayoutCalls[0]?.amountUsd).toBe(0.5)
    expect(charityPayoutCalls[0]?.amountAtomic).toBe("500000000000000000")
    expect(charityPayoutCalls[0]?.settlementToken).toBe("WIP")
    expect(charityPayoutCalls[0]?.idempotencyKey).toContain(`${quoteBody.id.replace(/^pq_/, "")}:charity:don_charity_water:60`)
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

    const purchaseRetry = await requestJson(
      `http://pirate.test/communities/${communityId}/purchase-settlements`,
      {
        quote: quoteBody.id,
        settlement_wallet_attachment: settlementWalletAttachmentId,
        funding_tx_ref: "0xfunding-paid-song-1",
        settlement_tx_ref: "tx-paid-song-1",
      },
      ctx.env,
      buyer.accessToken,
    )
    expect(purchaseRetry.status).toBe(201)
    const purchaseRetryBody = await json(purchaseRetry) as { id: string }
    expect(purchaseRetryBody.id).toBe(purchaseBody.id)
    expect(charityPayoutCalls).toHaveLength(1)
    expect(royaltySettlementCalls).toHaveLength(1)

    const communityDb = createClient({
      url: `file:${buildLocalCommunityDbPath(ctx.communityDbRoot, communityId)}`,
    })
    const rawPurchaseId = purchaseBody.id.replace(/^pur_/, "")
    const rawQuoteId = quoteBody.id.replace(/^pq_/, "")
    try {
      await communityDb.execute({
        sql: `DELETE FROM purchase_allocation_legs WHERE purchase_id = ?1`,
        args: [rawPurchaseId],
      })
      await communityDb.execute({
        sql: `DELETE FROM purchase_entitlements WHERE purchase_id = ?1`,
        args: [rawPurchaseId],
      })
      await communityDb.execute({
        sql: `DELETE FROM purchases WHERE purchase_id = ?1`,
        args: [rawPurchaseId],
      })
      await communityDb.execute({
        sql: `
          UPDATE purchase_quotes
          SET status = 'active',
              consumed_at = NULL,
              updated_at = '2026-04-21T00:00:00.000Z'
          WHERE quote_id = ?1
        `,
        args: [rawQuoteId],
      })
      await communityDb.execute({
        sql: `
          UPDATE purchase_settlement_attempts
          SET status = 'attempting',
              updated_at = '2026-04-21T00:00:00.000Z'
          WHERE quote_id = ?1
        `,
        args: [rawQuoteId],
      })
    } finally {
      communityDb.close()
    }

    const communityRepository = getCommunityRepository(ctx.env)
    try {
      const reconcileSummary = await reconcileStaleCommunityPurchaseSettlements({
        env: ctx.env,
        communityRepository,
        staleMs: 1,
      })
      expect(reconcileSummary).toMatchObject({
        checked: 1,
        finalized: 1,
        failed: 0,
        errors: 0,
      })
    } finally {
      communityRepository.close?.()
    }
    expect(charityPayoutCalls).toHaveLength(1)
    expect(royaltySettlementCalls).toHaveLength(1)

    await new Promise((resolve) => setTimeout(resolve, 2))
    const authorRoyaltyActivity = await app.request(
      "http://pirate.test/royalties/activity?limit=10",
      {
        headers: {
          authorization: `Bearer ${author.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(authorRoyaltyActivity.status).toBe(200)
    const authorRoyaltyActivityBody = await json(authorRoyaltyActivity) as {
      items: Array<{
        amount_wip_wei: string
        asset: string
        purchase: string | null
        story_ip: string
        title: string | null
        tx_hash: string | null
      }>
    }
    const earningActivity = authorRoyaltyActivityBody.items.find((item) => item.purchase === purchaseBody.id)
    expect(earningActivity).toMatchObject({
      amount_wip_wei: "4490000000000000000",
      asset: assetId,
      purchase: purchaseBody.id,
      story_ip: "0x1010101010101010101010101010101010101010",
      title: "Paid anthem",
      tx_hash: "0xroyalty-paid-song",
    })

    const purchaseRecord = await app.request(
      `http://pirate.test/communities/${communityId}/purchases/${purchaseBody.id}`,
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
      donation_partner: string | null
      donation_share_bps: number | null
      donation_amount_cents: number | null
    }
    expect(purchaseRecordBody.allocations).toEqual([
      {
        amount_cents: 50,
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
        amount_cents: 449,
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
    expect(purchaseRecordBody.donation_partner).toBe("don_charity_water")
    expect(purchaseRecordBody.donation_share_bps).toBe(1000)
    expect(purchaseRecordBody.donation_amount_cents).toBe(50)

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
      `/communities/${communityId}/assets/${assetId.replace(/^asset_/, "")}/content`,
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
  }, 15000)



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
      FILEBASE_MEDIA_BUCKET: "pirate-media",
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
    await verifyForLockedCommerce(ctx.env, author.userId, author.accessToken)

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
          song_artifact_upload: primaryUploadIntentBody.id,
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
      id: string
    }
    await markGeneratedPreviewReady({
      env: ctx.env,
      communityId,
      songArtifactBundleId: bundleBody.id.replace(/^sab_/, ""),
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
        song_artifact_bundle: bundleBody.id,
      },
      ctx.env,
      author.accessToken,
    )
    expect(derivativePostCreate.status).toBe(201)
    const derivativePostBody = await json(derivativePostCreate) as {
      asset?: string | null
    }
    const assetId = derivativePostBody.asset as string

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
      story_royalty_policy: string | null
      story_derivative_parent_ip_ids: string[] | null
      story_royalty_registration_status: string | null
    }
    expect(assetBody.story_royalty_policy).toBeNull()
    expect(assetBody.story_derivative_parent_ip_ids).toBeNull()
    expect(assetBody.story_royalty_registration_status).toBe("pending")

    const listingCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/listings`,
      {
        asset: assetId,
        price_cents: 499,
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

  testWithTimeout("allows commerce for a locked derivative asset once Story royalty registration metadata is present", async () => {
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
      FILEBASE_MEDIA_BUCKET: "pirate-media",
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
    await verifyForLockedCommerce(ctx.env, author.userId, author.accessToken)
    await verifyForLockedCommerce(ctx.env, buyer.userId, buyer.accessToken)

    const communityId = await createOpenSongCommunity(ctx.env, author.accessToken, "Derivative Registered Club")

    const donationPolicyUpdate = await app.request(
      `http://pirate.test/communities/${communityId}/donation-policy`,
      {
        method: "POST",
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
    await addCommunityMember(String(ctx.env.LOCAL_COMMUNITY_DB_ROOT), communityId, buyer.userId)

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
          song_artifact_upload: primaryUploadIntentBody.id,
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
      id: string
    }
    await markGeneratedPreviewReady({
      env: ctx.env,
      communityId,
      songArtifactBundleId: bundleBody.id.replace(/^sab_/, ""),
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
        song_artifact_bundle: bundleBody.id,
      },
      ctx.env,
      author.accessToken,
    )
    expect(derivativePostCreate.status).toBe(201)
    const derivativePostBody = await json(derivativePostCreate) as {
      asset?: string | null
    }
    const assetId = derivativePostBody.asset as string

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
      story_ip: string | null
      story_royalty_policy: string | null
      story_derivative_parent_ip_ids: string[] | null
      story_royalty_registration_status: string | null
      locked_delivery_status: string | null
    }
    expect(assetBody.story_ip).toBe("0x1111111111111111111111111111111111111111")
    expect(assetBody.story_royalty_policy).toBe("0xBe54FB168b3c982b7AaE60dB6CF75Bd8447b390E")
    expect(assetBody.story_derivative_parent_ip_ids).toEqual(["0x3333333333333333333333333333333333333333"])
    expect(assetBody.story_royalty_registration_status).toBe("registered")
    expect(assetBody.locked_delivery_status).toBe("ready")

    const listingCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/listings`,
      {
        asset: assetId,
        price_cents: 399,
        regional_pricing_enabled: false,
        donation_partner: "don_derivative_charity",
        donation_share_bps: 1000,
        status: "active",
      },
      ctx.env,
      author.accessToken,
    )
    expect(listingCreate.status).toBe(201)
    const listingBody = await json(listingCreate) as {
      id: string
      status: string
    }
    expect(listingBody.status).toBe("active")

    const quoteCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/purchase-quotes`,
      {
        listing: listingBody.id,
        ...routedCheckoutQuoteFields,
      },
      ctx.env,
      buyer.accessToken,
    )
    expect(quoteCreate.status).toBe(201)
    const quoteBody = await json(quoteCreate) as {
      id: string
      final_price_cents: number
      settlement_mode: string
      allocation_snapshot: Array<{
        recipient_type: string
        recipient_ref: string | null
        waterfall_position: number
        share_bps: number
        amount_cents: number
        settlement_strategy: string
      }>
    }
    expect(quoteBody.final_price_cents).toBe(399)
    expect(quoteBody.settlement_mode).toBe("royalty_native_story_payment")
    expect(quoteBody.allocation_snapshot).toEqual([
      {
        recipient_type: "charity",
        recipient_ref: "don_derivative_charity",
        waterfall_position: 60,
        share_bps: 1000,
        amount_cents: 40,
        settlement_strategy: "provider_payout",
      },
      {
        recipient_type: "creator",
        recipient_ref: null,
        waterfall_position: 70,
        share_bps: 9000,
        amount_cents: 359,
        settlement_strategy: "story_payout",
      },
    ])

    const purchaseSettle = await requestJson(
      `http://pirate.test/communities/${communityId}/purchase-settlements`,
      {
        quote: quoteBody.id,
        settlement_wallet_attachment: "wal_song_buyer_derivative_registered",
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
        amount_cents: 40,
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
        amount_cents: 359,
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
    expect(charityPayoutCalls[0]?.idempotencyKey).toContain(`${quoteBody.id.replace(/^pq_/, "")}:charity:don_derivative_charity:60`)
    expect(royaltySettlementCalls).toHaveLength(1)
    expect(royaltySettlementCalls[0]?.buyerAddress).toBe("0xbbb0000000000000000000000000000000000000")
    expect(royaltySettlementCalls[0]?.receiverIpId).toBe("0x1111111111111111111111111111111111111111")
    expect(royaltySettlementCalls[0]?.amount).toBe("3590000000000000000")
  }, 10000)

  test("creates a public video commerce asset backed by raw Filebase content", async () => {
    const storedObjects = new Map<string, { body: Uint8Array; contentType: string }>()
    installLockedSongFetchMocks({
      originalFetch,
      storedObjects,
    })

    const ctx = await createRouteTestContext({
      FILEBASE_S3_ACCESS_KEY: "test-filebase-access",
      FILEBASE_S3_SECRET_KEY: "test-filebase-secret",
      FILEBASE_S3_ENDPOINT: "https://s3.filebase.test",
      FILEBASE_MEDIA_BUCKET: "pirate-media",
    })
    cleanup = ctx.cleanup

    const author = await exchangeJwt(ctx.env, "video-author-public")
    await completeUniqueHumanVerification(ctx.env, author.accessToken)
    const communityId = await createOpenSongCommunity(ctx.env, author.accessToken, "Public Video Club")
    const videoBytes = new TextEncoder().encode("public-video-bytes")
    const videoUpload = await uploadSongArtifact({
      env: ctx.env,
      communityId,
      accessToken: author.accessToken,
      artifactKind: "primary_video",
      mimeType: "video/mp4",
      filename: "public-video.mp4",
      bytes: videoBytes,
    })

    const createdPost = await requestJson(
      `http://pirate.test/communities/${communityId}/posts`,
      {
        idempotency_key: "public-video-commerce-1",
        post_type: "video",
        title: "Public video",
        access_mode: "public",
        media_refs: [{
          storage_ref: videoUpload.storage_ref,
          mime_type: "video/mp4",
          size_bytes: videoBytes.byteLength,
          poster_ref: "http://pirate.test/community-media/post_image/public-video-cover.jpg",
          poster_mime_type: "image/jpeg",
          poster_size_bytes: 1234,
          poster_width: 1280,
          poster_height: 720,
          poster_frame_ms: 1000,
        }],
      },
      ctx.env,
      author.accessToken,
    )
    expect(createdPost.status).toBe(201)
    const postBody = await json(createdPost) as {
      asset: string
      access_mode: string
      media_refs: Array<{ storage_ref: string }>
    }
    expect(postBody.access_mode).toBe("public")
    expect(postBody.media_refs[0]?.storage_ref).toContain(`/public-communities/${communityId}/song-artifact-uploads/`)
    expect((postBody.media_refs[0] as { poster_ref?: string }).poster_ref).toBe("http://pirate.test/community-media/post_image/public-video-cover.jpg")

    const publicHeadResponse = await app.request(postBody.media_refs[0]?.storage_ref ?? "", {
      method: "HEAD",
    }, ctx.env)
    expect(publicHeadResponse.status).toBe(200)

    const publicContentResponse = await app.request(postBody.media_refs[0]?.storage_ref ?? "", {}, ctx.env)
    expect(publicContentResponse.status).toBe(200)
    expect(new Uint8Array(await publicContentResponse.arrayBuffer())).toEqual(videoBytes)

    const assetResponse = await app.request(
      `http://pirate.test/communities/${communityId}/assets/${postBody.asset}`,
      {
        headers: {
          authorization: `Bearer ${author.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(assetResponse.status).toBe(200)
    const assetBody = await json(assetResponse) as {
      asset_kind: string
      access_mode: string
      primary_content_ref: string
      locked_delivery_status: string
    }
    expect(assetBody.asset_kind).toBe("video_file")
    expect(assetBody.access_mode).toBe("public")
    expect(assetBody.primary_content_ref).toBe(videoUpload.storage_ref)
    expect(assetBody.locked_delivery_status).toBe("none")

    const contentResponse = await app.request(
      `http://pirate.test/communities/${communityId}/assets/${postBody.asset}/content`,
      {
        headers: {
          authorization: `Bearer ${author.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(contentResponse.status).toBe(200)
    expect(new Uint8Array(await contentResponse.arrayBuffer())).toEqual(videoBytes)
  })

  test("publishes a free video post with public media delivery and no commerce asset", async () => {
    const storedObjects = new Map<string, { body: Uint8Array; contentType: string }>()
    installLockedSongFetchMocks({
      originalFetch,
      storedObjects,
    })

    const ctx = await createRouteTestContext({
      FILEBASE_S3_ACCESS_KEY: "test-filebase-access",
      FILEBASE_S3_SECRET_KEY: "test-filebase-secret",
      FILEBASE_S3_ENDPOINT: "https://s3.filebase.test",
      FILEBASE_MEDIA_BUCKET: "pirate-media",
    })
    cleanup = ctx.cleanup

    const author = await exchangeJwt(ctx.env, "video-author-free")
    await completeUniqueHumanVerification(ctx.env, author.accessToken)
    const communityId = await createOpenSongCommunity(ctx.env, author.accessToken, "Free Video Club")
    const videoBytes = new TextEncoder().encode("free-video-bytes")
    const videoUpload = await uploadSongArtifact({
      env: ctx.env,
      communityId,
      accessToken: author.accessToken,
      artifactKind: "primary_video",
      mimeType: "video/mp4",
      filename: "free-video.mp4",
      bytes: videoBytes,
    })

    const createdPost = await requestJson(
      `http://pirate.test/communities/${communityId}/posts`,
      {
        idempotency_key: "free-video-post-1",
        post_type: "video",
        title: "Free video",
        media_refs: [{
          storage_ref: videoUpload.storage_ref,
          mime_type: "video/mp4",
          size_bytes: videoBytes.byteLength,
          poster_ref: "http://pirate.test/community-media/post_image/free-video-cover.jpg",
          poster_mime_type: "image/jpeg",
          poster_size_bytes: 1234,
        }],
      },
      ctx.env,
      author.accessToken,
    )
    expect(createdPost.status).toBe(201)
    const postBody = await json(createdPost) as {
      access_mode?: string | null
      asset?: string | null
      media_refs: Array<{ storage_ref: string }>
    }
    expect(postBody.access_mode).toBeNull()
    expect(postBody.asset).toBeNull()
    expect(postBody.media_refs[0]?.storage_ref).toContain(`/public-communities/${communityId}/song-artifact-uploads/`)

    const publicHeadResponse = await app.request(postBody.media_refs[0]?.storage_ref ?? "", {
      method: "HEAD",
    }, ctx.env)
    expect(publicHeadResponse.status).toBe(200)

    const publicContentResponse = await app.request(postBody.media_refs[0]?.storage_ref ?? "", {}, ctx.env)
    expect(publicContentResponse.status).toBe(200)
    expect(new Uint8Array(await publicContentResponse.arrayBuffer())).toEqual(videoBytes)

    const publicRangeResponse = await app.request(postBody.media_refs[0]?.storage_ref ?? "", {
      headers: {
        range: "bytes=0-3",
      },
    }, ctx.env)
    expect(publicRangeResponse.status).toBe(206)
    expect(publicRangeResponse.headers.get("accept-ranges")).toBe("bytes")
    expect(publicRangeResponse.headers.get("content-range")).toBe(`bytes 0-3/${videoBytes.byteLength}`)
    expect(new Uint8Array(await publicRangeResponse.arrayBuffer())).toEqual(videoBytes.slice(0, 4))
  })

  test("creates a members-only locked video commerce asset with Story CDR access", async () => {
    const storedObjects = new Map<string, { body: Uint8Array; contentType: string }>()
    setStoryRuntimeFundingAssertionForTests(async () => {})
    setStoryCdrUploaderForTests(async () => ({
      cdrVaultUuid: 9090,
      writerAddress: "0x0000000000000000000000000000000000000cd1",
      txHashes: {
        allocate: "0xalloc-video",
        write: "0xwrite-video",
      },
    }))
    setStoryAssetPublisherForTests(async () => ({
      entitlementConfiguredTxHash: "0xconfigure-video",
      publishTxHash: "0xpublish-video",
    }))
    setStoryRoyaltyRegistrarForTests(async (input) => {
      expect(input.assetKind).toBe("video_file")
      expect(input.bundle).toBeNull()
      expect(input.rightsBasis).toBe("original")
      expect(input.licensePreset).toBe("non-commercial")
      return {
        storyIpId: "0x3030303030303030303030303030303030303030",
        storyIpNftContract: "0x4040404040404040404040404040404040404040",
        storyIpNftTokenId: "909",
        storyLicenseTermsId: "19",
        storyLicenseTemplate: null,
        storyRoyaltyPolicy: "0xBe54FB168b3c982b7AaE60dB6CF75Bd8447b390E",
        storyDerivativeParentIpIds: null,
        storyRevenueToken: "0x1514000000000000000000000000000000000000",
        storyRoyaltyRegistrationStatus: "registered",
        storyDerivativeRegisteredAt: null,
      }
    })
    setStoryAccessProofSignerForTests(async (input) => ({
      digest: "0xd1e57090",
      signature: `0x${"22".repeat(65)}` as `0x${string}`,
      signerAddress: "0x0000000000000000000000000000000000000acc",
      proof: {
        vaultUuid: input.vaultUuid,
        caller: input.callerAddress,
        accessRef: input.accessRef,
        scope: "0xb8c1a2b531e7c9d996686b1cc6dcd49d2d7037be365b6d380ebaf489440d4f18",
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
      FILEBASE_MEDIA_BUCKET: "pirate-media",
      STORY_CONTRACT_OWNER_PRIVATE_KEY: "0x1000000000000000000000000000000000000000000000000000000000000001",
      STORY_OPERATOR_PRIVATE_KEY: "0x2000000000000000000000000000000000000000000000000000000000000002",
      STORY_CDR_WRITER_PRIVATE_KEY: "0x3000000000000000000000000000000000000000000000000000000000000003",
      STORY_ACCESS_CONTROLLER_PRIVATE_KEY: "0x4000000000000000000000000000000000000000000000000000000000000004",
    })
    cleanup = ctx.cleanup

    const author = await exchangeJwt(ctx.env, "video-author-locked")
    const buyer = await exchangeJwt(ctx.env, "video-buyer-locked")
    await attachPrimaryWallet({
      client: ctx.client,
      userId: author.userId,
      walletAttachmentId: "wal_video_author_locked",
      walletAddress: "0xaaa0000000000000000000000000000000000000",
    })
    await verifyForLockedCommerce(ctx.env, author.userId, author.accessToken)
    await verifyForLockedCommerce(ctx.env, buyer.userId, buyer.accessToken)
    const communityId = await createOpenSongCommunity(ctx.env, author.accessToken, "Locked Video Club")
    const joinBuyer = await requestJson(
      `http://pirate.test/communities/${communityId}/join`,
      {},
      ctx.env,
      buyer.accessToken,
    )
    expect(joinBuyer.status).toBe(200)
    await addCommunityMember(String(ctx.env.LOCAL_COMMUNITY_DB_ROOT), communityId, buyer.userId)
    const videoBytes = new TextEncoder().encode("locked-video-bytes")
    const videoUpload = await uploadSongArtifact({
      env: ctx.env,
      communityId,
      accessToken: author.accessToken,
      artifactKind: "primary_video",
      mimeType: "video/mp4",
      filename: "locked-video.mp4",
      bytes: videoBytes,
    })

    const createdPost = await requestJson(
      `http://pirate.test/communities/${communityId}/posts`,
      {
        idempotency_key: "locked-video-commerce-1",
        post_type: "video",
        title: "Members-only locked video",
        visibility: "members_only",
        access_mode: "locked",
        license_preset: "non-commercial",
        media_refs: [{
          storage_ref: videoUpload.storage_ref,
          mime_type: "video/mp4",
          size_bytes: videoBytes.byteLength,
          poster_ref: "http://pirate.test/community-media/post_image/locked-video-cover.jpg",
          poster_mime_type: "image/jpeg",
          poster_size_bytes: 2345,
          poster_width: 1280,
          poster_height: 720,
          poster_frame_ms: 2000,
        }],
      },
      ctx.env,
      author.accessToken,
    )
    expect(createdPost.status).toBe(201)
    const postBody = await json(createdPost) as {
      asset: string
      access_mode: string
      visibility: string
      media_refs?: Array<{ storage_ref?: string; poster_ref?: string; poster_frame_ms?: number }>
    }
    expect(postBody.access_mode).toBe("locked")
    expect(postBody.visibility).toBe("members_only")
    expect(postBody.media_refs?.[0]?.storage_ref).toBe("")
    expect(postBody.media_refs?.[0]?.poster_ref).toBe("http://pirate.test/community-media/post_image/locked-video-cover.jpg")
    expect(postBody.media_refs?.[0]?.poster_frame_ms).toBe(2000)

    const assetResponse = await app.request(
      `http://pirate.test/communities/${communityId}/assets/${postBody.asset}`,
      {
        headers: {
          authorization: `Bearer ${author.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(assetResponse.status).toBe(200)
    const assetBody = await json(assetResponse) as {
      asset_kind: string
      access_mode: string
      story_status: string
      locked_delivery_status: string
      story_cdr_vault_uuid: number
      story_ip: string | null
      story_license_terms: string | null
      story_royalty_registration_status: string
    }
    expect(assetBody.asset_kind).toBe("video_file")
    expect(assetBody.access_mode).toBe("locked")
    expect(assetBody.story_status).toBe("published")
    expect(assetBody.locked_delivery_status).toBe("ready")
    expect(assetBody.story_cdr_vault_uuid).toBe(9090)
    expect(assetBody.story_ip).toBe("0x3030303030303030303030303030303030303030")
    expect(assetBody.story_license_terms).toBe("19")
    expect(assetBody.story_royalty_registration_status).toBe("registered")

    const listingCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/listings`,
      {
        asset: postBody.asset,
        price_cents: 399,
        regional_pricing_enabled: false,
        status: "active",
      },
      ctx.env,
      author.accessToken,
    )
    expect(listingCreate.status).toBe(201)
    const listingBody = await json(listingCreate) as {
      id: string
    }

    const quoteCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/purchase-quotes`,
      {
        listing: listingBody.id,
        ...routedCheckoutQuoteFields,
      },
      ctx.env,
      buyer.accessToken,
    )
    expect(quoteCreate.status).toBe(201)
    const quoteBody = await json(quoteCreate) as {
      final_price_cents: number
      settlement_mode: string
    }
    expect(quoteBody.final_price_cents).toBe(399)
    expect(quoteBody.settlement_mode).toBe("royalty_native_story_payment")

    const accessResponse = await app.request(
      `http://pirate.test/communities/${communityId}/assets/${postBody.asset}/access`,
      {
        headers: {
          authorization: `Bearer ${author.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(accessResponse.status).toBe(200)
    const accessBody = await json(accessResponse) as {
      access_granted: boolean
      delivery_kind: string
      story_cdr_access: {
        vault_uuid: number
        mime_type: string
        ciphertext_ref: string
      } | null
    }
    expect(accessBody.access_granted).toBe(true)
    expect(accessBody.delivery_kind).toBe("story_cdr_ref")
    expect(accessBody.story_cdr_access?.vault_uuid).toBe(9090)
    expect(accessBody.story_cdr_access?.mime_type).toBe("video/mp4")
    expect(accessBody.story_cdr_access?.ciphertext_ref).toContain(`/assets/${postBody.asset.replace(/^asset_/, "")}/content`)

    const contentResponse = await app.request(
      `http://pirate.test/communities/${communityId}/assets/${postBody.asset}/content`,
      {
        headers: {
          authorization: `Bearer ${author.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(contentResponse.status).toBe(200)
    const encryptedBytes = new Uint8Array(await contentResponse.arrayBuffer())
    expect(encryptedBytes.byteLength).toBeGreaterThan(videoBytes.byteLength)
    expect(encryptedBytes).not.toEqual(videoBytes)
  })


})
