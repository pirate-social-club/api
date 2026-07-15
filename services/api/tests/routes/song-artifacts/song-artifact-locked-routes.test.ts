import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createClient } from "@libsql/client"
import { Wallet } from "ethers"
import { app } from "../../../src/index"
import { createRouteTestContext, json, resetRuntimeCaches } from "../../helpers"
import { getCommunityRepository } from "../../../src/lib/communities/db-community-repository"
import { buildLocalCommunityDbPath } from "../../../src/lib/communities/community-local-db"
import { processCommunityJobById } from "../../../src/lib/communities/jobs/runner"
import { COMMUNITY_JOB_MAX_ATTEMPTS } from "../../../src/lib/communities/jobs/runner-types"
import { reconcileRequestedLockedAssetDeliveryJobs } from "../../../src/lib/communities/jobs/locked-asset-delivery-handler"
import { reconcileStaleCommunityPurchaseSettlements } from "../../../src/lib/communities/commerce/settlement-service"
import { setStoryAccessProofSignerForTests } from "../../../src/lib/story/story-access-proof-service"
import { setStoryAssetPublisherForTests } from "../../../src/lib/story/story-publish-service"
import {
  resolveStoryRoyaltyDerivativeParents,
  setStoryRoyaltyRegistrarForTests,
} from "../../../src/lib/story/story-royalty-registration-service"
import {
  setStoryParentRoyaltyVaultTransferExecutorForTests,
  setStoryRoyaltyPurchaseSettlementExecutorForTests,
} from "../../../src/lib/story/story-royalty-settlement-service"
import { setStoryCdrUploaderForTests } from "../../../src/lib/story/story-cdr"
import { setStoryRuntimeFundingAssertionForTests } from "../../../src/lib/story/story-runtime-funding"
import { setCommunityCommerceBuyerFundingVerifierForTests } from "../../../src/lib/communities/commerce/funding-proof-service"
import {
  publicAssetAccessMessage,
  publicPurchaseQuoteMessage,
} from "../../../src/lib/communities/commerce/public-wallet-proof"
import { updateSongArtifactBundlePreview } from "../../../src/lib/song-artifacts/song-artifact-repository"
import { getControlPlaneClient } from "../../../src/lib/runtime-deps"
import { decodePublicAssetId } from "../../../src/lib/public-ids"
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

const compositeReadConditionAddress = "0xc0ffee0000000000000000000000000000000000"

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

async function markGeneratedPreviewFailed(input: {
  env: Env
  communityId: string
  songArtifactBundleId: string
  previewError: string
}): Promise<void> {
  await updateSongArtifactBundlePreview({
    client: getControlPlaneClient(input.env),
    communityId: input.communityId,
    songArtifactBundleId: input.songArtifactBundleId,
    previewAudio: null,
    previewStatus: "failed",
    previewError: input.previewError,
    updatedAt: new Date().toISOString(),
  })
}

async function markAssetRoyaltyAllocationVerified(input: {
  communityDbRoot: string
  communityId: string
  assetId: string
}): Promise<void> {
  const communityDb = createClient({
    url: `file:${buildLocalCommunityDbPath(input.communityDbRoot, input.communityId)}`,
  })
  try {
    const assetId = decodePublicAssetId(input.assetId)
    const now = new Date().toISOString()
    await communityDb.batch([
      {
        sql: `
          UPDATE assets
          SET royalty_allocation_status = 'verified',
              updated_at = ?2
          WHERE asset_id = ?1
        `,
        args: [assetId, now],
      },
      {
        sql: `
          UPDATE initial_royalty_allocations
          SET distribution_status = 'verified'
          WHERE asset_id = ?1
        `,
        args: [assetId],
      },
    ])
  } finally {
    communityDb.close()
  }
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
  testWithTimeout("creates locked song delivery asynchronously and finalizes it through the community job", async () => {
    const storedObjects = new Map<string, { body: Uint8Array; contentType: string }>()
    setStoryRuntimeFundingAssertionForTests(async () => {})
    setStoryCdrUploaderForTests(async () => ({
      cdrVaultUuid: 5151,
      writerAddress: "0x0000000000000000000000000000000000000cd1",
      txHashes: {
        allocate: "0xalloc-async",
        write: "0xwrite-async",
      },
    }))
    setStoryAssetPublisherForTests(async () => ({
      entitlementConfiguredTxHash: "0xconfigure-async",
      publishTxHash: "0xpublish-async",
    }))
    setStoryRoyaltyRegistrarForTests(async () => ({
      storyIpId: "0x5151515151515151515151515151515151515151",
      storyIpNftContract: "0x5252525252525252525252525252525252525252",
      storyIpNftTokenId: "515",
      storyLicenseTermsId: "51",
      storyLicenseTemplate: null,
      storyRoyaltyPolicy: "0xBe54FB168b3c982b7AaE60dB6CF75Bd8447b390E",
      storyDerivativeParentIpIds: null,
      storyRevenueToken: "0x1514000000000000000000000000000000000000",
      storyRoyaltyRegistrationStatus: "registered",
      storyDerivativeRegisteredAt: null,
    }))
    installLockedSongFetchMocks({
      originalFetch,
      storedObjects,
    })

    const ctx = await createRouteTestContext({
      STORY_LOCKED_DELIVERY_ASYNC: "true",
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
    })
    cleanup = ctx.cleanup

    const author = await exchangeJwt(ctx.env, "song-author-async-locked")
    const buyer = await exchangeJwt(ctx.env, "song-buyer-async-requested")
    await attachPrimaryWallet({
      client: ctx.client,
      userId: author.userId,
      walletAttachmentId: "wal_song_author_async_locked",
      walletAddress: "0xaaa0000000000000000000000000000000000000",
    })
    await verifyForLockedCommerce(ctx.env, author.userId, author.accessToken)
    const communityId = await createOpenSongCommunity(ctx.env, author.accessToken, "Async Paid Song Club")
    await addCommunityMember(String(ctx.env.LOCAL_COMMUNITY_DB_ROOT), communityId, buyer.userId)
    const primaryUpload = await uploadSongArtifact({
      env: ctx.env,
      communityId,
      accessToken: author.accessToken,
      artifactKind: "primary_audio",
      mimeType: "audio/mpeg",
      filename: "async-paid-anthem.mp3",
      bytes: new Uint8Array([31, 32, 33, 34]),
    })
    const bundleCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/song-artifacts`,
      {
        primary_audio: {
          song_artifact_upload: primaryUpload.id,
        },
        preview_window: {
          start_ms: 0,
          duration_ms: 30_000,
        },
        title: "Async Paid Anthem",
        lyrics: "Async paid line",
      },
      ctx.env,
      author.accessToken,
    )
    expect(bundleCreate.status).toBe(201)
    const bundleBody = await json(bundleCreate) as { id: string }
    await markGeneratedPreviewReady({
      env: ctx.env,
      communityId,
      songArtifactBundleId: bundleBody.id.replace(/^sab_/, ""),
      previewStorageRef: `http://pirate.test/generated-preview/${communityId}/async-paid-anthem.mp3`,
      previewSizeBytes: 4,
    })

    const postCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/posts`,
      {
        idempotency_key: "song-post-async-locked-1",
        post_type: "song",
        identity_mode: "public",
        title: "Async paid anthem",
        access_mode: "locked",
        song_mode: "original",
        rights_basis: "original",
        license_preset: "non-commercial",
        song_artifact_bundle: bundleBody.id,
      },
      ctx.env,
      author.accessToken,
    )
    expect(postCreate.status).toBe(201)
    const postBody = await json(postCreate) as {
      asset: string
      id: string
      status: string
    }
    expect(postBody.status).toBe("published")
    const assetId = postBody.asset

    const assetBeforeJob = await app.request(
      `http://pirate.test/communities/${communityId}/assets/${assetId}`,
      {
        headers: {
          authorization: `Bearer ${author.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(assetBeforeJob.status).toBe(200)
    const assetBeforeJobBody = await json(assetBeforeJob) as {
      locked_delivery_status: string
      story_status: string
    }
    expect(assetBeforeJobBody.locked_delivery_status).toBe("requested")
    expect(assetBeforeJobBody.story_status).toBe("requested")

    const creatorAccessBeforeJob = await app.request(
      `http://pirate.test/communities/${communityId}/assets/${assetId}/access`,
      {
        headers: {
          authorization: `Bearer ${author.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(creatorAccessBeforeJob.status).toBe(200)
    const creatorAccessBeforeJobBody = await json(creatorAccessBeforeJob) as {
      access_granted: boolean
      decision_reason: string
      locked_delivery_status: string
      delivery_kind: string | null
    }
    expect(creatorAccessBeforeJobBody.access_granted).toBe(false)
    expect(creatorAccessBeforeJobBody.decision_reason).toBe("delivery_pending")
    expect(creatorAccessBeforeJobBody.locked_delivery_status).toBe("requested")
    expect(creatorAccessBeforeJobBody.delivery_kind).toBeNull()

    const buyerAccessBeforeJob = await app.request(
      `http://pirate.test/communities/${communityId}/assets/${assetId}/access`,
      {
        headers: {
          authorization: `Bearer ${buyer.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(buyerAccessBeforeJob.status).toBe(200)
    const buyerAccessBeforeJobBody = await json(buyerAccessBeforeJob) as {
      access_granted: boolean
      decision_reason: string
      locked_delivery_status: string
      delivery_kind: string | null
    }
    expect(buyerAccessBeforeJobBody.access_granted).toBe(false)
    expect(buyerAccessBeforeJobBody.decision_reason).toBe("delivery_pending")
    expect(buyerAccessBeforeJobBody.locked_delivery_status).toBe("requested")
    expect(buyerAccessBeforeJobBody.delivery_kind).toBeNull()

    const publicContentBeforeJob = await app.request(
      `http://pirate.test/public-communities/${communityId}/assets/${assetId}/content`,
      {},
      ctx.env,
    )
    expect(publicContentBeforeJob.status).toBe(404)

    const creatorContentBeforeJob = await app.request(
      `http://pirate.test/communities/${communityId}/assets/${assetId}/content`,
      {
        headers: {
          authorization: `Bearer ${author.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(creatorContentBeforeJob.status).toBe(404)

    const listingCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/listings`,
      {
        asset: assetId,
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
      status: string
    }
    expect(listingBody.status).toBe("active")

    const publicBuyerWallet = Wallet.createRandom()
    const publicQuoteIssuedAt = Math.floor(Date.now() / 1000)
    const publicQuoteMessage = publicPurchaseQuoteMessage({
      communityId,
      listing: listingBody.id,
      walletAddress: publicBuyerWallet.address,
      chainRef: "eip155",
      nonce: "public-requested-quote-nonce",
      issuedAt: publicQuoteIssuedAt,
    })
    const publicQuoteBeforeJob = await requestJson(
      `http://pirate.test/public-communities/${communityId}/purchase-quotes`,
      {
        listing: listingBody.id,
        ...routedCheckoutQuoteFields,
        wallet_proof: {
          wallet_address: publicBuyerWallet.address,
          chain_ref: "eip155",
          nonce: "public-requested-quote-nonce",
          issued_at: publicQuoteIssuedAt,
          signature: await publicBuyerWallet.signMessage(publicQuoteMessage),
        },
      },
      ctx.env,
    )
    expect(publicQuoteBeforeJob.status).toBe(404)

    const communityDb = createClient({
      url: `file:${buildLocalCommunityDbPath(ctx.communityDbRoot, communityId)}`,
    })
    const jobRows = await communityDb.execute({
      sql: `
        SELECT job_id, job_type, subject_id, status
        FROM community_jobs
        WHERE job_type = 'locked_asset_delivery_prepare'
          AND subject_id = ?1
      `,
      args: [assetId.replace(/^asset_/, "")],
    })
    expect(jobRows.rows).toHaveLength(1)
    const originalJobId = String(jobRows.rows[0]?.job_id ?? "")
    expect(String(jobRows.rows[0]?.status)).toBe("queued")
    await communityDb.execute({
      sql: "DELETE FROM community_jobs WHERE job_id = ?1",
      args: [originalJobId],
    })
    const orphanedJobRows = await communityDb.execute({
      sql: `
        SELECT job_id
        FROM community_jobs
        WHERE job_type = 'locked_asset_delivery_prepare'
          AND subject_id = ?1
      `,
      args: [assetId.replace(/^asset_/, "")],
    })
    expect(orphanedJobRows.rows).toHaveLength(0)
    communityDb.close()

    const reconcileRepository = getCommunityRepository(ctx.env)
    try {
      const reconciled = await reconcileRequestedLockedAssetDeliveryJobs({
        env: ctx.env,
        communityRepository: reconcileRepository,
        communityIds: [communityId],
      })
      expect(reconciled.enqueued_jobs).toBe(1)
    } finally {
      await reconcileRepository.close?.()
    }

    const reconciledCommunityDb = createClient({
      url: `file:${buildLocalCommunityDbPath(ctx.communityDbRoot, communityId)}`,
    })
    const reconciledJobRows = await reconciledCommunityDb.execute({
      sql: `
        SELECT job_id, job_type, subject_id, status
        FROM community_jobs
        WHERE job_type = 'locked_asset_delivery_prepare'
          AND subject_id = ?1
      `,
      args: [assetId.replace(/^asset_/, "")],
    })
    expect(reconciledJobRows.rows).toHaveLength(1)
    let jobId = String(reconciledJobRows.rows[0]?.job_id ?? "")
    expect(jobId).not.toBe(originalJobId)
    expect(String(reconciledJobRows.rows[0]?.status)).toBe("queued")
    await reconciledCommunityDb.execute({
      sql: `
        UPDATE community_jobs
        SET status = 'failed',
            error_code = 'transient_test_failure',
            attempt_count = ?2,
            updated_at = ?3
        WHERE job_id = ?1
      `,
      args: [jobId, Math.max(1, COMMUNITY_JOB_MAX_ATTEMPTS - 1), new Date().toISOString()],
    })
    reconciledCommunityDb.close()

    const retriableFailedReconcileRepository = getCommunityRepository(ctx.env)
    try {
      const retriableFailedReconcile = await reconcileRequestedLockedAssetDeliveryJobs({
        env: ctx.env,
        communityRepository: retriableFailedReconcileRepository,
        communityIds: [communityId],
      })
      expect(retriableFailedReconcile.enqueued_jobs).toBe(0)
    } finally {
      await retriableFailedReconcileRepository.close?.()
    }

    const terminalFailedCommunityDb = createClient({
      url: `file:${buildLocalCommunityDbPath(ctx.communityDbRoot, communityId)}`,
    })
    await terminalFailedCommunityDb.execute({
      sql: `
        UPDATE community_jobs
        SET status = 'failed',
            error_code = 'terminal_test_failure',
            attempt_count = ?2,
            updated_at = ?3
        WHERE job_id = ?1
      `,
      args: [jobId, COMMUNITY_JOB_MAX_ATTEMPTS, new Date().toISOString()],
    })
    terminalFailedCommunityDb.close()

    const terminalFailedReconcileRepository = getCommunityRepository(ctx.env)
    try {
      const terminalFailedReconcile = await reconcileRequestedLockedAssetDeliveryJobs({
        env: ctx.env,
        communityRepository: terminalFailedReconcileRepository,
        communityIds: [communityId],
      })
      expect(terminalFailedReconcile.enqueued_jobs).toBe(1)
    } finally {
      await terminalFailedReconcileRepository.close?.()
    }

    const terminalReconciledCommunityDb = createClient({
      url: `file:${buildLocalCommunityDbPath(ctx.communityDbRoot, communityId)}`,
    })
    const terminalReconciledJobRows = await terminalReconciledCommunityDb.execute({
      sql: `
        SELECT job_id, status
        FROM community_jobs
        WHERE job_type = 'locked_asset_delivery_prepare'
          AND subject_id = ?1
        ORDER BY created_at DESC, job_id DESC
      `,
      args: [assetId.replace(/^asset_/, "")],
    })
    expect(terminalReconciledJobRows.rows).toHaveLength(2)
    jobId = String(terminalReconciledJobRows.rows[0]?.job_id ?? "")
    expect(String(terminalReconciledJobRows.rows[0]?.status)).toBe("queued")
    expect(jobId).not.toBe(originalJobId)
    terminalReconciledCommunityDb.close()

    const processRepository = getCommunityRepository(ctx.env)
    let processed
    try {
      processed = await processCommunityJobById({
        env: ctx.env,
        communityId,
        jobId,
        communityRepository: processRepository,
      })
    } finally {
      await processRepository.close?.()
    }
    expect(processed?.status).toBe("succeeded")

    const assetAfterJob = await app.request(
      `http://pirate.test/communities/${communityId}/assets/${assetId}`,
      {
        headers: {
          authorization: `Bearer ${author.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(assetAfterJob.status).toBe(200)
    const assetAfterJobBody = await json(assetAfterJob) as {
      locked_delivery_status: string
      story_cdr_vault_uuid: number
      story_ip: string | null
      story_royalty_registration_status: string | null
    }
    expect(assetAfterJobBody.locked_delivery_status).toBe("ready")
    expect(assetAfterJobBody.story_cdr_vault_uuid).toBe(5151)
    expect(assetAfterJobBody.story_ip).toBe("0x5151515151515151515151515151515151515151")
    expect(assetAfterJobBody.story_royalty_registration_status).toBe("registered")

    const noOpReconcileRepository = getCommunityRepository(ctx.env)
    try {
      const noOpReconcile = await reconcileRequestedLockedAssetDeliveryJobs({
        env: ctx.env,
        communityRepository: noOpReconcileRepository,
        communityIds: [communityId],
      })
      expect(noOpReconcile.enqueued_jobs).toBe(0)
    } finally {
      await noOpReconcileRepository.close?.()
    }

    const settledCommunityDb = createClient({
      url: `file:${buildLocalCommunityDbPath(ctx.communityDbRoot, communityId)}`,
    })
    try {
      const settledJobRows = await settledCommunityDb.execute({
        sql: `
          SELECT job_id, status, attempt_count
          FROM community_jobs
          WHERE job_type = 'locked_asset_delivery_prepare'
            AND subject_id = ?1
          ORDER BY created_at DESC, job_id DESC
        `,
        args: [assetId.replace(/^asset_/, "")],
      })
      expect(settledJobRows.rows).toHaveLength(2)
      expect(String(settledJobRows.rows[0]?.job_id ?? "")).toBe(jobId)
      expect(String(settledJobRows.rows[0]?.status ?? "")).toBe("succeeded")
      expect(String(settledJobRows.rows[1]?.status ?? "")).toBe("failed")
      expect(Number(settledJobRows.rows[1]?.attempt_count ?? 0)).toBe(COMMUNITY_JOB_MAX_ATTEMPTS)
    } finally {
      settledCommunityDb.close()
    }
  }, 30_000)

  testWithTimeout("repairs a partially completed locked delivery instead of rerunning Story publish", async () => {
    const storedObjects = new Map<string, { body: Uint8Array; contentType: string }>()
    setStoryRuntimeFundingAssertionForTests(async () => {
      throw new Error("partial repair should not assert Story signer funding")
    })
    setStoryCdrUploaderForTests(async () => {
      throw new Error("partial repair should not write CDR again")
    })
    setStoryAssetPublisherForTests(async () => {
      throw new Error("partial repair should not publish Story again")
    })
    setStoryRoyaltyRegistrarForTests(async () => {
      throw new Error("partial repair should not register Story royalties again")
    })
    installLockedSongFetchMocks({
      originalFetch,
      storedObjects,
    })

    const ctx = await createRouteTestContext({
      STORY_LOCKED_DELIVERY_ASYNC: "true",
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
    })
    cleanup = ctx.cleanup

    const author = await exchangeJwt(ctx.env, "song-author-partial-locked-repair")
    await attachPrimaryWallet({
      client: ctx.client,
      userId: author.userId,
      walletAttachmentId: "wal_song_author_partial_locked_repair",
      walletAddress: "0xaaa0000000000000000000000000000000000000",
    })
    await verifyForLockedCommerce(ctx.env, author.userId, author.accessToken)
    const communityId = await createOpenSongCommunity(ctx.env, author.accessToken, "Partial Repair Song Club")
    const primaryUpload = await uploadSongArtifact({
      env: ctx.env,
      communityId,
      accessToken: author.accessToken,
      artifactKind: "primary_audio",
      mimeType: "audio/mpeg",
      filename: "partial-repair-anthem.mp3",
      bytes: new Uint8Array([71, 72, 73, 74]),
    })
    const bundleCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/song-artifacts`,
      {
        primary_audio: {
          song_artifact_upload: primaryUpload.id,
        },
        preview_window: {
          start_ms: 0,
          duration_ms: 30_000,
        },
        title: "Partial Repair Anthem",
        lyrics: "Partial repair line",
      },
      ctx.env,
      author.accessToken,
    )
    expect(bundleCreate.status).toBe(201)
    const bundleBody = await json(bundleCreate) as { id: string }
    await markGeneratedPreviewReady({
      env: ctx.env,
      communityId,
      songArtifactBundleId: bundleBody.id.replace(/^sab_/, ""),
      previewStorageRef: `http://pirate.test/generated-preview/${communityId}/partial-repair-anthem.mp3`,
      previewSizeBytes: 4,
    })

    const postCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/posts`,
      {
        idempotency_key: "song-post-partial-locked-repair-1",
        post_type: "song",
        identity_mode: "public",
        title: "Partial repair anthem",
        access_mode: "locked",
        song_mode: "original",
        rights_basis: "original",
        license_preset: "non-commercial",
        song_artifact_bundle: bundleBody.id,
      },
      ctx.env,
      author.accessToken,
    )
    expect(postCreate.status).toBe(201)
    const postBody = await json(postCreate) as {
      asset: string
      status: string
    }
    expect(postBody.status).toBe("published")
    const assetId = postBody.asset.replace(/^asset_/, "")

    const communityDb = createClient({
      url: `file:${buildLocalCommunityDbPath(ctx.communityDbRoot, communityId)}`,
    })
    const jobRows = await communityDb.execute({
      sql: `
        SELECT job_id
        FROM community_jobs
        WHERE job_type = 'locked_asset_delivery_prepare'
          AND subject_id = ?1
      `,
      args: [assetId],
    })
    expect(jobRows.rows).toHaveLength(1)
    const jobId = String(jobRows.rows[0]?.job_id ?? "")
    const now = new Date().toISOString()
    await communityDb.execute({
      sql: `
        UPDATE assets
        SET publication_status = 'story_requested',
            story_status = 'failed',
            story_error = 'story_publish_failed:duplicate entitlement class',
            story_ip_id = '0x7171717171717171717171717171717171717171',
            story_ip_nft_contract = '0x7272727272727272727272727272727272727272',
            story_ip_nft_token_id = '717',
            story_publish_model = 'story_ip_v1',
            story_license_terms_id = '71',
            story_royalty_policy = '0xBe54FB168b3c982b7AaE60dB6CF75Bd8447b390E',
            story_royalty_policy_id = '0xBe54FB168b3c982b7AaE60dB6CF75Bd8447b390E',
            story_revenue_token = '0x1714000000000000000000000000000000000000',
            story_royalty_registration_status = 'registered',
            story_publish_tx_ref = '0xpublish-partial-repair',
            story_asset_version_id = ?2,
            story_cdr_vault_uuid = 7171,
            story_namespace = ?3,
            story_entitlement_token_id = '717171',
            story_read_condition = '0x29a859d9012ffc73443af5e3264c1605d44f6bcc',
            story_write_condition = '0xa8e49520c4d681d34fde757c41f5a06b87b52e43',
            locked_delivery_status = 'failed',
            locked_delivery_ref = ?4,
            locked_delivery_error = 'story_publish_failed:duplicate entitlement class',
            locked_delivery_storage_ref = 'locked-assets/partial-repair.enc',
            locked_delivery_secret_json = ?5,
            updated_at = ?6
        WHERE asset_id = ?1
      `,
      args: [
        assetId,
        `0x${"71".repeat(32)}`,
        `0x${"72".repeat(32)}`,
        `/communities/${communityId}/assets/${assetId}/content`,
        JSON.stringify({
          algorithm: "AES-GCM",
          iv_b64: "AAECAwQFBgcICQoL",
          mime_type: "audio/mpeg",
        }),
        now,
      ],
    })
    communityDb.close()

    const processRepository = getCommunityRepository(ctx.env)
    let processed
    try {
      processed = await processCommunityJobById({
        env: ctx.env,
        communityId,
        jobId,
        communityRepository: processRepository,
      })
    } finally {
      await processRepository.close?.()
    }
    expect(processed?.status).toBe("succeeded")

    const assetAfterRepair = await app.request(
      `http://pirate.test/communities/${communityId}/assets/asset_${assetId}`,
      {
        headers: {
          authorization: `Bearer ${author.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(assetAfterRepair.status).toBe(200)
    const assetAfterRepairBody = await json(assetAfterRepair) as {
      locked_delivery_status: string
      locked_delivery_error: string | null
      story_status: string
      story_error: string | null
      story_cdr_vault_uuid: number
      story_entitlement_token: string | null
    }
    expect(assetAfterRepairBody.locked_delivery_status).toBe("ready")
    expect(assetAfterRepairBody.locked_delivery_error).toBeNull()
    expect(assetAfterRepairBody.story_status).toBe("published")
    expect(assetAfterRepairBody.story_error).toBeNull()
    expect(assetAfterRepairBody.story_cdr_vault_uuid).toBe(7171)
    expect(assetAfterRepairBody.story_entitlement_token).toBe("717171")
  }, 30_000)

  testWithTimeout("allows locked song publishing while preview is pending and gates access until preview is ready", async () => {
    const storedObjects = new Map<string, { body: Uint8Array; contentType: string }>()
    setStoryRuntimeFundingAssertionForTests(async () => {})
    setStoryCdrUploaderForTests(async () => ({
      cdrVaultUuid: 6161,
      writerAddress: "0x0000000000000000000000000000000000000cd2",
      txHashes: {
        allocate: "0xalloc-preview-pending",
        write: "0xwrite-preview-pending",
      },
    }))
    setStoryAssetPublisherForTests(async () => ({
      entitlementConfiguredTxHash: "0xconfigure-preview-pending",
      publishTxHash: "0xpublish-preview-pending",
    }))
    setStoryRoyaltyRegistrarForTests(async () => ({
      storyIpId: "0x6161616161616161616161616161616161616161",
      storyIpNftContract: "0x6262626262626262626262626262626262626262",
      storyIpNftTokenId: "616",
      storyLicenseTermsId: "61",
      storyLicenseTemplate: null,
      storyRoyaltyPolicy: "0xBe54FB168b3c982b7AaE60dB6CF75Bd8447b390E",
      storyDerivativeParentIpIds: null,
      storyRevenueToken: "0x1614000000000000000000000000000000000000",
      storyRoyaltyRegistrationStatus: "registered",
      storyDerivativeRegisteredAt: null,
    }))
    setStoryAccessProofSignerForTests(async (input) => ({
      digest: "0xd1e57061",
      signature: `0x${"61".repeat(65)}` as `0x${string}`,
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
      STORY_LOCKED_DELIVERY_ASYNC: "true",
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
      STORY_COMPOSITE_READ_CONDITION_ADDRESS: compositeReadConditionAddress,
    })
    cleanup = ctx.cleanup

    const author = await exchangeJwt(ctx.env, "song-author-preview-pending")
    const buyer = await exchangeJwt(ctx.env, "song-buyer-preview-pending")
    await attachPrimaryWallet({
      client: ctx.client,
      userId: author.userId,
      walletAttachmentId: "wal_song_author_preview_pending",
      walletAddress: "0xaaa1000000000000000000000000000000000000",
    })
    await verifyForLockedCommerce(ctx.env, author.userId, author.accessToken)
    const communityId = await createOpenSongCommunity(ctx.env, author.accessToken, "Preview Pending Song Club")
    await addCommunityMember(String(ctx.env.LOCAL_COMMUNITY_DB_ROOT), communityId, buyer.userId)
    const primaryUpload = await uploadSongArtifact({
      env: ctx.env,
      communityId,
      accessToken: author.accessToken,
      artifactKind: "primary_audio",
      mimeType: "audio/mpeg",
      filename: "preview-pending-anthem.mp3",
      bytes: new Uint8Array([41, 42, 43, 44]),
    })
    const bundleCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/song-artifacts`,
      {
        primary_audio: {
          song_artifact_upload: primaryUpload.id,
        },
        preview_window: {
          start_ms: 0,
          duration_ms: 30_000,
        },
        title: "Preview Pending Anthem",
        lyrics: "Preview pending line",
      },
      ctx.env,
      author.accessToken,
    )
    expect(bundleCreate.status).toBe(201)
    const bundleBody = await json(bundleCreate) as { id: string }

    const postCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/posts`,
      {
        idempotency_key: "song-post-preview-pending-1",
        post_type: "song",
        identity_mode: "public",
        title: "Preview pending anthem",
        access_mode: "locked",
        song_mode: "original",
        rights_basis: "original",
        license_preset: "non-commercial",
        song_artifact_bundle: bundleBody.id,
      },
      ctx.env,
      author.accessToken,
    )
    expect(postCreate.status).toBe(201)
    const postBody = await json(postCreate) as {
      asset: string
    }
    expect(typeof postBody.asset === "string" && postBody.asset.length > 0).toBe(true)
    const assetId = postBody.asset

    const communityDb = createClient({
      url: `file:${buildLocalCommunityDbPath(ctx.communityDbRoot, communityId)}`,
    })
    const jobRows = await communityDb.execute({
      sql: `
        SELECT job_id
        FROM community_jobs
        WHERE job_type = 'locked_asset_delivery_prepare'
          AND subject_id = ?1
      `,
      args: [assetId.replace(/^asset_/, "")],
    })
    communityDb.close()
    expect(jobRows.rows).toHaveLength(1)
    const jobId = String(jobRows.rows[0]?.job_id ?? "")
    const processRepository = getCommunityRepository(ctx.env)
    try {
      const processed = await processCommunityJobById({
        env: ctx.env,
        communityId,
        jobId,
        communityRepository: processRepository,
      })
      expect(processed?.status).toBe("succeeded")
    } finally {
      await processRepository.close?.()
    }

    const creatorAccessBeforePreview = await app.request(
      `http://pirate.test/communities/${communityId}/assets/${assetId}/access`,
      {
        headers: {
          authorization: `Bearer ${author.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(creatorAccessBeforePreview.status).toBe(200)
    const creatorAccessBeforePreviewBody = await json(creatorAccessBeforePreview) as {
      access_granted: boolean
      bundle_preview_status: string | null
      decision_reason: string
      story_cdr_access: unknown
    }
    expect(creatorAccessBeforePreviewBody.access_granted).toBe(false)
    expect(creatorAccessBeforePreviewBody.decision_reason).toBe("preview_pending")
    expect(creatorAccessBeforePreviewBody.bundle_preview_status).toBe("pending")
    expect(creatorAccessBeforePreviewBody.story_cdr_access).toBeNull()

    const buyerAccessBeforePreview = await app.request(
      `http://pirate.test/communities/${communityId}/assets/${assetId}/access`,
      {
        headers: {
          authorization: `Bearer ${buyer.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(buyerAccessBeforePreview.status).toBe(200)
    const buyerAccessBeforePreviewBody = await json(buyerAccessBeforePreview) as {
      access_granted: boolean
      bundle_preview_status: string | null
      decision_reason: string
    }
    expect(buyerAccessBeforePreviewBody.access_granted).toBe(false)
    expect(buyerAccessBeforePreviewBody.decision_reason).toBe("preview_pending")
    expect(buyerAccessBeforePreviewBody.bundle_preview_status).toBe("pending")

    await markGeneratedPreviewReady({
      env: ctx.env,
      communityId,
      songArtifactBundleId: bundleBody.id.replace(/^sab_/, ""),
      previewStorageRef: `http://pirate.test/generated-preview/${communityId}/preview-pending-anthem.mp3`,
      previewSizeBytes: 4,
    })

    const creatorAccessAfterPreview = await app.request(
      `http://pirate.test/communities/${communityId}/assets/${assetId}/access`,
      {
        headers: {
          authorization: `Bearer ${author.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(creatorAccessAfterPreview.status).toBe(200)
    const creatorAccessAfterPreviewBody = await json(creatorAccessAfterPreview) as {
      access_granted: boolean
      bundle_preview_status: string | null
      decision_reason: string
      story_cdr_access?: {
        vault_uuid?: number
        read_condition_address?: string
        access_aux_data_hex?: string
        access_proof?: { mode?: string }
      } | null
    }
    expect(creatorAccessAfterPreviewBody.access_granted).toBe(true)
    expect(creatorAccessAfterPreviewBody.decision_reason).toBe("creator")
    expect(creatorAccessAfterPreviewBody.bundle_preview_status).toBe("completed")
    expect(creatorAccessAfterPreviewBody.story_cdr_access?.vault_uuid).toBe(6161)
    expect(creatorAccessAfterPreviewBody.story_cdr_access?.read_condition_address?.toLowerCase()).toBe(
      compositeReadConditionAddress,
    )
    expect(creatorAccessAfterPreviewBody.story_cdr_access?.access_aux_data_hex).not.toBe("0x")
    expect(creatorAccessAfterPreviewBody.story_cdr_access?.access_proof?.mode).toBeUndefined()

    const buyerAccessAfterPreview = await app.request(
      `http://pirate.test/communities/${communityId}/assets/${assetId}/access`,
      {
        headers: {
          authorization: `Bearer ${buyer.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(buyerAccessAfterPreview.status).toBe(200)
    const buyerAccessAfterPreviewBody = await json(buyerAccessAfterPreview) as {
      access_granted: boolean
      bundle_preview_status: string | null
      decision_reason: string
    }
    expect(buyerAccessAfterPreviewBody.access_granted).toBe(false)
    expect(buyerAccessAfterPreviewBody.decision_reason).toBe("purchase_required")
    expect(buyerAccessAfterPreviewBody.bundle_preview_status).toBe("completed")

    const failedPreviewUpload = await uploadSongArtifact({
      env: ctx.env,
      communityId,
      accessToken: author.accessToken,
      artifactKind: "primary_audio",
      mimeType: "audio/mpeg",
      filename: "failed-preview-anthem.mp3",
      bytes: new Uint8Array([45, 46, 47, 48]),
    })
    const failedBundleCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/song-artifacts`,
      {
        primary_audio: {
          song_artifact_upload: failedPreviewUpload.id,
        },
        preview_window: {
          start_ms: 0,
          duration_ms: 30_000,
        },
        title: "Failed Preview Anthem",
        lyrics: "Failed preview line",
      },
      ctx.env,
      author.accessToken,
    )
    expect(failedBundleCreate.status).toBe(201)
    const failedBundleBody = await json(failedBundleCreate) as { id: string }
    await markGeneratedPreviewFailed({
      env: ctx.env,
      communityId,
      songArtifactBundleId: failedBundleBody.id.replace(/^sab_/, ""),
      previewError: "ffmpeg exited with test failure",
    })
    const failedPreviewPostCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/posts`,
      {
        idempotency_key: "song-post-failed-preview-1",
        post_type: "song",
        identity_mode: "public",
        title: "Failed preview anthem",
        access_mode: "locked",
        song_mode: "original",
        rights_basis: "original",
        license_preset: "non-commercial",
        song_artifact_bundle: failedBundleBody.id,
      },
      ctx.env,
      author.accessToken,
    )
    expect(failedPreviewPostCreate.status).toBe(400)
    const failedPreviewPostBody = await json(failedPreviewPostCreate) as { message: string }
    expect(failedPreviewPostBody.message).toBe("Song preview is not ready for locked publishing")
  }, 30_000)

  testWithTimeout("marks async locked song delivery failed when CDR write fails", async () => {
    const storedObjects = new Map<string, { body: Uint8Array; contentType: string }>()
    setStoryRuntimeFundingAssertionForTests(async () => {})
    setStoryCdrUploaderForTests(async () => {
      throw new Error("cdr_write_failed:test forced CDR failure")
    })
    installLockedSongFetchMocks({
      originalFetch,
      storedObjects,
    })

    const ctx = await createRouteTestContext({
      STORY_LOCKED_DELIVERY_ASYNC: "true",
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
    })
    cleanup = ctx.cleanup

    const author = await exchangeJwt(ctx.env, "song-author-async-locked-failure")
    await attachPrimaryWallet({
      client: ctx.client,
      userId: author.userId,
      walletAttachmentId: "wal_song_author_async_locked_failure",
      walletAddress: "0xaaa1000000000000000000000000000000000000",
    })
    await verifyForLockedCommerce(ctx.env, author.userId, author.accessToken)
    const communityId = await createOpenSongCommunity(ctx.env, author.accessToken, "Async Failed Paid Song Club")
    const primaryUpload = await uploadSongArtifact({
      env: ctx.env,
      communityId,
      accessToken: author.accessToken,
      artifactKind: "primary_audio",
      mimeType: "audio/mpeg",
      filename: "async-failed-paid-anthem.mp3",
      bytes: new Uint8Array([41, 42, 43, 44]),
    })
    const bundleCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/song-artifacts`,
      {
        primary_audio: {
          song_artifact_upload: primaryUpload.id,
        },
        preview_window: {
          start_ms: 0,
          duration_ms: 30_000,
        },
        title: "Async Failed Paid Anthem",
        lyrics: "Async failed paid line",
      },
      ctx.env,
      author.accessToken,
    )
    expect(bundleCreate.status).toBe(201)
    const bundleBody = await json(bundleCreate) as { id: string }
    await markGeneratedPreviewReady({
      env: ctx.env,
      communityId,
      songArtifactBundleId: bundleBody.id.replace(/^sab_/, ""),
      previewStorageRef: `http://pirate.test/generated-preview/${communityId}/async-failed-paid-anthem.mp3`,
      previewSizeBytes: 4,
    })

    const postCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/posts`,
      {
        idempotency_key: "song-post-async-locked-failure-1",
        post_type: "song",
        identity_mode: "public",
        title: "Async failed paid anthem",
        access_mode: "locked",
        song_mode: "original",
        rights_basis: "original",
        license_preset: "non-commercial",
        song_artifact_bundle: bundleBody.id,
      },
      ctx.env,
      author.accessToken,
    )
    expect(postCreate.status).toBe(201)
    const postBody = await json(postCreate) as {
      asset: string
      id: string
      status: string
    }
    expect(postBody.status).toBe("published")
    const assetId = postBody.asset

    const communityDb = createClient({
      url: `file:${buildLocalCommunityDbPath(ctx.communityDbRoot, communityId)}`,
    })
    const jobRows = await communityDb.execute({
      sql: `
        SELECT job_id
        FROM community_jobs
        WHERE job_type = 'locked_asset_delivery_prepare'
          AND subject_id = ?1
      `,
      args: [assetId.replace(/^asset_/, "")],
    })
    expect(jobRows.rows).toHaveLength(1)
    const jobId = String(jobRows.rows[0]?.job_id ?? "")
    communityDb.close()

    const processRepository = getCommunityRepository(ctx.env)
    let processed
    try {
      processed = await processCommunityJobById({
        env: ctx.env,
        communityId,
        jobId,
        communityRepository: processRepository,
      })
    } finally {
      await processRepository.close?.()
    }
    expect(processed?.status).toBe("failed")
    expect(processed?.error_code).toContain("cdr_write_failed:test forced CDR failure")

    const assetAfterRetryableFailure = await app.request(
      `http://pirate.test/communities/${communityId}/assets/${assetId}`,
      {
        headers: {
          authorization: `Bearer ${author.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(assetAfterRetryableFailure.status).toBe(200)
    const assetAfterRetryableFailureBody = await json(assetAfterRetryableFailure) as {
      locked_delivery_status: string
      locked_delivery_error: string | null
      story_status: string
    }
    expect(assetAfterRetryableFailureBody.locked_delivery_status).toBe("requested")
    expect(assetAfterRetryableFailureBody.locked_delivery_error).toContain("cdr_write_failed:test forced CDR failure")
    expect(assetAfterRetryableFailureBody.story_status).toBe("requested")

    const postAfterJob = await app.request(
      `http://pirate.test/posts/${postBody.id}`,
      {
        headers: {
          authorization: `Bearer ${author.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(postAfterJob.status).toBe(200)
    const postAfterJobBody = await json(postAfterJob) as {
      post: {
        status: string
      }
    }
    expect(postAfterJobBody.post.status).toBe("published")

    const accessAfterRetryableFailure = await app.request(
      `http://pirate.test/communities/${communityId}/assets/${assetId}/access`,
      {
        headers: {
          authorization: `Bearer ${author.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(accessAfterRetryableFailure.status).toBe(200)
    const accessAfterRetryableFailureBody = await json(accessAfterRetryableFailure) as {
      access_granted: boolean
      decision_reason: string
      locked_delivery_status: string
      delivery_kind: string | null
    }
    expect(accessAfterRetryableFailureBody.access_granted).toBe(false)
    expect(accessAfterRetryableFailureBody.decision_reason).toBe("delivery_pending")
    expect(accessAfterRetryableFailureBody.locked_delivery_status).toBe("requested")
    expect(accessAfterRetryableFailureBody.delivery_kind).toBeNull()

    const terminalFailureDb = createClient({
      url: `file:${buildLocalCommunityDbPath(ctx.communityDbRoot, communityId)}`,
    })
    await terminalFailureDb.execute({
      sql: `
        UPDATE community_jobs
        SET status = 'failed',
            attempt_count = ?2,
            available_at = NULL,
            updated_at = ?3
        WHERE job_id = ?1
      `,
      args: [jobId, Math.max(1, COMMUNITY_JOB_MAX_ATTEMPTS - 1), new Date().toISOString()],
    })
    terminalFailureDb.close()

    const terminalProcessRepository = getCommunityRepository(ctx.env)
    let terminalProcessed
    try {
      terminalProcessed = await processCommunityJobById({
        env: ctx.env,
        communityId,
        jobId,
        communityRepository: terminalProcessRepository,
      })
    } finally {
      await terminalProcessRepository.close?.()
    }
    expect(terminalProcessed?.status).toBe("failed")
    expect(terminalProcessed?.attempt_count).toBe(COMMUNITY_JOB_MAX_ATTEMPTS)
    expect(terminalProcessed?.error_code).toContain("cdr_write_failed:test forced CDR failure")

    const assetAfterTerminalFailure = await app.request(
      `http://pirate.test/communities/${communityId}/assets/${assetId}`,
      {
        headers: {
          authorization: `Bearer ${author.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(assetAfterTerminalFailure.status).toBe(200)
    const assetAfterTerminalFailureBody = await json(assetAfterTerminalFailure) as {
      locked_delivery_status: string
      locked_delivery_error: string | null
      story_status: string
    }
    expect(assetAfterTerminalFailureBody.locked_delivery_status).toBe("failed")
    expect(assetAfterTerminalFailureBody.locked_delivery_error).toContain("cdr_write_failed:test forced CDR failure")
    expect(assetAfterTerminalFailureBody.story_status).toBe("failed")

    const accessAfterTerminalFailure = await app.request(
      `http://pirate.test/communities/${communityId}/assets/${assetId}/access`,
      {
        headers: {
          authorization: `Bearer ${author.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(accessAfterTerminalFailure.status).toBe(200)
    const accessAfterTerminalFailureBody = await json(accessAfterTerminalFailure) as {
      access_granted: boolean
      decision_reason: string
      locked_delivery_status: string
      delivery_kind: string | null
    }
    expect(accessAfterTerminalFailureBody.access_granted).toBe(false)
    expect(accessAfterTerminalFailureBody.decision_reason).toBe("delivery_pending")
    expect(accessAfterTerminalFailureBody.locked_delivery_status).toBe("failed")
    expect(accessAfterTerminalFailureBody.delivery_kind).toBeNull()
  }, 30_000)

  testWithTimeout("publishes a locked song, sells access, and decrypts the purchased asset", async () => {
    const storedObjects = new Map<string, { body: Uint8Array; contentType: string }>()
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
        title: "Paid Anthem",
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
    expect(authorAssetBody.display_title).toBe("Paid Anthem")
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

    await markAssetRoyaltyAllocationVerified({
      communityDbRoot: ctx.communityDbRoot,
      communityId,
      assetId,
    })

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

    const publicBuyerWallet = Wallet.createRandom()
    const publicQuoteIssuedAt = Math.floor(Date.now() / 1000)
    const publicQuoteNonce = "public-quote-nonce-1"
    const publicQuoteMessage = publicPurchaseQuoteMessage({
      communityId,
      listing: listingBody.id,
      walletAddress: publicBuyerWallet.address,
      chainRef: "eip155",
      nonce: publicQuoteNonce,
      issuedAt: publicQuoteIssuedAt,
    })
    const publicQuoteCreate = await requestJson(
      `http://pirate.test/public-communities/${communityId}/purchase-quotes`,
      {
        listing: listingBody.id,
        ...routedCheckoutQuoteFields,
        wallet_proof: {
          wallet_address: publicBuyerWallet.address,
          chain_ref: "eip155",
          nonce: publicQuoteNonce,
          issued_at: publicQuoteIssuedAt,
          signature: await publicBuyerWallet.signMessage(publicQuoteMessage),
        },
      },
      ctx.env,
    )
    expect(publicQuoteCreate.status).toBe(201)
    const publicQuoteBody = await json(publicQuoteCreate) as {
      id: string
      buyer_kind: string
      buyer_wallet: { address: string }
      final_price_cents: number
    }
    expect(publicQuoteBody.buyer_kind).toBe("wallet")
    expect(publicQuoteBody.buyer_wallet.address).toBe(publicBuyerWallet.address)
    expect(publicQuoteBody.final_price_cents).toBe(499)

    const publicAccessIssuedAt = Math.floor(Date.now() / 1000)
    const publicAccessNonce = "public-access-nonce-1"
    const publicAccessMessage = publicAssetAccessMessage({
      communityId,
      asset: assetId,
      walletAddress: publicBuyerWallet.address,
      chainRef: "eip155",
      nonce: publicAccessNonce,
      issuedAt: publicAccessIssuedAt,
    })
    const publicAccessBeforePurchase = await requestJson(
      `http://pirate.test/public-communities/${communityId}/assets/${assetId}/access`,
      {
        wallet_proof: {
          wallet_address: publicBuyerWallet.address,
          chain_ref: "eip155",
          nonce: publicAccessNonce,
          issued_at: publicAccessIssuedAt,
          signature: await publicBuyerWallet.signMessage(publicAccessMessage),
        },
      },
      ctx.env,
    )
    expect(publicAccessBeforePurchase.status).toBe(200)
    const publicAccessBeforePurchaseBody = await json(publicAccessBeforePurchase) as {
      access_granted: boolean
      decision_reason: string | null
    }
    expect(publicAccessBeforePurchaseBody.access_granted).toBe(false)
    expect(publicAccessBeforePurchaseBody.decision_reason).toBe("purchase_required")

    const publicPurchaseSettle = await requestJson(
      `http://pirate.test/public-communities/${communityId}/purchase-settlements`,
      {
        quote: publicQuoteBody.id,
        funding_tx_ref: "0xfunding-public-paid-song-1",
        settlement_tx_ref: "tx-public-paid-song-1",
      },
      ctx.env,
    )
    expect(publicPurchaseSettle.status).toBe(201)
    const publicPurchaseBody = await json(publicPurchaseSettle) as {
      buyer_kind: string
      buyer_wallet: { address: string }
      settlement_wallet_attachment: string | null
      settlement_tx_ref: string
      entitlement_kind: string
      entitlement_target_ref: string
    }
    expect(publicPurchaseBody.buyer_kind).toBe("wallet")
    expect(publicPurchaseBody.buyer_wallet.address).toBe(publicBuyerWallet.address)
    expect(publicPurchaseBody.settlement_wallet_attachment).toBeNull()
    expect(publicPurchaseBody.settlement_tx_ref).toBe("0xroyalty-paid-song")
    expect(publicPurchaseBody.entitlement_kind).toBe("asset_access")
    expect(publicPurchaseBody.entitlement_target_ref).toBe(assetId)
    expect(royaltySettlementCalls.at(-1)?.buyerAddress).toBe(publicBuyerWallet.address)

    const publicAccessAfterPurchaseIssuedAt = Math.floor(Date.now() / 1000)
    const publicAccessAfterPurchaseNonce = "public-access-nonce-2"
    const publicAccessAfterPurchaseMessage = publicAssetAccessMessage({
      communityId,
      asset: assetId,
      walletAddress: publicBuyerWallet.address,
      chainRef: "eip155",
      nonce: publicAccessAfterPurchaseNonce,
      issuedAt: publicAccessAfterPurchaseIssuedAt,
    })
    const publicAccessAfterPurchase = await requestJson(
      `http://pirate.test/public-communities/${communityId}/assets/${assetId}/access`,
      {
        wallet_proof: {
          wallet_address: publicBuyerWallet.address,
          chain_ref: "eip155",
          nonce: publicAccessAfterPurchaseNonce,
          issued_at: publicAccessAfterPurchaseIssuedAt,
          signature: await publicBuyerWallet.signMessage(publicAccessAfterPurchaseMessage),
        },
      },
      ctx.env,
    )
    expect(publicAccessAfterPurchase.status).toBe(200)
    const publicAccessAfterPurchaseBody = await json(publicAccessAfterPurchase) as {
      access_granted: boolean
      decision_reason: string | null
      story_cdr_access?: {
        access_scope: string
        ciphertext_ref: string
      }
    }
    expect(publicAccessAfterPurchaseBody.access_granted).toBe(true)
    expect(publicAccessAfterPurchaseBody.decision_reason).toBe("purchase_entitlement")
    expect(publicAccessAfterPurchaseBody.story_cdr_access?.access_scope).toBe("asset.share")
    expect(publicAccessAfterPurchaseBody.story_cdr_access?.ciphertext_ref).toBe(
      `/public-communities/com_${communityId}/assets/${assetId}/content`,
    )

    const publicCiphertextAfterPurchase = await app.request(
      `http://pirate.test/public-communities/${communityId}/assets/${assetId}/content`,
      {},
      ctx.env,
    )
    expect(publicCiphertextAfterPurchase.status).toBe(200)
    expect(publicCiphertextAfterPurchase.headers.get("content-type")).toBe("application/octet-stream")
    const publicCiphertext = new Uint8Array(await publicCiphertextAfterPurchase.arrayBuffer())
    expect(publicCiphertext).not.toEqual(primaryBytes)

    charityPayoutCalls.length = 0
    royaltySettlementCalls.length = 0

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

    const purchaseEffects = await app.request(
      `http://pirate.test/communities/${communityId}/purchases/${purchaseBody.id}/settlement-effects`,
      {
        headers: {
          authorization: `Bearer ${buyer.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(purchaseEffects.status).toBe(200)
    const purchaseEffectsBody = await json(purchaseEffects) as {
      items: Array<{
        quote: string
        purchase: string
        effect_kind: string
        effect_ref: string
        status: string
        settlement_ref: string | null
        provider_receipt_ref: string | null
        tax_receipt_ref: string | null
        attempt_count: number
      }>
      next_cursor: string | null
    }
    expect(purchaseEffectsBody.next_cursor).toBeNull()
    expect(purchaseEffectsBody.items).toHaveLength(4)
    expect(purchaseEffectsBody.items.map((effect) => effect.effect_kind).sort()).toEqual([
      "buyer_funding_receipt",
      "charity_payout",
      "story_entitlement_mint",
      "story_royalty_payment",
    ])
    expect(purchaseEffectsBody.items).toContainEqual(expect.objectContaining({
      quote: quoteBody.id,
      purchase: purchaseBody.id,
      effect_kind: "buyer_funding_receipt",
      effect_ref: "0xfunding-paid-song-1",
      status: "confirmed",
      settlement_ref: "0xfunding-paid-song-1",
      attempt_count: 1,
    }))
    expect(purchaseEffectsBody.items).toContainEqual(expect.objectContaining({
      effect_kind: "charity_payout",
      effect_ref: "charity:don_charity_water:60",
      status: "confirmed",
      settlement_ref: "endaoment:settlement:donation-0001",
      provider_receipt_ref: "endaoment:receipt:donation-0001",
      tax_receipt_ref: "endaoment:tax:donation-0001",
      attempt_count: 1,
    }))
    expect(purchaseEffectsBody.items).toContainEqual(expect.objectContaining({
      effect_kind: "story_royalty_payment",
      effect_ref: assetId.replace(/^asset_/, ""),
      status: "confirmed",
      settlement_ref: "0xroyalty-paid-song",
      provider_receipt_ref: "0xroyalty-paid-song",
      attempt_count: 1,
    }))
    expect(purchaseEffectsBody.items).toContainEqual(expect.objectContaining({
      effect_kind: "story_entitlement_mint",
      status: "confirmed",
      settlement_ref: "0xentitlement-paid-song",
      provider_receipt_ref: null,
      attempt_count: 1,
    }))

    const authorPurchaseEffects = await app.request(
      `http://pirate.test/communities/${communityId}/purchases/${purchaseBody.id}/settlement-effects`,
      {
        headers: {
          authorization: `Bearer ${author.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(authorPurchaseEffects.status).toBe(404)

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
      title: "Paid Anthem",
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
    expect(buyerAccessAfterPurchaseBody.story_cdr_access?.read_condition_address.toLowerCase()).toBe(
      compositeReadConditionAddress,
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



  test("rejects song asset creation when Story royalty registration is unavailable", async () => {
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
        title: "Derivative Commerce",
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
        asset_id: "ast_story_failed_derivative_route",
        song_mode: "remix",
        rights_basis: "derivative",
        license_preset: "commercial-remix",
        commercial_rev_share_pct: 10,
        upstream_asset_refs: ["acr:custom-file:source-track"],
        song_artifact_bundle: bundleBody.id,
      },
      ctx.env,
      author.accessToken,
    )
    expect(derivativePostCreate.status).toBe(502)
    const failedPostBody = await json(derivativePostCreate) as {
      code?: string
      message?: string
      retryable?: boolean
      details?: Record<string, unknown>
    }
    expect(failedPostBody).toMatchObject({
      code: "provider_unavailable",
      // config_missing is an operator/config failure — not resolvable by retrying,
      // so retryable must be false (a user retry loop can never fix missing config).
      message: "This asset could not be published because Story registration is not configured. Please contact support.",
      retryable: false,
      details: {
        reason: "story_royalty_registration_failed",
        rights_basis: "derivative",
        upstream_asset_ref_count: 1,
        story_error_class: "config_missing",
      },
    })
    // raw SDK/contract/RPC text must not leak to the client (logs + story_error col only).
    // `royalty_registration_failed:` is the raw-concatenation prefix; the non-sensitive
    // details.reason "story_royalty_registration_failed" (no colon) is fine.
    expect(JSON.stringify(failedPostBody)).not.toContain("royalty_registration_failed:")
    expect(JSON.stringify(failedPostBody)).not.toContain("story_royalty_config_missing")

    const communityDb = createClient({
      url: `file:${buildLocalCommunityDbPath(ctx.communityDbRoot, communityId)}`,
    })
    try {
      const postRows = await communityDb.execute({
        sql: `
          SELECT idempotency_key, post_type, asset_id, rights_basis, upstream_asset_refs_json
          FROM posts
          WHERE idempotency_key = ?1
        `,
        args: ["song-post-derivative-commerce-1"],
      })
      const assetRows = await communityDb.execute({
        sql: "SELECT COUNT(*) AS count FROM assets WHERE asset_id = ?1",
        args: ["ast_story_failed_derivative_route"],
      })
      expect(postRows.rows).toHaveLength(1)
      expect(postRows.rows[0]).toMatchObject({
        post_type: "song",
        asset_id: "ast_story_failed_derivative_route",
        rights_basis: "derivative",
        upstream_asset_refs_json: JSON.stringify(["acr:custom-file:source-track"]),
      })
      expect(Number(assetRows.rows[0]?.count ?? 0)).toBe(0)
    } finally {
      communityDb.close()
    }
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
    const parentRoyaltyVaultTransferCalls: Array<{
      childIpId: string
      parentIpId: string
      royaltyPolicy: string | null | undefined
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
    setStoryParentRoyaltyVaultTransferExecutorForTests(async (input) => {
      parentRoyaltyVaultTransferCalls.push({
        childIpId: input.childIpId,
        parentIpId: input.parentIpId,
        royaltyPolicy: input.royaltyPolicy,
      })
      return {
        transferTxHash: "0xparent-vault-derivative",
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
        title: "Derivative Registered",
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
        license_preset: "commercial-remix",
        commercial_rev_share_pct: 10,
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

    await markAssetRoyaltyAllocationVerified({
      communityDbRoot: ctx.communityDbRoot,
      communityId,
      assetId,
    })

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
      id: string
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
    expect(parentRoyaltyVaultTransferCalls).toEqual([
      {
        childIpId: "0x1111111111111111111111111111111111111111",
        parentIpId: "0x3333333333333333333333333333333333333333",
        royaltyPolicy: "0xBe54FB168b3c982b7AaE60dB6CF75Bd8447b390E",
      },
    ])

    const derivativePurchaseEffects = await app.request(
      `http://pirate.test/communities/${communityId}/purchases/${purchaseBody.id}/settlement-effects`,
      {
        headers: {
          authorization: `Bearer ${buyer.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(derivativePurchaseEffects.status).toBe(200)
    const derivativePurchaseEffectsBody = await json(derivativePurchaseEffects) as {
      items: Array<{
        quote: string
        purchase: string
        effect_kind: string
        effect_ref: string
        status: string
        settlement_ref: string | null
        provider_receipt_ref: string | null
        tax_receipt_ref: string | null
        attempt_count: number
      }>
      next_cursor: string | null
    }
    expect(derivativePurchaseEffectsBody.next_cursor).toBeNull()
    expect(derivativePurchaseEffectsBody.items).toHaveLength(5)
    expect(derivativePurchaseEffectsBody.items.map((effect) => effect.effect_kind).sort()).toEqual([
      "buyer_funding_receipt",
      "charity_payout",
      "story_entitlement_mint",
      "story_parent_royalty_vault_transfer",
      "story_royalty_payment",
    ])
    expect(derivativePurchaseEffectsBody.items).toContainEqual(expect.objectContaining({
      quote: quoteBody.id,
      purchase: purchaseBody.id,
      effect_kind: "story_royalty_payment",
      effect_ref: assetId.replace(/^asset_/, ""),
      status: "confirmed",
      settlement_ref: "0xroyalty-derivative",
      provider_receipt_ref: "0xroyalty-derivative",
      attempt_count: 1,
    }))
    expect(derivativePurchaseEffectsBody.items).toContainEqual(expect.objectContaining({
      effect_kind: "story_parent_royalty_vault_transfer",
      effect_ref: `${assetId.replace(/^asset_/, "")}:0x3333333333333333333333333333333333333333`,
      status: "confirmed",
      settlement_ref: "0xparent-vault-derivative",
      provider_receipt_ref: "0xparent-vault-derivative",
      attempt_count: 1,
    }))
    expect(derivativePurchaseEffectsBody.items).toContainEqual(expect.objectContaining({
      effect_kind: "story_entitlement_mint",
      status: "confirmed",
      settlement_ref: "0xentitlement-derivative",
      provider_receipt_ref: null,
      attempt_count: 1,
    }))

    const communityDb = createClient({
      url: `file:${buildLocalCommunityDbPath(ctx.communityDbRoot, communityId)}`,
    })
    const rawQuoteId = quoteBody.id.replace(/^pq_/, "")
    try {
      await communityDb.execute({
        sql: `
          UPDATE purchase_settlement_attempts
          SET status = 'attempting',
              failure_reason = NULL,
              updated_at = '2026-04-21T00:00:00.000Z'
          WHERE quote_id = ?1
        `,
        args: [rawQuoteId],
      })
      await communityDb.execute({
        sql: `
          UPDATE purchase_settlement_effects
          SET status = 'submitted',
              failed_at = NULL,
              failure_reason = NULL,
              submitted_at = '2026-04-21T00:00:00.000Z',
              updated_at = '2026-04-21T00:00:00.000Z'
          WHERE quote_id = ?1
            AND effect_kind = 'story_parent_royalty_vault_transfer'
        `,
        args: [rawQuoteId],
      })
    } finally {
      communityDb.close()
    }

    const communityRepository = getCommunityRepository(ctx.env)
    try {
      const submittedVaultTransferSummary = await reconcileStaleCommunityPurchaseSettlements({
        env: ctx.env,
        communityRepository,
        staleMs: 1,
      })
      expect(submittedVaultTransferSummary).toMatchObject({
        checked: 1,
        finalized: 0,
        failed: 0,
        stillPending: 1,
        errors: 0,
      })
    } finally {
      communityRepository.close?.()
    }

    const failedCommunityDb = createClient({
      url: `file:${buildLocalCommunityDbPath(ctx.communityDbRoot, communityId)}`,
    })
    try {
      await failedCommunityDb.execute({
        sql: `
          UPDATE purchase_settlement_attempts
          SET status = 'attempting',
              failure_reason = NULL,
              updated_at = '2026-04-21T00:00:00.000Z'
          WHERE quote_id = ?1
        `,
        args: [rawQuoteId],
      })
      await failedCommunityDb.execute({
        sql: `
          UPDATE purchase_settlement_effects
          SET status = 'failed',
              submitted_at = NULL,
              failed_at = '2026-04-21T00:00:00.000Z',
              failure_reason = 'transfer_to_vault_failed',
              updated_at = '2026-04-21T00:00:00.000Z'
          WHERE quote_id = ?1
            AND effect_kind = 'story_parent_royalty_vault_transfer'
        `,
        args: [rawQuoteId],
      })
    } finally {
      failedCommunityDb.close()
    }

    const failedCommunityRepository = getCommunityRepository(ctx.env)
    try {
      const failedVaultTransferSummary = await reconcileStaleCommunityPurchaseSettlements({
        env: ctx.env,
        communityRepository: failedCommunityRepository,
        staleMs: 1,
      })
      expect(failedVaultTransferSummary).toMatchObject({
        checked: 1,
        finalized: 0,
        failed: 1,
        stillPending: 0,
        errors: 0,
      })
    } finally {
      failedCommunityRepository.close?.()
    }
  }, 10000)

  testWithTimeout("settles a locked remix with multiple Story parent assets", async () => {
    const storedObjects = new Map<string, { body: Uint8Array; contentType: string }>()
    const royaltySettlementCalls: Array<{
      receiverIpId: string
      amount: string
    }> = []
    const parentRoyaltyVaultTransferCalls: Array<{
      childIpId: string
      parentIpId: string
      royaltyPolicy: string | null | undefined
    }> = []
    const expectedParentRefs: string[] = []

    setStoryRuntimeFundingAssertionForTests(async () => {})
    setStoryCdrUploaderForTests(async () => ({
      cdrVaultUuid: 6262,
      writerAddress: "0x0000000000000000000000000000000000000cd2",
      txHashes: {
        allocate: "0xalloc-multi-parent",
        write: "0xwrite-multi-parent",
      },
    }))
    setStoryAssetPublisherForTests(async () => ({
      entitlementConfiguredTxHash: "0xconfigure-multi-parent",
      publishTxHash: "0xpublish-multi-parent",
    }))
    setStoryRoyaltyRegistrarForTests(async (input) => {
      if (input.rightsBasis === "original") {
        const originalByTitle: Record<string, {
          ip: string
          token: string
          terms: string
        }> = {
          "Multi Parent Source A": {
            ip: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            token: "101",
            terms: "101",
          },
          "Multi Parent Source B": {
            ip: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            token: "202",
            terms: "202",
          },
        }
        const original = originalByTitle[input.title ?? ""]
        expect(original).toBeDefined()
        return {
          storyIpId: original!.ip,
          storyIpNftContract: "0x2222222222222222222222222222222222222222",
          storyIpNftTokenId: original!.token,
          storyLicenseTermsId: original!.terms,
          storyLicenseTemplate: null,
          storyRoyaltyPolicy: "0xBe54FB168b3c982b7AaE60dB6CF75Bd8447b390E",
          storyDerivativeParentIpIds: null,
          storyRevenueToken: "0x1514000000000000000000000000000000000000",
          storyRoyaltyRegistrationStatus: "registered",
          storyDerivativeRegisteredAt: null,
        }
      }

      expect(input.rightsBasis).toBe("derivative")
      expect(input.upstreamAssetRefs).toEqual(expectedParentRefs)
      const resolvedParents = await resolveStoryRoyaltyDerivativeParents({
        client: input.client,
        communityId: input.communityId,
        upstreamAssetRefs: input.upstreamAssetRefs,
      })
      expect(resolvedParents).toEqual([
        {
          ipId: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          licenseTermsId: 101n,
        },
        {
          ipId: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          licenseTermsId: 202n,
        },
      ])
      return {
        storyIpId: "0x1111111111111111111111111111111111111111",
        storyIpNftContract: "0x2222222222222222222222222222222222222222",
        storyIpNftTokenId: "303",
        storyLicenseTermsId: "303",
        storyLicenseTemplate: null,
        storyRoyaltyPolicy: "0xBe54FB168b3c982b7AaE60dB6CF75Bd8447b390E",
        storyDerivativeParentIpIds: resolvedParents!.map((parent) => parent.ipId),
        storyRevenueToken: "0x1514000000000000000000000000000000000000",
        storyRoyaltyRegistrationStatus: "registered",
        storyDerivativeRegisteredAt: "2026-04-21T00:00:00.000Z",
      }
    })
    setStoryRoyaltyPurchaseSettlementExecutorForTests(async (input) => {
      royaltySettlementCalls.push({
        receiverIpId: input.receiverIpId,
        amount: String(input.amount),
      })
      return {
        royaltyTxHash: "0xroyalty-multi-parent",
        entitlementTxHash: "0xentitlement-multi-parent",
        settlementTxHash: "0xroyalty-multi-parent",
      }
    })
    setStoryParentRoyaltyVaultTransferExecutorForTests(async (input) => {
      parentRoyaltyVaultTransferCalls.push({
        childIpId: input.childIpId,
        parentIpId: input.parentIpId,
        royaltyPolicy: input.royaltyPolicy,
      })
      return {
        transferTxHash: `0xparent-vault-${input.parentIpId.slice(2, 6)}`,
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
    })
    cleanup = ctx.cleanup

    const author = await exchangeJwt(ctx.env, "song-author-multi-parent")
    const buyer = await exchangeJwt(ctx.env, "song-buyer-multi-parent")
    await attachPrimaryWallet({
      client: ctx.client,
      userId: author.userId,
      walletAttachmentId: "wal_song_author_multi_parent",
      walletAddress: "0xaaa0000000000000000000000000000000000000",
    })
    await attachPrimaryWallet({
      client: ctx.client,
      userId: buyer.userId,
      walletAttachmentId: "wal_song_buyer_multi_parent",
      walletAddress: "0xbbb0000000000000000000000000000000000000",
    })
    await verifyForLockedCommerce(ctx.env, author.userId, author.accessToken)
    await verifyForLockedCommerce(ctx.env, buyer.userId, buyer.accessToken)

    const communityId = await createOpenSongCommunity(ctx.env, author.accessToken, "Multi Parent Remix Club")
    await addCommunityMember(String(ctx.env.LOCAL_COMMUNITY_DB_ROOT), communityId, buyer.userId)

    async function createSongPost(input: {
      title: string
      filename: string
      idempotencyKey: string
      songMode: "original" | "remix"
      accessMode: "public" | "locked"
      upstreamAssetRefs?: string[]
      bytes: Uint8Array
    }): Promise<{ asset: string }> {
      const upload = await uploadSongArtifact({
        env: ctx.env,
        communityId,
        accessToken: author.accessToken,
        artifactKind: "primary_audio",
        mimeType: "audio/mpeg",
        filename: input.filename,
        bytes: input.bytes,
      })
      const bundleCreate = await requestJson(
        `http://pirate.test/communities/${communityId}/song-artifacts`,
        {
          primary_audio: {
            song_artifact_upload: upload.id,
          },
          preview_window: {
            start_ms: 0,
            duration_ms: 30_000,
          },
          title: input.title,
          lyrics: `${input.title} lyric`,
        },
        ctx.env,
        author.accessToken,
      )
      expect(bundleCreate.status).toBe(201)
      const bundleBody = await json(bundleCreate) as { id: string }
      await markGeneratedPreviewReady({
        env: ctx.env,
        communityId,
        songArtifactBundleId: bundleBody.id.replace(/^sab_/, ""),
        previewStorageRef: `http://pirate.test/generated-preview/${communityId}/${input.filename}`,
        previewSizeBytes: 4,
      })
      const postCreate = await requestJson(
        `http://pirate.test/communities/${communityId}/posts`,
        {
          idempotency_key: input.idempotencyKey,
          post_type: "song",
          identity_mode: "public",
          title: input.title,
          access_mode: input.accessMode,
          song_mode: input.songMode,
          rights_basis: input.songMode === "remix" ? "derivative" : "original",
          license_preset: "commercial-remix",
          commercial_rev_share_pct: 10,
          upstream_asset_refs: input.upstreamAssetRefs,
          song_artifact_bundle: bundleBody.id,
        },
        ctx.env,
        author.accessToken,
      )
      expect(postCreate.status).toBe(201)
      const postBody = await json(postCreate) as { asset?: string | null }
      expect(postBody.asset).toBeTruthy()
      return { asset: postBody.asset! }
    }

    const sourceA = await createSongPost({
      title: "Multi Parent Source A",
      filename: "multi-parent-source-a.mp3",
      idempotencyKey: "song-post-multi-parent-source-a",
      songMode: "original",
      accessMode: "public",
      bytes: new Uint8Array([1, 2, 3, 4]),
    })
    const sourceB = await createSongPost({
      title: "Multi Parent Source B",
      filename: "multi-parent-source-b.mp3",
      idempotencyKey: "song-post-multi-parent-source-b",
      songMode: "original",
      accessMode: "public",
      bytes: new Uint8Array([5, 6, 7, 8]),
    })
    expectedParentRefs.push(`story:asset:${sourceA.asset}`, `story:asset:${sourceB.asset}`)

    const remix = await createSongPost({
      title: "Multi Parent Remix",
      filename: "multi-parent-remix.mp3",
      idempotencyKey: "song-post-multi-parent-remix",
      songMode: "remix",
      accessMode: "locked",
      upstreamAssetRefs: expectedParentRefs,
      bytes: new Uint8Array([9, 10, 11, 12]),
    })

    const assetRead = await app.request(
      `http://pirate.test/communities/${communityId}/assets/${remix.asset}`,
      {
        headers: {
          authorization: `Bearer ${author.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(assetRead.status).toBe(200)
    const assetBody = await json(assetRead) as {
      story_derivative_parent_ip_ids: string[] | null
      story_royalty_registration_status: string | null
      story_error?: string | null
    }
    if (assetBody.story_royalty_registration_status !== "registered") {
      throw new Error(`multi-parent remix registration failed: ${JSON.stringify(assetBody)}`)
    }
    expect(assetBody.story_royalty_registration_status).toBe("registered")
    expect(assetBody.story_derivative_parent_ip_ids).toEqual([
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ])

    await markAssetRoyaltyAllocationVerified({
      communityDbRoot: ctx.communityDbRoot,
      communityId,
      assetId: remix.asset,
    })

    const listingCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/listings`,
      {
        asset: remix.asset,
        price_cents: 200,
        regional_pricing_enabled: false,
        status: "active",
      },
      ctx.env,
      author.accessToken,
    )
    expect(listingCreate.status).toBe(201)
    const listingBody = await json(listingCreate) as { id: string }

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
      settlement_mode: string
    }
    expect(quoteBody.settlement_mode).toBe("royalty_native_story_payment")

    const purchaseSettle = await requestJson(
      `http://pirate.test/communities/${communityId}/purchase-settlements`,
      {
        quote: quoteBody.id,
        settlement_wallet_attachment: "wal_song_buyer_multi_parent",
        funding_tx_ref: "0xfunding-multi-parent-1",
        settlement_tx_ref: "ignored-client-ref",
      },
      ctx.env,
      buyer.accessToken,
    )
    expect(purchaseSettle.status).toBe(201)
    const purchaseBody = await json(purchaseSettle) as {
      settlement_mode: string
      settlement_tx_ref: string
    }
    expect(purchaseBody.settlement_mode).toBe("royalty_native_story_payment")
    expect(purchaseBody.settlement_tx_ref).toBe("0xroyalty-multi-parent")
    expect(royaltySettlementCalls).toEqual([
      {
        receiverIpId: "0x1111111111111111111111111111111111111111",
        amount: "2000000000000000000",
      },
    ])
    expect(parentRoyaltyVaultTransferCalls).toEqual([
      {
        childIpId: "0x1111111111111111111111111111111111111111",
        parentIpId: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        royaltyPolicy: "0xBe54FB168b3c982b7AaE60dB6CF75Bd8447b390E",
      },
      {
        childIpId: "0x1111111111111111111111111111111111111111",
        parentIpId: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        royaltyPolicy: "0xBe54FB168b3c982b7AaE60dB6CF75Bd8447b390E",
      },
    ])

    const communityDb = createClient({
      url: `file:${buildLocalCommunityDbPath(ctx.communityDbRoot, communityId)}`,
    })
    const rawQuoteId = quoteBody.id.replace(/^pq_/, "")
    try {
      const effects = await communityDb.execute({
        sql: `
          SELECT effect_kind, effect_key, status, settlement_ref
          FROM purchase_settlement_effects
          WHERE quote_id = ?1
            AND effect_kind = 'story_parent_royalty_vault_transfer'
          ORDER BY effect_key ASC
        `,
        args: [rawQuoteId],
      })
      expect(effects.rows.map((row) => ({
        effect_key: row.effect_key,
        status: row.status,
        settlement_ref: row.settlement_ref,
      }))).toEqual([
        {
          effect_key: `${remix.asset.replace(/^asset_/, "")}:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
          status: "confirmed",
          settlement_ref: "0xparent-vault-aaaa",
        },
        {
          effect_key: `${remix.asset.replace(/^asset_/, "")}:0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`,
          status: "confirmed",
          settlement_ref: "0xparent-vault-bbbb",
        },
      ])
      await communityDb.execute({
        sql: `
          UPDATE purchase_settlement_attempts
          SET status = 'attempting',
              failure_reason = NULL,
              updated_at = '2026-04-21T00:00:00.000Z'
          WHERE quote_id = ?1
        `,
        args: [rawQuoteId],
      })
      await communityDb.execute({
        sql: `
          UPDATE purchase_settlement_effects
          SET status = 'submitted',
              failed_at = NULL,
              failure_reason = NULL,
              submitted_at = '2026-04-21T00:00:00.000Z',
              updated_at = '2026-04-21T00:00:00.000Z'
          WHERE quote_id = ?1
            AND effect_kind = 'story_parent_royalty_vault_transfer'
            AND effect_key = ?2
        `,
        args: [rawQuoteId, `${remix.asset.replace(/^asset_/, "")}:0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`],
      })
    } finally {
      communityDb.close()
    }

    const communityRepository = getCommunityRepository(ctx.env)
    try {
      const submittedSummary = await reconcileStaleCommunityPurchaseSettlements({
        env: ctx.env,
        communityRepository,
        staleMs: 1,
      })
      expect(submittedSummary).toMatchObject({
        checked: 1,
        finalized: 0,
        failed: 0,
        stillPending: 1,
        errors: 0,
      })
    } finally {
      communityRepository.close?.()
    }

    const failedCommunityDb = createClient({
      url: `file:${buildLocalCommunityDbPath(ctx.communityDbRoot, communityId)}`,
    })
    try {
      await failedCommunityDb.execute({
        sql: `
          UPDATE purchase_settlement_attempts
          SET status = 'attempting',
              failure_reason = NULL,
              updated_at = '2026-04-21T00:00:00.000Z'
          WHERE quote_id = ?1
        `,
        args: [rawQuoteId],
      })
      await failedCommunityDb.execute({
        sql: `
          UPDATE purchase_settlement_effects
          SET status = 'failed',
              submitted_at = NULL,
              failed_at = '2026-04-21T00:00:00.000Z',
              failure_reason = 'second_parent_transfer_failed',
              updated_at = '2026-04-21T00:00:00.000Z'
          WHERE quote_id = ?1
            AND effect_kind = 'story_parent_royalty_vault_transfer'
            AND effect_key = ?2
        `,
        args: [rawQuoteId, `${remix.asset.replace(/^asset_/, "")}:0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`],
      })
    } finally {
      failedCommunityDb.close()
    }

    const failedCommunityRepository = getCommunityRepository(ctx.env)
    try {
      const failedSummary = await reconcileStaleCommunityPurchaseSettlements({
        env: ctx.env,
        communityRepository: failedCommunityRepository,
        staleMs: 1,
      })
      expect(failedSummary).toMatchObject({
        checked: 1,
        finalized: 0,
        failed: 1,
        stillPending: 0,
        errors: 0,
      })
    } finally {
      failedCommunityRepository.close?.()
    }
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
      OPENAI_API_KEY: "test-openai-key",
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
      OPENAI_API_KEY: "test-openai-key",
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
    const storyPublishCalls: Array<{
      rightsBasis: "none" | "original" | "derivative"
      upstreamAssetRefs: string[] | null
    }> = []
    setStoryRuntimeFundingAssertionForTests(async () => {})
    setStoryCdrUploaderForTests(async () => ({
      cdrVaultUuid: 9090,
      writerAddress: "0x0000000000000000000000000000000000000cd1",
      txHashes: {
        allocate: "0xalloc-video",
        write: "0xwrite-video",
      },
    }))
    setStoryAssetPublisherForTests(async (input) => {
      storyPublishCalls.push({
        rightsBasis: input.rightsBasis,
        upstreamAssetRefs: input.upstreamAssetRefs,
      })
      return {
        entitlementConfiguredTxHash: "0xconfigure-video",
        publishTxHash: "0xpublish-video",
      }
    })
    setStoryRoyaltyRegistrarForTests(async (input) => {
      expect(input.assetKind).toBe("video_file")
      expect(input.bundle).toBeNull()
      if (input.rightsBasis === "derivative") {
        expect(input.licensePreset).toBe("non-commercial")
        expect(input.upstreamAssetRefs).toEqual(["story:ip:0x1111111111111111111111111111111111111111#licenseTermsId=19"])
        return {
          storyIpId: "0x5050505050505050505050505050505050505050",
          storyIpNftContract: "0x4040404040404040404040404040404040404040",
          storyIpNftTokenId: "910",
          storyLicenseTermsId: "23",
          storyLicenseTemplate: null,
          storyRoyaltyPolicy: "0xBe54FB168b3c982b7AaE60dB6CF75Bd8447b390E",
          storyDerivativeParentIpIds: ["0x1111111111111111111111111111111111111111"],
          storyRevenueToken: "0x1514000000000000000000000000000000000000",
          storyRoyaltyRegistrationStatus: "registered",
          storyDerivativeRegisteredAt: "2026-06-04T00:00:00.000Z",
        }
      }
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
      OPENAI_API_KEY: "test-openai-key",
      STORY_CONTRACT_OWNER_PRIVATE_KEY: "0x1000000000000000000000000000000000000000000000000000000000000001",
      STORY_OPERATOR_PRIVATE_KEY: "0x2000000000000000000000000000000000000000000000000000000000000002",
      STORY_CDR_WRITER_PRIVATE_KEY: "0x3000000000000000000000000000000000000000000000000000000000000003",
      STORY_ACCESS_CONTROLLER_PRIVATE_KEY: "0x4000000000000000000000000000000000000000000000000000000000000004",
      STORY_COMPOSITE_READ_CONDITION_ADDRESS: compositeReadConditionAddress,
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
    expect("preview_video" in (postBody.media_refs?.[0] ?? {})).toBe(false)

    const previewBytes = new TextEncoder().encode("locked-video-preview-bytes")
    const previewUpload = await uploadSongArtifact({
      env: ctx.env,
      communityId,
      accessToken: author.accessToken,
      artifactKind: "preview_video",
      mimeType: "video/mp4",
      filename: "locked-video-preview.mp4",
      bytes: previewBytes,
    })

    const createdPreviewPost = await requestJson(
      `http://pirate.test/communities/${communityId}/posts`,
      {
        idempotency_key: "locked-video-commerce-preview-1",
        post_type: "video",
        title: "Members-only locked video with trailer",
        visibility: "members_only",
        access_mode: "locked",
        license_preset: "non-commercial",
        media_refs: [{
          storage_ref: videoUpload.storage_ref,
          mime_type: "video/mp4",
          size_bytes: videoBytes.byteLength,
          poster_ref: "http://pirate.test/community-media/post_image/locked-video-trailer-cover.jpg",
          poster_mime_type: "image/jpeg",
          poster_size_bytes: 3456,
          poster_width: 1280,
          poster_height: 720,
          poster_frame_ms: 2500,
          preview_video: {
            storage_ref: previewUpload.storage_ref,
            mime_type: "video/mp4",
            size_bytes: previewBytes.byteLength,
          },
        }],
      },
      ctx.env,
      author.accessToken,
    )
    expect(createdPreviewPost.status).toBe(201)
    const previewPostBody = await json(createdPreviewPost) as {
      access_mode: string
      media_refs?: Array<{
        storage_ref?: string
        poster_ref?: string
        preview_video?: {
          storage_ref?: string
          mime_type?: string
          size_bytes?: number | null
        }
      }>
    }
    expect(previewPostBody.access_mode).toBe("locked")
    expect(previewPostBody.media_refs?.[0]?.storage_ref).toBe("")
    expect(previewPostBody.media_refs?.[0]?.poster_ref).toBe("http://pirate.test/community-media/post_image/locked-video-trailer-cover.jpg")
    expect(previewPostBody.media_refs?.[0]?.preview_video?.storage_ref).toContain(`/public-communities/${communityId}/song-artifact-uploads/`)
    expect(previewPostBody.media_refs?.[0]?.preview_video?.mime_type).toBe("video/mp4")
    expect(previewPostBody.media_refs?.[0]?.preview_video?.size_bytes).toBe(previewBytes.byteLength)

    const previewUrl = previewPostBody.media_refs?.[0]?.preview_video?.storage_ref ?? ""
    const previewHeadResponse = await app.request(previewUrl, {
      method: "HEAD",
    }, ctx.env)
    expect(previewHeadResponse.status).toBe(200)

    const previewContentResponse = await app.request(previewUrl, {}, ctx.env)
    expect(previewContentResponse.status).toBe(200)
    expect(new Uint8Array(await previewContentResponse.arrayBuffer())).toEqual(previewBytes)

    const previewRangeResponse = await app.request(previewUrl, {
      headers: {
        range: "bytes=0-3",
      },
    }, ctx.env)
    expect(previewRangeResponse.status).toBe(206)
    expect(previewRangeResponse.headers.get("accept-ranges")).toBe("bytes")
    expect(previewRangeResponse.headers.get("content-range")).toBe(`bytes 0-3/${previewBytes.byteLength}`)
    expect(new Uint8Array(await previewRangeResponse.arrayBuffer())).toEqual(previewBytes.slice(0, 4))

    const derivativeVideoBytes = new TextEncoder().encode("locked-derivative-video-bytes")
    const derivativeVideoUpload = await uploadSongArtifact({
      env: ctx.env,
      communityId,
      accessToken: author.accessToken,
      artifactKind: "primary_video",
      mimeType: "video/mp4",
      filename: "locked-derivative-video.mp4",
      bytes: derivativeVideoBytes,
    })
    const derivativePost = await requestJson(
      `http://pirate.test/communities/${communityId}/posts`,
      {
        idempotency_key: "locked-video-commerce-derivative-1",
        post_type: "video",
        title: "Members-only derivative video",
        visibility: "members_only",
        access_mode: "locked",
        license_preset: "non-commercial",
        rights_basis: "derivative",
        upstream_asset_refs: ["story:ip:0x1111111111111111111111111111111111111111#licenseTermsId=19"],
        media_refs: [{
          storage_ref: derivativeVideoUpload.storage_ref,
          mime_type: "video/mp4",
          size_bytes: derivativeVideoBytes.byteLength,
          poster_ref: "http://pirate.test/community-media/post_image/locked-derivative-video-cover.jpg",
          poster_mime_type: "image/jpeg",
          poster_size_bytes: 4567,
          poster_width: 1280,
          poster_height: 720,
          poster_frame_ms: 1000,
        }],
      },
      ctx.env,
      author.accessToken,
    )
    expect(derivativePost.status).toBe(201)
    const derivativePostBody = await json(derivativePost) as {
      asset: string
      access_mode: string
    }
    expect(derivativePostBody.access_mode).toBe("locked")

    const derivativeAssetResponse = await app.request(
      `http://pirate.test/communities/${communityId}/assets/${derivativePostBody.asset}`,
      {
        headers: {
          authorization: `Bearer ${author.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(derivativeAssetResponse.status).toBe(200)
    const derivativeAssetBody = await json(derivativeAssetResponse) as {
      access_mode: string
      rights_basis: string
      story_ip: string | null
      story_derivative_parent_ip_ids: string[] | null
      story_royalty_registration_status: string
    }
    expect(derivativeAssetBody.access_mode).toBe("locked")
    expect(derivativeAssetBody.rights_basis).toBe("derivative")
    expect(derivativeAssetBody.story_ip).toBe("0x5050505050505050505050505050505050505050")
    expect(derivativeAssetBody.story_derivative_parent_ip_ids).toEqual(["0x1111111111111111111111111111111111111111"])
    expect(derivativeAssetBody.story_royalty_registration_status).toBe("registered")
    expect(storyPublishCalls).toContainEqual({
      rightsBasis: "derivative",
      upstreamAssetRefs: ["story:ip:0x1111111111111111111111111111111111111111#licenseTermsId=19"],
    })

    const wrongPreviewPost = await requestJson(
      `http://pirate.test/communities/${communityId}/posts`,
      {
        idempotency_key: "locked-video-commerce-preview-wrong-kind",
        post_type: "video",
        title: "Members-only locked video with invalid trailer",
        visibility: "members_only",
        access_mode: "locked",
        license_preset: "non-commercial",
        media_refs: [{
          storage_ref: videoUpload.storage_ref,
          mime_type: "video/mp4",
          size_bytes: videoBytes.byteLength,
          poster_ref: "http://pirate.test/community-media/post_image/locked-video-invalid-cover.jpg",
          poster_mime_type: "image/jpeg",
          poster_size_bytes: 3456,
          preview_video: {
            storage_ref: videoUpload.storage_ref,
            mime_type: "video/mp4",
            size_bytes: videoBytes.byteLength,
          },
        }],
      },
      ctx.env,
      author.accessToken,
    )
    expect(wrongPreviewPost.status).toBe(404)

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

    await markAssetRoyaltyAllocationVerified({
      communityDbRoot: ctx.communityDbRoot,
      communityId,
      assetId: postBody.asset,
    })

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
        read_condition_address: string
        access_aux_data_hex: string
      } | null
    }
    expect(accessBody.access_granted).toBe(true)
    expect(accessBody.delivery_kind).toBe("story_cdr_ref")
    expect(accessBody.story_cdr_access?.vault_uuid).toBe(9090)
    expect(accessBody.story_cdr_access?.mime_type).toBe("video/mp4")
    expect(accessBody.story_cdr_access?.read_condition_address.toLowerCase()).toBe(compositeReadConditionAddress)
    expect(accessBody.story_cdr_access?.access_aux_data_hex).not.toBe("0x")
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
