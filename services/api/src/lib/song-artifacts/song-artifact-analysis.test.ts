import { describe, expect, test } from "bun:test"
import { analyzeSongBundle } from "./song-artifact-analysis"

describe("song artifact analysis", () => {
  test("records an allow outcome when ACR identification is skipped by community policy", async () => {
    const result = await analyzeSongBundle({
      env: {},
      lyrics: "Line one",
      primaryAudioUpload: {
        id: "sau_skip_acr",
        filename: "trusted-band.mp3",
        mime_type: "audio/mpeg",
        size_bytes: 8,
        storage_object_key: "songs/trusted-band.mp3",
      },
      skipAcrIdentification: true,
    } as never)

    expect(result.analysisState).toBe("allow")
    expect(result.moderationResult?.audio_identification).toEqual({
      provider: "acrcloud",
      skipped: true,
      policy_source: "community_song_acr_policy",
      skip_reason: "trusted_artist_onboarding",
    })
  })
})
