import { describe, expect, test } from "bun:test"
import { deriveKaraokeRevisionId, resolveKaraokeRevisionId } from "./karaoke-revision"

const instrumentalAudio = {
  storage_ref: "r2://songs/instrumental.mp3",
  mime_type: "audio/mpeg",
}
const timedLyrics = {
  lines: [{ end_ms: 1200, start_ms: 100, text: "Lovin' you" }],
}

describe("resolveKaraokeRevisionId", () => {
  test("preserves a stored revision", async () => {
    expect(await resolveKaraokeRevisionId({
      instrumentalAudio,
      karaokeRevisionId: "krv_stored",
      timedLyrics,
    })).toBe("krv_stored")
  })

  test("derives a stable revision for legacy ready bundles", async () => {
    const derived = await deriveKaraokeRevisionId({ instrumentalAudio, timedLyrics })
    expect(derived).toMatch(/^krv_[0-9a-f]{64}$/u)
    expect(await resolveKaraokeRevisionId({
      instrumentalAudio,
      karaokeRevisionId: null,
      timedLyrics,
    })).toBe(derived)
  })

  test("does not invent a revision for an incomplete bundle", async () => {
    expect(await resolveKaraokeRevisionId({
      instrumentalAudio: null,
      karaokeRevisionId: null,
      timedLyrics,
    })).toBeNull()
  })
})
