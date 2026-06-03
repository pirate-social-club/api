import { existsSync } from "node:fs"
import { describe, expect, test } from "bun:test"
import type { Env } from "../../env"
import { cropAudioPreviewWithFfmpeg } from "./song-artifact-preview"

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

const ffmpegPath = "/usr/bin/ffmpeg"
const testWithFfmpeg = existsSync(ffmpegPath) ? test : test.skip

describe("song artifact preview", () => {
  testWithFfmpeg("crops and transcodes preview audio with ffmpeg", async () => {
    const preview = await cropAudioPreviewWithFfmpeg({
      env: {
        SONG_PREVIEW_FFMPEG_BIN: ffmpegPath,
      } as Env,
      sourceBytes: makeSilentWavBytes(2),
      sourceMimeType: "audio/wav",
      previewWindow: {
        start_ms: 500,
        duration_ms: 1_000,
      },
    })

    expect(preview.durationMs).toBe(1_000)
    expect(preview.bytes.byteLength).toBeGreaterThan(0)
    expect(
      preview.bytes[0] === 0x49 && preview.bytes[1] === 0x44 && preview.bytes[2] === 0x33
        || preview.bytes[0] === 0xff,
    ).toBe(true)
  })
})
