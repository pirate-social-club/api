import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createClient } from "@libsql/client"
import { app } from "../src/index"
import { createRouteTestContext, json, resetRuntimeCaches } from "./helpers"
import { buildLocalCommunityDbPath } from "../src/lib/communities/community-local-db"
import { getCommunityRepository } from "../src/lib/communities/db-community-repository"
import { processCommunityJobById } from "../src/lib/communities/jobs/runner"
import { setCommunityCommerceBuyerFundingVerifierForTests } from "../src/lib/communities/commerce/funding-proof-service"
import { setStoryAccessProofSignerForTests } from "../src/lib/story/story-access-proof-service"
import { setStoryAssetPublisherForTests } from "../src/lib/story/story-publish-service"
import { setStoryCdrUploaderForTests } from "../src/lib/story/story-cdr"
import { setStoryRoyaltyRegistrarForTests } from "../src/lib/story/story-royalty-registration-service"
import { setStoryRuntimeFundingAssertionForTests } from "../src/lib/story/story-runtime-funding"
import { setStoryRoyaltyPurchaseSettlementExecutorForTests } from "../src/lib/story/story-royalty-settlement-service"
import { addCommunityMember, exchangeJwt, requestJson } from "./routes/communities/community-routes-test-helpers"
import {
  attachPrimaryWallet,
  createOpenSongCommunity,
  installLockedSongFetchMocks,
} from "./routes/song-artifacts/song-artifact-locked-test-helpers"
import type { Env } from "../src/types"

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

let cleanup: (() => Promise<void>) | null = null
let originalFetch: typeof fetch

function authHeaders(accessToken: string, contentType = "application/json"): Record<string, string> {
  return {
    authorization: `Bearer ${accessToken}`,
    "content-type": contentType,
  }
}

async function executeCommunityJob(input: {
  env: Env
  communityId: string
  jobId: string
}): Promise<void> {
  const repository = getCommunityRepository(input.env)
  try {
    const result = await processCommunityJobById({
      env: input.env,
      communityId: input.communityId,
      jobId: input.jobId,
      communityRepository: repository,
    })
    expect(result?.status).toBe("succeeded")
  } finally {
    await repository.close?.()
  }
}

async function findJobId(input: {
  communityDbRoot: string
  communityId: string
  jobType: string
  subjectId: string
}): Promise<string> {
  const client = createClient({
    url: `file:${buildLocalCommunityDbPath(input.communityDbRoot, input.communityId)}`,
  })
  try {
    const result = await client.execute({
      sql: `
        SELECT job_id
        FROM community_jobs
        WHERE community_id = ?1
          AND job_type = ?2
          AND subject_id = ?3
        ORDER BY created_at DESC, job_id DESC
        LIMIT 1
      `,
      args: [input.communityId, input.jobType, input.subjectId],
    })
    const jobId = result.rows[0]?.job_id
    expect(typeof jobId).toBe("string")
    return String(jobId)
  } finally {
    client.close()
  }
}

async function makeBlobReady(input: {
  client: ReturnType<typeof createClient>
  contentBlobId: string
  contentHash: string
  sizeBytes: number
}): Promise<void> {
  const now = new Date().toISOString()
  await input.client.execute({
    sql: `
      INSERT INTO content_security_scanner_releases (
        scanner_release_id, security_scan_profile, status, source_revision,
        runtime_lock_sha256, base_image_digest, engine_image_digest, engine_version,
        signature_version, signature_date, definition_digest, deployed_image_digest,
        sbom_ref, corpus_evidence_ref, created_at, activated_at
      ) VALUES (
        'csr_generic_goods_fixture', 'clamav-text-v1', 'active', 'revision-fixture',
        ?1, ?2, ?3, '1.5.4', 'signatures-fixture', ?4, ?5, ?6,
        'sbom-fixture', 'corpus-fixture', ?4, ?4
      )
      ON CONFLICT(scanner_release_id) DO NOTHING
    `,
    args: [
      "a".repeat(64),
      `sha256:${"b".repeat(64)}`,
      `sha256:${"c".repeat(64)}`,
      now,
      "d".repeat(64),
      `sha256:${"e".repeat(64)}`,
    ],
  })
  await input.client.execute({
    sql: `
      INSERT INTO content_security_scan_jobs (
        scan_job_id, content_blob_id, scanner_release_id, scan_sequence,
        request_reason, security_scan_profile, expected_content_hash,
        expected_size_bytes, status, attempt_count, max_attempts,
        queued_at, completed_at, created_at, updated_at
      ) VALUES (
        'csj_generic_goods_fixture', ?1, 'csr_generic_goods_fixture', 1,
        'initial_upload', 'clamav-text-v1', ?2, ?3, 'succeeded', 1, 4,
        ?4, ?4, ?4, ?4
      )
      ON CONFLICT(scan_job_id) DO NOTHING
    `,
    args: [input.contentBlobId, input.contentHash, input.sizeBytes, now],
  })
  await input.client.execute({
    sql: `
      INSERT INTO content_security_scan_results (
        scan_result_id, scan_job_id, content_blob_id, scanner_release_id,
        attempt_number, content_hash, size_bytes, outcome, security_scan_profile,
        scanner_policy_version, engine_version, signature_version, signature_date,
        engine_image_digest, definition_digest, finding_code, error_code,
        content_format_policy_version, content_format_outcome, detected_mime_type,
        content_format_finding_code, content_format_error_code, duration_ms, recorded_at
      ) VALUES (
        'csr_result_generic_goods_fixture', 'csj_generic_goods_fixture', ?1,
        'csr_generic_goods_fixture', 1, ?2, ?3, 'clean', 'clamav-text-v1',
        'clamav-text-v1', '1.5.4', 'signatures-fixture', ?4, ?5, ?6, NULL, NULL,
        'text-download-formats-v1', 'allow', 'text/csv', NULL, NULL, 1, ?4
      )
      ON CONFLICT(scan_result_id) DO NOTHING
    `,
    args: [
      input.contentBlobId,
      input.contentHash,
      input.sizeBytes,
      now,
      `sha256:${"c".repeat(64)}`,
      "d".repeat(64),
    ],
  })
  await input.client.execute({
    sql: `
      UPDATE content_blobs
      SET status = 'ready', security_scan_state = 'clean',
          detected_mime_type = 'text/csv', security_scan_profile = 'clamav-text-v1',
          scanner_engine_version = '1.5.4', scanner_signature_version = 'signatures-fixture',
          security_scan_result_ref = 'csr_result_generic_goods_fixture',
          security_scanned_at = ?2, updated_at = ?2
      WHERE content_blob_id = ?1
    `,
    args: [input.contentBlobId, now],
  })
}

// The SQLite route fixture still carries legacy CHECKs for generic post types,
// Story projection kinds, and emergency-control tables even though the API and
// community shard support them. Keep these adaptations local to the isolated
// route database until the corresponding core fixture migrations are aligned.
async function allowGenericPostProjections(client: ReturnType<typeof createClient>): Promise<void> {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS generic_asset_emergency_controls (
      control_id TEXT PRIMARY KEY,
      scope TEXT NOT NULL CHECK (scope IN ('all', 'content_hash', 'asset', 'uploader', 'community', 'validation_profile')),
      target_ref TEXT,
      state TEXT NOT NULL CHECK (state IN ('active', 'cleared')),
      reason TEXT NOT NULL,
      actor_ref TEXT NOT NULL,
      created_at TEXT NOT NULL,
      cleared_at TEXT,
      cleared_by TEXT,
      CHECK ((scope = 'all' AND target_ref IS NULL) OR (scope <> 'all' AND target_ref IS NOT NULL)),
      CHECK ((state = 'active' AND cleared_at IS NULL AND cleared_by IS NULL) OR (state = 'cleared' AND cleared_at IS NOT NULL AND cleared_by IS NOT NULL))
    )
  `)
  await client.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_generic_asset_emergency_controls_active ON generic_asset_emergency_controls(scope, COALESCE(target_ref, '')) WHERE state = 'active'")
  await client.execute("CREATE INDEX IF NOT EXISTS idx_generic_asset_emergency_controls_lookup ON generic_asset_emergency_controls(state, scope, target_ref)")
  await client.execute("DROP INDEX IF EXISTS idx_community_post_projections_club_created")
  await client.execute("DROP INDEX IF EXISTS idx_community_post_projections_status_created")
  await client.execute("DROP INDEX IF EXISTS idx_community_post_projections_published_score_created")
  await client.execute("DROP INDEX IF EXISTS idx_community_post_projections_source_version")
  await client.execute("ALTER TABLE community_post_projections RENAME TO community_post_projections_legacy")
  await client.execute(`
    CREATE TABLE community_post_projections (
      projection_id TEXT PRIMARY KEY,
      community_id TEXT NOT NULL,
      source_post_id TEXT NOT NULL,
      author_user_id TEXT,
      identity_mode TEXT NOT NULL CHECK (identity_mode IN ('public', 'anonymous')),
      post_type TEXT NOT NULL CHECK (post_type IN ('text', 'image', 'video', 'link', 'song', 'crosspost', 'file', 'deck')),
      status TEXT NOT NULL CHECK (status IN ('draft', 'processing', 'published', 'failed', 'hidden', 'removed', 'deleted')),
      visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'members_only')),
      upvote_count INTEGER NOT NULL DEFAULT 0,
      downvote_count INTEGER NOT NULL DEFAULT 0,
      comment_count INTEGER NOT NULL DEFAULT 0,
      like_count INTEGER NOT NULL DEFAULT 0,
      source_created_at TEXT NOT NULL,
      projected_payload_json TEXT NOT NULL,
      projection_version INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (community_id) REFERENCES communities(community_id)
    )
  `)
  await client.execute(`
    INSERT INTO community_post_projections (
      projection_id, community_id, source_post_id, author_user_id, identity_mode, post_type,
      status, visibility, upvote_count, downvote_count, comment_count, like_count,
      source_created_at, projected_payload_json, projection_version, created_at, updated_at
    )
    SELECT projection_id, community_id, source_post_id, author_user_id, identity_mode, post_type,
      status, visibility, upvote_count, downvote_count, comment_count, like_count,
      source_created_at, projected_payload_json, projection_version, created_at, updated_at
    FROM community_post_projections_legacy
  `)
  await client.execute("DROP TABLE community_post_projections_legacy")
  await client.execute("CREATE INDEX idx_community_post_projections_club_created ON community_post_projections(community_id, source_created_at DESC)")
  await client.execute("CREATE INDEX idx_community_post_projections_status_created ON community_post_projections(status, source_created_at DESC)")
  await client.execute("CREATE INDEX idx_community_post_projections_published_score_created ON community_post_projections(status, community_id, (upvote_count - downvote_count) DESC, source_created_at DESC, source_post_id DESC)")
  await client.execute("CREATE UNIQUE INDEX idx_community_post_projections_source_version ON community_post_projections(community_id, source_post_id, projection_version)")

  // SQLite does not apply the PostgreSQL DROP/ADD CHECK migration used by the
  // fixture runner, so adapt the control-plane Story projection table too.
  await client.execute("DROP INDEX IF EXISTS idx_story_registered_asset_projections_kind_updated")
  await client.execute("DROP INDEX IF EXISTS idx_story_registered_asset_projections_kind_title")
  await client.execute("DROP INDEX IF EXISTS idx_story_registered_asset_projections_unique")
  await client.execute("DROP INDEX IF EXISTS idx_story_registered_asset_projections_post_status")
  await client.execute("ALTER TABLE story_registered_asset_projections RENAME TO story_registered_asset_projections_legacy")
  await client.execute(`
    CREATE TABLE story_registered_asset_projections (
      projection_id TEXT PRIMARY KEY,
      community_id TEXT NOT NULL,
      asset_id TEXT NOT NULL,
      display_title TEXT,
      creator_user_id TEXT NOT NULL,
      asset_kind TEXT NOT NULL CHECK (asset_kind IN ('song_audio', 'video_file', 'download_file', 'learning_deck')),
      license_preset TEXT,
      commercial_rev_share_pct INTEGER,
      story_ip_id TEXT NOT NULL,
      story_license_terms_id TEXT,
      source_post_id TEXT NOT NULL,
      source_post_status TEXT NOT NULL DEFAULT 'published',
      source_updated_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (community_id) REFERENCES communities(community_id)
    )
  `)
  await client.execute(`
    INSERT INTO story_registered_asset_projections (
      projection_id, community_id, asset_id, display_title, creator_user_id, asset_kind,
      license_preset, commercial_rev_share_pct, story_ip_id, story_license_terms_id,
      source_post_id, source_post_status, source_updated_at, created_at, updated_at
    )
    SELECT projection_id, community_id, asset_id, display_title, creator_user_id, asset_kind,
      license_preset, commercial_rev_share_pct, story_ip_id, story_license_terms_id,
      source_post_id, source_post_status, source_updated_at, created_at, updated_at
    FROM story_registered_asset_projections_legacy
  `)
  await client.execute("DROP TABLE story_registered_asset_projections_legacy")
  await client.execute("CREATE INDEX idx_story_registered_asset_projections_kind_updated ON story_registered_asset_projections(asset_kind, updated_at DESC) WHERE source_post_status = 'published'")
  await client.execute("CREATE INDEX idx_story_registered_asset_projections_kind_title ON story_registered_asset_projections(asset_kind, lower(display_title)) WHERE source_post_status = 'published'")
  await client.execute("CREATE UNIQUE INDEX idx_story_registered_asset_projections_unique ON story_registered_asset_projections(community_id, asset_id)")
  await client.execute("CREATE INDEX idx_story_registered_asset_projections_post_status ON story_registered_asset_projections(source_post_status, updated_at)")
}

async function ensureGenericEmergencyControls(client: ReturnType<typeof createClient>): Promise<void> {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS generic_asset_emergency_controls (
      control_id TEXT PRIMARY KEY,
      scope TEXT NOT NULL CHECK (scope IN ('all', 'content_hash', 'asset', 'uploader', 'community', 'validation_profile')),
      target_ref TEXT,
      state TEXT NOT NULL CHECK (state IN ('active', 'cleared')),
      reason TEXT NOT NULL,
      actor_ref TEXT NOT NULL,
      created_at TEXT NOT NULL,
      cleared_at TEXT,
      cleared_by TEXT,
      CHECK ((scope = 'all' AND target_ref IS NULL) OR (scope <> 'all' AND target_ref IS NOT NULL)),
      CHECK ((state = 'active' AND cleared_at IS NULL AND cleared_by IS NULL) OR (state = 'cleared' AND cleared_at IS NOT NULL AND cleared_by IS NOT NULL))
    )
  `)
  await client.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_generic_asset_emergency_controls_active ON generic_asset_emergency_controls(scope, COALESCE(target_ref, '')) WHERE state = 'active'")
  await client.execute("CREATE INDEX IF NOT EXISTS idx_generic_asset_emergency_controls_lookup ON generic_asset_emergency_controls(state, scope, target_ref)")
}

beforeEach(() => {
  resetRuntimeCaches()
  originalFetch = globalThis.fetch
  setCommunityCommerceBuyerFundingVerifierForTests(async (input) => ({
    txRef: input.fundingTxRef,
    fromAddress: input.buyerAddress,
    toAddress: input.quote.funding_destination_address ?? "0x5000000000000000000000000000000000000005",
    tokenAddress: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
    amountAtomic: String(BigInt(input.quote.final_price_cents * 10_000)),
    chainRef: "eip155:84532",
  }))
  setStoryRuntimeFundingAssertionForTests(async () => {})
  setStoryCdrUploaderForTests(async () => ({
    cdrVaultUuid: 7171,
    writerAddress: "0x0000000000000000000000000000000000000cd7",
    txHashes: { allocate: "0xalloc-generic", write: "0xwrite-generic" },
  }))
  setStoryAssetPublisherForTests(async () => ({
    entitlementConfiguredTxHash: "0xconfigure-generic",
    publishTxHash: "0xpublish-generic",
  }))
  setStoryRoyaltyRegistrarForTests(async () => ({
    storyIpId: "0x7171717171717171717171717171717171717171",
    storyIpNftContract: "0x7272727272727272727272727272727272727272",
    storyIpNftTokenId: "717",
    storyLicenseTermsId: "71",
    storyLicenseTemplate: null,
    storyRoyaltyPolicy: "0xBe54FB168b3c982b7AaE60dB6CF75Bd8447b390E",
    storyDerivativeParentIpIds: null,
    storyRevenueToken: "0x1514000000000000000000000000000000000000",
    storyRoyaltyRegistrationStatus: "registered",
    storyDerivativeRegisteredAt: null,
  }))
  setStoryAccessProofSignerForTests(async (input) => ({
    digest: "0x7171",
    signature: `0x${"71".repeat(65)}` as `0x${string}`,
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
  setStoryRoyaltyPurchaseSettlementExecutorForTests(async () => ({
    royaltyTxHash: "0xroyalty-generic",
    entitlementTxHash: "0xentitlement-generic",
    settlementTxHash: "0xsettlement-generic",
  }))
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  setCommunityCommerceBuyerFundingVerifierForTests(null)
  setStoryRuntimeFundingAssertionForTests(null)
  setStoryCdrUploaderForTests(null)
  setStoryAssetPublisherForTests(null)
  setStoryRoyaltyRegistrarForTests(null)
  setStoryAccessProofSignerForTests(null)
  setStoryRoyaltyPurchaseSettlementExecutorForTests(null)
  if (cleanup) {
    await cleanup()
    cleanup = null
  }
})

describe("generic digital goods commerce routes", () => {
  test("enforces entitlement across blob publication, purchase, access, and content delivery", async () => {
    const storedObjects = new Map<string, { body: Uint8Array; contentType: string }>()
    installLockedSongFetchMocks({ originalFetch, storedObjects })

    const ctx = await createRouteTestContext({
      GENERIC_DIGITAL_GOODS_ENABLED: "true",
      CONTENT_BLOB_UPLOADS_ENABLED: "true",
      CONTENT_SECURITY_SCAN_ENQUEUE_ENABLED: "false",
      CONTENT_BLOB_UPLOAD_COMMUNITY_IDS: "",
      CONTENT_SOURCE_BROKER_SHARED_SECRET: "fixture-broker-secret",
      FILEBASE_S3_ACCESS_KEY: "test-filebase-access",
      FILEBASE_S3_SECRET_KEY: "test-filebase-secret",
      FILEBASE_S3_ENDPOINT: "https://s3.filebase.test",
      FILEBASE_MEDIA_BUCKET: "pirate-media",
      STORY_COMPOSITE_READ_CONDITION_ADDRESS: "0xc0ffee0000000000000000000000000000000000",
      STORY_CONTRACT_OWNER_PRIVATE_KEY: "0x1000000000000000000000000000000000000000000000000000000000000001",
      STORY_OPERATOR_PRIVATE_KEY: "0x2000000000000000000000000000000000000000000000000000000000000002",
      STORY_CDR_WRITER_PRIVATE_KEY: "0x3000000000000000000000000000000000000000000000000000000000000003",
      STORY_ACCESS_CONTROLLER_PRIVATE_KEY: "0x4000000000000000000000000000000000000000000000000000000000000004",
    })
    cleanup = ctx.cleanup
    await allowGenericPostProjections(ctx.client)

    const sourceBytes = new TextEncoder().encode("word,meaning\nship,vessel\n")
    const sourceHash = `0x${await crypto.subtle.digest("SHA-256", sourceBytes).then((digest) =>
      Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""))}`
    const brokerObjects = new Map<string, Uint8Array>()
    ctx.env.CONTENT_SOURCE_BROKER = {
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init)
        const contentBlobId = decodeURIComponent(new URL(request.url).pathname.split("/").at(-1) ?? "")
        expect(request.headers.get("authorization")).toBe("Bearer fixture-broker-secret")
        if (request.method === "PUT") {
          const bytes = new Uint8Array(await request.arrayBuffer())
          brokerObjects.set(contentBlobId, bytes)
          return Response.json({
            object: "content_source_object",
            content_blob: contentBlobId,
            status: "stored",
            storage_namespace: "content-source/v1",
            storage_object_key: `content-source/v1/${contentBlobId}`,
            size_bytes: bytes.byteLength,
            content_sha256: request.headers.get("x-content-sha256"),
          }, { status: 201 })
        }
        const bytes = brokerObjects.get(contentBlobId)
        return bytes
          ? new Response(bytes.buffer as ArrayBuffer, { status: 200 })
          : new Response("missing", { status: 404 })
      },
      connect: () => { throw new Error("not implemented") },
    }

    const author = await exchangeJwt(ctx.env, "generic-goods-author")
    const buyer = await exchangeJwt(ctx.env, "generic-goods-buyer")
    await attachPrimaryWallet({
      client: ctx.client,
      userId: author.userId,
      walletAttachmentId: "wal_generic_goods_author",
      walletAddress: "0xaaa0000000000000000000000000000000000000",
    })
    await attachPrimaryWallet({
      client: ctx.client,
      userId: buyer.userId,
      walletAttachmentId: "wal_generic_goods_buyer",
      walletAddress: "0xbbb0000000000000000000000000000000000000",
    })
    const communityId = await createOpenSongCommunity(ctx.env, author.accessToken, "Generic Goods Club")
    await addCommunityMember(String(ctx.env.LOCAL_COMMUNITY_DB_ROOT), communityId, buyer.userId)
    ctx.env.CONTENT_BLOB_UPLOAD_COMMUNITY_IDS = communityId
    const communitySchemaClient = createClient({
      url: `file:${buildLocalCommunityDbPath(String(ctx.communityDbRoot), communityId)}`,
    })
    await ensureGenericEmergencyControls(communitySchemaClient)
    communitySchemaClient.close()

    const createBlobResponse = await app.request(
      `http://pirate.test/communities/${communityId}/content-blobs`,
      {
        method: "POST",
        headers: authHeaders(author.accessToken),
        body: JSON.stringify({
          validation_profile: "download_file_v1",
          declared_filename: "words.csv",
          declared_mime_type: "text/csv",
          declared_size_bytes: sourceBytes.byteLength,
          upload_mode: "proxy",
        }),
      },
      ctx.env,
    )
    expect(createBlobResponse.status).toBe(201)
    const createdBlob = await json(createBlobResponse) as { id: string }
    const uploadResponse = await app.request(
      `http://pirate.test/communities/${communityId}/content-blobs/${createdBlob.id}/content`,
      {
        method: "PUT",
        headers: authHeaders(author.accessToken, "application/octet-stream"),
        body: sourceBytes.buffer as ArrayBuffer,
      },
      ctx.env,
    )
    expect(uploadResponse.status).toBe(200)
    const uploadedBlob = await json(uploadResponse) as {
      verified_content_hash: string
      verified_size_bytes: number
    }
    expect(uploadedBlob.verified_content_hash).toBe(sourceHash)
    expect(uploadedBlob.verified_size_bytes).toBe(sourceBytes.byteLength)
    await makeBlobReady({
      client: ctx.client,
      contentBlobId: createdBlob.id,
      contentHash: sourceHash,
      sizeBytes: sourceBytes.byteLength,
    })

    const postResponse = await requestJson(
      `http://pirate.test/communities/${communityId}/posts`,
      {
        idempotency_key: "generic-goods-post-1",
        post_type: "file",
        identity_mode: "public",
        title: "Words deck",
        access_mode: "locked",
        rights_basis: "original",
        license_preset: "non-commercial",
        file_upload: createdBlob.id,
        publish_mode: "async",
        listing_draft: {
          price_cents: 100,
          regional_pricing_enabled: false,
          status: "active",
        },
      },
      ctx.env,
      author.accessToken,
    )
    expect(postResponse.status).toBe(202)
    const postBody = await json(postResponse) as { id: string; status: string }
    expect(postBody.status).toBe("processing")
    const rawPostId = postBody.id.replace(/^post_/, "")
    const postFinalizeJobId = await findJobId({
      communityDbRoot: String(ctx.communityDbRoot),
      communityId,
      jobType: "post_publish_finalize",
      subjectId: rawPostId,
    })

    // The first finalize attempt claims the verified blob and enqueues delivery;
    // the delivery job is intentionally a separate durable transition.
    const firstRepository = getCommunityRepository(ctx.env)
    let firstFinalize
    try {
      firstFinalize = await processCommunityJobById({
        env: ctx.env,
        communityId,
        jobId: postFinalizeJobId,
        communityRepository: firstRepository,
      })
    } finally {
      await firstRepository.close?.()
    }
    expect(firstFinalize?.status).toBe("failed")
    const communityDb = createClient({
      url: `file:${buildLocalCommunityDbPath(String(ctx.communityDbRoot), communityId)}`,
    })
    const postRow = await communityDb.execute({
      sql: "SELECT asset_id FROM posts WHERE post_id = ?1",
      args: [rawPostId],
    })
    const rawAssetId = String(postRow.rows[0]?.asset_id ?? "")
    expect(rawAssetId).toMatch(/^[a-zA-Z0-9_-]+$/)
    const lockedDeliveryJobId = await findJobId({
      communityDbRoot: String(ctx.communityDbRoot),
      communityId,
      jobType: "locked_asset_delivery_prepare",
      subjectId: rawAssetId,
    })
    await executeCommunityJob({ env: ctx.env, communityId, jobId: lockedDeliveryJobId })
    await communityDb.execute({
      sql: `
        UPDATE community_jobs
        SET status = 'queued', available_at = ?2, error_code = NULL, updated_at = ?2
        WHERE job_id = ?1
      `,
      args: [postFinalizeJobId, new Date().toISOString()],
    })
    communityDb.close()
    await executeCommunityJob({ env: ctx.env, communityId, jobId: postFinalizeJobId })

    const assetId = `asset_${rawAssetId}`
    const listingResponse = await requestJson(
      `http://pirate.test/communities/${communityId}/listings`,
      {
        asset: assetId,
        price_cents: 100,
        regional_pricing_enabled: false,
        status: "active",
      },
      ctx.env,
      author.accessToken,
    )
    expect(listingResponse.status).toBe(400)

    const noEntitlementAccess = await app.request(
      `http://pirate.test/communities/${communityId}/assets/${assetId}/access`,
      { headers: { authorization: `Bearer ${buyer.accessToken}` } },
      ctx.env,
    )
    expect(noEntitlementAccess.status).toBe(200)
    const deniedAccessBody = await json(noEntitlementAccess) as {
      access_granted: boolean
      decision_reason: string
      delivery_kind: string | null
      story_cdr_access: unknown
    }
    expect(deniedAccessBody).toMatchObject({
      access_granted: false,
      decision_reason: "purchase_required",
      delivery_kind: null,
      // The API must not release a CDR key-access package before entitlement.
      story_cdr_access: null,
    })

    const noEntitlementContent = await app.request(
      `http://pirate.test/communities/${communityId}/assets/${assetId}/content`,
      { headers: { authorization: `Bearer ${buyer.accessToken}` } },
      ctx.env,
    )
    // Locked content is intentionally ciphertext at the API boundary. The
    // server-side gate is the null story_cdr_access package above; actual CDR
    // key release/decryption happens downstream and is not available in this
    // SQLite harness because the Story CDR upload and validators are mocked.
    expect(noEntitlementContent.status).toBe(200)
    const ciphertextBeforePurchase = new Uint8Array(await noEntitlementContent.arrayBuffer())
    expect(ciphertextBeforePurchase).not.toEqual(sourceBytes)
    // AES-GCM appends its 16-byte authentication tag to the plaintext.
    expect(ciphertextBeforePurchase.byteLength).toBe(sourceBytes.byteLength + 16)

    const listingRead = await app.request(
      `http://pirate.test/communities/${communityId}/listings`,
      { headers: { authorization: `Bearer ${buyer.accessToken}` } },
      ctx.env,
    )
    expect(listingRead.status).toBe(200)
    const listings = await json(listingRead) as { items: Array<{ id: string; asset: string; price_cents: number }> }
    const listing = listings.items.find((item) => item.asset === assetId)
    expect(listing).toMatchObject({ asset: assetId, price_cents: 100 })

    const quoteResponse = await requestJson(
      `http://pirate.test/communities/${communityId}/purchase-quotes`,
      { listing: listing!.id, ...routedCheckoutQuoteFields },
      ctx.env,
      buyer.accessToken,
    )
    expect(quoteResponse.status).toBe(201)
    const quote = await json(quoteResponse) as { id: string; final_price_cents: number }
    expect(quote.final_price_cents).toBe(100)
    const settlementResponse = await requestJson(
      `http://pirate.test/communities/${communityId}/purchase-settlements`,
      {
        quote: quote.id,
        settlement_wallet_attachment: "wal_generic_goods_buyer",
        funding_tx_ref: "0xfunding-generic-goods",
        settlement_tx_ref: "tx-generic-goods",
      },
      ctx.env,
      buyer.accessToken,
    )
    expect(settlementResponse.status).toBe(201)
    const purchase = await json(settlementResponse) as {
      entitlement_kind: string
      entitlement_target_ref: string
    }
    expect(purchase).toEqual(expect.objectContaining({
      entitlement_kind: "asset_access",
      entitlement_target_ref: assetId,
    }))

    const entitledAccess = await app.request(
      `http://pirate.test/communities/${communityId}/assets/${assetId}/access`,
      { headers: { authorization: `Bearer ${buyer.accessToken}` } },
      ctx.env,
    )
    expect(entitledAccess.status).toBe(200)
    const entitledAccessBody = await json(entitledAccess) as {
      access_granted: boolean
      decision_reason: string
      delivery_kind: string | null
      story_cdr_access: {
        access_scope: string
        access_aux_data_hex: string
        access_proof: Record<string, unknown>
      } | null
    }
    expect(entitledAccessBody).toMatchObject({
      access_granted: true,
      decision_reason: "purchase_entitlement",
      delivery_kind: "story_cdr_ref",
      // Generic assets use the signed CDR read condition. The package is the
      // hand-off to the downstream key-release client and only appears after
      // the entitlement lookup succeeds.
      story_cdr_access: {
        access_scope: "asset.share",
        access_aux_data_hex: expect.stringMatching(/^0x[0-9a-f]+$/i),
        access_proof: {
          signature: expect.any(String),
          caller: expect.any(String),
          // Signed CDR proofs carry the hashed access scope in the proof;
          // the human-readable package scope above remains asset.share.
          scope: expect.any(String),
        },
      },
    })

    const contentResponse = await app.request(
      `http://pirate.test/communities/${communityId}/assets/${assetId}/content`,
      { headers: { authorization: `Bearer ${buyer.accessToken}` } },
      ctx.env,
    )
    expect(contentResponse.status).toBe(200)
    expect(contentResponse.headers.get("content-type")).toBe("application/octet-stream")
    const encryptedBytes = new Uint8Array(await contentResponse.arrayBuffer())
    expect(encryptedBytes).toEqual(ciphertextBeforePurchase)
    expect(encryptedBytes.byteLength).toBe(sourceBytes.byteLength + 16)
  }, 45_000)
})
