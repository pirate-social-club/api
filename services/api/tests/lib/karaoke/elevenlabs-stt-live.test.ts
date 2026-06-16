import { describe, expect, test } from "bun:test"
import {
  KARAOKE_TRANSPORT_PROTOCOL_VERSION,
  type KaraokeClientBinaryFrame,
  type KaraokeSttAdapterMessage,
} from "@pirate/karaoke-runtime"

import {
  ElevenLabsKaraokeSttAdapter,
  type KaraokeSttSocket,
  type KaraokeSttSocketConnect,
} from "../../../src/lib/karaoke/elevenlabs-stt-adapter"

// Opt-in live test (Phase 4 step 4). Skipped unless ELEVENLABS_API_KEY is set,
// so CI and normal local runs never hit the network. It validates the adapter's
// real wire format end-to-end: synthesize speech via ElevenLabs TTS, stream it
// through the realtime STT adapter, and assert word-timed stt_final events.
//
// NOTE: it injects a Bun-native WebSocket (which supports request headers) in
// place of the production workerd fetch-upgrade transport — the production
// connect path can only run inside workerd. This test covers the protocol +
// translation; the workerd transport wrapper is exercised by the integration
// suite with the fake adapter.

const KEY = process.env.ELEVENLABS_API_KEY
const PV = KARAOKE_TRANSPORT_PROTOCOL_VERSION
const VOICE_ID = "21m00Tcm4TlvDq8ikWAM"

const bunWebSocketConnect: KaraokeSttSocketConnect = async ({ apiKey, url }) => {
  const socket = new WebSocket(url, { headers: { "xi-api-key": apiKey } } as unknown as string)
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve())
    socket.addEventListener("error", () => reject(new Error("elevenlabs_ws_error_before_open")))
    setTimeout(() => reject(new Error("elevenlabs_ws_open_timeout")), 10_000)
  })
  return socket as unknown as KaraokeSttSocket
}

async function synthesizePcm16(apiKey: string, text: string): Promise<Uint8Array> {
  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=pcm_16000`, {
    body: JSON.stringify({ model_id: "eleven_multilingual_v2", text }),
    headers: { "content-type": "application/json", "xi-api-key": apiKey },
    method: "POST",
  })
  if (!response.ok) throw new Error(`tts_failed_${response.status}`)
  return new Uint8Array(await response.arrayBuffer())
}

function frameFor(bytes: Uint8Array, offsetBytes: number, sequence: number): KaraokeClientBinaryFrame {
  // 16-bit mono @ 16kHz => 32 bytes per ms.
  return {
    attemptId: "attempt-live",
    chunkId: sequence,
    pcm16: bytes.slice().buffer,
    protocolVersion: PV,
    sampleRate: 16_000,
    sequence,
    sessionId: "session-live",
    songEndMs: Math.round((offsetBytes + bytes.length) / 32),
    songStartMs: Math.round(offsetBytes / 32),
    type: "audio_chunk",
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("ElevenLabs realtime STT (live, opt-in)", () => {
  test.skipIf(!KEY)(
    "transcribes synthesized speech into word-timed stt_final events",
    async () => {
      const apiKey = KEY as string
      const pcm = await synthesizePcm16(apiKey, "Hold on, we are almost home tonight.")
      expect(pcm.length).toBeGreaterThan(0)

      const messages: KaraokeSttAdapterMessage[] = []
      const adapter = new ElevenLabsKaraokeSttAdapter({ apiKey, connect: bunWebSocketConnect, retention: "not_stored" })
      await adapter.start({
        attemptId: "attempt-live",
        onMessage: async (message) => {
          messages.push(message)
        },
        sessionId: "session-live",
      })

      const CHUNK = 3200 // 100ms
      let sequence = 1
      for (let offset = 0; offset < pcm.length; offset += CHUNK) {
        await adapter.sendPcm16(frameFor(pcm.subarray(offset, offset + CHUNK), offset, sequence))
        sequence += 1
        await delay(25)
      }
      // Manual commit: explicitly flush, then wait for the correlated final.
      const handle = await adapter.commit()
      expect(handle).not.toBeNull()
      await delay(3000)
      await adapter.close()

      const finals = messages.filter((message) => message.event.type === "stt_final")
      expect(finals.length).toBeGreaterThan(0)

      // The committed final must carry the correlation handle for our commit.
      const acked = finals.find((message) => message.commit?.commitId === handle?.commitId)
      expect(acked).toBeDefined()
      expect(acked?.commit?.streamGeneration).toBe(handle?.streamGeneration)

      const withWords = finals.find((message) => message.event.words.length > 0)
      expect(withWords).toBeDefined()
      expect(withWords?.event.words[0]).toMatchObject({ final: true, source: "stt" })
      expect(
        withWords?.event.words.every((word) => Number.isFinite(word.startMs) && word.endMs >= word.startMs),
      ).toBe(true)
      // No spacing tokens should leak through as words.
      expect(withWords?.event.words.every((word) => word.text.trim().length > 0)).toBe(true)
    },
    30_000,
  )
})
