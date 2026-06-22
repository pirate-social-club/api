import { afterEach, describe, expect, test } from "bun:test"
import {
  KARAOKE_TRANSPORT_PROTOCOL_VERSION,
  type KaraokeClientBinaryFrame,
  type KaraokeSttAdapterMessage,
} from "@pirate/karaoke-runtime"

import {
  connectWorkerdWebSocket,
  ELEVENLABS_REALTIME_SCRIBE_TOKEN_PATH,
  ElevenLabsKaraokeSttAdapter,
  type KaraokeSttSocket,
} from "../../../src/lib/karaoke/elevenlabs-stt-adapter"

// Inbound provider messages are processed through a serialized promise chain, so
// tests flush the microtask/macrotask queue after delivering a message.
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

class FakeSttSocket implements KaraokeSttSocket {
  readonly sent: string[] = []
  closed: { code?: number; reason?: string } | null = null
  private messageListeners: ((event: { data: string | ArrayBuffer }) => void)[] = []

  send(data: string): void {
    this.sent.push(data)
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason }
  }

  addEventListener(type: "message" | "close" | "error", listener: (event: never) => void): void {
    if (type === "message") {
      this.messageListeners.push(listener as (event: { data: string | ArrayBuffer }) => void)
    }
  }

  async deliver(message: unknown): Promise<void> {
    const data = typeof message === "string" ? message : JSON.stringify(message)
    for (const listener of this.messageListeners) listener({ data })
    await flush()
  }

  sentCommits(): unknown[] {
    return this.sent.map((s) => JSON.parse(s)).filter((m) => (m as { commit?: unknown }).commit === true)
  }
}

function frame(overrides: Partial<KaraokeClientBinaryFrame> = {}): KaraokeClientBinaryFrame {
  return {
    attemptId: "attempt-1",
    chunkId: 1,
    pcm16: new Uint8Array([1, 2, 3, 4]).buffer,
    protocolVersion: KARAOKE_TRANSPORT_PROTOCOL_VERSION,
    sampleRate: 16_000,
    sequence: 1,
    sessionId: "session-1",
    songEndMs: 200,
    songStartMs: 100,
    type: "audio_chunk",
    ...overrides,
  }
}

// Frame with a controlled audio duration: `bytes` PCM16 bytes => bytes/32 ms.
function timedFrame(songStartMs: number, bytes: number, sequence: number): KaraokeClientBinaryFrame {
  return frame({
    pcm16: new Uint8Array(bytes).buffer,
    sequence,
    songEndMs: songStartMs + Math.round(bytes / 32),
    songStartMs,
  })
}

async function startAdapter(options: { retention?: "not_stored" } = { retention: "not_stored" }): Promise<{
  adapter: ElevenLabsKaraokeSttAdapter
  socket: FakeSttSocket
  messages: KaraokeSttAdapterMessage[]
  connectUrl: string
  connectApiKey: string
}> {
  const socket = new FakeSttSocket()
  const messages: KaraokeSttAdapterMessage[] = []
  let connectUrl = ""
  let connectApiKey = ""
  const adapter = new ElevenLabsKaraokeSttAdapter({
    apiKey: "secret-key",
    connect: async (input) => {
      connectUrl = input.url
      connectApiKey = input.apiKey
      return socket
    },
    model: "scribe_v2_realtime",
    retention: options.retention,
  })
  await adapter.start({
    attemptId: "attempt-1",
    onMessage: async (message) => {
      messages.push(message)
    },
    sessionId: "session-1",
  })
  return { adapter, connectApiKey, connectUrl, messages, socket }
}

const finals = (messages: KaraokeSttAdapterMessage[]) => messages.filter((m) => m.event.type === "stt_final")
const partials = (messages: KaraokeSttAdapterMessage[]) => messages.filter((m) => m.event.type === "stt_partial")

describe("ElevenLabsKaraokeSttAdapter", () => {
  test("connects with model, pcm_16000, manual commit, and the api key", async () => {
    const { connectApiKey, connectUrl } = await startAdapter()
    const url = new URL(connectUrl)
    expect(connectApiKey).toBe("secret-key")
    expect(url.protocol).toBe("wss:")
    expect(url.searchParams.get("model_id")).toBe("scribe_v2_realtime")
    expect(url.searchParams.get("audio_format")).toBe("pcm_16000")
    expect(url.searchParams.get("include_timestamps")).toBe("true")
    expect(url.searchParams.get("commit_strategy")).toBe("manual")
  })

  test("requests zero-retention (disable_logging) when retention is not_stored", async () => {
    const { connectUrl } = await startAdapter({ retention: "not_stored" })
    expect(new URL(connectUrl).searchParams.get("disable_logging")).toBe("true")
  })

  test("does not disable logging when no retention policy is set", async () => {
    const { connectUrl } = await startAdapter({})
    expect(new URL(connectUrl).searchParams.get("disable_logging")).toBeNull()
  })

  test("each start() mints a distinct stream generation", async () => {
    const socket = new FakeSttSocket()
    const adapter = new ElevenLabsKaraokeSttAdapter({ apiKey: "k", connect: async () => socket })
    await adapter.start({ attemptId: "a", onMessage: async () => {}, sessionId: "s" })
    const first = adapter.streamGeneration
    await adapter.start({ attemptId: "a", onMessage: async () => {}, sessionId: "s" })
    const second = adapter.streamGeneration
    expect(first).toBeTruthy()
    expect(second).toBeTruthy()
    expect(first).not.toBe(second)
  })

  test("forwards PCM16 frames as base64 input_audio_chunk messages", async () => {
    const { adapter, socket } = await startAdapter()
    await adapter.sendPcm16(frame())
    expect(JSON.parse(socket.sent[0]!)).toEqual({
      audio_base_64: "AQIDBA==",
      message_type: "input_audio_chunk",
      sample_rate: 16_000,
    })
  })

  test("emits a text-only stt_partial for partial transcripts (no commit metadata)", async () => {
    const { socket, messages } = await startAdapter()
    await socket.deliver({ message_type: "partial_transcript", text: "hold" })
    expect(partials(messages)).toHaveLength(1)
    const message = messages[0]!
    expect(message.event.type).toBe("stt_partial")
    expect(message.event.text).toBe("hold")
    expect(message.event.words).toEqual([])
    expect(message.commit).toBeUndefined()
  })

  test("maps committed transcripts to stt_final with song-time word timing and confidence", async () => {
    const { adapter, socket, messages } = await startAdapter()
    await adapter.sendPcm16(timedFrame(2000, 32_000, 1)) // 1s of audio: song 2000..3000
    await socket.deliver({
      message_type: "committed_transcript_with_timestamps",
      text: "hold on",
      words: [
        { end: 0.4, logprob: -0.05, start: 0, text: "hold", type: "word" },
        { end: 0.5, start: 0.4, text: " ", type: "spacing" },
        { confidence: 0.9, end: 0.9, start: 0.5, text: "on", type: "word" },
      ],
    })

    const final = finals(messages).at(-1)!.event
    expect(final.type).toBe("stt_final")
    expect(final.text).toBe("hold on")
    expect(final.deliveredAtAudioMs).toBe(3000)
    expect(final.words).toHaveLength(2)
    expect(final.words[0]).toMatchObject({ endMs: 2400, final: true, source: "stt", startMs: 2000, text: "hold" })
    expect(final.words[0]!.confidence).toBeCloseTo(Math.exp(-0.05), 5)
    expect(final.words[1]).toMatchObject({ confidence: 0.9, endMs: 2900, startMs: 2500, text: "on" })
  })

  test("maps word timing across a seek using the stream→song segment map", async () => {
    const { adapter, socket, messages } = await startAdapter()
    await adapter.sendPcm16(timedFrame(0, 32_000, 1)) // stream 0..1000ms -> song 0..1000
    await adapter.sendPcm16(timedFrame(5000, 32_000, 2)) // seek: stream 1000..2000ms -> song 5000..6000
    await socket.deliver({
      message_type: "committed_transcript_with_timestamps",
      text: "home",
      words: [{ end: 1.4, logprob: -0.1, start: 1.2, text: "home", type: "word" }],
    })
    expect(finals(messages).at(-1)!.event.words[0]).toMatchObject({ endMs: 5400, startMs: 5200, text: "home" })
  })

  test("rejects a commit below the safe audio floor without killing the stream", async () => {
    const { adapter, socket } = await startAdapter()
    await adapter.sendPcm16(timedFrame(0, 6_400, 1)) // 200ms < 400ms floor
    const handle = await adapter.commit()
    expect(handle).toBeNull()
    expect(socket.closed).toBeNull()
    expect(socket.sentCommits()).toHaveLength(0)
  })

  test("allows only one in-flight commit; a second is refused until the first acks", async () => {
    const { adapter, socket } = await startAdapter()
    await adapter.sendPcm16(timedFrame(0, 16_000, 1)) // 500ms
    const first = await adapter.commit()
    expect(first).not.toBeNull()
    await adapter.sendPcm16(timedFrame(500, 16_000, 2))
    expect(await adapter.commit()).toBeNull() // one in flight
    expect(socket.sentCommits()).toHaveLength(1)
  })

  test("FIFO acknowledgement carries the original commitId, generation, and frontier", async () => {
    const { adapter, socket, messages } = await startAdapter()
    await adapter.sendPcm16(timedFrame(0, 16_000, 1)) // 500ms -> frontier 500
    const handle = await adapter.commit()
    expect(handle).toMatchObject({ frontierMs: 500, streamGeneration: adapter.streamGeneration })
    await socket.deliver({
      message_type: "committed_transcript_with_timestamps",
      text: "home",
      words: [{ end: 0.4, start: 0.1, text: "home", type: "word" }],
    })
    const final = finals(messages).at(-1)!
    expect(final.commit).toEqual({
      commitId: handle!.commitId,
      coverageMs: 500,
      streamGeneration: handle!.streamGeneration,
    })
    // After the ack, a new commit is allowed again.
    await adapter.sendPcm16(timedFrame(500, 16_000, 2))
    expect(await adapter.commit()).not.toBeNull()
  })

  test("close() drains an in-flight commit instead of discarding its final", async () => {
    const { adapter, socket, messages } = await startAdapter()
    await adapter.sendPcm16(timedFrame(0, 16_000, 1))
    const handle = await adapter.commit()
    expect(handle).not.toBeNull()
    const closing = adapter.close()
    await socket.deliver({
      message_type: "committed_transcript_with_timestamps",
      text: "home",
      words: [{ end: 0.4, start: 0.1, text: "home", type: "word" }],
    })
    await closing
    expect(finals(messages)).toHaveLength(1)
    expect(finals(messages)[0]!.commit?.commitId).toBe(handle!.commitId)
    expect(socket.closed).toEqual({ code: 1000, reason: "karaoke_session_ended" })
  })

  test("ignores the text-only committed_transcript to avoid double-counting", async () => {
    const { socket, messages } = await startAdapter()
    await socket.deliver({ message_type: "committed_transcript", text: "hold on" })
    expect(messages).toHaveLength(0)
  })

  test("stops forwarding audio after a provider error message", async () => {
    const { adapter, socket } = await startAdapter()
    await socket.deliver({ message: "bad key", message_type: "auth_error" })
    await adapter.sendPcm16(frame())
    expect(socket.sent).toHaveLength(0)
  })

  test("ignores malformed, session, and unknown messages", async () => {
    const { socket, messages } = await startAdapter()
    await socket.deliver("not json")
    await socket.deliver({ message_type: "session_started" })
    await socket.deliver({ foo: "bar" })
    expect(messages).toHaveLength(0)
  })

  test("stops forwarding audio after a provider auth_error", async () => {
    const { adapter, socket } = await startAdapter()
    await socket.deliver({
      message_type: "auth_error",
      error: "You must be authenticated to use this endpoint.",
    })
    const before = socket.sent.length
    await adapter.sendPcm16(frame())
    expect(socket.sent.length).toBe(before)
  })
})

describe("connectWorkerdWebSocket (token auth)", () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  test("mints a single-use token over REST, then upgrades with ?token= and no api-key header", async () => {
    const calls: { url: string; init?: { method?: string; headers?: Record<string, string> } }[] = []
    let accepted = false
    const fakeSocket = { accept: () => { accepted = true } }
    globalThis.fetch = (async (url: unknown, init?: unknown) => {
      calls.push({ url: String(url), init: init as { method?: string; headers?: Record<string, string> } })
      if (String(url).includes(ELEVENLABS_REALTIME_SCRIBE_TOKEN_PATH)) {
        return { ok: true, status: 200, json: async () => ({ token: "tok_abc" }) }
      }
      return { webSocket: fakeSocket, status: 101 }
    }) as unknown as typeof fetch

    await connectWorkerdWebSocket({
      url: "wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime&disable_logging=true",
      apiKey: "sk_test",
    })

    const mint = calls.find((c) => c.url.includes(ELEVENLABS_REALTIME_SCRIBE_TOKEN_PATH))
    expect(mint?.url).toBe("https://api.elevenlabs.io/v1/single-use-token/realtime_scribe")
    expect(mint?.init?.method).toBe("POST")
    expect(mint?.init?.headers?.["xi-api-key"]).toBe("sk_test")

    const upgrade = calls.find((c) => c.url.includes("/speech-to-text/realtime"))
    expect(upgrade?.url).toContain("token=tok_abc")
    expect(upgrade?.url).toContain("model_id=scribe_v2_realtime")
    expect(upgrade?.init?.headers?.["xi-api-key"]).toBeUndefined()
    expect(upgrade?.init?.headers?.Upgrade).toBe("websocket")
    expect(accepted).toBe(true)
  })

  test("throws and never attempts the WS upgrade when token mint is unauthorized", async () => {
    let upgradeAttempted = false
    globalThis.fetch = (async (url: unknown) => {
      if (String(url).includes(ELEVENLABS_REALTIME_SCRIBE_TOKEN_PATH)) {
        return { ok: false, status: 401, text: async () => "Unauthorized" }
      }
      upgradeAttempted = true
      return { webSocket: { accept() {} }, status: 101 }
    }) as unknown as typeof fetch

    await expect(
      connectWorkerdWebSocket({ url: "wss://api.elevenlabs.io/v1/speech-to-text/realtime", apiKey: "bad" }),
    ).rejects.toThrow(/token_mint_failed_401/)
    expect(upgradeAttempted).toBe(false)
  })

  test("throws when the mint response carries no token", async () => {
    globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({}) })) as unknown as typeof fetch
    await expect(
      connectWorkerdWebSocket({ url: "wss://api.elevenlabs.io/v1/speech-to-text/realtime", apiKey: "k" }),
    ).rejects.toThrow(/token_missing/)
  })
})
