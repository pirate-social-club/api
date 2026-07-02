import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { app } from "../../../src/index"
import { createRouteTestContext, json, resetRuntimeCaches } from "../../helpers"
import { setStoryRoyaltyRegistrarForTests } from "../../../src/lib/story/story-royalty-registration-service"
import {
  completeUniqueHumanVerification,
  exchangeJwt,
  requestJson,
} from "./song-artifact-test-helpers"
import { attachPrimaryWallet, uploadSongArtifact } from "./song-artifact-locked-test-helpers"

let cleanup: (() => Promise<void>) | null = null
let originalFetch: typeof fetch

function installSuccessfulStoryRoyaltyRegistrarForTests(): void {
  setStoryRoyaltyRegistrarForTests(async (input) => ({
    storyIpId: "0x9999999999999999999999999999999999999999",
    storyIpNftContract: "0x8888888888888888888888888888888888888888",
    storyIpNftTokenId: input.assetId.replace(/\D/g, "").slice(0, 12) || "1",
    storyLicenseTermsId: "17",
    storyLicenseTemplate: null,
    storyRoyaltyPolicy: "0xBe54FB168b3c982b7AaE60dB6CF75Bd8447b390E",
    storyDerivativeParentIpIds: input.rightsBasis === "derivative" ? [] : null,
    storyRevenueToken: "0x1514000000000000000000000000000000000000",
    storyRoyaltyRegistrationStatus: "registered",
    storyDerivativeRegisteredAt: input.rightsBasis === "derivative" ? "2026-04-21T00:00:00.000Z" : null,
  }))
}

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

describe("song artifact catalog sync routes", () => {
  test("records missing catalog configuration without blocking publish", async () => {
    const storedObjects = new Map<string, { body: Uint8Array; contentType: string }>()
    let acrCloudCatalogCallCount = 0

    ;(globalThis as { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> }).fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request ? input : new Request(input, init)
      if (request.url === "https://openrouter.test/api/v1/chat/completions") {
        return Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  age_gate_rating: "safe",
                  reason: "clean lyrics",
                }),
              },
            },
          ],
        })
      }

      if (request.url === "https://acrcloud.test/v1/identify") {
        return Response.json({
          status: {
            code: 0,
            msg: "Success",
          },
          metadata: {
            music: [],
          },
        })
      }

      if (request.url === "https://console-v2.acrcloud.test/api/buckets/30358/files") {
        acrCloudCatalogCallCount += 1
        return Response.json({
          data: {
            id: 99,
            acr_id: "acr_catalog_should_not_run",
            state: 0,
          },
        })
      }

      if (request.url === "https://elevenlabs.test/forced-alignment") {
        return Response.json({
          provider: "elevenlabs",
          segments: [
            {
              start_ms: 0,
              end_ms: 1800,
              text: "Line one",
            },
          ],
        })
      }

      if (!request.url.startsWith("https://s3.filebase.test/")) {
        return await originalFetch(request)
      }

      if (request.method === "PUT") {
        storedObjects.set(request.url, {
          body: new Uint8Array(await request.arrayBuffer()),
          contentType: request.headers.get("content-type") || "application/octet-stream",
        })
        return new Response(null, {
          status: 200,
          headers: { "x-amz-meta-cid": "bafysongartifactcid" },
        })
      }

      if (request.method === "GET") {
        const stored = storedObjects.get(request.url)
        if (!stored) {
          return new Response("missing", { status: 404 })
        }
        return new Response(stored.body.slice().buffer, {
          status: 200,
          headers: {
            "content-type": stored.contentType,
            "content-length": String(stored.body.byteLength),
          },
        })
      }

      return new Response("unexpected method", { status: 500 })
    }

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
      ACRCLOUD_PERSONAL_ACCESS_TOKEN: "test-acrcloud-pat",
      ELEVENLABS_API_KEY: "test-elevenlabs-key",
      ELEVENLABS_FORCE_ALIGNMENT_URL: "https://elevenlabs.test/forced-alignment",
    })
    cleanup = ctx.cleanup

    const author = await exchangeJwt(ctx.env, "song-author-missing-bucket")
    await attachPrimaryWallet({
      client: ctx.client,
      userId: author.userId,
      walletAttachmentId: "wal_song_author_missing_bucket",
      walletAddress: "0xaaa0000000000000000000000000000000000005",
    })
    installSuccessfulStoryRoyaltyRegistrarForTests()
    await completeUniqueHumanVerification(ctx.env, author.accessToken)

    const communityCreate = await requestJson(
      "http://pirate.test/communities",
      {
        display_name: "Song Club Missing Bucket",
        membership_mode: "request",
        handle_policy: {
          policy_template: "standard",
        },
      },
      ctx.env,
      author.accessToken,
    )
    const communityCreateBody = await json(communityCreate) as {
      community: {
        id: string
      }
    }
    const communityId = communityCreateBody.community.id.replace(/^com_/, "")

    const uploadIntentBody = await uploadSongArtifact({
      env: ctx.env,
      communityId,
      accessToken: author.accessToken,
      artifactKind: "primary_audio",
      mimeType: "audio/mpeg",
      filename: "anthem.mp3",
      bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
    })

    const bundleCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/song-artifacts`,
      {
        primary_audio: {
          song_artifact_upload: uploadIntentBody.id,
        },
        title: "Catalog Sync Song",
        lyrics: "Line one",
      },
      ctx.env,
      author.accessToken,
    )
    const bundleBody = await json(bundleCreate) as { id: string }

    const postCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/posts`,
      {
        idempotency_key: "song-post-missing-bucket",
        post_type: "song",
        identity_mode: "public",
        title: "Song without catalog bucket",
        song_mode: "original",
        rights_basis: "original",
        license_preset: "non-commercial",
        song_artifact_bundle: bundleBody.id,
      },
      ctx.env,
      author.accessToken,
    )
    expect(postCreate.status).toBe(201)

    const bundleRead = await app.request(
      `http://pirate.test/communities/${communityId}/song-artifacts/${bundleBody.id}`,
      {
        headers: {
          authorization: `Bearer ${author.accessToken}`,
        },
      },
      ctx.env,
    )
    const bundleReadBody = await json(bundleRead) as {
      moderation_result?: {
        catalog_sync?: {
          synced?: boolean
          error?: string
        }
      }
    }
    expect(bundleReadBody.moderation_result?.catalog_sync?.synced).toBe(false)
    expect(bundleReadBody.moderation_result?.catalog_sync?.error).toBe("missing_configuration")
    expect(acrCloudCatalogCallCount).toBe(0)
  })

  test("does not re-upload to the catalog when a consumed bundle is published again", async () => {
    const storedObjects = new Map<string, { body: Uint8Array; contentType: string }>()
    let acrCloudCatalogCallCount = 0

    ;(globalThis as { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> }).fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request ? input : new Request(input, init)
      if (request.url === "https://openrouter.test/api/v1/chat/completions") {
        return Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  age_gate_rating: "safe",
                  reason: "clean lyrics",
                }),
              },
            },
          ],
        })
      }

      if (request.url === "https://acrcloud.test/v1/identify") {
        return Response.json({
          status: {
            code: 0,
            msg: "Success",
          },
          metadata: {
            music: [],
          },
        })
      }

      if (request.url === "https://console-v2.acrcloud.test/api/buckets/30358/files") {
        acrCloudCatalogCallCount += 1
        return Response.json({
          data: {
            id: 77,
            acr_id: "acr_test_song_77",
            state: 0,
          },
        })
      }

      if (request.url === "https://elevenlabs.test/forced-alignment") {
        return Response.json({
          provider: "elevenlabs",
          segments: [
            {
              start_ms: 0,
              end_ms: 1800,
              text: "Line one",
            },
          ],
        })
      }

      if (!request.url.startsWith("https://s3.filebase.test/")) {
        return await originalFetch(request)
      }

      if (request.method === "PUT") {
        storedObjects.set(request.url, {
          body: new Uint8Array(await request.arrayBuffer()),
          contentType: request.headers.get("content-type") || "application/octet-stream",
        })
        return new Response(null, {
          status: 200,
          headers: { "x-amz-meta-cid": "bafysongartifactcid" },
        })
      }

      if (request.method === "GET") {
        const stored = storedObjects.get(request.url)
        if (!stored) {
          return new Response("missing", { status: 404 })
        }
        return new Response(stored.body.slice().buffer, {
          status: 200,
          headers: {
            "content-type": stored.contentType,
            "content-length": String(stored.body.byteLength),
          },
        })
      }

      return new Response("unexpected method", { status: 500 })
    }

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
      ACRCLOUD_PERSONAL_ACCESS_TOKEN: "test-acrcloud-pat",
      ACRCLOUD_BUCKET_ID: "30358",
      ACRCLOUD_CONSOLE_BASE_URL: "https://console-v2.acrcloud.test/api",
      ELEVENLABS_API_KEY: "test-elevenlabs-key",
      ELEVENLABS_FORCE_ALIGNMENT_URL: "https://elevenlabs.test/forced-alignment",
    })
    cleanup = ctx.cleanup

    const author = await exchangeJwt(ctx.env, "song-author-republish")
    await attachPrimaryWallet({
      client: ctx.client,
      userId: author.userId,
      walletAttachmentId: "wal_song_author_republish",
      walletAddress: "0xaaa0000000000000000000000000000000000006",
    })
    installSuccessfulStoryRoyaltyRegistrarForTests()
    await completeUniqueHumanVerification(ctx.env, author.accessToken)

    const communityCreate = await requestJson(
      "http://pirate.test/communities",
      {
        display_name: "Song Club Republish",
        membership_mode: "request",
        handle_policy: {
          policy_template: "standard",
        },
      },
      ctx.env,
      author.accessToken,
    )
    const communityCreateBody = await json(communityCreate) as {
      community: {
        id: string
      }
    }
    const communityId = communityCreateBody.community.id.replace(/^com_/, "")

    const uploadIntentBody = await uploadSongArtifact({
      env: ctx.env,
      communityId,
      accessToken: author.accessToken,
      artifactKind: "primary_audio",
      mimeType: "audio/mpeg",
      filename: "anthem.mp3",
      bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
    })

    const bundleCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/song-artifacts`,
      {
        primary_audio: {
          song_artifact_upload: uploadIntentBody.id,
        },
        title: "Catalog Sync Song",
        lyrics: "Line one",
      },
      ctx.env,
      author.accessToken,
    )
    const bundleBody = await json(bundleCreate) as { id: string }

    const firstPostCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/posts`,
      {
        idempotency_key: "song-post-republish-1",
        post_type: "song",
        identity_mode: "public",
        title: "Song republish one",
        song_mode: "original",
        rights_basis: "original",
        license_preset: "non-commercial",
        song_artifact_bundle: bundleBody.id,
      },
      ctx.env,
      author.accessToken,
    )
    expect(firstPostCreate.status).toBe(201)

    const secondPostCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/posts`,
      {
        idempotency_key: "song-post-republish-2",
        post_type: "song",
        identity_mode: "public",
        title: "Song republish two",
        song_mode: "original",
        rights_basis: "original",
        license_preset: "non-commercial",
        song_artifact_bundle: bundleBody.id,
      },
      ctx.env,
      author.accessToken,
    )
    expect(secondPostCreate.status).toBe(201)
    expect(acrCloudCatalogCallCount).toBe(1)
  })
})
