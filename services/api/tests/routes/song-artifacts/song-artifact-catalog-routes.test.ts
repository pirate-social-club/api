import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { app } from "../../../src/index"
import { createRouteTestContext, json, resetRuntimeCaches } from "../../helpers"
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

describe("song artifact catalog routes", () => {
  test("requires derivative references when ACRCloud custom bucket returns a match", async () => {
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

    const communityCreate = await requestJson(
      "http://pirate.test/communities",
      {
        display_name: "Song Match Club",
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
      id: string
    }

    await app.request(
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

    const bundleCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/song-artifacts`,
      {
        primary_audio: {
          song_artifact_upload: uploadIntentBody.id,
        },
        lyrics: "Line one",
      },
      ctx.env,
      author.accessToken,
    )
    expect(bundleCreate.status).toBe(201)
    const bundleBody = await json(bundleCreate) as {
      id: string
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
        song_artifact_bundle: bundleBody.id,
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
        song_artifact_bundle: bundleBody.id,
      },
      ctx.env,
      author.accessToken,
    )
    expect(allowedPostCreate.status).toBe(201)
  })
})
