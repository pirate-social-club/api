import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createClient } from "@libsql/client"
import { solveChallenge, type Challenge, type Payload } from "altcha-lib"
import { deriveKey } from "altcha-lib/algorithms/pbkdf2"
import { app } from "../../../src/index"
import type { AltchaScope } from "../../../src/lib/verification/altcha-provider"
import { createRouteTestContext, json, resetRuntimeCaches } from "../../helpers"
import { buildLocalCommunityDbPath } from "../../../src/lib/communities/community-local-db"
import { getCommunityRepository } from "../../../src/lib/communities/db-community-repository"
import { processCommunityJobsForCommunity } from "../../../src/lib/communities/jobs/runner"
import { setStoryAccessProofSignerForTests } from "../../../src/lib/story/story-access-proof-service"
import { setStoryAssetPublisherForTests } from "../../../src/lib/story/story-publish-service"
import { setStoryCdrUploaderForTests } from "../../../src/lib/story/story-cdr"
import { setStoryRuntimeFundingAssertionForTests } from "../../../src/lib/story/story-runtime-funding"
import { setStoryRoyaltyRegistrarForTests } from "../../../src/lib/story/story-royalty-registration-service"
import {
  completeUniqueHumanVerification,
  exchangeJwt,
  requestJson,
} from "./song-artifact-test-helpers"
import { attachPrimaryWallet, createOpenSongCommunity, uploadSongArtifact } from "./song-artifact-locked-test-helpers"

const testWithTimeout = test as unknown as (name: string, fn: () => Promise<void>, timeout: number) => void

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

function makeSilentWavBytes(durationSeconds = 2): Uint8Array {
  const sampleRate = 8000
  const channelCount = 1
  const bytesPerSample = 2
  const sampleCount = sampleRate * durationSeconds
  const dataSize = sampleCount * channelCount * bytesPerSample
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)
  const writeAscii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index))
    }
  }

  writeAscii(0, "RIFF")
  view.setUint32(4, 36 + dataSize, true)
  writeAscii(8, "WAVE")
  writeAscii(12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channelCount, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * channelCount * bytesPerSample, true)
  view.setUint16(32, channelCount * bytesPerSample, true)
  view.setUint16(34, bytesPerSample * 8, true)
  writeAscii(36, "data")
  view.setUint32(40, dataSize, true)

  return new Uint8Array(buffer)
}

async function solveAltchaProofFromRoute(input: {
  env: Awaited<ReturnType<typeof createRouteTestContext>>["env"]
  accessToken: string
  scope: AltchaScope
  action: string
}): Promise<string> {
  const response = await app.request(
    `http://pirate.test/verification/altcha/challenge?scope=${input.scope}&action=${encodeURIComponent(input.action)}`,
    {
      headers: { authorization: `Bearer ${input.accessToken}` },
    },
    input.env,
  )
  expect(response.status).toBe(200)
  const challenge = await json(response) as Challenge
  const solution = await solveChallenge({ challenge, deriveKey })
  if (!solution) {
    throw new Error("ALTCHA challenge did not solve")
  }
  return btoa(JSON.stringify({ challenge, solution } satisfies Payload))
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

describe("song artifact routes", () => {
  test("allows an unverified community owner to upload and bundle song artifacts", async () => {
    const storedObjects = new Map<string, { body: Uint8Array; contentType: string }>()

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request ? input : new Request(input, init)
      if (request.url === "https://openrouter.test/api/v1/chat/completions") {
        return Response.json({
          choices: [{
            message: {
              content: JSON.stringify({
                age_gate_rating: "safe",
                reason: "clean lyrics",
              }),
            },
          }],
        })
      }

      if (request.url === "https://acrcloud.test/v1/identify") {
        return Response.json({
          status: { code: 0, msg: "Success" },
          metadata: { music: [] },
        })
      }

      if (request.url === "https://console-v2.acrcloud.test/api/buckets/30358/files") {
        return Response.json({
          data: {
            id: 52,
            acr_id: "acr_unverified_owner_upload",
            state: 0,
          },
        })
      }

      if (request.url === "https://elevenlabs.test/forced-alignment") {
        return Response.json({
          provider: "elevenlabs",
          segments: [{
            start_ms: 0,
            end_ms: 900,
            text: "Owner line",
          }],
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
        return new Response(null, { status: 200 })
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
      PIRATE_API_PUBLIC_ORIGIN: "http://pirate.test",
      SONG_PREVIEW_FFMPEG_BIN: "__test_passthrough__",
    })
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "song-artifact-unverified-owner")
    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Unverified Owner Songs",
      membership_mode: "request",
      handle_policy: {
        policy_template: "standard",
      },
    }, ctx.env, owner.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { id: string }
    }
    const communityId = communityCreateBody.community.id.replace(/^com_/, "")

    const uploadIntent = await requestJson(
      `http://pirate.test/communities/${communityId}/song-artifact-uploads`,
      {
        artifact_kind: "primary_audio",
        mime_type: "audio/wav",
        filename: "owner.wav",
        size_bytes: makeSilentWavBytes().byteLength,
      },
      ctx.env,
      owner.accessToken,
    )
    expect(uploadIntent.status).toBe(201)
    const uploadIntentBody = await json(uploadIntent) as {
      id: string
      storage_ref: string
    }

    const uploadContent = await app.request(
      `http://pirate.test/communities/${communityId}/song-artifact-uploads/${uploadIntentBody.id}/content`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${owner.accessToken}`,
          "content-type": "application/octet-stream",
        },
        body: Buffer.from(makeSilentWavBytes()),
      },
      ctx.env,
    )
    expect(uploadContent.status).toBe(200)

    const bundleCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/song-artifacts`,
      {
        primary_audio: {
          song_artifact_upload: uploadIntentBody.id,
        },
        title: "Owner Song",
        lyrics: "Owner line",
        genius_annotations_url: "https://www.genius.com/34172986",
      },
      ctx.env,
      owner.accessToken,
    )
    expect(bundleCreate.status).toBe(201)
    const bundleCreateBody = await json(bundleCreate) as {
      id: string
      genius_annotations_url: string | null
    }
    expect(bundleCreateBody.genius_annotations_url).toBe("https://genius.com/34172986")

    const bundleRead = await app.request(
      `http://pirate.test/communities/${communityId}/song-artifacts/${bundleCreateBody.id}`,
      {
        headers: {
          authorization: `Bearer ${owner.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(bundleRead.status).toBe(200)
    const bundleReadBody = await json(bundleRead) as {
      genius_annotations_url: string | null
    }
    expect(bundleReadBody.genius_annotations_url).toBe("https://genius.com/34172986")

    const bundleList = await app.request(
      `http://pirate.test/communities/${communityId}/song-artifacts?q=Owner&limit=10`,
      {
        headers: {
          authorization: `Bearer ${owner.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(bundleList.status).toBe(200)
    const bundleListBody = await json(bundleList) as {
      items: Array<{ genius_annotations_url: string | null }>
    }
    expect(bundleListBody.items[0]?.genius_annotations_url).toBe("https://genius.com/34172986")

    const invalidBundleCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/song-artifacts`,
      {
        primary_audio: {
          song_artifact_upload: uploadIntentBody.id,
        },
        title: "Invalid Genius URL",
        lyrics: "Owner line",
        genius_annotations_url: "https://example.com/34172986",
      },
      ctx.env,
      owner.accessToken,
    )
    expect(invalidBundleCreate.status).toBe(400)
  })

  test("allows an unverified member to publish a song with ALTCHA when the gate policy is OR", async () => {
    const storedObjects = new Map<string, { body: Uint8Array; contentType: string }>()

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request ? input : new Request(input, init)
      if (request.url === "https://openrouter.test/api/v1/chat/completions") {
        return Response.json({
          choices: [{
            message: {
              content: JSON.stringify({
                age_gate_rating: "safe",
                reason: "instrumental",
              }),
            },
          }],
        })
      }

      if (request.url === "https://acrcloud.test/v1/identify") {
        return Response.json({
          status: { code: 0, msg: "Success" },
          metadata: { music: [] },
        })
      }

      if (request.url === "https://console-v2.acrcloud.test/api/buckets/30358/files") {
        return Response.json({
          data: {
            id: 53,
            acr_id: "acr_altcha_member_upload",
            state: 0,
          },
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
        return new Response(null, { status: 200 })
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
      ALTCHA_HMAC_SECRET: "test-altcha-secret",
      ALTCHA_HMAC_KEY_SECRET: "test-altcha-key-secret",
      ALTCHA_POW_COST: "1",
      ALTCHA_POW_COUNTER_MIN: "1",
      ALTCHA_POW_COUNTER_MAX: "2",
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
      SONG_PREVIEW_FFMPEG_BIN: "__test_passthrough__",
    })
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "song-artifact-altcha-or-creator")
    await completeUniqueHumanVerification(ctx.env, creator.accessToken)
    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "ALTCHA OR Songs",
      membership_mode: "gated",
      gate_policy: {
        version: 1,
        expression: {
          op: "or",
          children: [
            { op: "gate", gate: { type: "unique_human", provider: "very" } },
            { op: "gate", gate: { type: "altcha_pow" } },
          ],
        },
      },
    }, ctx.env, creator.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { id: string }
    }
    const communityId = communityCreateBody.community.id

    const member = await exchangeJwt(ctx.env, "song-artifact-altcha-or-member")
    const joinProof = await solveAltchaProofFromRoute({
      env: ctx.env,
      accessToken: member.accessToken,
      scope: "community_join",
      action: `community:${communityId}`,
    })
    const joined = await app.request(
      `http://pirate.test/communities/${communityId}/join`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${member.accessToken}`,
          "x-pirate-altcha": joinProof,
        },
      },
      ctx.env,
    )
    expect(joined.status).toBe(200)
    await attachPrimaryWallet({
      client: ctx.client,
      userId: member.userId,
      walletAttachmentId: "wal_song_altcha_member",
      walletAddress: "0xaaa0000000000000000000000000000000000007",
    })
    installSuccessfulStoryRoyaltyRegistrarForTests()

    const primaryBytes = makeSilentWavBytes()
    const uploadIntent = await requestJson(
      `http://pirate.test/communities/${communityId}/song-artifact-uploads`,
      {
        artifact_kind: "primary_audio",
        mime_type: "audio/wav",
        filename: "altcha-song.wav",
        size_bytes: primaryBytes.byteLength,
      },
      ctx.env,
      member.accessToken,
    )
    expect(uploadIntent.status).toBe(201)
    const uploadIntentBody = await json(uploadIntent) as { id: string }

    const uploadContent = await app.request(
      `http://pirate.test/communities/${communityId}/song-artifact-uploads/${uploadIntentBody.id}/content`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${member.accessToken}`,
          "content-type": "application/octet-stream",
        },
        body: Buffer.from(primaryBytes),
      },
      ctx.env,
    )
    expect(uploadContent.status).toBe(200)

    const bundleCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/song-artifacts`,
      {
        primary_audio: {
          song_artifact_upload: uploadIntentBody.id,
        },
        title: "ALTCHA Song",
        lyrics: "",
      },
      ctx.env,
      member.accessToken,
    )
    expect(bundleCreate.status).toBe(201)
    const bundleCreateBody = await json(bundleCreate) as { id: string; lyrics: string }
    expect(bundleCreateBody.lyrics).toBe("")

    const postProof = await solveAltchaProofFromRoute({
      env: ctx.env,
      accessToken: member.accessToken,
      scope: "post_create",
      action: `community:${communityId}`,
    })
    const postCreate = await app.request(
      `http://pirate.test/communities/${communityId}/posts`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${member.accessToken}`,
          "content-type": "application/json",
          "x-pirate-altcha": postProof,
        },
        body: JSON.stringify({
          idempotency_key: "altcha-or-song-post",
          post_type: "song",
          identity_mode: "public",
          title: "ALTCHA Song",
          access_mode: "public",
          song_mode: "original",
          rights_basis: "original",
          license_preset: "non-commercial",
          song_artifact_bundle: bundleCreateBody.id,
        }),
      },
      ctx.env,
    )
    expect(postCreate.status).toBe(201)
  })

  testWithTimeout("generates a server-side preview crop and uses it for locked song publication", async () => {
    const storedObjects = new Map<string, { body: Uint8Array; contentType: string }>()

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
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
        return Response.json({
          data: {
            id: 42,
            acr_id: "acr_test_preview_crop",
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
              end_ms: 1200,
              text: "Paid line",
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
        return new Response(null, { status: 200 })
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

    setStoryRuntimeFundingAssertionForTests(async () => {})
    setStoryCdrUploaderForTests(async () => ({
      cdrVaultUuid: 4242,
      writerAddress: "0x0000000000000000000000000000000000000cd1",
      txHashes: {
        allocate: "0xalloc",
        write: "0xwrite",
      },
    }))
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
        scope: "0xb8c1a2b531e7c9d996686b1cc6dcd49d2d7037be365b6d380ebaf489440d4f18",
        expiry: input.expiry,
        namespace: input.namespace,
      },
    }))

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
      PIRATE_API_PUBLIC_ORIGIN: "http://pirate.test",
      SONG_PREVIEW_FFMPEG_BIN: "__test_passthrough__",
    })
    cleanup = ctx.cleanup

    const author = await exchangeJwt(ctx.env, "song-preview-crop-author")
    await attachPrimaryWallet({
      client: ctx.client,
      userId: author.userId,
      walletAttachmentId: "wal_song_preview_crop_author",
      walletAddress: "0xaaa0000000000000000000000000000000000001",
    })
    installSuccessfulStoryRoyaltyRegistrarForTests()
    await completeUniqueHumanVerification(ctx.env, author.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Preview Crop Club",
      membership_mode: "request",
      handle_policy: {
        policy_template: "standard",
      },
    }, ctx.env, author.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: {
        id: string
      }
    }
    const communityId = communityCreateBody.community.id.replace(/^com_/, "")
    const primaryBytes = makeSilentWavBytes()

    const uploadIntent = await requestJson(
      `http://pirate.test/communities/${communityId}/song-artifact-uploads`,
      {
        artifact_kind: "primary_audio",
        mime_type: "audio/wav",
        filename: "preview-source.wav",
        size_bytes: primaryBytes.byteLength,
      },
      ctx.env,
      author.accessToken,
    )
    expect(uploadIntent.status).toBe(201)
    const uploadIntentBody = await json(uploadIntent) as {
      id: string
      upload_url: string
    }
    const primaryBody = new ArrayBuffer(primaryBytes.byteLength)
    new Uint8Array(primaryBody).set(primaryBytes)

    const uploadContent = await app.request(
      `http://pirate.test/communities/${communityId}/song-artifact-uploads/${uploadIntentBody.id}/content`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${author.accessToken}`,
          "content-type": "audio/wav",
        },
        body: primaryBody,
      },
      ctx.env,
    )
    expect(uploadContent.status).toBe(200)

    const bundleCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/song-artifacts`,
      {
        primary_audio: {
          song_artifact_upload: uploadIntentBody.id,
        },
        preview_window: {
          start_ms: 0,
          duration_ms: 1_000,
        },
        title: "Paid Song",
        lyrics: "Paid line",
      },
      ctx.env,
      author.accessToken,
    )
    expect(bundleCreate.status).toBe(201)
    const pendingBundle = await json(bundleCreate) as {
      id: string
      preview_audio?: unknown | null
      preview_status: string
      preview_window?: { start_ms: number; duration_ms: number } | null
    }
    expect(pendingBundle.preview_audio).toBeNull()
    expect(pendingBundle.preview_status).toBe("pending")
    expect(pendingBundle.preview_window).toEqual({
      start_ms: 0,
      duration_ms: 1_000,
    })

    const jobSummary = await processCommunityJobsForCommunity({
      env: ctx.env,
      communityId,
      communityRepository: getCommunityRepository(ctx.env),
      maxJobs: 1,
    })
    expect(jobSummary.processed_jobs).toBe(1)
    expect(jobSummary.jobs[0]?.job_type).toBe("song_preview_generate")
    expect(jobSummary.jobs[0]?.status).toBe("succeeded")

    const completedBundleRead = await app.request(
      `http://pirate.test/communities/${communityId}/song-artifacts/${pendingBundle.id}`,
      {
        headers: {
          authorization: `Bearer ${author.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(completedBundleRead.status).toBe(200)
    const completedBundle = await json(completedBundleRead) as {
      preview_audio?: {
        storage_ref: string
        mime_type: string
        size_bytes?: number | null
        duration_ms?: number | null
      } | null
      preview_status: string
    }
    expect(completedBundle.preview_status).toBe("completed")
    expect(completedBundle.preview_audio?.mime_type).toBe("audio/mpeg")
    expect(completedBundle.preview_audio?.storage_ref).toContain(
      `/communities/${communityId}/song-artifact-uploads/`,
    )
    expect((completedBundle.preview_audio?.size_bytes ?? 0) > 0).toBe(true)
    expect((completedBundle.preview_audio?.duration_ms ?? 0) > 0).toBe(true)
    expect((completedBundle.preview_audio?.duration_ms ?? 0) < 30_000).toBe(true)

    const previewContent = await app.request(
      completedBundle.preview_audio?.storage_ref ?? "",
      {
        headers: {
          authorization: `Bearer ${author.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(previewContent.status).toBe(200)
    expect(previewContent.headers.get("content-type")).toBe("audio/mpeg")
    expect((await previewContent.arrayBuffer()).byteLength).toBe(completedBundle.preview_audio?.size_bytes)

    const lockedPostCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/posts`,
      {
        idempotency_key: "song-preview-crop-locked-post",
        post_type: "song",
        identity_mode: "public",
        title: "Paid preview crop",
        access_mode: "locked",
        song_mode: "original",
        rights_basis: "original",
        license_preset: "non-commercial",
        song_artifact_bundle: pendingBundle.id,
      },
      ctx.env,
      author.accessToken,
    )
    expect(lockedPostCreate.status).toBe(201)
    const lockedPost = await json(lockedPostCreate) as {
      access_mode?: string | null
      media_refs?: Array<{ storage_ref: string; mime_type?: string }>
    }
    expect(lockedPost.access_mode).toBe("locked")
    expect(lockedPost.media_refs?.[0]?.storage_ref).toBe(completedBundle.preview_audio?.storage_ref)
    expect(lockedPost.media_refs?.[0]?.mime_type).toBe("audio/mpeg")
  }, 15000)

test("uploads a song artifact bundle and publishes a song post", async () => {
    const storedObjects = new Map<string, { body: Uint8Array; contentType: string }>()
    let openRouterCallCount = 0
    let acrCloudCallCount = 0
    let acrCloudCatalogCallCount = 0
    let elevenLabsCallCount = 0

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request ? input : new Request(input, init)
      if (request.url === "https://openrouter.test/api/v1/chat/completions") {
        openRouterCallCount += 1
        return Response.json({
          id: "chatcmpl_test_song_bundle",
          model: "google/gemini-3.1-flash-lite-preview",
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
        acrCloudCallCount += 1
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
            id: 42,
            acr_id: "acr_test_song_42",
            state: 0,
          },
        })
      }

      if (request.url === "https://elevenlabs.test/forced-alignment") {
        elevenLabsCallCount += 1
        return Response.json({
          provider: "elevenlabs",
          segments: [
            {
              start_ms: 0,
              end_ms: 1800,
              text: "Line one",
            },
            {
              start_ms: 1800,
              end_ms: 3600,
              text: "Line two",
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
        return new Response(null, { status: 200 })
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

    const author = await exchangeJwt(ctx.env, "song-author")
    await attachPrimaryWallet({
      client: ctx.client,
      userId: author.userId,
      walletAttachmentId: "wal_song_author",
      walletAddress: "0xaaa0000000000000000000000000000000000002",
    })
    installSuccessfulStoryRoyaltyRegistrarForTests()
    await completeUniqueHumanVerification(ctx.env, author.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Song Club",
      membership_mode: "request",
      handle_policy: {
        policy_template: "standard",
      },
    }, ctx.env, author.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: {
        id: string
      }
    }
    const communityId = communityCreateBody.community.id.replace(/^com_/, "")

    const uploadIntent = await requestJson(
      `http://pirate.test/communities/${communityId}/song-artifact-uploads`,
      {
        artifact_kind: "primary_audio",
        mime_type: "audio/mpeg",
        filename: "anthem.mp3",
        size_bytes: 8,
      },
      ctx.env,
      author.accessToken,
    )
    expect(uploadIntent.status).toBe(201)
    const uploadIntentBody = await json(uploadIntent) as {
      id: string
      upload_url: string
      storage_ref: string
      status: string
    }
    expect(uploadIntentBody.status).toBe("pending_upload")
    expect(`http://pirate.test/communities/${communityId}/song-artifact-uploads/${uploadIntentBody.id}/content`).toContain(`/communities/${communityId}/song-artifact-uploads/`)

    const previewUploadIntent = await requestJson(
      `http://pirate.test/communities/${communityId}/song-artifact-uploads`,
      {
        artifact_kind: "preview_audio",
        mime_type: "audio/mpeg",
        filename: "uploaded-preview.mp3",
        size_bytes: 4,
      },
      ctx.env,
      author.accessToken,
    )
    expect(previewUploadIntent.status).toBe(400)

    const uploadContent = await app.request(
      `http://pirate.test/communities/${communityId}/song-artifact-uploads/${uploadIntentBody.id}/content`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${author.accessToken}`,
          "content-type": "application/octet-stream",
        },
        body: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer,
      },
      ctx.env,
    )
    expect(uploadContent.status).toBe(200)
    const uploaded = await json(uploadContent) as {
      id: string
      status: string
      content_hash: string
    }
    expect(uploaded.id).toBe(uploadIntentBody.id)
    expect(uploaded.status).toBe("uploaded")
    expect(uploaded.content_hash).toMatch(/^0x[0-9a-f]{64}$/)

    const coverUploadIntent = await requestJson(
      `http://pirate.test/communities/${communityId}/song-artifact-uploads`,
      {
        artifact_kind: "cover_art",
        mime_type: "image/jpeg",
        filename: "cover.jpg",
        size_bytes: 4,
      },
      ctx.env,
      author.accessToken,
    )
    expect(coverUploadIntent.status).toBe(201)
    const coverUploadIntentBody = await json(coverUploadIntent) as {
      id: string
      storage_ref: string
    }
    const coverUploadContent = await app.request(
      `http://pirate.test/communities/${communityId}/song-artifact-uploads/${coverUploadIntentBody.id}/content`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${author.accessToken}`,
          "content-type": "image/jpeg",
        },
        body: new Uint8Array([9, 8, 7, 6]).buffer,
      },
      ctx.env,
    )
    expect(coverUploadContent.status).toBe(200)

    const instrumentalUploadIntent = await requestJson(
      `http://pirate.test/communities/${communityId}/song-artifact-uploads`,
      {
        artifact_kind: "instrumental_audio",
        mime_type: "audio/mpeg",
        filename: "instrumental.mp3",
        size_bytes: 4,
      },
      ctx.env,
      author.accessToken,
    )
    expect(instrumentalUploadIntent.status).toBe(201)
    const instrumentalUploadIntentBody = await json(instrumentalUploadIntent) as {
      id: string
      storage_ref: string
    }
    const instrumentalUploadContent = await app.request(
      `http://pirate.test/communities/${communityId}/song-artifact-uploads/${instrumentalUploadIntentBody.id}/content`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${author.accessToken}`,
          "content-type": "audio/mpeg",
        },
        body: new Uint8Array([1, 3, 3, 7]).buffer,
      },
      ctx.env,
    )
    expect(instrumentalUploadContent.status).toBe(200)

    const vocalUploadIntent = await requestJson(
      `http://pirate.test/communities/${communityId}/song-artifact-uploads`,
      {
        artifact_kind: "vocal_audio",
        mime_type: "audio/mpeg",
        filename: "vocals.mp3",
        size_bytes: 4,
      },
      ctx.env,
      author.accessToken,
    )
    expect(vocalUploadIntent.status).toBe(201)
    const vocalUploadIntentBody = await json(vocalUploadIntent) as {
      id: string
      storage_ref: string
    }
    const vocalUploadContent = await app.request(
      `http://pirate.test/communities/${communityId}/song-artifact-uploads/${vocalUploadIntentBody.id}/content`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${author.accessToken}`,
          "content-type": "audio/mpeg",
        },
        body: new Uint8Array([4, 4, 4, 4]).buffer,
      },
      ctx.env,
    )
    expect(vocalUploadContent.status).toBe(200)

    const readContent = await app.request(
      `http://pirate.test/communities/${communityId}/song-artifact-uploads/${uploadIntentBody.id}/content`,
      {},
      ctx.env,
    )
    expect(readContent.status).toBe(200)
    expect(new Uint8Array(await readContent.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))

    const headContent = await app.request(
      `http://pirate.test/communities/${communityId}/song-artifact-uploads/${uploadIntentBody.id}/content`,
      { method: "HEAD" },
      ctx.env,
    )
    expect(headContent.status).toBe(200)
    expect(headContent.headers.get("content-length")).toBe("8")
    expect((await headContent.arrayBuffer()).byteLength).toBe(0)

    const bundleCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/song-artifacts`,
      {
        primary_audio: {
          song_artifact_upload: uploadIntentBody.id,
        },
        cover_art: {
          song_artifact_upload: coverUploadIntentBody.id,
        },
        instrumental_audio: {
          song_artifact_upload: instrumentalUploadIntentBody.id,
        },
        vocal_audio: {
          song_artifact_upload: vocalUploadIntentBody.id,
        },
        title: "Published Song",
        lyrics: "Line one\nLine two",
        genius_annotations_url: "https://www.genius.com/34172986",
      },
      ctx.env,
      author.accessToken,
    )
    expect(bundleCreate.status).toBe(201)
    const bundleBody = await json(bundleCreate) as {
      id: string
      status: string
      media_refs: Array<{ storage_ref: string; mime_type: string }>
      cover_art: { storage_ref: string; mime_type: string } | null
      moderation_status: string
      alignment_status: string
      timed_lyrics: { segments: unknown[] }
    }
    expect(bundleBody.status).toBe("ready")
    expect(bundleBody.media_refs).toHaveLength(1)
    expect(bundleBody.media_refs[0]?.storage_ref).toBe(uploadIntentBody.storage_ref)
    expect(bundleBody.cover_art?.storage_ref).toBe(coverUploadIntentBody.storage_ref)
    expect(bundleBody.moderation_status).toBe("completed")
    expect(bundleBody.alignment_status).toBe("completed")
    expect(bundleBody.timed_lyrics.segments.length).toBe(2)
    expect(openRouterCallCount).toBe(1)
    expect(acrCloudCallCount).toBe(1)
    expect(elevenLabsCallCount).toBe(1)

    await ctx.client.execute({
      sql: `
        UPDATE song_artifact_bundles
        SET primary_audio_json = ?1
        WHERE song_artifact_bundle_id = ?2
      `,
      args: [
        JSON.stringify({
          storage_ref: uploadIntentBody.storage_ref,
          mime_type: "audio/mpeg",
          size_bytes: 8,
          content_hash: uploaded.content_hash,
          duration_ms: 123_456,
        }),
        bundleBody.id.replace(/^sab_/, ""),
      ],
    })

    const postCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/posts`,
      {
        idempotency_key: "song-post-1",
        post_type: "song",
        identity_mode: "public",
        title: "My first song",
        song_mode: "original",
        rights_basis: "original",
        license_preset: "commercial-remix",
        commercial_rev_share_pct: 10,
        song_artifact_bundle: bundleBody.id,
      },
      ctx.env,
      author.accessToken,
    )
    expect(postCreate.status).toBe(201)
    const postBody = await json(postCreate) as {
      asset?: string | null
      id: string
      post_type: string
      status: string
      song_artifact_bundle: string | null
      song_annotations_url?: string | null
      media_refs?: Array<{ storage_ref: string }>
    }
    expect(postBody.post_type).toBe("song")
    expect(postBody.status).toBe("published")
    expect(postBody.song_artifact_bundle).toBe(bundleBody.id)
    expect(postBody.song_annotations_url).toBe("https://genius.com/34172986")
    expect(postBody.media_refs?.[0]?.storage_ref).toBe(uploadIntentBody.storage_ref)

    const postRead = await app.request(
      `http://pirate.test/posts/${postBody.id}`,
      {
        headers: {
          authorization: `Bearer ${author.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(postRead.status).toBe(200)
    const postReadBody = await json(postRead) as {
      post?: {
        song_annotations_url?: string | null
      }
      song_presentation?: {
        title: string | null
        cover_art_ref: string | null
        duration_ms: number | null
        downloadable_audio?: Array<{
          kind: string
          storage_ref: string
          mime_type: string
        }> | null
      } | null
    }
    expect(postReadBody.post?.song_annotations_url).toBe("https://genius.com/34172986")
    expect(postReadBody.song_presentation).toMatchObject({
      title: "Published Song",
      cover_art_ref: coverUploadIntentBody.storage_ref,
      duration_ms: 123_456,
    })
    expect(postReadBody.song_presentation?.downloadable_audio?.map((item) => ({
      kind: item.kind,
      storage_ref: item.storage_ref,
      mime_type: item.mime_type,
    }))).toEqual([
      {
        kind: "original",
        storage_ref: uploadIntentBody.storage_ref,
        mime_type: "audio/mpeg",
      },
      {
        kind: "instrumental",
        storage_ref: instrumentalUploadIntentBody.storage_ref,
        mime_type: "audio/mpeg",
      },
      {
        kind: "vocals",
        storage_ref: vocalUploadIntentBody.storage_ref,
        mime_type: "audio/mpeg",
      },
    ])

    const bundleRead = await app.request(
      `http://pirate.test/communities/${communityId}/song-artifacts/${bundleBody.id}`,
      {
        headers: {
          authorization: `Bearer ${author.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(bundleRead.status).toBe(200)
    const bundleReadBody = await json(bundleRead) as {
      status: string
      moderation_result?: {
        catalog_sync?: {
          synced?: boolean
          file_id?: number
          acr_id?: string
        }
      }
    }
    expect(bundleReadBody.status).toBe("consumed")
    expect(bundleReadBody.moderation_result?.catalog_sync?.synced).toBe(true)
    expect(bundleReadBody.moderation_result?.catalog_sync?.file_id).toBe(42)
    expect(bundleReadBody.moderation_result?.catalog_sync?.acr_id).toBe("acr_test_song_42")
    expect(acrCloudCatalogCallCount).toBe(1)

    expect(postBody.asset).toBeTruthy()
    const originalAssetRead = await app.request(
      `http://pirate.test/communities/${communityId}/assets/${postBody.asset}`,
      {
        headers: {
          authorization: `Bearer ${author.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(originalAssetRead.status).toBe(200)
    const originalAssetBody = await json(originalAssetRead) as {
      story_ip: string | null
      story_royalty_registration_status: string
    }
    expect(originalAssetBody.story_royalty_registration_status).toBe("registered")
    expect(originalAssetBody.story_ip).toBeTruthy()

    const deleteOriginalPost = await requestJson(
      `http://pirate.test/communities/${communityId}/posts/${postBody.id}/delete`,
      {},
      ctx.env,
      author.accessToken,
    )
    expect(deleteOriginalPost.status).toBe(200)

    const retryUploadIntent = await requestJson(
      `http://pirate.test/communities/${communityId}/song-artifact-uploads`,
      {
        artifact_kind: "primary_audio",
        mime_type: "audio/mpeg",
        filename: "anthem-retry.mp3",
        size_bytes: 8,
      },
      ctx.env,
      author.accessToken,
    )
    expect(retryUploadIntent.status).toBe(201)
    const retryUploadIntentBody = await json(retryUploadIntent) as {
      id: string
      storage_ref: string
    }
    const retryUploadContent = await app.request(
      `http://pirate.test/communities/${communityId}/song-artifact-uploads/${retryUploadIntentBody.id}/content`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${author.accessToken}`,
          "content-type": "application/octet-stream",
        },
        body: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer,
      },
      ctx.env,
    )
    expect(retryUploadContent.status).toBe(200)

    const retryBundleCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/song-artifacts`,
      {
        primary_audio: {
          song_artifact_upload: retryUploadIntentBody.id,
        },
        title: "Republished Song",
        lyrics: "Line one\nLine two",
      },
      ctx.env,
      author.accessToken,
    )
    expect(retryBundleCreate.status).toBe(201)
    const retryBundleBody = await json(retryBundleCreate) as {
      id: string
      status: string
    }
    expect(retryBundleBody.status).toBe("ready")

    await ctx.client.execute({
      sql: `
        UPDATE song_artifact_bundles
        SET primary_audio_json = ?1
        WHERE song_artifact_bundle_id = ?2
      `,
      args: [
        JSON.stringify({
          storage_ref: retryUploadIntentBody.storage_ref,
          mime_type: "audio/mpeg",
          size_bytes: 8,
          content_hash: uploaded.content_hash,
          duration_ms: 123_456,
        }),
        retryBundleBody.id.replace(/^sab_/, ""),
      ],
    })

    setStoryRoyaltyRegistrarForTests(async () => {
      throw new Error("duplicate original should reuse the previous Story registration")
    })
    const retryPostCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/posts`,
      {
        idempotency_key: "song-post-republish-same-content",
        post_type: "song",
        identity_mode: "public",
        title: "My republished song",
        song_mode: "original",
        rights_basis: "original",
        license_preset: "non-commercial",
        song_artifact_bundle: retryBundleBody.id,
      },
      ctx.env,
      author.accessToken,
    )
    expect(retryPostCreate.status).toBe(201)
    const retryPostBody = await json(retryPostCreate) as {
      asset?: string | null
      status: string
    }
    expect(retryPostBody.status).toBe("published")
    expect(retryPostBody.asset).toBeTruthy()

    const retryAssetRead = await app.request(
      `http://pirate.test/communities/${communityId}/assets/${retryPostBody.asset}`,
      {
        headers: {
          authorization: `Bearer ${author.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(retryAssetRead.status).toBe(200)
    const retryAssetBody = await json(retryAssetRead) as {
      story_ip: string | null
      story_royalty_registration_status: string
      license_preset: string | null
      commercial_rev_share_pct: number | null
    }
    expect(retryAssetBody.story_royalty_registration_status).toBe("registered")
    expect(retryAssetBody.story_ip).toBe(originalAssetBody.story_ip)
    expect(retryAssetBody.license_preset).toBe("commercial-remix")
    expect(retryAssetBody.commercial_rev_share_pct).toBe(10)

    const previewWindowBundleCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/song-artifacts`,
      {
        primary_audio: {
          song_artifact_upload: uploadIntentBody.id,
        },
        title: "Preview Window Song",
        lyrics: "Preview line one\nPreview line two",
        preview_window: {
          start_ms: 42_000,
          duration_ms: 1_000,
        },
      },
      ctx.env,
      author.accessToken,
    )
    expect(previewWindowBundleCreate.status).toBe(201)
    const previewWindowBundleBody = await json(previewWindowBundleCreate) as {
      preview_audio?: unknown | null
      preview_status: string
      preview_window?: { start_ms: number; duration_ms: number } | null
    }
    expect(previewWindowBundleBody.preview_audio).toBeNull()
    expect(previewWindowBundleBody.preview_status).toBe("pending")
    expect(previewWindowBundleBody.preview_window).toEqual({
      start_ms: 42_000,
      duration_ms: 1_000,
    })

    const conflictingPreviewCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/song-artifacts`,
      {
        primary_audio: {
          song_artifact_upload: uploadIntentBody.id,
        },
        title: "Conflicting Preview Song",
        lyrics: "Conflicting preview source",
        preview_audio: {
          song_artifact_upload: "sau_conflicting_preview",
        },
        preview_window: {
          start_ms: 0,
          duration_ms: 1_000,
        },
      },
      ctx.env,
      author.accessToken,
    )
    expect(conflictingPreviewCreate.status).toBe(400)
  })

  test("allows a remix submit when the same bytes were already registered as an original", async () => {
    const storedObjects = new Map<string, { body: Uint8Array; contentType: string }>()

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request ? input : new Request(input, init)
      if (request.url === "https://openrouter.test/api/v1/chat/completions") {
        return Response.json({
          id: "chatcmpl_test_story_original_collision",
          model: "google/gemini-3.1-flash-lite-preview",
          choices: [{
            message: {
              content: JSON.stringify({
                age_gate_rating: "safe",
                reason: "clean lyrics",
              }),
            },
          }],
        })
      }

      if (request.url === "https://acrcloud.test/v1/identify") {
        return Response.json({
          status: { code: 0, msg: "Success" },
          metadata: { music: [] },
        })
      }

      if (request.url === "https://console-v2.acrcloud.test/api/buckets/30358/files") {
        return Response.json({
          data: {
            id: 64,
            acr_id: "acr_story_original_collision",
            state: 0,
          },
        })
      }

      if (request.url === "https://elevenlabs.test/forced-alignment") {
        return Response.json({
          provider: "elevenlabs",
          segments: [{
            start_ms: 0,
            end_ms: 900,
            text: "Collision line",
          }],
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
        return new Response(null, { status: 200 })
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

    const author = await exchangeJwt(ctx.env, "song-author-story-original-collision")
    await attachPrimaryWallet({
      client: ctx.client,
      userId: author.userId,
      walletAttachmentId: "wal_song_author_story_original_collision",
      walletAddress: "0xaaa0000000000000000000000000000000000004",
    })
    await completeUniqueHumanVerification(ctx.env, author.accessToken)

    const originalStoryIp = "0x9999999999999999999999999999999999999999"
    let registrarCallsAfterOriginal = 0
    setStoryRoyaltyRegistrarForTests(async () => ({
      storyIpId: originalStoryIp,
      storyIpNftContract: "0x8888888888888888888888888888888888888888",
      storyIpNftTokenId: "123",
      storyLicenseTermsId: "17",
      storyLicenseTemplate: null,
      storyRoyaltyPolicy: "0xBe54FB168b3c982b7AaE60dB6CF75Bd8447b390E",
      storyDerivativeParentIpIds: null,
      storyRevenueToken: "0x1514000000000000000000000000000000000000",
      storyRoyaltyRegistrationStatus: "registered",
      storyDerivativeRegisteredAt: null,
    }))

    const communityId = await createOpenSongCommunity(ctx.env, author.accessToken, "Story Collision Club")
    const primaryBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
    const originalUpload = await uploadSongArtifact({
      env: ctx.env,
      communityId,
      accessToken: author.accessToken,
      artifactKind: "primary_audio",
      mimeType: "audio/mpeg",
      filename: "collision-original.mp3",
      bytes: primaryBytes,
    })
    const originalBundleCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/song-artifacts`,
      {
        primary_audio: {
          song_artifact_upload: originalUpload.id,
        },
        title: "Collision Original",
        lyrics: "Collision line",
      },
      ctx.env,
      author.accessToken,
    )
    expect(originalBundleCreate.status).toBe(201)
    const originalBundle = await json(originalBundleCreate) as { id: string }
    const originalPostCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/posts`,
      {
        idempotency_key: "song-post-story-original-collision-original",
        post_type: "song",
        identity_mode: "public",
        title: "Collision original",
        song_mode: "original",
        rights_basis: "original",
        license_preset: "commercial-remix",
        commercial_rev_share_pct: 10,
        song_artifact_bundle: originalBundle.id,
      },
      ctx.env,
      author.accessToken,
    )
    expect(originalPostCreate.status).toBe(201)
    const originalPost = await json(originalPostCreate) as {
      asset?: string | null
      id: string
    }
    expect(originalPost.asset).toBeTruthy()

    const deleteOriginalPost = await requestJson(
      `http://pirate.test/communities/${communityId}/posts/${originalPost.id}/delete`,
      {},
      ctx.env,
      author.accessToken,
    )
    expect(deleteOriginalPost.status).toBe(200)

    setStoryRoyaltyRegistrarForTests(async () => {
      registrarCallsAfterOriginal += 1
      return {
        storyIpId: "0x3333333333333333333333333333333333333333",
        storyIpNftContract: "0x8888888888888888888888888888888888888888",
        storyIpNftTokenId: "456",
        storyLicenseTermsId: "23",
        storyLicenseTemplate: null,
        storyRoyaltyPolicy: "0xBe54FB168b3c982b7AaE60dB6CF75Bd8447b390E",
        storyDerivativeParentIpIds: [originalStoryIp],
        storyRevenueToken: "0x1514000000000000000000000000000000000000",
        storyRoyaltyRegistrationStatus: "registered",
        storyDerivativeRegisteredAt: "2026-04-21T00:00:00.000Z",
      }
    })

    const derivativeUpload = await uploadSongArtifact({
      env: ctx.env,
      communityId,
      accessToken: author.accessToken,
      artifactKind: "primary_audio",
      mimeType: "audio/mpeg",
      filename: "collision-remix.mp3",
      bytes: primaryBytes,
    })
    const derivativeBundleCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/song-artifacts`,
      {
        primary_audio: {
          song_artifact_upload: derivativeUpload.id,
        },
        title: "Collision Remix",
        lyrics: "Collision line remix",
      },
      ctx.env,
      author.accessToken,
    )
    expect(derivativeBundleCreate.status).toBe(201)
    const derivativeBundle = await json(derivativeBundleCreate) as { id: string }
    const derivativePostCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/posts`,
      {
        idempotency_key: "song-post-story-original-collision-derivative",
        post_type: "song",
        identity_mode: "public",
        title: "Collision remix",
        asset_id: "ast_story_original_collision_derivative_route",
        song_mode: "remix",
        rights_basis: "derivative",
        license_preset: "commercial-remix",
        commercial_rev_share_pct: 10,
        upstream_asset_refs: [`story:ip:${originalStoryIp}#licenseTermsId=17`],
        song_artifact_bundle: derivativeBundle.id,
      },
      ctx.env,
      author.accessToken,
    )
    expect(derivativePostCreate.status).toBe(201)
    await json(derivativePostCreate)
    expect(registrarCallsAfterOriginal).toBe(1)

    const communityDb = createClient({
      url: `file:${buildLocalCommunityDbPath(ctx.communityDbRoot, communityId)}`,
    })
    try {
      const postRows = await communityDb.execute({
        sql: "SELECT COUNT(*) AS count FROM posts WHERE idempotency_key = ?1",
        args: ["song-post-story-original-collision-derivative"],
      })
      const assetRows = await communityDb.execute({
        sql: `
          SELECT rights_basis, primary_content_hash, story_ip_id, story_royalty_registration_status
          FROM assets
          WHERE asset_id = ?1
        `,
        args: ["ast_story_original_collision_derivative_route"],
      })
      expect(Number(postRows.rows[0]?.count ?? 0)).toBe(1)
      expect(assetRows.rows).toHaveLength(1)
      expect(assetRows.rows[0]?.rights_basis).toBe("derivative")
      expect(assetRows.rows[0]?.story_ip_id).toBe("0x3333333333333333333333333333333333333333")
      expect(assetRows.rows[0]?.story_royalty_registration_status).toBe("registered")
    } finally {
      communityDb.close()
    }
  })

  test("allows song publication when ACRCloud is not configured in local dev", async () => {
    const storedObjects = new Map<string, { body: Uint8Array; contentType: string }>()

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request ? input : new Request(input, init)

      if (!request.url.startsWith("https://s3.filebase.test/")) {
        return await originalFetch(request)
      }

      if (request.method === "PUT") {
        storedObjects.set(request.url, {
          body: new Uint8Array(await request.arrayBuffer()),
          contentType: request.headers.get("content-type") || "application/octet-stream",
        })
        return new Response(null, { status: 200 })
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
    })
    cleanup = ctx.cleanup

    const author = await exchangeJwt(ctx.env, "song-author-no-acr")
    await attachPrimaryWallet({
      client: ctx.client,
      userId: author.userId,
      walletAttachmentId: "wal_song_author_no_acr",
      walletAddress: "0xaaa0000000000000000000000000000000000003",
    })
    installSuccessfulStoryRoyaltyRegistrarForTests()
    await completeUniqueHumanVerification(ctx.env, author.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "No ACR Song Club",
      membership_mode: "request",
      handle_policy: {
        policy_template: "standard",
      },
    }, ctx.env, author.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: {
        id: string
      }
    }
    const communityId = communityCreateBody.community.id.replace(/^com_/, "")

    const uploadIntent = await requestJson(
      `http://pirate.test/communities/${communityId}/song-artifact-uploads`,
      {
        artifact_kind: "primary_audio",
        mime_type: "audio/mpeg",
        filename: "local-dev-song.mp3",
        size_bytes: 8,
      },
      ctx.env,
      author.accessToken,
    )
    expect(uploadIntent.status).toBe(201)
    const uploadIntentBody = await json(uploadIntent) as {
      id: string
      upload_url: string
      storage_ref: string
    }

    const uploadContent = await app.request(
      `http://pirate.test/communities/${communityId}/song-artifact-uploads/${uploadIntentBody.id}/content`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${author.accessToken}`,
          "content-type": "application/octet-stream",
        },
        body: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer,
      },
      ctx.env,
    )
    expect(uploadContent.status).toBe(200)

    const bundleCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/song-artifacts`,
      {
        primary_audio: {
          song_artifact_upload: uploadIntentBody.id,
        },
        title: "Local Dev Song",
        lyrics: "Line one\nLine two",
      },
      ctx.env,
      author.accessToken,
    )
    expect(bundleCreate.status).toBe(201)
    const bundleBody = await json(bundleCreate) as {
      id: string
      status: string
      moderation_status: string
      moderation_result?: {
        analysis_state?: string
        audio_identification?: {
          provider_result?: {
            error?: string
          }
        }
      }
    }
    expect(bundleBody.status).toBe("ready")
    expect(bundleBody.moderation_status).toBe("failed")
    expect(bundleBody.moderation_result?.analysis_state).toBe("allow")
    expect(bundleBody.moderation_result?.audio_identification?.provider_result?.error).toBe("missing_configuration")

    const postCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/posts`,
      {
        idempotency_key: "song-post-no-acr",
        post_type: "song",
        identity_mode: "public",
        title: "Song without ACR",
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
      post_type: string
      status: string
      song_artifact_bundle: string | null
    }
    expect(postBody.post_type).toBe("song")
    expect(postBody.status).toBe("published")
    expect(postBody.song_artifact_bundle).toBe(bundleBody.id)
  })

})
