import {
  KARAOKE_TRANSPORT_PROTOCOL_VERSION,
  type KaraokeRecognizedWord,
  type KaraokeSttAdapterMessage,
  type KaraokeSttCommitAck,
  type KaraokeStreamingSttEvent,
} from "@pirate-social-club/karaoke-runtime"

export type KaraokeSttEmit = (message: KaraokeSttAdapterMessage) => Promise<void>

/**
 * Provider-agnostic helper shared by every real streaming STT adapter.
 *
 * Owns the two cross-cutting concerns the transport envelope requires but that
 * are unrelated to any provider's wire format:
 *  - a strictly monotonic per-attempt `sequence` (the session host rejects
 *    non-monotonic STT events), and
 *  - `deliveredAtAudioMs`, tracked as the furthest song-time position fed.
 *
 * Concrete adapters translate provider messages into (text, words) and call
 * `emitPartial` / `emitFinal`; on a committed final they pass the commit ack so
 * it travels to the host on the message wrapper (never on the client transcript).
 */
export class KaraokeSttEventEmitter {
  private sequence: number
  private latestAudioMs = 0

  constructor(
    private readonly sessionId: string,
    private readonly attemptId: string,
    private readonly emit: KaraokeSttEmit,
    // Resume point for the envelope sequence. A provider stream can restart
    // mid-attempt (reconnect, or a fresh DO restoring the session), and each
    // restart builds a NEW emitter — but the host's `lastSttSequence` survives and
    // rejects anything not strictly greater, WITHOUT advancing on rejection. So a
    // counter that restarted at 0 silently suppressed transcript + scoring for the
    // rest of the attempt. Always seed from the host's surviving high-water mark.
    // Required, not defaulted: a default would let a future restart path silently
    // reintroduce the reset.
    initialSequence: number,
  ) {
    this.sequence = initialSequence
  }

  noteAudioTimeMs(ms: number): void {
    if (Number.isFinite(ms) && ms > this.latestAudioMs) {
      this.latestAudioMs = ms
    }
  }

  async emitPartial(text: string, words: KaraokeRecognizedWord[]): Promise<void> {
    await this.emit({ event: this.buildEvent("stt_partial", text, words) })
  }

  async emitFinal(text: string, words: KaraokeRecognizedWord[], commit?: KaraokeSttCommitAck): Promise<void> {
    await this.emit({ commit, event: this.buildEvent("stt_final", text, words) })
  }

  private buildEvent(
    type: "stt_partial" | "stt_final",
    text: string,
    words: KaraokeRecognizedWord[],
  ): KaraokeStreamingSttEvent {
    this.sequence += 1
    return {
      attemptId: this.attemptId,
      deliveredAtAudioMs: this.latestAudioMs,
      protocolVersion: KARAOKE_TRANSPORT_PROTOCOL_VERSION,
      sequence: this.sequence,
      sessionId: this.sessionId,
      text,
      type,
      words,
    }
  }
}
