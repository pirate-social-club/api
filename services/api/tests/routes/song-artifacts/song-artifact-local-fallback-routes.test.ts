import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { app } from "../../../src/index"
import { createRouteTestContext, json, resetRuntimeCaches } from "../../helpers"
import { getCommunityRepository } from "../../../src/lib/communities/db-community-repository"
import { processCommunityJobsForCommunity } from "../../../src/lib/communities/jobs/runner"
import {
  exchangeJwt,
  requestJson,
} from "./song-artifact-test-helpers"
import {
  attachPrimaryWallet,
  createOpenSongCommunity,
  installLockedSongFetchMocks,
  uploadSongArtifact,
  verifyAsHuman,
} from "./song-artifact-locked-test-helpers"

let cleanup: (() => Promise<void>) | null = null
let originalFetch: typeof fetch

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

describe("song artifact local fallback routes", () => {
  test("allows locked song publication without Story runtime keys in local dev", async () => {
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
      SONG_PREVIEW_FFMPEG_BIN: "__test_passthrough__",
    })
    cleanup = ctx.cleanup

    const author = await exchangeJwt(ctx.env, "song-author-local-story-fallback")
    await verifyAsHuman(ctx.env, author.accessToken)
    await attachPrimaryWallet({
      client: ctx.client,
      userId: author.userId,
      walletAttachmentId: "wal_song_author_local_story_fallback",
      walletAddress: "0xccc0000000000000000000000000000000000000",
    })

    const communityId = await createOpenSongCommunity(ctx.env, author.accessToken, "Local Story Fallback Club")

    const primaryBytes = makeSilentWavBytes()
    const primaryUpload = await uploadSongArtifact({
      env: ctx.env,
      communityId,
      accessToken: author.accessToken,
      artifactKind: "primary_audio",
      mimeType: "audio/wav",
      filename: "local-fallback-paid.wav",
      bytes: primaryBytes,
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
        lyrics: "Paid line",
      },
      ctx.env,
      author.accessToken,
    )
    expect(bundleCreate.status).toBe(201)
    const bundleBody = await json(bundleCreate) as {
      id: string
    }

    const jobSummary = await processCommunityJobsForCommunity({
      env: ctx.env,
      communityId,
      communityRepository: getCommunityRepository(ctx.env),
      maxJobs: 1,
    })
    expect(jobSummary.jobs[0]?.job_type).toBe("song_preview_generate")
    expect(jobSummary.jobs[0]?.status).toBe("succeeded")

    const lockedPostCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/posts`,
      {
        idempotency_key: "song-post-local-story-fallback-1",
        post_type: "song",
        identity_mode: "public",
        title: "Local fallback paid anthem",
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
    const lockedPostBody = await json(lockedPostCreate) as {
      asset?: string | null
      access_mode?: string | null
    }
    expect(lockedPostBody.access_mode).toBe("locked")
    expect(typeof lockedPostBody.asset === "string" && lockedPostBody.asset.length > 0).toBe(true)

    const assetId = String(lockedPostBody.asset)
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
      access_mode: string
      story_status: string
      locked_delivery_status: string
      primary_content_ref: string
    }
    expect(assetBody.access_mode).toBe("locked")
    expect(assetBody.story_status).toBe("published")
    expect(assetBody.locked_delivery_status).toBe("ready")
    expect(assetBody.primary_content_ref).toBe(primaryUpload.storage_ref)

    const encryptedContent = await app.request(
      `http://pirate.test/communities/${communityId}/assets/${assetId}/content`,
      {
        headers: {
          authorization: `Bearer ${author.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(encryptedContent.status).toBe(200)
    expect(encryptedContent.headers.get("content-type")).toBe("application/octet-stream")
    const ciphertext = new Uint8Array(await encryptedContent.arrayBuffer())
    expect(ciphertext).not.toEqual(primaryBytes)

    const listingCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/listings`,
      {
        asset: assetId,
        price_cents: 650,
        regional_pricing_enabled: false,
        status: "active",
      },
      ctx.env,
      author.accessToken,
    )
    expect(listingCreate.status).toBe(201)
  })
})
