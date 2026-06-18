import {
  KARAOKE_TRANSPORT_PROTOCOL_VERSION,
  type KaraokeServerEvent,
  type KaraokeSessionEffect,
  type KaraokeSessionState,
  type KaraokeStreamingSttEvent,
  type KaraokeTransportError,
  type KaraokeTransportEnvelope,
} from "@pirate/karaoke-runtime";
import { pushKaraokeDebug } from "./karaoke-debug-buffer";

export interface OutboxRow {
  eventId: string;
  event: KaraokeServerEvent;
}

export interface OutboxStore {
  loadPending(input: { sessionId: string; attemptId: string }): Promise<OutboxRow[]>;
  markPending(input: { sessionId: string; attemptId: string; rows: OutboxRow[] }): Promise<void>;
  markDelivered(input: { sessionId: string; attemptId: string; eventIds: readonly string[] }): Promise<void>;
}

export interface InMemoryOutboxStoreOptions {
  now?: () => number;
}

export class InMemoryOutboxStore implements OutboxStore {
  private readonly rows = new Map<string, { event: KaraokeServerEvent; eventId: string; deliveredAt: number | null; createdAt: number }>();
  private readonly now: () => number;

  constructor(options: InMemoryOutboxStoreOptions = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  async loadPending(input: { sessionId: string; attemptId: string }): Promise<OutboxRow[]> {
    const prefix = `${input.sessionId}:${input.attemptId}:`;
    const pending: OutboxRow[] = [];
    for (const [key, row] of this.rows.entries()) {
      if (!key.startsWith(prefix)) continue;
      if (row.deliveredAt === null) {
        pending.push({ event: row.event, eventId: row.eventId });
      }
    }
    pending.sort((a, b) => a.event.sequence - b.event.sequence);
    return pending;
  }

  async markPending(input: { sessionId: string; attemptId: string; rows: OutboxRow[] }): Promise<void> {
    for (const row of input.rows) {
      const key = `${input.sessionId}:${input.attemptId}:${row.eventId}`;
      const existing = this.rows.get(key);
      this.rows.set(key, { ...row, createdAt: existing?.createdAt ?? this.now(), deliveredAt: null });
    }
  }

  async markDelivered(input: { sessionId: string; attemptId: string; eventIds: readonly string[] }): Promise<void> {
    for (const eventId of input.eventIds) {
      const key = `${input.sessionId}:${input.attemptId}:${eventId}`;
      const existing = this.rows.get(key);
      if (!existing) continue;
      this.rows.set(key, { ...existing, deliveredAt: this.now() });
    }
  }

  snapshot(): ReadonlyMap<string, { event: KaraokeServerEvent; eventId: string; deliveredAt: number | null; createdAt: number }> {
    return this.rows;
  }
}

export interface CloudflareEffectRunnerOptions {
  outbox: OutboxStore;
  broadcast: (event: KaraokeServerEvent) => Promise<void>;
  initialServerSequence?: number;
  persistBeforeBroadcast?: (input: {
    nextServerSequence: number;
    rows: OutboxRow[];
    state: KaraokeSessionState;
  }) => Promise<void>;
}

function envelope(state: KaraokeSessionState, sequence: number): KaraokeTransportEnvelope {
  return {
    attemptId: state.attemptId,
    protocolVersion: KARAOKE_TRANSPORT_PROTOCOL_VERSION,
    sequence,
    sessionId: state.sessionId,
  };
}

function buildLineScoreServerEvent(
  state: KaraokeSessionState,
  sequence: number,
  score: KaraokeSessionState["finalizedLineScores"][number],
): { event: KaraokeServerEvent; eventId: string } {
  const eventId = `${state.sessionId}:${state.attemptId}:line_score:${score.lineId}`;
  return {
    event: { ...envelope(state, sequence), eventId, result: score, type: "line_score" },
    eventId,
  };
}

function buildSummaryServerEvent(
  state: KaraokeSessionState,
  sequence: number,
  summary: NonNullable<KaraokeSessionState["summary"]>,
): { event: KaraokeServerEvent; eventId: string } {
  const eventId = `${state.sessionId}:${state.attemptId}:summary`;
  return {
    event: { ...envelope(state, sequence), eventId, summary, type: "summary" },
    eventId,
  };
}

function buildSessionErrorServerEvent(
  state: KaraokeSessionState,
  sequence: number,
  error: KaraokeTransportError,
): { event: KaraokeServerEvent; eventId: string } {
  const eventId = `${state.sessionId}:${state.attemptId}:session_error:${error.sequence ?? sequence}`;
  return {
    event: { ...envelope(state, sequence), code: error.code, eventId, type: "session_error" },
    eventId,
  };
}

const PERSISTED_EFFECT_KINDS: ReadonlySet<KaraokeSessionEffect["type"]> = new Set([
  "emit_line_score",
  "emit_summary",
]);

export class CloudflareKaraokeEffectRunner {
  private readonly outbox: OutboxStore;
  private readonly broadcast: (event: KaraokeServerEvent) => Promise<void>;
  private readonly persistBeforeBroadcast?: CloudflareEffectRunnerOptions["persistBeforeBroadcast"];
  private serverSequence: number;

  constructor(options: CloudflareEffectRunnerOptions) {
    this.outbox = options.outbox;
    this.broadcast = options.broadcast;
    this.persistBeforeBroadcast = options.persistBeforeBroadcast;
    this.serverSequence = options.initialServerSequence ?? 0;
  }

  nextServerSequence(): number {
    return this.serverSequence;
  }

  async runKaraokeEffect(
    effect: KaraokeSessionEffect,
    state: KaraokeSessionState,
  ): Promise<void> {
    if (!PERSISTED_EFFECT_KINDS.has(effect.type)) {
      return;
    }
    const built = this.buildPersistedEvent(effect, state);
    if (!built) {
      return;
    }
    pushKaraokeDebug(state.sessionId, "emit_effect", { type: effect.type });
    await this.persistRowsBeforeBroadcast([built], state);
    await this.broadcast(built.event);
    await this.outbox.markDelivered({
      attemptId: state.attemptId,
      eventIds: [built.eventId],
      sessionId: state.sessionId,
    });
  }

  async relaySttEvent(
    event: KaraokeStreamingSttEvent,
    state: KaraokeSessionState,
  ): Promise<void> {
    pushKaraokeDebug(state.sessionId, "relay_stt", { type: event.type, textLen: (event.text ?? "").length, words: event.words?.length ?? 0 });
    const sequence = this.serverSequence;
    this.serverSequence += 1;
    const relayEvent: KaraokeServerEvent = {
      ...envelope(state, sequence),
      eventId: `${state.sessionId}:${state.attemptId}:${event.type}:${event.sequence}`,
      text: event.text,
      type: event.type,
      words: event.words,
    };
    await this.broadcast(relayEvent);
  }

  async reportTransportError(
    error: KaraokeTransportError,
    state: KaraokeSessionState,
  ): Promise<void> {
    pushKaraokeDebug(state.sessionId, "session_error", { code: error.code });
    const sequence = this.serverSequence;
    this.serverSequence += 1;
    const built = buildSessionErrorServerEvent(state, sequence, error);
    await this.persistRowsBeforeBroadcast([built], state);
    await this.broadcast(built.event);
    await this.outbox.markDelivered({
      attemptId: state.attemptId,
      eventIds: [built.eventId],
      sessionId: state.sessionId,
    });
  }

  async flushPending(input: { sessionId: string; attemptId: string }): Promise<void> {
    const rows = await this.outbox.loadPending(input);
    for (const row of rows) {
      await this.broadcast(row.event);
    }
    await this.outbox.markDelivered({
      attemptId: input.attemptId,
      eventIds: rows.map((row) => row.eventId),
      sessionId: input.sessionId,
    });
  }

  private buildPersistedEvent(
    effect: KaraokeSessionEffect,
    state: KaraokeSessionState,
  ): OutboxRow | null {
    if (effect.type === "emit_line_score") {
      const sequence = this.serverSequence;
      this.serverSequence += 1;
      const built = buildLineScoreServerEvent(state, sequence, effect.score);
      return { event: built.event, eventId: built.eventId };
    }
    if (effect.type === "emit_summary") {
      const sequence = this.serverSequence;
      this.serverSequence += 1;
      const built = buildSummaryServerEvent(state, sequence, effect.summary);
      return { event: built.event, eventId: built.eventId };
    }
    return null;
  }

  private async persistRowsBeforeBroadcast(
    rows: OutboxRow[],
    state: KaraokeSessionState,
  ): Promise<void> {
    if (this.persistBeforeBroadcast) {
      await this.persistBeforeBroadcast({
        nextServerSequence: this.serverSequence,
        rows,
        state,
      });
      return;
    }
    await this.outbox.markPending({
      attemptId: state.attemptId,
      rows,
      sessionId: state.sessionId,
    });
  }
}
