import type {
  KaraokeClientBinaryFrame,
  KaraokeRecognizedWord,
  KaraokeSttAdapterMessage,
} from "@pirate/karaoke-runtime"

import { KaraokeSttEventEmitter } from "./stt-event-emitter"

export const ELEVENLABS_DEFAULT_STT_WEBSOCKET_URL = "wss://api.elevenlabs.io/v1/speech-to-text/realtime"
export const ELEVENLABS_DEFAULT_STT_MODEL = "scribe_v2_realtime"

// Keep stream→song segment history bounded; committed transcripts always
// reference very recent audio, so two minutes is ample headroom.
const SEGMENT_RETENTION_MS = 120_000
// The live API rejects commits below 0.3s of uncommitted audio with
// `commit_throttled` AND closes the socket; ~0.1s is consumed server-side by
// partial decoding, so require 0.4s of submitted audio before committing.
const SAFE_COMMIT_FLOOR_MS = 400
// Terminal wait for an in-flight commit's final during close() (probe: ~370ms).
const COMMIT_DRAIN_TIMEOUT_MS = 1_500

// --- ElevenLabs realtime STT wire format ------------------------------------
// Per the ElevenLabs v1 speech-to-text realtime docs and a live probe. Client->
// server messages are keyed by `message_type`, carry base64 audio under
// `audio_base_64`, and use a boolean `commit` flag on the audio message. Server->
// client events carry their event name (read defensively from `message_type`/
// `type`). Partials are text-only; word-level timestamps (seconds) + per-word
// `logprob` arrive only on committed_transcript_with_timestamps, whose `words`
// array interleaves `type:"word"` entries with `type:"spacing"` separators.
const OUTBOUND_AUDIO_MESSAGE_TYPE = "input_audio_chunk"
const INBOUND_PARTIAL_TYPES = new Set(["partial_transcript"])
// We always request include_timestamps=true, so the server emits BOTH a
// text-only `committed_transcript` and a word-timed
// `committed_transcript_with_timestamps` for the same segment. Finalize only on
// the timestamped variant to avoid double-counting the segment.
const INBOUND_FINAL_TYPES = new Set(["committed_transcript_with_timestamps"])
const INBOUND_ERROR_TYPES = new Set([
  "auth_error",
  "quota_exceeded",
  "rate_limited",
  "queue_overflow",
  "resource_exhausted",
  "session_time_limit_exceeded",
  "input_error",
  "error",
])
// ---------------------------------------------------------------------------

export interface KaraokeSttSocketMessageEvent {
  data: string | ArrayBuffer
}

export interface KaraokeSttSocket {
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: "message", listener: (event: KaraokeSttSocketMessageEvent) => void): void
  addEventListener(type: "close", listener: (event: { code: number; reason: string }) => void): void
  addEventListener(type: "error", listener: (event: unknown) => void): void
}

export type KaraokeSttSocketConnect = (input: { url: string; apiKey: string }) => Promise<KaraokeSttSocket>

export interface ElevenLabsKaraokeSttAdapterOptions {
  apiKey: string
  model?: string
  websocketUrl?: string
  /** When "not_stored", request zero-retention (no provider-side logging). */
  retention?: "not_stored"
  /** Injectable for tests; defaults to a workerd outbound WebSocket upgrade. */
  connect?: KaraokeSttSocketConnect
}

/** Opens an ElevenLabs realtime STT WebSocket from within workerd. */
export const ELEVENLABS_REALTIME_SCRIBE_TOKEN_PATH = "/v1/single-use-token/realtime_scribe"

/**
 * Opens the ElevenLabs realtime STT socket from the Workers runtime.
 *
 * Auth: the realtime STT WebSocket authenticates via a `token` query parameter,
 * NOT the `xi-api-key` request header. The header is honored on REST calls (e.g.
 * forced alignment) but is not conveyed to the provider on the workerd
 * fetch-based WS upgrade, so a header-authed upgrade arrives unauthenticated and
 * the provider replies `auth_error` ("You must be authenticated…"). We therefore
 * mint a single-use realtime-scribe token over REST (which DOES carry the header)
 * and put it in the WS query string. Single-use → minted fresh on every
 * connect/reconnect.
 */
export async function connectWorkerdWebSocket(input: { url: string; apiKey: string }): Promise<KaraokeSttSocket> {
  // workerd's fetch() rejects ws://wss:// schemes ("Fetch API cannot load: wss://…");
  // an outbound WebSocket is opened with an http(s):// URL + an Upgrade header.
  const upgradeUrl = input.url.replace(/^wss:\/\//i, "https://").replace(/^ws:\/\//i, "http://")

  const tokenEndpoint = new URL(ELEVENLABS_REALTIME_SCRIBE_TOKEN_PATH, upgradeUrl)
  const tokenResponse = await fetch(tokenEndpoint.toString(), {
    method: "POST",
    headers: { "xi-api-key": input.apiKey },
  })
  if (!tokenResponse.ok) {
    // 401/403 here is a real auth/config failure (bad/missing key, or the key
    // lacks realtime-STT scope). Surface it — do NOT silently fall back to a
    // header-authed upgrade, which would recreate the unauthenticated all-miss.
    const detail = (await tokenResponse.text().catch(() => "")).slice(0, 200)
    throw new Error(`elevenlabs_stt_token_mint_failed_${tokenResponse.status}${detail ? `: ${detail}` : ""}`)
  }
  const minted = (await tokenResponse.json().catch(() => null)) as { token?: string } | null
  const token = minted?.token?.trim()
  if (!token) {
    throw new Error("elevenlabs_stt_token_missing")
  }

  const wsUrl = new URL(upgradeUrl)
  wsUrl.searchParams.set("token", token)
  const response = await fetch(wsUrl.toString(), {
    headers: { Upgrade: "websocket" },
  })
  const socket = response.webSocket
  if (!socket) {
    throw new Error(`elevenlabs_stt_upgrade_failed_${response.status}`)
  }
  socket.accept()
  return socket as unknown as KaraokeSttSocket
}

function base64FromArrayBuffer(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ""
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

// Maps a position in the contiguous submitted-audio stream to song time. Each
// submitted frame contributes one segment; on pause/seek the song time jumps
// while stream time stays contiguous, so a single fixed offset is wrong — we
// look up the segment that contains the word's stream position instead.
interface StreamSegment {
  streamStartMs: number
  streamEndMs: number
  songStartMs: number
}

/**
 * Real streaming STT adapter backed by ElevenLabs `scribe_v2_realtime`.
 *
 * Implements the KaraokeStreamingSttAdapter contract: opens a single outbound
 * WebSocket on start, forwards PCM16 mono 16kHz chunks (base64 JSON), and
 * translates committed transcripts into KaraokeStreamingSttEvents with
 * word-level timing mapped back into song time.
 */
export class ElevenLabsKaraokeSttAdapter {
  private readonly apiKey: string
  private readonly model: string
  private readonly websocketUrl: string
  private readonly retention?: "not_stored"
  private readonly connect: KaraokeSttSocketConnect

  // streamGeneration is null before start()/after close(); a fresh UUID per
  // start() so an evicted stream's pending commit can never match a new one.
  streamGeneration: string | null = null

  private socket: KaraokeSttSocket | null = null
  private emitter: KaraokeSttEventEmitter | null = null
  private closed = false
  private sampleRate = 16_000
  private streamCursorMs = 0
  private segments: StreamSegment[] = []
  // Bytes of audio submitted since the last successful commit (the commit floor
  // is measured from these submitted bytes, never wall time).
  private uncommittedBytes = 0
  // Furthest song-time position submitted; the frontier an explicit commit covers.
  private submittedSongFrontierMs = 0
  // At most one commit in flight; its ack is the next committed final (FIFO).
  private inFlight: { commitId: string; frontierMs: number } | null = null
  // Resolves when an in-flight commit's final arrives, so close() can drain it.
  private drainWaiter: (() => void) | null = null
  // Serialize inbound provider messages so partial/final ordering and the STT
  // sequence stay deterministic even though the socket fires callbacks eagerly.
  private inbound: Promise<void> = Promise.resolve()

  constructor(options: ElevenLabsKaraokeSttAdapterOptions) {
    this.apiKey = options.apiKey
    this.model = options.model?.trim() || ELEVENLABS_DEFAULT_STT_MODEL
    this.websocketUrl = options.websocketUrl?.trim() || ELEVENLABS_DEFAULT_STT_WEBSOCKET_URL
    this.retention = options.retention
    this.connect = options.connect ?? connectWorkerdWebSocket
  }

  async start(input: {
    attemptId: string
    sessionId: string
    onMessage: (message: KaraokeSttAdapterMessage) => Promise<void>
  }): Promise<void> {
    this.closed = false
    this.streamCursorMs = 0
    this.segments = []
    this.uncommittedBytes = 0
    this.submittedSongFrontierMs = 0
    this.inFlight = null
    this.drainWaiter = null
    this.inbound = Promise.resolve()
    this.streamGeneration = crypto.randomUUID()
    this.emitter = new KaraokeSttEventEmitter(input.sessionId, input.attemptId, input.onMessage)

    let socket: KaraokeSttSocket
    try {
      socket = await this.connect({ apiKey: this.apiKey, url: this.buildUrl() })
    } catch (error) {
      // Surface the connect failure (token mint / upgrade) — sanitized, no key.
      // This is what becomes the session_error.message and the all-miss cause;
      // logging it makes it visible in `wrangler tail` (flushed on socket close)
      // even though the throw happens before any provider-message log.
      console.error("[karaoke-stt] STT connect failed", {
        message: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
    this.socket = socket
    socket.addEventListener("message", (event) => {
      this.inbound = this.inbound.then(() => this.handleMessage(event.data)).catch(() => undefined)
    })
    socket.addEventListener("close", () => {
      this.markClosed()
    })
    socket.addEventListener("error", () => {
      this.markClosed()
    })
  }

  async sendPcm16(frame: KaraokeClientBinaryFrame): Promise<void> {
    this.sampleRate = frame.sampleRate
    this.recordSegment(frame)
    this.uncommittedBytes += frame.pcm16.byteLength
    if (Number.isFinite(frame.songEndMs) && frame.songEndMs > this.submittedSongFrontierMs) {
      this.submittedSongFrontierMs = frame.songEndMs
    }
    this.emitter?.noteAudioTimeMs(frame.songEndMs)
    const socket = this.socket
    if (!socket || this.closed) return
    socket.send(JSON.stringify({
      audio_base_64: base64FromArrayBuffer(frame.pcm16),
      message_type: OUTBOUND_AUDIO_MESSAGE_TYPE,
      sample_rate: frame.sampleRate,
    }))
  }

  async commit(): Promise<{ commitId: string; streamGeneration: string; frontierMs: number } | null> {
    const socket = this.socket
    // One commit in flight; below-floor commits would be throttled AND close the
    // socket, so refuse without sending. Either way the stream survives.
    if (!socket || this.closed || this.inFlight !== null || this.streamGeneration === null) return null
    if (this.uncommittedMs() < SAFE_COMMIT_FLOOR_MS) return null

    const commitId = crypto.randomUUID()
    const frontierMs = this.submittedSongFrontierMs
    this.inFlight = { commitId, frontierMs }
    this.uncommittedBytes = 0
    socket.send(JSON.stringify({
      audio_base_64: "",
      commit: true,
      message_type: OUTBOUND_AUDIO_MESSAGE_TYPE,
      sample_rate: this.sampleRate,
    }))
    return { commitId, frontierMs, streamGeneration: this.streamGeneration }
  }

  async close(): Promise<void> {
    // Drain an in-flight commit so a pending/acknowledged final is never discarded.
    if (this.inFlight && this.socket && !this.closed) {
      await new Promise<void>((resolve) => {
        this.drainWaiter = resolve
        setTimeout(resolve, COMMIT_DRAIN_TIMEOUT_MS)
      })
      this.drainWaiter = null
    }
    const socket = this.socket
    this.markClosed()
    this.socket = null
    this.emitter = null
    this.streamGeneration = null
    if (!socket) return
    try {
      socket.close(1000, "karaoke_session_ended")
    } catch {
      // best-effort
    }
  }

  private markClosed(): void {
    this.closed = true
    // Unblock any close() drain waiting on a final that will now never arrive.
    this.drainWaiter?.()
    this.drainWaiter = null
  }

  private uncommittedMs(): number {
    return (this.uncommittedBytes / 2 / this.sampleRate) * 1000
  }

  private buildUrl(): string {
    const url = new URL(this.websocketUrl)
    url.searchParams.set("model_id", this.model)
    url.searchParams.set("audio_format", "pcm_16000")
    url.searchParams.set("include_timestamps", "true")
    // Manual commits only: committed finals then arrive ONLY in response to our
    // explicit commit() calls, giving a clean FIFO 1:1 commit→ack correlation
    // (VAD would emit uncorrelated finals). Partials still stream for live feedback.
    url.searchParams.set("commit_strategy", "manual")
    // Honor the runtime's retention: "not_stored" promise — disable provider
    // logging/retention of the audio + transcript.
    if (this.retention === "not_stored") {
      url.searchParams.set("disable_logging", "true")
    }
    return url.toString()
  }

  private recordSegment(frame: KaraokeClientBinaryFrame): void {
    const durationMs = (frame.pcm16.byteLength / 2 / frame.sampleRate) * 1000
    if (!(durationMs > 0)) return
    const streamStartMs = this.streamCursorMs
    this.streamCursorMs += durationMs
    this.segments.push({
      songStartMs: Number.isFinite(frame.songStartMs) ? frame.songStartMs : 0,
      streamEndMs: this.streamCursorMs,
      streamStartMs,
    })
    const cutoff = this.streamCursorMs - SEGMENT_RETENTION_MS
    if (cutoff > 0 && this.segments.length > 1 && this.segments[0]!.streamEndMs < cutoff) {
      this.segments = this.segments.filter((segment) => segment.streamEndMs >= cutoff)
    }
  }

  private async handleMessage(data: string | ArrayBuffer): Promise<void> {
    if (typeof data !== "string") return
    const emitter = this.emitter
    if (!emitter) return
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      return
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return
    const message = parsed as Record<string, unknown>
    const type = readString(message.message_type) || readString(message.type)

    if (INBOUND_ERROR_TYPES.has(type)) {
      // Stop forwarding audio on a provider error. (Typed error propagation to
      // the client via an adapter→host channel is part of the lifecycle pass.)
      this.closed = true
      // Log the full provider payload (truncated), not just the coarse code —
      // `{code: auth_error}` alone hid that the real failure was an
      // unauthenticated upgrade ("You must be authenticated to use this endpoint").
      console.warn("[karaoke-stt] elevenlabs provider error", {
        code: type,
        payload: JSON.stringify(message).slice(0, 400),
      })
      return
    }

    const text = readString(message.text) || readString(message.transcript)
    if (INBOUND_PARTIAL_TYPES.has(type)) {
      if (text) await emitter.emitPartial(text, [])
      return
    }
    if (INBOUND_FINAL_TYPES.has(type)) {
      // In manual mode every committed final answers the oldest in-flight commit
      // (FIFO). Attach its correlation handle so the host can advance the watermark.
      const inFlight = this.inFlight
      this.inFlight = null
      const commit = inFlight && this.streamGeneration
        ? { commitId: inFlight.commitId, coverageMs: inFlight.frontierMs, streamGeneration: this.streamGeneration }
        : undefined
      const mappedWords = this.mapWords(message.words)
      // Diagnostic: what ElevenLabs actually transcribed + the song-time range of
      // the words. Empty/garbage text => audio/mic problem; correct text at an
      // offset song-time => timing/bucketizer problem. Captured via wrangler tail.
      console.log("[karaoke-stt] committed_final", JSON.stringify({
        text,
        wordCount: mappedWords.length,
        firstWordMs: mappedWords[0]?.startMs ?? null,
        lastWordMs: mappedWords[mappedWords.length - 1]?.endMs ?? null,
        commitId: commit?.commitId ?? null,
        coverageMs: commit?.coverageMs ?? null,
      }))
      await emitter.emitFinal(text, mappedWords, commit)
      // Release a close() drain waiting on this commit's final.
      this.drainWaiter?.()
      this.drainWaiter = null
    }
  }

  private mapWords(raw: unknown): KaraokeRecognizedWord[] {
    if (!Array.isArray(raw)) return []
    const words: KaraokeRecognizedWord[] = []
    for (const item of raw) {
      if (!item || typeof item !== "object") continue
      const entry = item as Record<string, unknown>
      // ElevenLabs interleaves `type:"spacing"` separator tokens between words.
      if (readString(entry.type) === "spacing") continue
      const text = (readString(entry.text) || readString(entry.word)).trim()
      const startSec = readFiniteNumber(entry.start) ?? readFiniteNumber(entry.start_time)
      const endSec = readFiniteNumber(entry.end) ?? readFiniteNumber(entry.end_time)
      if (!text || startSec === null || endSec === null) continue
      words.push({
        confidence: this.confidence(entry),
        endMs: this.toSongTimeMs(endSec),
        final: true,
        source: "stt",
        startMs: this.toSongTimeMs(startSec),
        text,
      })
    }
    return words
  }

  // Provider word start/end are seconds into the contiguous submitted audio
  // stream. Map through the segment that contains that stream position so that
  // pauses/seeks (which shift song time but not stream time) stay correct.
  private toSongTimeMs(seconds: number): number {
    const streamMs = seconds * 1000
    if (this.segments.length === 0) return Math.round(streamMs)
    for (let index = this.segments.length - 1; index >= 0; index -= 1) {
      const segment = this.segments[index]!
      if (streamMs >= segment.streamStartMs) {
        return Math.round(segment.songStartMs + (streamMs - segment.streamStartMs))
      }
    }
    const first = this.segments[0]!
    return Math.round(first.songStartMs + (streamMs - first.streamStartMs))
  }

  private confidence(entry: Record<string, unknown>): number | null {
    const direct = readFiniteNumber(entry.confidence)
    if (direct !== null) return Math.min(1, Math.max(0, direct))
    const logprob = readFiniteNumber(entry.logprob)
    if (logprob !== null) return Math.min(1, Math.max(0, Math.exp(logprob)))
    return null
  }
}
