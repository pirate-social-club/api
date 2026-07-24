import { afterEach, describe, expect, test } from "bun:test"
import { mockFetch } from "../../test-helpers/fetch"
import { analyzeSongBundle } from "./song-artifact-analysis"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("song artifact analysis", () => {
  test("marks ACR identification as skipped when staging bypass is requested", async () => {
    const result = await analyzeSongBundle({
      communityId: "com_test",
      env: {},
      lyrics: "",
      primaryAudioUpload: {
        id: "sau_instrumental",
        filename: "instrumental.mp3",
        mime_type: "audio/mpeg",
        size_bytes: 8,
        storage_object_key: "songs/instrumental.mp3",
      } as never,
      skipAcrIdentification: true,
    })

    expect(result.analysisState).toBe("allow")
    expect(result.moderationResult?.audio_identification).toEqual({
      provider: "acrcloud",
      skipped: true,
      acr_skipped_reason: "staging_bypass",
    })
    expect(result.alignmentStatus).toBe("completed")
    expect(result.timedLyrics).toBeNull()
    expect(result.moderationResult?.lyrics).toEqual({
      provider: "openrouter",
      skipped: true,
      skip_reason: "empty_lyrics",
      analysis_state: "allow",
      content_safety_state: "safe",
      age_gate_policy: "none",
    })
  })
})

describe("song artifact ACR custom-bucket match semantics", () => {
  const primaryAudioUpload = {
    id: "sau_primary",
    filename: "song.mp3",
    mime_type: "audio/mpeg",
    size_bytes: 3,
    storage_object_key: "songs/song.mp3",
  } as never

  function acrConfiguredEnv() {
    return {
      ACRCLOUD_ACCESS_KEY: "acr-key",
      ACRCLOUD_ACCESS_SECRET: "acr-secret",
      ACRCLOUD_HOST: "acrcloud.test",
      FILEBASE_S3_ACCESS_KEY: "filebase-key",
      FILEBASE_S3_SECRET_KEY: "filebase-secret",
      FILEBASE_MEDIA_BUCKET: "media-bucket",
    }
  }

  function stubFetchForAcrMetadata(metadata: Record<string, unknown>) {
    globalThis.fetch = mockFetch(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.includes("acrcloud.test")) {
        return new Response(JSON.stringify({ metadata }), {
          headers: { "content-type": "application/json" },
        })
      }
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "audio/mpeg" },
      })
    })
  }

  function audioIdentificationOf(result: { moderationResult?: Record<string, unknown> | null }) {
    return result.moderationResult?.audio_identification as { match_found?: boolean } | undefined
  }

  test("untagged custom bucket match still counts as a catalog match", async () => {
    stubFetchForAcrMetadata({
      custom_files: [
        { acr_id: "acr_1", user_defined: { source: "pirate", song_artifact_bundle_id: "sab_1" } },
      ],
    })

    const result = await analyzeSongBundle({
      communityId: "com_test",
      env: acrConfiguredEnv(),
      lyrics: "",
      primaryAudioUpload,
    })

    expect(audioIdentificationOf(result)?.match_found).toBe(true)
    expect(result.analysisState).toBe("allow_with_required_reference")
  })

  test("video-audio custom bucket matches do not count as a catalog match", async () => {
    stubFetchForAcrMetadata({
      custom_files: [
        // Nested and flattened user_defined shapes are both tolerated.
        { acr_id: "acr_vid_nested", user_defined: { content_type: "video_audio" } },
        { acr_id: "acr_vid_flat", content_type: "video_audio" },
      ],
    })

    const result = await analyzeSongBundle({
      communityId: "com_test",
      env: acrConfiguredEnv(),
      lyrics: "",
      primaryAudioUpload,
    })

    expect(audioIdentificationOf(result)?.match_found).toBe(false)
    expect(result.analysisState).toBe("allow")
  })
})
