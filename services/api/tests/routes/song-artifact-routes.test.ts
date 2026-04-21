import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import app from "../../src/index"
import { createRouteTestContext, json, resetRuntimeCaches } from "../helpers"
import {
  completeUniqueHumanVerification,
  exchangeJwt,
  requestJson,
} from "./song-artifact-test-helpers"

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

describe("song artifact routes", () => {
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
      FILEBASE_S3_BUCKET_MUSIC: "pirate-song-media",
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
    await completeUniqueHumanVerification(ctx.env, author.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Song Club",
      handle_policy: {
        policy_template: "standard",
      },
    }, ctx.env, author.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: {
        community_id: string
      }
    }
    const communityId = communityCreateBody.community.community_id

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
      song_artifact_upload_id: string
      upload_url: string
      storage_ref: string
      status: string
    }
    expect(uploadIntentBody.status).toBe("pending_upload")
    expect(uploadIntentBody.upload_url).toContain(`/communities/${communityId}/song-artifact-uploads/`)

    const uploadContent = await app.request(
      uploadIntentBody.upload_url,
      {
        method: "PUT",
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
      song_artifact_upload_id: string
      status: string
      content_hash: string
    }
    expect(uploaded.song_artifact_upload_id).toBe(uploadIntentBody.song_artifact_upload_id)
    expect(uploaded.status).toBe("uploaded")
    expect(uploaded.content_hash).toMatch(/^0x[0-9a-f]{64}$/)

    const readContent = await app.request(uploadIntentBody.storage_ref, {}, ctx.env)
    expect(readContent.status).toBe(200)
    expect(new Uint8Array(await readContent.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))

    const bundleCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/song-artifacts`,
      {
        primary_audio: {
          song_artifact_upload_id: uploadIntentBody.song_artifact_upload_id,
        },
        lyrics: "Line one\nLine two",
      },
      ctx.env,
      author.accessToken,
    )
    expect(bundleCreate.status).toBe(201)
    const bundleBody = await json(bundleCreate) as {
      song_artifact_bundle_id: string
      status: string
      media_refs: Array<{ storage_ref: string; mime_type: string }>
      moderation_status: string
      alignment_status: string
      timed_lyrics: { segments: unknown[] }
    }
    expect(bundleBody.status).toBe("ready")
    expect(bundleBody.media_refs).toHaveLength(1)
    expect(bundleBody.media_refs[0]?.storage_ref).toBe(uploadIntentBody.storage_ref)
    expect(bundleBody.moderation_status).toBe("completed")
    expect(bundleBody.alignment_status).toBe("completed")
    expect(bundleBody.timed_lyrics.segments.length).toBe(2)
    expect(openRouterCallCount).toBe(1)
    expect(acrCloudCallCount).toBe(1)
    expect(elevenLabsCallCount).toBe(1)

    const postCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/posts`,
      {
        idempotency_key: "song-post-1",
        post_type: "song",
        identity_mode: "public",
        title: "My first song",
        song_mode: "original",
        rights_basis: "original",
        song_artifact_bundle_id: bundleBody.song_artifact_bundle_id,
      },
      ctx.env,
      author.accessToken,
    )
    expect(postCreate.status).toBe(201)
    const postBody = await json(postCreate) as {
      post_id: string
      post_type: string
      status: string
      song_artifact_bundle_id: string | null
      media_refs?: Array<{ storage_ref: string }>
    }
    expect(postBody.post_type).toBe("song")
    expect(postBody.status).toBe("published")
    expect(postBody.song_artifact_bundle_id).toBe(bundleBody.song_artifact_bundle_id)
    expect(postBody.media_refs?.[0]?.storage_ref).toBe(uploadIntentBody.storage_ref)

    const bundleRead = await app.request(
      `http://pirate.test/communities/${communityId}/song-artifacts/${bundleBody.song_artifact_bundle_id}`,
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
      FILEBASE_S3_BUCKET_MUSIC: "pirate-song-media",
    })
    cleanup = ctx.cleanup

    const author = await exchangeJwt(ctx.env, "song-author-no-acr")
    await completeUniqueHumanVerification(ctx.env, author.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "No ACR Song Club",
      membership_mode: "open",
      handle_policy: {
        policy_template: "standard",
      },
    }, ctx.env, author.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: {
        community_id: string
      }
    }
    const communityId = communityCreateBody.community.community_id

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
      song_artifact_upload_id: string
      upload_url: string
      storage_ref: string
    }

    const uploadContent = await app.request(
      uploadIntentBody.upload_url,
      {
        method: "PUT",
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
          song_artifact_upload_id: uploadIntentBody.song_artifact_upload_id,
        },
        lyrics: "Line one\nLine two",
      },
      ctx.env,
      author.accessToken,
    )
    expect(bundleCreate.status).toBe(201)
    const bundleBody = await json(bundleCreate) as {
      song_artifact_bundle_id: string
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
        song_artifact_bundle_id: bundleBody.song_artifact_bundle_id,
      },
      ctx.env,
      author.accessToken,
    )
    expect(postCreate.status).toBe(201)
    const postBody = await json(postCreate) as {
      post_type: string
      status: string
      song_artifact_bundle_id: string | null
    }
    expect(postBody.post_type).toBe("song")
    expect(postBody.status).toBe("published")
    expect(postBody.song_artifact_bundle_id).toBe(bundleBody.song_artifact_bundle_id)
  })

})
