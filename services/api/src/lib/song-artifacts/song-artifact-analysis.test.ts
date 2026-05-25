import { describe, expect, test } from "bun:test"
import { analyzeSongBundle } from "./song-artifact-analysis"

describe("song artifact analysis", () => {
  test("skips lyric moderation and alignment for instrumental bundles", async () => {
    const result = await analyzeSongBundle({
      env: {},
      lyrics: "",
      primaryAudioUpload: {
        id: "sau_instrumental",
        filename: "instrumental.mp3",
        mime_type: "audio/mpeg",
        size_bytes: 8,
        storage_object_key: "songs/instrumental.mp3",
      },
      skipAcrIdentification: true,
    } as never)

    expect(result.analysisState).toBe("allow")
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
