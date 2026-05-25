import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createClient } from "@libsql/client"
import { app } from "../../../src/index"
import { buildLocalCommunityDbUrl } from "../../../src/lib/communities/community-local-db"
import { createRouteTestContext, json, resetRuntimeCaches } from "../../helpers"
import {
  completeUniqueHumanVerification,
  exchangeJwt,
  requestJson,
} from "./song-artifact-test-helpers"

let cleanup: (() => Promise<void>) | null = null
let originalFetch: typeof fetch

type DerivativeSourceListBody = {
  items: Array<{
    asset: string
    title: string
    kind: "song" | "video"
    story_ip: string
    story_license_terms: string
    creator_user: string
    creator_handle?: string | null
    creator_display_name?: string | null
  }>
  next_cursor: string | null
}

async function insertDerivativeSourceAsset(input: {
  communityDbRoot: string
  communityId: string
  creatorUserId: string
  assetId: string
  title: string
  assetKind: "song_audio" | "video_file"
  rightsBasis: "original" | "derivative"
  publicationStatus: "story_published" | "withdrawn"
  storyIpId?: string
  storyLicenseTermsId?: string
}): Promise<void> {
  const client = createClient({
    url: buildLocalCommunityDbUrl(input.communityDbRoot, input.communityId),
  })
  const now = new Date().toISOString()
  const postId = `post_${input.assetId}`

  try {
    await client.execute({
      sql: `
        INSERT INTO posts (
          post_id, community_id, author_user_id, identity_mode, post_type, status,
          song_mode, title, rights_basis, asset_id, analysis_state, content_safety_state,
          age_gate_policy, created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, 'public', ?4, 'published',
          ?5, ?6, ?7, ?8, 'allow', 'safe',
          'none', ?9, ?9
        )
      `,
      args: [
        postId,
        input.communityId,
        input.creatorUserId,
        input.assetKind === "video_file" ? "video" : "song",
        input.assetKind === "song_audio" ? input.rightsBasis === "derivative" ? "remix" : "original" : null,
        input.title,
        input.rightsBasis,
        input.assetId,
        now,
      ],
    })

    await client.execute({
      sql: `
        INSERT INTO assets (
          asset_id, community_id, source_post_id, display_title, song_artifact_bundle_id, creator_user_id, asset_kind,
          rights_basis, access_mode, license_preset, commercial_rev_share_pct,
          primary_content_ref, primary_content_hash, publication_status,
          story_status, story_error, story_ip_id, story_ip_nft_contract, story_ip_nft_token_id,
          story_publish_model, story_license_terms_id, story_license_template, story_royalty_policy,
          story_royalty_policy_id, story_derivative_parent_ip_ids_json, story_derivative_registered_at,
          story_revenue_token, story_royalty_registration_status, locked_delivery_status, locked_delivery_ref,
          locked_delivery_error, created_at, updated_at, story_publish_tx_ref, story_asset_version_id,
          story_cdr_vault_uuid, story_namespace, story_entitlement_token_id, story_read_condition,
          story_write_condition, locked_delivery_storage_ref, locked_delivery_secret_json
        ) VALUES (
          ?1, ?2, ?3, ?4, NULL, ?5, ?6,
          ?7, 'public', 'commercial-remix', 15,
          ?8, ?9, ?10,
          'published', NULL, ?11, NULL, NULL,
          'story_ip_v1', ?12, NULL, NULL,
          NULL, NULL, NULL,
          NULL, 'registered', 'none', NULL,
          NULL, ?13, ?13, NULL, NULL,
          NULL, NULL, NULL, NULL,
          NULL, NULL, NULL
        )
      `,
      args: [
        input.assetId,
        input.communityId,
        postId,
        input.title,
        input.creatorUserId,
        input.assetKind,
        input.rightsBasis,
        `asset:${input.assetId}`,
        `0xhash${input.assetId}`,
        input.publicationStatus,
        input.storyIpId ?? `0x${input.assetId.padEnd(40, "0").slice(0, 40)}`,
        input.storyLicenseTermsId ?? "17",
        now,
      ],
    })
  } finally {
    client.close()
  }
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

describe("song artifact catalog routes", () => {
  test("lists Story-registered derivative sources for community members", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "derivative-source-owner")
    await completeUniqueHumanVerification(ctx.env, owner.accessToken)
    const ownerProfile = await app.request("http://pirate.test/profiles/me", {
      method: "POST",
      headers: {
        authorization: `Bearer ${owner.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        display_name: "Derivative Artist",
      }),
    }, ctx.env)
    expect(ownerProfile.status).toBe(200)

    const communityCreate = await requestJson(
      "http://pirate.test/communities",
      {
        display_name: "Derivative Source Club",
        membership_mode: "request",
        handle_policy: {
          policy_template: "standard",
        },
      },
      ctx.env,
      owner.accessToken,
    )
    expect(communityCreate.status === 201 || communityCreate.status === 202).toBe(true)
    const communityCreateBody = await json(communityCreate) as {
      community: {
        id: string
      }
    }
    const communityId = communityCreateBody.community.id.replace(/^com_/, "")

    await insertDerivativeSourceAsset({
      communityDbRoot: ctx.communityDbRoot,
      communityId,
      creatorUserId: owner.userId,
      assetId: "ast_original_song",
      title: "Original Source",
      assetKind: "song_audio",
      rightsBasis: "original",
      publicationStatus: "story_published",
      storyIpId: "0x1111111111111111111111111111111111111111",
      storyLicenseTermsId: "17",
    })
    await insertDerivativeSourceAsset({
      communityDbRoot: ctx.communityDbRoot,
      communityId,
      creatorUserId: owner.userId,
      assetId: "ast_derivative_song",
      title: "Derivative Echo",
      assetKind: "song_audio",
      rightsBasis: "derivative",
      publicationStatus: "story_published",
      storyIpId: "0x2222222222222222222222222222222222222222",
      storyLicenseTermsId: "18",
    })
    await insertDerivativeSourceAsset({
      communityDbRoot: ctx.communityDbRoot,
      communityId,
      creatorUserId: owner.userId,
      assetId: "ast_withdrawn_song",
      title: "Withdrawn Source",
      assetKind: "song_audio",
      rightsBasis: "original",
      publicationStatus: "withdrawn",
      storyIpId: "0x3333333333333333333333333333333333333333",
      storyLicenseTermsId: "19",
    })
    await insertDerivativeSourceAsset({
      communityDbRoot: ctx.communityDbRoot,
      communityId,
      creatorUserId: owner.userId,
      assetId: "ast_story_video",
      title: "Video Source",
      assetKind: "video_file",
      rightsBasis: "original",
      publicationStatus: "story_published",
      storyIpId: "0x4444444444444444444444444444444444444444",
      storyLicenseTermsId: "20",
    })

    const songSources = await app.request(
      `http://pirate.test/communities/${communityId}/derivative-sources?kind=song&limit=25`,
      {
        headers: {
          authorization: `Bearer ${owner.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(songSources.status).toBe(200)
    const songSourcesBody = await json(songSources) as DerivativeSourceListBody
    expect(songSourcesBody.next_cursor).toBeNull()
    expect(songSourcesBody.items.map((item) => item.asset).sort()).toEqual([
      "asset_ast_derivative_song",
      "asset_ast_original_song",
    ])
    expect(songSourcesBody.items.map((item) => item.title).sort()).toEqual([
      "Derivative Echo",
      "Original Source",
    ])
    expect(songSourcesBody.items.every((item) => item.kind === "song")).toBe(true)
    expect(songSourcesBody.items.every((item) => item.creator_handle?.endsWith(".pirate"))).toBe(true)
    expect(songSourcesBody.items.every((item) => !item.creator_handle?.startsWith("usr_"))).toBe(true)
    expect(songSourcesBody.items.every((item) => item.creator_display_name === "Derivative Artist")).toBe(true)
    expect(songSourcesBody.items.find((item) => item.asset === "asset_ast_derivative_song")?.story_license_terms).toBe("18")

    const queriedSources = await app.request(
      `http://pirate.test/communities/${communityId}/derivative-sources?kind=song&q=Derivative`,
      {
        headers: {
          authorization: `Bearer ${owner.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(queriedSources.status).toBe(200)
    const queriedSourcesBody = await json(queriedSources) as DerivativeSourceListBody
    expect(queriedSourcesBody.items.map((item) => item.asset)).toEqual(["asset_ast_derivative_song"])

    const videoSources = await app.request(
      `http://pirate.test/communities/${communityId}/derivative-sources?kind=video`,
      {
        headers: {
          authorization: `Bearer ${owner.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(videoSources.status).toBe(200)
    const videoSourcesBody = await json(videoSources) as DerivativeSourceListBody
    expect(videoSourcesBody.items.map((item) => item.asset)).toEqual(["asset_ast_story_video"])
    expect(videoSourcesBody.items[0]?.kind).toBe("video")

    const liveSources = await app.request(
      `http://pirate.test/communities/${communityId}/derivative-sources?kind=live`,
      {
        headers: {
          authorization: `Bearer ${owner.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(liveSources.status).toBe(200)
    const liveSourcesBody = await json(liveSources) as DerivativeSourceListBody
    expect(liveSourcesBody.items.map((item) => item.asset).sort()).toEqual([
      "asset_ast_derivative_song",
      "asset_ast_original_song",
    ])
    expect(liveSourcesBody.items.every((item) => item.kind === "song")).toBe(true)

    const outsider = await exchangeJwt(ctx.env, "derivative-source-outsider")
    const outsiderSources = await app.request(
      `http://pirate.test/communities/${communityId}/derivative-sources?kind=song`,
      {
        headers: {
          authorization: `Bearer ${outsider.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(outsiderSources.status).toBe(404)
  })

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
        title: "Catalog Song",
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
        license_preset: "commercial-remix",
        commercial_rev_share_pct: 10,
        upstream_asset_refs: ["acr:custom-file:acr_match_1"],
        song_artifact_bundle: bundleBody.id,
      },
      ctx.env,
      author.accessToken,
    )
    expect(allowedPostCreate.status).toBe(201)
  })
})
