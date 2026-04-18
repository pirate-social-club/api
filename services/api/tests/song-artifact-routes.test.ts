import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import app from "../src/index"
import { createRouteTestContext, json, mintUpstreamJwt, resetRuntimeCaches } from "./helpers"
import type { Env } from "../src/types"
import { setStoryAccessProofSignerForTests } from "../src/lib/story/story-access-proof-service"
import { setStoryAssetPublisherForTests } from "../src/lib/story/story-publish-service"
import { setStoryCdrUploaderForTests } from "../src/lib/story/story-cdr"
import { setStoryRuntimeFundingAssertionForTests } from "../src/lib/story/story-runtime-funding"
import { setStoryPurchaseSettlementExecutorForTests } from "../src/lib/story/story-settlement-service"

let cleanup: (() => Promise<void>) | null = null
let originalFetch: typeof fetch

function requestJson(url: string, body: unknown, env: Env, token?: string): Promise<Response> {
  return Promise.resolve(app.request(
    url,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    },
    env,
  ))
}

async function exchangeJwt(env: Env, sub: string): Promise<{
  accessToken: string
  userId: string
  primaryWalletAttachmentId: string | null
}> {
  const jwt = await mintUpstreamJwt(env, { sub })
  const response = await requestJson("http://pirate.test/auth/session/exchange", {
    proof: {
      type: "jwt_based_auth",
      jwt,
    },
  }, env)
  const body = await json(response) as {
    access_token: string
    user: {
      user_id: string
      primary_wallet_attachment_id?: string | null
    }
    wallet_attachments?: Array<{
      wallet_attachment_id: string
      is_primary?: boolean | null
    }>
  }
  const primaryWalletAttachmentId = body.user.primary_wallet_attachment_id
    ?? body.wallet_attachments?.find((attachment) => attachment.is_primary)?.wallet_attachment_id
    ?? body.wallet_attachments?.[0]?.wallet_attachment_id
    ?? null
  return {
    accessToken: body.access_token,
    userId: body.user.user_id,
    primaryWalletAttachmentId,
  }
}

async function completeUniqueHumanVerification(
  env: Env,
  accessToken: string,
): Promise<void> {
  const verificationSession = await requestJson("http://pirate.test/verification-sessions", {
    provider: "self",
  }, env, accessToken)
  const verificationBody = await json(verificationSession) as { verification_session_id: string }
  await requestJson(
    `http://pirate.test/verification-sessions/${verificationBody.verification_session_id}/complete`,
    {},
    env,
    accessToken,
  )
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

  test("requires derivative references when ACRCloud custom bucket returns a match", async () => {
    const originalFetch = globalThis.fetch
    let cleanup: (() => Promise<void>) | null = null

    try {
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
              custom_files: [
                {
                  acrid: "acr_match_1",
                  bucket_id: "30358",
                  score: 100,
                },
              ],
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
        ELEVENLABS_API_KEY: "test-elevenlabs-key",
        ELEVENLABS_FORCE_ALIGNMENT_URL: "https://elevenlabs.test/forced-alignment",
      })
      cleanup = ctx.cleanup

      const author = await exchangeJwt(ctx.env, "song-author-custom-match")
      await completeUniqueHumanVerification(ctx.env, author.accessToken)

      const communityCreate = await requestJson("http://pirate.test/communities", {
        display_name: "Song Match Club",
        handle_policy: {
          policy_template: "standard",
        },
      }, ctx.env, author.accessToken)
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
      const uploadIntentBody = await json(uploadIntent) as {
        song_artifact_upload_id: string
      }

      await app.request(
        `http://pirate.test/communities/${communityId}/song-artifact-uploads/${uploadIntentBody.song_artifact_upload_id}/content`,
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

      const bundleCreate = await requestJson(
        `http://pirate.test/communities/${communityId}/song-artifacts`,
        {
          primary_audio: {
            song_artifact_upload_id: uploadIntentBody.song_artifact_upload_id,
          },
          lyrics: "Line one",
        },
        ctx.env,
        author.accessToken,
      )
      expect(bundleCreate.status).toBe(201)
      const bundleBody = await json(bundleCreate) as {
        song_artifact_bundle_id: string
        moderation_result?: {
          analysis_state?: string
          audio_identification?: {
            match_found?: boolean
          }
        }
      }
      expect(bundleBody.moderation_result?.analysis_state).toBe("allow_with_required_reference")
      expect(bundleBody.moderation_result?.audio_identification?.match_found).toBe(true)

      const blockedPostCreate = await requestJson(
        `http://pirate.test/communities/${communityId}/posts`,
        {
          idempotency_key: "song-post-match-no-refs",
          post_type: "song",
          identity_mode: "public",
          title: "Matched song",
          song_mode: "original",
          rights_basis: "original",
          song_artifact_bundle_id: bundleBody.song_artifact_bundle_id,
        },
        ctx.env,
        author.accessToken,
      )
      expect(blockedPostCreate.status).toBe(400)

      const allowedPostCreate = await requestJson(
        `http://pirate.test/communities/${communityId}/posts`,
        {
          idempotency_key: "song-post-match-with-refs",
          post_type: "song",
          identity_mode: "public",
          title: "Matched song derivative",
          song_mode: "remix",
          rights_basis: "derivative",
          upstream_asset_refs: ["acr:custom-file:acr_match_1"],
          song_artifact_bundle_id: bundleBody.song_artifact_bundle_id,
        },
        ctx.env,
        author.accessToken,
      )
      expect(allowedPostCreate.status).toBe(201)
    } finally {
      globalThis.fetch = originalFetch
      if (cleanup) {
        await cleanup()
      }
    }
  })

  test("records missing catalog configuration without blocking publish", async () => {
    const storedObjects = new Map<string, { body: Uint8Array; contentType: string }>()
    let acrCloudCatalogCallCount = 0

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
      ELEVENLABS_API_KEY: "test-elevenlabs-key",
      ELEVENLABS_FORCE_ALIGNMENT_URL: "https://elevenlabs.test/forced-alignment",
    })
    cleanup = ctx.cleanup

    const author = await exchangeJwt(ctx.env, "song-author-missing-bucket")
    await completeUniqueHumanVerification(ctx.env, author.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Song Club Missing Bucket",
      handle_policy: {
        policy_template: "standard",
      },
    }, ctx.env, author.accessToken)
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
    const uploadIntentBody = await json(uploadIntent) as { song_artifact_upload_id: string }

    await app.request(
      `http://pirate.test/communities/${communityId}/song-artifact-uploads/${uploadIntentBody.song_artifact_upload_id}/content`,
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

    const bundleCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/song-artifacts`,
      {
        primary_audio: {
          song_artifact_upload_id: uploadIntentBody.song_artifact_upload_id,
        },
        lyrics: "Line one",
      },
      ctx.env,
      author.accessToken,
    )
    const bundleBody = await json(bundleCreate) as { song_artifact_bundle_id: string }

    const postCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/posts`,
      {
        idempotency_key: "song-post-missing-bucket",
        post_type: "song",
        identity_mode: "public",
        title: "Song without catalog bucket",
        song_mode: "original",
        rights_basis: "original",
        song_artifact_bundle_id: bundleBody.song_artifact_bundle_id,
      },
      ctx.env,
      author.accessToken,
    )
    expect(postCreate.status).toBe(201)

    const bundleRead = await app.request(
      `http://pirate.test/communities/${communityId}/song-artifacts/${bundleBody.song_artifact_bundle_id}`,
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

    const author = await exchangeJwt(ctx.env, "song-author-republish")
    await completeUniqueHumanVerification(ctx.env, author.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Song Club Republish",
      handle_policy: {
        policy_template: "standard",
      },
    }, ctx.env, author.accessToken)
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
    const uploadIntentBody = await json(uploadIntent) as { song_artifact_upload_id: string }

    await app.request(
      `http://pirate.test/communities/${communityId}/song-artifact-uploads/${uploadIntentBody.song_artifact_upload_id}/content`,
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

    const bundleCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/song-artifacts`,
      {
        primary_audio: {
          song_artifact_upload_id: uploadIntentBody.song_artifact_upload_id,
        },
        lyrics: "Line one",
      },
      ctx.env,
      author.accessToken,
    )
    const bundleBody = await json(bundleCreate) as { song_artifact_bundle_id: string }

    const firstPostCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/posts`,
      {
        idempotency_key: "song-post-republish-1",
        post_type: "song",
        identity_mode: "public",
        title: "Song republish one",
        song_mode: "original",
        rights_basis: "original",
        song_artifact_bundle_id: bundleBody.song_artifact_bundle_id,
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
        song_artifact_bundle_id: bundleBody.song_artifact_bundle_id,
      },
      ctx.env,
      author.accessToken,
    )
    expect(secondPostCreate.status).toBe(201)
    expect(acrCloudCatalogCallCount).toBe(1)
  })

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
    const attachedAt = new Date().toISOString()
    await ctx.client.execute({
      sql: `
        INSERT INTO wallet_attachments (
          wallet_attachment_id, user_id, chain_namespace, wallet_address_normalized, wallet_address_display,
          source_provider, source_subject, attachment_kind, is_primary, status, attached_at, detached_at, created_at, updated_at
        ) VALUES (
          ?1, ?2, 'eip155:1315', ?3, ?3,
          'test', ?2, 'external', 1, 'active', ?4, NULL, ?4, ?4
        )
      `,
      args: ["wal_song_author_locked", author.userId, "0xaaa0000000000000000000000000000000000000", attachedAt],
    })
    await ctx.client.execute({
      sql: `
        UPDATE users
        SET primary_wallet_attachment_id = ?2,
            updated_at = ?3
        WHERE user_id = ?1
      `,
      args: [author.userId, "wal_song_author_locked", attachedAt],
    })
    await ctx.client.execute({
      sql: `
        INSERT INTO wallet_attachments (
          wallet_attachment_id, user_id, chain_namespace, wallet_address_normalized, wallet_address_display,
          source_provider, source_subject, attachment_kind, is_primary, status, attached_at, detached_at, created_at, updated_at
        ) VALUES (
          ?1, ?2, 'eip155:1315', ?3, ?3,
          'test', ?2, 'external', 1, 'active', ?4, NULL, ?4, ?4
        )
      `,
      args: ["wal_song_buyer_locked", buyer.userId, "0xbbb0000000000000000000000000000000000000", attachedAt],
    })
    await ctx.client.execute({
      sql: `
        UPDATE users
        SET primary_wallet_attachment_id = ?2,
            updated_at = ?3
        WHERE user_id = ?1
      `,
      args: [buyer.userId, "wal_song_buyer_locked", attachedAt],
    })
    await completeUniqueHumanVerification(ctx.env, author.accessToken)
    await completeUniqueHumanVerification(ctx.env, buyer.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Paid Song Club",
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

    const joinBuyer = await requestJson(
      `http://pirate.test/communities/${communityId}/join`,
      {},
      ctx.env,
      buyer.accessToken,
    )
    expect(joinBuyer.status).toBe(200)

    const primaryBytes = new Uint8Array([21, 22, 23, 24, 25, 26, 27, 28])
    const previewBytes = new Uint8Array([1, 2, 3, 4])

    const primaryUploadIntent = await requestJson(
      `http://pirate.test/communities/${communityId}/song-artifact-uploads`,
      {
        artifact_kind: "primary_audio",
        mime_type: "audio/mpeg",
        filename: "paid-anthem.mp3",
        size_bytes: primaryBytes.byteLength,
      },
      ctx.env,
      author.accessToken,
    )
    const primaryUploadIntentBody = await json(primaryUploadIntent) as {
      song_artifact_upload_id: string
      storage_ref: string
    }

    const previewUploadIntent = await requestJson(
      `http://pirate.test/communities/${communityId}/song-artifact-uploads`,
      {
        artifact_kind: "preview_audio",
        mime_type: "audio/mpeg",
        filename: "paid-anthem-preview.mp3",
        size_bytes: previewBytes.byteLength,
      },
      ctx.env,
      author.accessToken,
    )
    const previewUploadIntentBody = await json(previewUploadIntent) as {
      song_artifact_upload_id: string
      storage_ref: string
    }

    await app.request(
      `http://pirate.test/communities/${communityId}/song-artifact-uploads/${primaryUploadIntentBody.song_artifact_upload_id}/content`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${author.accessToken}`,
          "content-type": "audio/mpeg",
        },
        body: primaryBytes.buffer,
      },
      ctx.env,
    )

    await app.request(
      `http://pirate.test/communities/${communityId}/song-artifact-uploads/${previewUploadIntentBody.song_artifact_upload_id}/content`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${author.accessToken}`,
          "content-type": "audio/mpeg",
        },
        body: previewBytes.buffer,
      },
      ctx.env,
    )

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
        status: "active",
      },
      ctx.env,
      author.accessToken,
    )
    expect(listingCreate.status).toBe(201)
    const listingBody = await json(listingCreate) as {
      listing_id: string
    }

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
    }
    expect(quoteBody.final_price_usd).toBe(4.99)
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
      entitlement_kind: string
      entitlement_target_ref: string
      settlement_tx_ref: string
    }
    expect(purchaseBody.entitlement_kind).toBe("asset_access")
    expect(purchaseBody.entitlement_target_ref).toBe(assetId)
    expect(purchaseBody.settlement_tx_ref).toBe("0xstorysettlementpaid0001")
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
})
