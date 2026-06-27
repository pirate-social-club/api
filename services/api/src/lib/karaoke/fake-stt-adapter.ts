import {
  KARAOKE_TRANSPORT_PROTOCOL_VERSION,
  type KaraokeClientBinaryFrame,
  type KaraokeRecognizedWord,
  type KaraokeSttAdapterMessage,
  type KaraokeSttCommitAck,
  type KaraokeStreamingSttAdapter,
  type KaraokeStreamingSttEvent,
} from "@pirate-social-club/karaoke-runtime";

export type FakeSttMessageHandler = (message: KaraokeSttAdapterMessage) => Promise<void>;

/**
 * Test/dev fake. Two ways to drive it:
 *  - emit(): inject an uncorrelated final (no commit metadata) — e.g. the
 *    /internal/stt route.
 *  - commit() + ackCommit(): model the real commit→ack lifecycle with EXPLICIT
 *    acknowledgement (no auto-ack), so tests control ordering and can forge
 *    stale/mismatched acks.
 */
export class FakeKaraokeStreamingSttAdapter implements KaraokeStreamingSttAdapter {
  readonly frames: KaraokeClientBinaryFrame[] = [];
  startCount = 0;
  closeCount = 0;
  commitCount = 0;
  started = false;
  streamGeneration: string | null = null;
  /** When true, commit() refuses (simulates the below-floor provider rejection). */
  refuseCommits = false;
  private onMessage: FakeSttMessageHandler | null = null;
  private starting: Promise<void> | null = null;
  private inFlight: { commitId: string; frontierMs: number } | null = null;
  private commitSeq = 0;
  private sttSeq = 0;
  private submittedFrontierMs = 0;
  private lastCommittedFrontierMs = 0;
  private sessionId = "fake-session";
  private attemptId = "fake-attempt";

  async start(input: {
    attemptId: string;
    sessionId: string;
    onMessage: FakeSttMessageHandler;
  }): Promise<void> {
    if (this.starting) {
      await this.starting;
      return;
    }
    this.starting = (async () => {
      this.startCount += 1;
      this.started = true;
      // A fresh, globally-unique generation per start so a restored (new-instance)
      // stream never collides with an evicted stream's persisted pending commit.
      this.streamGeneration = crypto.randomUUID();
      this.inFlight = null;
      this.lastCommittedFrontierMs = 0;
      this.onMessage = input.onMessage;
      this.sessionId = input.sessionId;
      this.attemptId = input.attemptId;
    })();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  async sendPcm16(frame: KaraokeClientBinaryFrame): Promise<void> {
    this.frames.push(frame);
    if (Number.isFinite(frame.songEndMs) && frame.songEndMs > this.submittedFrontierMs) {
      this.submittedFrontierMs = frame.songEndMs;
    }
  }

  async commit(): Promise<{ commitId: string; streamGeneration: string; frontierMs: number } | null> {
    this.commitCount += 1;
    if (this.refuseCommits || this.inFlight !== null || !this.streamGeneration) return null;
    // Model the provider audio floor: refuse when no new audio has been submitted
    // since the last commit (so a terminal finish with nothing new falls through
    // to the reducer's terminal sweep rather than issuing a stuck commit).
    if (this.submittedFrontierMs <= this.lastCommittedFrontierMs) return null;
    this.commitSeq += 1;
    const handle = {
      commitId: `fake-commit-${this.commitSeq}`,
      frontierMs: this.submittedFrontierMs,
      streamGeneration: this.streamGeneration,
    };
    this.inFlight = { commitId: handle.commitId, frontierMs: handle.frontierMs };
    this.lastCommittedFrontierMs = handle.frontierMs;
    return handle;
  }

  hasInFlightCommit(): boolean {
    return this.inFlight !== null;
  }

  /** Explicitly acknowledge the in-flight commit with a committed final. */
  async ackCommit(
    words: KaraokeRecognizedWord[],
    overrides: { commitId?: string; streamGeneration?: string; coverageMs?: number } = {},
  ): Promise<void> {
    const inflight = this.inFlight;
    this.inFlight = null;
    const commit: KaraokeSttCommitAck = {
      commitId: overrides.commitId ?? inflight?.commitId ?? "fake-commit-0",
      coverageMs: overrides.coverageMs ?? inflight?.frontierMs ?? 0,
      streamGeneration: overrides.streamGeneration ?? this.streamGeneration ?? "fake-gen-0",
    };
    await this.deliver(this.finalEvent(words, commit.coverageMs), commit);
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    this.started = false;
    this.onMessage = null;
    this.streamGeneration = null;
    this.inFlight = null;
    this.starting = null;
  }

  /** Injects an uncorrelated message (no commit metadata) — used by /internal/stt. */
  async emit(event: KaraokeStreamingSttEvent, commit?: KaraokeSttCommitAck): Promise<void> {
    await this.deliver(event, commit);
  }

  private async deliver(event: KaraokeStreamingSttEvent, commit?: KaraokeSttCommitAck): Promise<void> {
    if (!this.onMessage) {
      throw new Error("Fake karaoke STT adapter is not started");
    }
    await this.onMessage({ commit, event });
  }

  private finalEvent(words: KaraokeRecognizedWord[], coverageMs: number): KaraokeStreamingSttEvent {
    this.sttSeq += 1;
    return {
      attemptId: this.attemptId,
      deliveredAtAudioMs: coverageMs,
      protocolVersion: KARAOKE_TRANSPORT_PROTOCOL_VERSION,
      sequence: this.sttSeq,
      sessionId: this.sessionId,
      text: words.map((word) => word.text).join(" "),
      type: "stt_final",
      words,
    };
  }
}
