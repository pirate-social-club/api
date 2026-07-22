import { afterEach, describe, expect, test } from "bun:test";
import {
  KARAOKE_TRANSPORT_PROTOCOL_VERSION,
  encodeKaraokeBinaryFrame,
  type KaraokeClientBinaryFrame,
  type KaraokeScoringPolicy,
  type KaraokeServerEvent,
  type StoredKaraokeSessionSnapshot,
  type ScorableKaraokeLine,
} from "@pirate-social-club/karaoke-runtime";
import type { Env } from "../../../src/env";
import { encryptElevenLabsKey } from "../../../src/lib/communities/assistant-policy/credential-crypto";
import {
  CloudflareKaraokeEffectRunner,
  InMemoryOutboxStore,
} from "../../../src/lib/karaoke/cloudflare-effect-runner";
import { FakeKaraokeStreamingSttAdapter } from "../../../src/lib/karaoke/fake-stt-adapter";
import {
  KaraokeSessionRuntimeDO,
  type DurableObjectContextLike,
} from "../../../src/lib/karaoke/session-do";
import { setControlPlanePostgresPoolFactoryForTests } from "../../../src/lib/runtime-deps";

afterEach(() => {
  setControlPlanePostgresPoolFactoryForTests(null);
});

interface FakeSqlRow {
  [key: string]: string | number | null;
}

class FakeSqlStorage {
  private readonly tables = new Map<string, FakeSqlRow[]>();

  exec<T extends Record<string, ArrayBuffer | string | number | null>>(
    sql: string,
    ...bindings: (ArrayBuffer | string | number | null)[]
  ): { toArray(): T[] } {
    const normalized = sql.replace(/\s+/g, " ").trim();
    if (normalized.includes("CREATE TABLE IF NOT EXISTS karaoke_session_snapshots")) {
      this.tables.set("karaoke_session_snapshots", this.tables.get("karaoke_session_snapshots") ?? []);
    } else if (normalized.includes("CREATE TABLE IF NOT EXISTS karaoke_session_outbox")) {
      this.tables.set("karaoke_session_outbox", this.tables.get("karaoke_session_outbox") ?? []);
    } else if (normalized.includes("CREATE TABLE IF NOT EXISTS karaoke_attempt_finalize_outbox")) {
      this.tables.set("karaoke_attempt_finalize_outbox", this.tables.get("karaoke_attempt_finalize_outbox") ?? []);
    } else if (normalized.includes("CREATE INDEX IF NOT EXISTS karaoke_session_outbox_pending_idx")) {
      this.requireTable("karaoke_session_outbox");
    } else if (normalized.includes("CREATE INDEX IF NOT EXISTS karaoke_attempt_finalize_pending_idx")) {
      this.requireTable("karaoke_attempt_finalize_outbox");
    } else if (normalized.startsWith("INSERT OR IGNORE INTO karaoke_session_outbox")) {
      this.requireTable("karaoke_session_outbox");
      this.upsertOutboxRow(bindings);
    } else if (normalized.startsWith("INSERT INTO karaoke_attempt_finalize_outbox")) {
      this.requireTable("karaoke_attempt_finalize_outbox");
      this.upsertFinalizeOutboxRow(bindings);
    } else if (normalized.startsWith("UPDATE karaoke_attempt_finalize_outbox SET delivered_at")) {
      this.requireTable("karaoke_attempt_finalize_outbox");
      this.updateFinalizeDelivered(bindings);
    } else if (normalized.startsWith("UPDATE karaoke_attempt_finalize_outbox SET attempts")) {
      this.requireTable("karaoke_attempt_finalize_outbox");
      this.updateFinalizeRetry(bindings);
    } else if (normalized.startsWith("UPDATE karaoke_session_outbox")) {
      this.requireTable("karaoke_session_outbox");
      this.updateOutboxDelivered(bindings);
    } else if (normalized.startsWith("INSERT INTO karaoke_session_snapshots")) {
      this.requireTable("karaoke_session_snapshots");
      this.upsertSnapshotRow(bindings);
    } else if (normalized.startsWith("DELETE FROM karaoke_session_outbox")) {
      this.requireTable("karaoke_session_outbox");
      this.tables.set("karaoke_session_outbox", []);
    } else if (normalized.startsWith("DELETE FROM karaoke_session_snapshots")) {
      this.requireTable("karaoke_session_snapshots");
      this.tables.set("karaoke_session_snapshots", []);
    }
    const rows = this.matchingRows(normalized, bindings) as T[];
    return { toArray: () => rows };
  }

  snapshot(): ReadonlyMap<string, ReadonlyArray<FakeSqlRow>> {
    return this.tables;
  }

  private matchingRows(sql: string, _bindings: unknown[]): FakeSqlRow[] {
    const normalized = sql.replace(/\s+/g, " ").trim();
    if (normalized.includes("FROM karaoke_session_outbox")) {
      this.requireTable("karaoke_session_outbox");
      const outbox = this.tables.get("karaoke_session_outbox") ?? [];
      const ordered = [...outbox].sort((a, b) => Number(a.sequence) - Number(b.sequence));
      const [sessionId, attemptId] = _bindings as [string, string];
      const filtered = ordered.filter((row) =>
        row.delivered_at === null
        && row.session_id === sessionId
        && row.attempt_id === attemptId
      );
      return filtered;
    }
    if (normalized.includes("FROM karaoke_attempt_finalize_outbox")) {
      this.requireTable("karaoke_attempt_finalize_outbox");
      const table = this.tables.get("karaoke_attempt_finalize_outbox") ?? [];
      if (normalized.includes("COUNT(*) AS count")) {
        return [{ count: table.filter((row) => row.delivered_at === null).length }];
      }
      if (normalized.includes("SELECT next_attempt_at")) {
        return table
          .filter((row) => row.delivered_at === null)
          .sort((a, b) => Number(a.next_attempt_at) - Number(b.next_attempt_at))
          .slice(0, 1);
      }
      if (normalized.includes("WHERE delivered_at IS NULL AND next_attempt_at <= ?")) {
        const [now] = _bindings as [number];
        return table
          .filter((row) => row.delivered_at === null && Number(row.next_attempt_at) <= now)
          .sort((a, b) => Number(a.next_attempt_at) - Number(b.next_attempt_at))
          .slice(0, 3);
      }
      return table;
    }
    if (normalized.includes("FROM karaoke_session_snapshots")) {
      return this.tables.get("karaoke_session_snapshots") ?? [];
    }
    return [];
  }

  private requireTable(name: string): void {
    if (!this.tables.has(name)) {
      throw new Error(`no such table: ${name}`);
    }
  }

  private upsertOutboxRow(bindings: unknown[]): void {
    const [sessionId, attemptId, eventId, sequence, eventJson, createdAt] = bindings as [string, string, string, number, string, number];
    const table = this.tables.get("karaoke_session_outbox") ?? [];
    const existing = table.find((row) => row.session_id === sessionId && row.attempt_id === attemptId && row.event_id === eventId);
    if (existing) return;
    table.push({
      attempt_id: attemptId,
      created_at: createdAt,
      delivered_at: null,
      event_id: eventId,
      event_json: eventJson,
      sequence,
      session_id: sessionId,
    });
    this.tables.set("karaoke_session_outbox", table);
  }

  private updateOutboxDelivered(bindings: unknown[]): void {
    const [deliveredAt, sessionId, attemptId, eventId] = bindings as [number, string, string, string];
    const table = this.tables.get("karaoke_session_outbox") ?? [];
    const row = table.find((r) => r.session_id === sessionId && r.attempt_id === attemptId && r.event_id === eventId);
    if (row) row.delivered_at = deliveredAt;
  }

  private upsertFinalizeOutboxRow(bindings: unknown[]): void {
    const [
      sessionId,
      attemptId,
      payloadJson,
      nextAttemptAt,
      createdAt,
      updatedAt,
    ] = bindings as [string, string, string, number, number, number];
    const table = this.tables.get("karaoke_attempt_finalize_outbox") ?? [];
    const existing = table.find((row) => row.session_id === sessionId && row.attempt_id === attemptId);
    const next = {
      attempt_id: attemptId,
      attempts: 0,
      created_at: createdAt,
      delivered_at: null,
      next_attempt_at: nextAttemptAt,
      payload_json: payloadJson,
      session_id: sessionId,
      updated_at: updatedAt,
    };
    if (existing) Object.assign(existing, next);
    else table.push(next);
    this.tables.set("karaoke_attempt_finalize_outbox", table);
  }

  private updateFinalizeDelivered(bindings: unknown[]): void {
    const [deliveredAt, updatedAt, sessionId, attemptId] = bindings as [number, number, string, string];
    const table = this.tables.get("karaoke_attempt_finalize_outbox") ?? [];
    const row = table.find((r) => r.session_id === sessionId && r.attempt_id === attemptId);
    if (row) {
      row.delivered_at = deliveredAt;
      row.updated_at = updatedAt;
    }
  }

  private updateFinalizeRetry(bindings: unknown[]): void {
    const [attempts, nextAttemptAt, updatedAt, sessionId, attemptId] = bindings as [number, number, number, string, string];
    const table = this.tables.get("karaoke_attempt_finalize_outbox") ?? [];
    const row = table.find((r) => r.session_id === sessionId && r.attempt_id === attemptId);
    if (row) {
      row.attempts = attempts;
      row.next_attempt_at = nextAttemptAt;
      row.updated_at = updatedAt;
    }
  }

  private upsertSnapshotRow(bindings: unknown[]): void {
    const [sessionId, attemptId, stateJson, lastClientSequence, lastSttSequence, updatedAt] = bindings as [
      string,
      string,
      string,
      number | null,
      number | null,
      number,
    ];
    const table = this.tables.get("karaoke_session_snapshots") ?? [];
    const existing = table.find((row) => row.session_id === sessionId && row.attempt_id === attemptId);
    const next = {
      attempt_id: attemptId,
      last_client_sequence: lastClientSequence,
      last_stt_sequence: lastSttSequence,
      session_id: sessionId,
      state_json: stateJson,
      updated_at: updatedAt,
    };
    if (existing) Object.assign(existing, next);
    else table.push(next);
    this.tables.set("karaoke_session_snapshots", table);
  }
}

class FakeKvStorage {
  private readonly kv = new Map<string, unknown>();
  alarm: number | null = null;
  readonly sql = new FakeSqlStorage();

  async get<T>(key: string): Promise<T | null> {
    return (this.kv.get(key) as T | undefined) ?? null;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.kv.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.kv.delete(key);
  }

  transactionSync<T>(callback: () => T): T {
    return callback();
  }

  async setAlarm(scheduledTime: number | Date): Promise<void> {
    this.alarm = scheduledTime instanceof Date ? scheduledTime.getTime() : scheduledTime;
  }

  async deleteAlarm(): Promise<void> {
    this.alarm = null;
  }
}

function makeContext(): {
  addSocket(tag: string, socket: { close?(code?: number, reason?: string): void; send(payload: string): void }): void;
  ctx: DurableObjectContextLike;
  storage: FakeKvStorage;
} {
  const storage = new FakeKvStorage();
  const sockets = new Map<string, WebSocket[]>();
  const ctx: DurableObjectContextLike = {
    storage,
    async blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
      return await callback();
    },
    getWebSockets(tag?: string) {
      return tag ? [...(sockets.get(tag) ?? [])] : [...sockets.values()].flat();
    },
  };
  return {
    addSocket(tag, socket) {
      const tagged = sockets.get(tag) ?? [];
      tagged.push(socket as WebSocket);
      sockets.set(tag, tagged);
    },
    ctx,
    storage,
  };
}

const ENV_STUB = { ENVIRONMENT: "test" } as Env;

const ENABLED_POLICY: KaraokeScoringPolicy = {
  kind: "enabled",
  model: "test-model",
  provider: "elevenlabs",
  retention: "not_stored",
};

const LINES: ScorableKaraokeLine[] = [
  {
    endMs: 1000,
    lineId: "line-1",
    lineIndex: 0,
    scoredLineIndex: 0,
    startMs: 0,
    text: "hold on",
    words: [
      { endMs: 400, startMs: 0, text: "hold" },
      { endMs: 900, startMs: 500, text: "on" },
    ],
  },
];

function initRequest() {
  return {
    attemptId: "attempt-1",
    communityId: "community-1",
    lines: LINES,
    postId: "post-1",
    scoringPolicy: ENABLED_POLICY,
    sessionExpiresAtMs: Date.now() + 60 * 60 * 1000,
    sessionId: "session-1",
    subjectUserId: "user-1",
  };
}

let envelopeSequence = 0;
function envelope<T extends object>(type: string, payload: T) {
  envelopeSequence += 1;
  return {
    attemptId: "attempt-1",
    protocolVersion: KARAOKE_TRANSPORT_PROTOCOL_VERSION,
    sequence: envelopeSequence,
    sessionId: "session-1",
    ...payload,
    type,
  };
}

function resetEnvelopeSequence() {
  envelopeSequence = 0;
}

async function startSession(do_: KaraokeSessionRuntimeDO): Promise<Response> {
  return await do_.fetch(new Request("https://do/internal/client-event", {
    body: JSON.stringify(envelope("start", { postId: "post-1", startedAtAudioMs: 0 })),
    headers: { "content-type": "application/json" },
    method: "POST",
  }));
}

const DUMMY_SOCKET = { send() {} } as unknown as WebSocket;

// --- Step 4 commit→ack helpers (the watermark second gate requires a commit) ---
function initDoRequest(): Request {
  return new Request("https://do/init", {
    body: JSON.stringify(initRequest()),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

function clientEventRequest(sequence: number, type: string, payload: Record<string, unknown>): Request {
  return new Request("https://do/internal/client-event", {
    body: JSON.stringify({
      attemptId: "attempt-1",
      protocolVersion: KARAOKE_TRANSPORT_PROTOCOL_VERSION,
      sequence,
      sessionId: "session-1",
      ...payload,
      type,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

function audioFrameBytes(sequence: number, songEndMs: number): ArrayBuffer {
  return encodeKaraokeBinaryFrame({
    attemptId: "attempt-1",
    chunkId: sequence,
    pcm16: new ArrayBuffer(320),
    protocolVersion: KARAOKE_TRANSPORT_PROTOCOL_VERSION,
    sampleRate: 16_000,
    sequence,
    sessionId: "session-1",
    songEndMs,
    songStartMs: 0,
    type: "audio_chunk",
  });
}

const HOLD_ON_WORDS = [
  { confidence: 0.95, endMs: 400, final: true, startMs: 0, text: "hold" },
  { confidence: 0.95, endMs: 900, final: true, startMs: 500, text: "on" },
];

/**
 * Drives the full commit→ack flow: start, push one audio frame that advances the
 * committed frontier past the line, a playback tick (which makes the scheduler
 * issue a commit), then an explicit ack carrying the recognized words.
 */
async function startAndScore(
  do_: KaraokeSessionRuntimeDO,
  adapter: FakeKaraokeStreamingSttAdapter,
  options: { audioEndMs?: number; playbackMs?: number; words?: typeof HOLD_ON_WORDS } = {},
): Promise<void> {
  const audioEndMs = options.audioEndMs ?? 1100;
  const playbackMs = options.playbackMs ?? 1100;
  await do_.fetch(clientEventRequest(1, "start", { postId: "post-1", startedAtAudioMs: 0 }));
  await do_.webSocketMessage(DUMMY_SOCKET, audioFrameBytes(2, audioEndMs));
  await do_.fetch(clientEventRequest(3, "playback_sync", { audioTimeMs: playbackMs, playing: true }));
  await do_.drainCommitChainForTests();
  await adapter.ackCommit(options.words ?? HOLD_ON_WORDS);
  await do_.drainCommitChainForTests();
}

/** Drives start → audio → playback so a commit is in flight, WITHOUT acking it. */
async function startAndCommitNoAck(do_: KaraokeSessionRuntimeDO, audioEndMs = 1100, playbackMs = 1100): Promise<void> {
  await do_.fetch(clientEventRequest(1, "start", { postId: "post-1", startedAtAudioMs: 0 }));
  await do_.webSocketMessage(DUMMY_SOCKET, audioFrameBytes(2, audioEndMs));
  await do_.fetch(clientEventRequest(3, "playback_sync", { audioTimeMs: playbackMs, playing: true }));
  await do_.drainCommitChainForTests();
}

function storedSnapshot(storage: FakeKvStorage): StoredKaraokeSessionSnapshot {
  const rows = storage.sql.snapshot().get("karaoke_session_snapshots") ?? [];
  return JSON.parse(String(rows[0]?.state_json)) as StoredKaraokeSessionSnapshot;
}

describe("KaraokeSessionRuntimeDO", () => {
  test("resolves a community credential through a request-scoped Postgres client", async () => {
    const wrapKey = "ab".repeat(32);
    const encryptedSecret = encryptElevenLabsKey({
      plaintextKey: "elevenlabs-test-key-1234567890", // gitleaks:allow — synthetic test fixture
      wrapKey,
    });
    let poolsCreated = 0;
    let poolsClosed = 0;
    setControlPlanePostgresPoolFactoryForTests(() => {
      poolsCreated += 1;
      const query = async (sql: string) => ({
        rowCount: 1,
        rows: sql.includes("community_assistant_credentials") ? [{
          actor_user_id: "user-1",
          community_assistant_credential_id: "cac-1",
          community_id: "community-1",
          created_at: "2026-07-14T00:00:00.000Z",
          encrypted_secret: encryptedSecret,
          encryption_key_version: 2,
          key_last4: "7890",
          provider: "elevenlabs",
          revoked_at: null,
          rotated_from: null,
          status: "active",
        }] : [],
      });
      return {
        connect: async () => ({ query, release() {} }),
        end: async () => { poolsClosed += 1; },
        query,
      };
    });
    const { ctx } = makeContext();
    const do_ = new KaraokeSessionRuntimeDO(ctx, {
      CONTROL_PLANE_DATABASE_URL: "postgres://karaoke.test/control-plane",
      CREDENTIAL_WRAP_KEY: wrapKey,
      ENVIRONMENT: "production",
    } as Env, {});

    const response = await do_.fetch(initDoRequest());

    expect(response.status).toBe(200);
    expect(poolsCreated).toBe(1);
    expect(poolsClosed).toBe(1);
  });

  test("returns a terminal configuration response when the community credential is absent", async () => {
    let poolsClosed = 0;
    setControlPlanePostgresPoolFactoryForTests(() => {
      const query = async () => ({ rowCount: 0, rows: [] });
      return {
        connect: async () => ({ query, release() {} }),
        end: async () => { poolsClosed += 1; },
        query,
      };
    });
    const { ctx } = makeContext();
    const do_ = new KaraokeSessionRuntimeDO(ctx, {
      CONTROL_PLANE_DATABASE_URL: "postgres://karaoke.test/control-plane",
      CREDENTIAL_WRAP_KEY: "ab".repeat(32),
      ENVIRONMENT: "production",
    } as Env, {});

    const response = await do_.fetch(initDoRequest());

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "karaoke_stt_unconfigured_elevenlabs" });
    expect(poolsClosed).toBe(1);
  });

  test("aborts a restored socket instead of fake-scoring when provider configuration is unavailable", async () => {
    const { ctx } = makeContext();
    const initialized = new KaraokeSessionRuntimeDO(ctx, { ENVIRONMENT: "production" } as Env, {
      sttAdapter: new FakeKaraokeStreamingSttAdapter(),
    });
    expect((await initialized.fetch(initDoRequest())).status).toBe(200);

    setControlPlanePostgresPoolFactoryForTests(() => {
      const query = async () => ({ rowCount: 0, rows: [] });
      return { connect: async () => ({ query, release() {} }), end: async () => {}, query };
    });
    const restored = new KaraokeSessionRuntimeDO(ctx, {
      CONTROL_PLANE_DATABASE_URL: "postgres://karaoke.test/control-plane",
      CREDENTIAL_WRAP_KEY: "ab".repeat(32),
      ENVIRONMENT: "production",
    } as Env, {});
    const sent: string[] = [];
    let closed: [number | undefined, string | undefined] | null = null;
    const socket = {
      close(code?: number, reason?: string) { closed = [code, reason]; },
      send(value: string) { sent.push(value); },
    } as unknown as WebSocket;

    await restored.webSocketMessage(socket, JSON.stringify(envelope("start", { postId: "post-1", startedAtAudioMs: 0 })));

    expect(closed as unknown).toEqual([4002, "Karaoke scoring unavailable"]);
    expect(sent.map((value) => JSON.parse(value))).toContainEqual(expect.objectContaining({
      code: "karaoke_stt_unconfigured",
      type: "session_error",
    }));
    expect(restored.snapshotForTests()).toBeNull();
  });

  test("aborts a legacy restored session whose metadata has no community identity", async () => {
    const { ctx, storage } = makeContext();
    const initialized = new KaraokeSessionRuntimeDO(ctx, { ENVIRONMENT: "production" } as Env, {
      sttAdapter: new FakeKaraokeStreamingSttAdapter(),
    });
    expect((await initialized.fetch(initDoRequest())).status).toBe(200);
    const row = storage.sql.snapshot().get("karaoke_session_snapshots")?.[0];
    if (!row) throw new Error("expected stored karaoke snapshot");
    const snapshot = JSON.parse(String(row.state_json)) as { runtimeMetadata: { communityId?: string } };
    delete snapshot.runtimeMetadata.communityId;
    row.state_json = JSON.stringify(snapshot);

    const restored = new KaraokeSessionRuntimeDO(ctx, { ENVIRONMENT: "production" } as Env, {});
    let closedCode: number | undefined;
    const sent: string[] = [];
    const socket = {
      close(code?: number) { closedCode = code; },
      send(value: string) { sent.push(value); },
    } as unknown as WebSocket;

    await restored.webSocketMessage(socket, JSON.stringify(envelope("start", { postId: "post-1", startedAtAudioMs: 0 })));

    expect(closedCode).toBe(4002);
    expect(sent.map((value) => JSON.parse(value))).toContainEqual(expect.objectContaining({
      code: "karaoke_stt_unconfigured",
      type: "session_error",
    }));
    expect(restored.snapshotForTests()).toBeNull();
  });

  test("keeps test-only internal endpoints unavailable in production", async () => {
    const { ctx } = makeContext();
    const do_ = new KaraokeSessionRuntimeDO(ctx, { ENVIRONMENT: "production" } as Env, {});

    const response = await do_.fetch(new Request("https://do/internal/client-event", { method: "POST" }));

    expect(response.status).toBe(404);
  });

  test("schedules expiry and alarm cleanup closes sockets and clears persisted state", async () => {
    const { addSocket, ctx, storage } = makeContext();
    let closed: [number | undefined, string | undefined] | null = null;
    addSocket("attempt:attempt-1", {
      close(code, reason) {
        closed = [code, reason];
      },
      send() {},
    });
    let now = Date.now();
    const expiresAt = now + 60_000;
    const do_ = new KaraokeSessionRuntimeDO(ctx, ENV_STUB, { now: () => now });
    const response = await do_.fetch(new Request("https://do/init", {
      body: JSON.stringify({ ...initRequest(), sessionExpiresAtMs: expiresAt }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }));

    expect(response.status).toBe(200);
    expect(storage.alarm).toBe(expiresAt);
    now = expiresAt;
    await do_.alarm();
    expect(closed as unknown).toEqual([4001, "Karaoke session expired"]);
    expect(storage.alarm).toBeNull();
    expect(storage.sql.snapshot().get("karaoke_session_snapshots")).toEqual([]);
    expect(storage.sql.snapshot().get("karaoke_session_outbox")).toEqual([]);
  });

  test("commit acknowledgement finalizes a line and persists a delivered line_score outbox row", async () => {
    const sent: KaraokeServerEvent[] = [];
    const broadcast = async (event: KaraokeServerEvent) => {
      sent.push(event);
    };
    const { ctx } = makeContext();
    const outbox = new InMemoryOutboxStore();
    const adapter = new FakeKaraokeStreamingSttAdapter();
    const do_ = new KaraokeSessionRuntimeDO(ctx, ENV_STUB, { broadcast, outboxStore: outbox, sttAdapter: adapter });

    expect((await do_.fetch(initDoRequest())).status).toBe(200);
    await startAndScore(do_, adapter);

    const lineScoreRows = [...outbox.snapshot().values()].filter((row) => row.eventId.endsWith(":line_score:line-1"));
    expect(lineScoreRows).toHaveLength(1);
    expect(lineScoreRows[0]?.event.type).toBe("line_score");
    expect(lineScoreRows[0]?.deliveredAt).not.toBeNull();
    const sentLineScores = sent.filter((event) => event.type === "line_score");
    expect(sentLineScores).toHaveLength(1);
    expect(sentLineScores[0]?.type === "line_score" && sentLineScores[0].result.lineId).toBe("line-1");
  });

  test("finish finalizes remaining lines and emits a summary", async () => {
    const sent: KaraokeServerEvent[] = [];
    const broadcast = async (event: KaraokeServerEvent) => {
      sent.push(event);
    };
    const { ctx } = makeContext();
    const adapter = new FakeKaraokeStreamingSttAdapter();
    const do_ = new KaraokeSessionRuntimeDO(ctx, ENV_STUB, { broadcast, outboxStore: new InMemoryOutboxStore(), sttAdapter: adapter });
    expect((await do_.fetch(initDoRequest())).status).toBe(200);
    await startAndScore(do_, adapter); // commits + acks line-1

    // No new audio since the ack → the terminal commit is refused → the reducer's
    // terminal sweep finalizes and summarizes immediately (no extra ack needed).
    await do_.fetch(clientEventRequest(4, "finish", { audioTimeMs: 1300 }));
    await do_.drainCommitChainForTests();

    const summaryEvent = sent.find((event) => event.type === "summary");
    expect(summaryEvent).toBeDefined();
    expect(summaryEvent?.type === "summary" && summaryEvent.summary.lineCount).toBe(1);
  });

  test("persists snapshot after meaningful transitions", async () => {
    resetEnvelopeSequence();
    const sent: KaraokeServerEvent[] = [];
    const broadcast = async (event: KaraokeServerEvent) => {
      sent.push(event);
    };
    const { ctx, storage } = makeContext();
    const do_ = new KaraokeSessionRuntimeDO(ctx, ENV_STUB, { broadcast, outboxStore: new InMemoryOutboxStore() });
    await do_.fetch(new Request("https://do/init", {
      body: JSON.stringify(initRequest()),
      headers: { "content-type": "application/json" },
      method: "POST",
    }));

    const snapshotRows = storage.sql.snapshot().get("karaoke_session_snapshots") ?? [];
    expect(snapshotRows).toHaveLength(1);
  });

  test("rejects re-initialization", async () => {
    resetEnvelopeSequence();
    const sent: KaraokeServerEvent[] = [];
    const broadcast = async (event: KaraokeServerEvent) => {
      sent.push(event);
    };
    const { ctx } = makeContext();
    const do_ = new KaraokeSessionRuntimeDO(ctx, ENV_STUB, { broadcast, outboxStore: new InMemoryOutboxStore() });
    await do_.fetch(new Request("https://do/init", {
      body: JSON.stringify(initRequest()),
      headers: { "content-type": "application/json" },
      method: "POST",
    }));
    const second = await do_.fetch(new Request("https://do/init", {
      body: JSON.stringify(initRequest()),
      headers: { "content-type": "application/json" },
      method: "POST",
    }));
    expect(second.status).toBe(409);
  });

  test("does not start STT until the client starts the session", async () => {
    const sent: KaraokeServerEvent[] = [];
    const broadcast = async (event: KaraokeServerEvent) => {
      sent.push(event);
    };
    const { ctx } = makeContext();
    const do_ = new KaraokeSessionRuntimeDO(ctx, ENV_STUB, { broadcast, outboxStore: new InMemoryOutboxStore() });
    const init = await do_.fetch(new Request("https://do/init", {
      body: JSON.stringify(initRequest()),
      headers: { "content-type": "application/json" },
      method: "POST",
    }));
    expect(init.status).toBe(200);
    const sttBeforeStart = await do_.fetch(new Request("https://do/internal/stt", {
      body: JSON.stringify(envelope("stt_partial", {
        deliveredAtAudioMs: 100,
        text: "",
        words: [],
      })),
      headers: { "content-type": "application/json" },
      method: "POST",
    }));
    expect(sttBeforeStart.status).toBe(409);
  });

  test("evicting after commit_sent persists orphan invalidation (provider_failed) before processing on restore", async () => {
    const { ctx, storage } = makeContext();
    const doA = new KaraokeSessionRuntimeDO(ctx, ENV_STUB, { broadcast: async () => {}, outboxStore: new InMemoryOutboxStore() });
    expect((await doA.fetch(initDoRequest())).status).toBe(200);
    await startAndCommitNoAck(doA); // commit in flight, never acked, then "evicted"

    // The persisted snapshot reflects the in-flight commit and no scores yet.
    const beforeRestore = storedSnapshot(storage);
    expect(beforeRestore.state.pendingCommit).not.toBeNull();
    expect(beforeRestore.state.finalizedLineScores).toHaveLength(0);

    // Fresh instance on the same storage = eviction; its new stream generation can
    // never acknowledge the persisted commit. The first op triggers restore, which
    // invalidates the orphaned commit (provider_failed) and persists that BEFORE
    // processing the op itself.
    const doB = new KaraokeSessionRuntimeDO(ctx, ENV_STUB, { broadcast: async () => {}, outboxStore: new InMemoryOutboxStore() });
    await doB.fetch(clientEventRequest(4, "playback_sync", { audioTimeMs: 1100, playing: true }));
    await doB.drainCommitChainForTests();

    const line1 = doB.snapshotForTests()?.finalizedLineScores.find((s) => s.lineId === "line-1");
    expect(line1?.finalizedReason).toBe("provider_failed");
    expect(line1?.uncertain).toBe(true);

    const afterRestore = storedSnapshot(storage);
    expect(afterRestore.state.pendingCommit).toBeNull();
    expect(afterRestore.state.finalizedLineScores.some((s) => s.lineId === "line-1" && s.finalizedReason === "provider_failed")).toBe(true);
  });

  test("a stale acknowledgement from the evicted stream is ignored after rehydration", async () => {
    const { ctx } = makeContext();
    const adapterA = new FakeKaraokeStreamingSttAdapter();
    const doA = new KaraokeSessionRuntimeDO(ctx, ENV_STUB, { broadcast: async () => {}, outboxStore: new InMemoryOutboxStore(), sttAdapter: adapterA });
    expect((await doA.fetch(initDoRequest())).status).toBe(200);
    await startAndCommitNoAck(doA);
    const staleGeneration = adapterA.streamGeneration as string;

    // Rehydrate on a fresh stream (orphan invalidated → provider_failed, no pending).
    const adapterB = new FakeKaraokeStreamingSttAdapter();
    const doB = new KaraokeSessionRuntimeDO(ctx, ENV_STUB, { broadcast: async () => {}, outboxStore: new InMemoryOutboxStore(), sttAdapter: adapterB });
    await doB.fetch(clientEventRequest(4, "playback_sync", { audioTimeMs: 1100, playing: true }));
    await doB.drainCommitChainForTests();
    const watermarkBefore = doB.snapshotForTests()?.sttWatermarkMs ?? -1;
    const wordsBefore = doB.snapshotForTests()?.recognizedWords.length ?? -1;

    // A late committed final tagged with the OLD (evicted) stream generation must
    // be dropped entirely — no watermark advance, no word merge.
    await adapterB.ackCommit([{ confidence: 0.9, endMs: 900, final: true, startMs: 500, text: "ghost" }], {
      commitId: "stale-commit",
      coverageMs: 5000,
      streamGeneration: staleGeneration,
    });
    await doB.drainCommitChainForTests();

    expect(doB.snapshotForTests()?.sttWatermarkMs).toBe(watermarkBefore);
    expect(doB.snapshotForTests()?.recognizedWords.length).toBe(wordsBefore);
  });

  test("uses the production SQLite outbox and broadcasts to attempt-tagged sockets", async () => {
    const received: KaraokeServerEvent[] = [];
    const { addSocket, ctx, storage } = makeContext();
    addSocket("attempt:attempt-1", {
      send(payload) {
        received.push(JSON.parse(payload) as KaraokeServerEvent);
      },
    });
    // No broadcast/outboxStore overrides → exercises the real attempt-tagged
    // socket broadcast + the production SqliteOutboxStore.
    const adapter = new FakeKaraokeStreamingSttAdapter();
    const do_ = new KaraokeSessionRuntimeDO(ctx, ENV_STUB, { sttAdapter: adapter });

    expect((await do_.fetch(initDoRequest())).status).toBe(200);
    await startAndScore(do_, adapter);

    // The committed final is relayed, then the covered line is scored — both
    // delivered to the attempt-tagged socket in order.
    expect(received.map((event) => event.type)).toEqual(["stt_final", "line_score"]);
    const rows = storage.sql.snapshot().get("karaoke_session_outbox") ?? [];
    expect(rows).toHaveLength(1); // only the line_score is persisted (stt relay is fire-and-forget)
    expect(rows[0]?.delivered_at).not.toBeNull();
  });

  test("restores JSON, binary, STT, and server-output sequence counters after eviction", async () => {
    const sent: KaraokeServerEvent[] = [];
    const broadcast = async (event: KaraokeServerEvent) => {
      sent.push(event);
    };
    const { ctx, storage } = makeContext();
    const outbox = new InMemoryOutboxStore();
    const adapter = new FakeKaraokeStreamingSttAdapter();
    const doA = new KaraokeSessionRuntimeDO(ctx, ENV_STUB, { broadcast, outboxStore: outbox, sttAdapter: adapter });
    expect((await doA.fetch(initDoRequest())).status).toBe(200);
    // Advances client (start=1, audio=2, playback=3), STT (ack=1), and server
    // output (stt_final relay=0, line_score=1 → next 2) counters, then persists.
    await startAndScore(doA, adapter);

    // All four counters were persisted by doA (client incl. binary share one
    // inbound counter; STT and server-output are separate).
    const persisted = storedSnapshot(storage);
    expect(persisted.lastClientSequence).toBe(3); // start=1, audio frame=2, playback=3
    expect(persisted.lastSttSequence).toBe(1); // the single committed ack
    expect(persisted.serverSequence).toBe(2); // stt_final relay=0, line_score=1 → next 2

    const doB = new KaraokeSessionRuntimeDO(ctx, ENV_STUB, { broadcast, outboxStore: outbox, sttAdapter: new FakeKaraokeStreamingSttAdapter() });

    // JSON client counter restored: replaying client seq 3 is non-monotonic. The
    // resulting session_error's sequence is 2, proving the SERVER-output counter
    // resumed from the persisted 2 rather than resetting to 0.
    const jsonReplay = await doB.fetch(clientEventRequest(3, "pause", { audioTimeMs: 100 }));
    expect(jsonReplay.status).toBe(400);
    expect(sent.at(-1)?.type).toBe("session_error");
    expect((sent.at(-1) as { code?: string } | undefined)?.code).toBe("non_monotonic_sequence");
    expect(sent.at(-1)?.sequence).toBe(2);

    // Binary client counter restored: replaying audio frame seq 2 is non-monotonic,
    // and the server counter keeps advancing (3).
    await doB.webSocketMessage(DUMMY_SOCKET, audioFrameBytes(2, 1300));
    expect((sent.at(-1) as { code?: string } | undefined)?.code).toBe("non_monotonic_sequence");
    expect(sent.at(-1)?.sequence).toBe(3);
  });

  test("resumes STT scoring after a fresh DO restores the session", async () => {
    const sent: KaraokeServerEvent[] = [];
    const broadcast = async (event: KaraokeServerEvent) => {
      sent.push(event);
    };
    const { ctx, storage } = makeContext();
    const outbox = new InMemoryOutboxStore();
    const adapterA = new FakeKaraokeStreamingSttAdapter();
    const doA = new KaraokeSessionRuntimeDO(ctx, ENV_STUB, {
      broadcast,
      outboxStore: outbox,
      sttAdapter: adapterA,
    });
    expect((await doA.fetch(initDoRequest())).status).toBe(200);
    await startAndScore(doA, adapterA);
    expect(storedSnapshot(storage).lastSttSequence).toBe(1);

    // A fresh DO instance (eviction / runtime restart) with a BRAND-NEW adapter,
    // whose sequence counter therefore starts from whatever the host seeds it with.
    const adapterB = new FakeKaraokeStreamingSttAdapter();
    const doB = new KaraokeSessionRuntimeDO(ctx, ENV_STUB, {
      broadcast,
      outboxStore: outbox,
      sttAdapter: adapterB,
    });

    // Drive real post-restore scoring: audio → playback → committed final.
    // Client sequences continue past the restored lastClientSequence of 3.
    await doB.webSocketMessage(DUMMY_SOCKET, audioFrameBytes(4, 2400));
    await doB.fetch(clientEventRequest(5, "playback_sync", { audioTimeMs: 2400, playing: true }));
    await doB.drainCommitChainForTests();
    await adapterB.ackCommit(HOLD_ON_WORDS);
    await doB.drainCommitChainForTests();

    // The restored stream resumed at 2 (persisted high-water mark was 1), so the
    // final was accepted rather than refused. Before the initialSequence contract
    // the fresh adapter emitted 1, which the host rejected without advancing —
    // silently killing transcript and scoring for the rest of the attempt.
    const codes = sent.map((event) => (event as { code?: string }).code);
    expect(codes).not.toContain("non_monotonic_sequence");
    expect(sent.some((event) => event.type === "stt_final")).toBe(true);
    expect(storedSnapshot(storage).lastSttSequence).toBe(2);
  });

  test("persists snapshot and pending output before a failed broadcast, then replays it", async () => {
    const { ctx, storage } = makeContext();
    const adapter = new FakeKaraokeStreamingSttAdapter();
    const failing = new KaraokeSessionRuntimeDO(ctx, ENV_STUB, {
      broadcast: async (event) => {
        if (event.type === "line_score") throw new Error("socket failed");
      },
      sttAdapter: adapter,
    });
    expect((await failing.fetch(initDoRequest())).status).toBe(200);
    // The line_score broadcast throws; the host's serialized chain swallows it,
    // but the snapshot + the pending outbox row were persisted BEFORE the broadcast.
    await startAndScore(failing, adapter);

    const stored = storedSnapshot(storage);
    expect(stored.state.finalizedLineScores).toHaveLength(1); // score persisted
    const pendingRows = storage.sql.snapshot().get("karaoke_session_outbox") ?? [];
    expect(pendingRows).toHaveLength(1);
    expect(pendingRows[0]?.delivered_at).toBeNull(); // broadcast failed → not delivered

    // A recovered instance replays the undelivered row, then marks it delivered.
    const replayed: KaraokeServerEvent[] = [];
    const recovered = new KaraokeSessionRuntimeDO(ctx, ENV_STUB, {
      broadcast: async (event) => {
        replayed.push(event);
      },
    });
    expect((await recovered.fetch(clientEventRequest(4, "pause", { audioTimeMs: 1100 }))).status).toBe(200);
    expect(replayed.map((event) => event.type)).toEqual(["line_score"]);
    expect(replayed[0]?.eventId).toBe("session-1:attempt-1:line_score:line-1");
    const afterReplay = storage.sql.snapshot().get("karaoke_session_outbox") ?? [];
    expect(afterReplay[0]?.delivered_at).not.toBeNull(); // replay marked delivered
  });

  test("rejects malformed event payloads before they reach the host", async () => {
    resetEnvelopeSequence();
    const { ctx } = makeContext();
    const do_ = new KaraokeSessionRuntimeDO(ctx, ENV_STUB, {});
    await do_.fetch(new Request("https://do/init", {
      body: JSON.stringify(initRequest()),
      headers: { "content-type": "application/json" },
      method: "POST",
    }));
    const response = await do_.fetch(new Request("https://do/internal/client-event", {
      body: JSON.stringify({
        attemptId: "attempt-1",
        protocolVersion: KARAOKE_TRANSPORT_PROTOCOL_VERSION,
        sequence: 0,
        sessionId: "session-1",
        type: "line_boundary",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }));

    expect(response.status).toBe(400);
    expect(do_.snapshotForTests()?.assignmentLocks.size).toBe(0);
  });

  test("decodes WebSocket PCM frames and forwards them to the STT adapter", async () => {
    resetEnvelopeSequence();
    const sttAdapter = new FakeKaraokeStreamingSttAdapter();
    const { ctx } = makeContext();
    const do_ = new KaraokeSessionRuntimeDO(ctx, ENV_STUB, {
      broadcast: async () => {},
      outboxStore: new InMemoryOutboxStore(),
      sttAdapter,
    });
    await do_.fetch(new Request("https://do/init", {
      body: JSON.stringify(initRequest()),
      headers: { "content-type": "application/json" },
      method: "POST",
    }));
    expect((await startSession(do_)).status).toBe(200);

    const frame: KaraokeClientBinaryFrame = {
      attemptId: "attempt-1",
      chunkId: 1,
      pcm16: new Uint8Array([1, 2, 3, 4]).buffer,
      protocolVersion: KARAOKE_TRANSPORT_PROTOCOL_VERSION,
      sampleRate: 16_000,
      sequence: 2,
      sessionId: "session-1",
      songEndMs: 200,
      songStartMs: 100,
      type: "audio_chunk",
    };
    await do_.webSocketMessage({ send() {} } as unknown as WebSocket, encodeKaraokeBinaryFrame(frame));

    expect(sttAdapter.frames).toHaveLength(1);
    expect(sttAdapter.frames[0]).toMatchObject({
      chunkId: 1,
      sequence: 2,
      songEndMs: 200,
      songStartMs: 100,
    });
    expect([...new Uint8Array(sttAdapter.frames[0]!.pcm16)]).toEqual([1, 2, 3, 4]);
  });

  test("reports malformed and non-recording binary frames without forwarding audio", async () => {
    resetEnvelopeSequence();
    const sent: KaraokeServerEvent[] = [];
    const sttAdapter = new FakeKaraokeStreamingSttAdapter();
    const { ctx } = makeContext();
    const do_ = new KaraokeSessionRuntimeDO(ctx, ENV_STUB, {
      broadcast: async (event) => { sent.push(event); },
      outboxStore: new InMemoryOutboxStore(),
      sttAdapter,
    });
    await do_.fetch(new Request("https://do/init", {
      body: JSON.stringify(initRequest()),
      headers: { "content-type": "application/json" },
      method: "POST",
    }));

    await do_.webSocketMessage({ send() {} } as unknown as WebSocket, new ArrayBuffer(8));
    const beforeStart = encodeKaraokeBinaryFrame({
      attemptId: "attempt-1",
      chunkId: 1,
      pcm16: new ArrayBuffer(2),
      protocolVersion: 1,
      sampleRate: 16_000,
      sequence: 1,
      sessionId: "session-1",
      songEndMs: 100,
      songStartMs: 0,
      type: "audio_chunk",
    });
    await do_.webSocketMessage({ send() {} } as unknown as WebSocket, beforeStart);

    expect((await startSession(do_)).status).toBe(200);
    const finishResponse = await do_.fetch(new Request("https://do/internal/client-event", {
      body: JSON.stringify(envelope("finish", { audioTimeMs: 200 })),
      headers: { "content-type": "application/json" },
      method: "POST",
    }));
    expect(finishResponse.status).toBe(200);
    await do_.webSocketMessage({ send() {} } as unknown as WebSocket, encodeKaraokeBinaryFrame({
      attemptId: "attempt-1",
      chunkId: 2,
      pcm16: new ArrayBuffer(2),
      protocolVersion: 1,
      sampleRate: 16_000,
      sequence: 3,
      sessionId: "session-1",
      songEndMs: 200,
      songStartMs: 100,
      type: "audio_chunk",
    }));

    expect(sttAdapter.frames).toHaveLength(0);
    expect(sent.filter((event) => event.type === "session_error").map((event) => event.code)).toEqual([
      "binary_truncated",
      "session_not_recording",
      "session_not_recording",
    ]);
  });

  test("shares sequence ordering between JSON and binary WebSocket messages", async () => {
    resetEnvelopeSequence();
    const sent: KaraokeServerEvent[] = [];
    const sttAdapter = new FakeKaraokeStreamingSttAdapter();
    const { ctx } = makeContext();
    const do_ = new KaraokeSessionRuntimeDO(ctx, ENV_STUB, {
      broadcast: async (event) => { sent.push(event); },
      outboxStore: new InMemoryOutboxStore(),
      sttAdapter,
    });
    await do_.fetch(new Request("https://do/init", {
      body: JSON.stringify(initRequest()),
      headers: { "content-type": "application/json" },
      method: "POST",
    }));
    expect((await startSession(do_)).status).toBe(200);

    await do_.webSocketMessage({ send() {} } as unknown as WebSocket, encodeKaraokeBinaryFrame({
      attemptId: "attempt-1",
      chunkId: 1,
      pcm16: new ArrayBuffer(2),
      protocolVersion: 1,
      sampleRate: 16_000,
      sequence: 1,
      sessionId: "session-1",
      songEndMs: 100,
      songStartMs: 0,
      type: "audio_chunk",
    }));

    expect(sttAdapter.frames).toHaveLength(0);
    expect(sent.at(-1)).toMatchObject({ code: "non_monotonic_sequence", type: "session_error" });
  });
});

describe("CloudflareKaraokeEffectRunner", () => {
  test("persists line_score outbox row before delivering and marks delivered after", async () => {
    const order: string[] = [];
    const outbox = new InMemoryOutboxStore();
    const sent: KaraokeServerEvent[] = [];
    const runner = new CloudflareKaraokeEffectRunner({
      broadcast: async (event) => {
        order.push("broadcast");
        sent.push(event);
      },
      outbox: {
        async loadPending() {
          return [];
        },
        async markPending(input) {
          order.push(`markPending:${input.rows.map((row) => row.eventId).join(",")}`);
          await outbox.markPending(input);
        },
        async markDelivered(input) {
          order.push(`markDelivered:${input.eventIds.join(",")}`);
          await outbox.markDelivered(input);
        },
      },
    });

    const state = {
      attemptId: "attempt-1",
      assignmentLocks: new Set<string>(),
      pendingCommit: null,
      sttWatermarkMs: 0,
      currentTimeMs: 0,
      finalizedLineScores: [
        {
          confidenceScore: 1,
          finalizedReason: "line_end" as const,
          lineId: "line-1",
          lineIndex: 0,
          recognizedWords: [],
          score: 1,
          scoredLineIndex: 0,
          uncertain: false,
          textScore: {
            confidenceMean: 1,
            keywordCoverage: 1,
            missedWords: [],
            phoneticAvailable: true,
            phoneticCoverage: 1,
            phoneticQuality: 1,
            score: 1,
            wer: 0,
          },
          timingScore: null,
          transcript: "hold on",
        },
      ],
      lines: [],
      recognizedWords: [],
      scoringPolicy: ENABLED_POLICY,
      sessionId: "session-1",
      status: "recording" as const,
      summary: null,
    };

    await runner.runKaraokeEffect(
      { score: state.finalizedLineScores[0]!, type: "emit_line_score" },
      state,
    );

    expect(order).toEqual([
      "markPending:session-1:attempt-1:line_score:line-1",
      "broadcast",
      "markDelivered:session-1:attempt-1:line_score:line-1",
    ]);
    expect(sent).toHaveLength(1);
    const delivered = outbox.snapshot().get("session-1:attempt-1:line_score:line-1");
    expect(delivered?.deliveredAt).not.toBeNull();
  });

  test("ignores audio-control effects and does not persist them", async () => {
    const outbox = new InMemoryOutboxStore();
    const sent: KaraokeServerEvent[] = [];
    const runner = new CloudflareKaraokeEffectRunner({
      broadcast: async (event) => {
        sent.push(event);
      },
      outbox: outbox,
    });

    const state = {
      attemptId: "attempt-1",
      assignmentLocks: new Set<string>(),
      pendingCommit: null,
      sttWatermarkMs: 0,
      currentTimeMs: 0,
      finalizedLineScores: [],
      lines: [],
      recognizedWords: [],
      scoringPolicy: ENABLED_POLICY,
      sessionId: "session-1",
      status: "recording" as const,
      summary: null,
    };

    await runner.runKaraokeEffect({ type: "pause_audio_stream" }, state);
    await runner.runKaraokeEffect({ type: "discard_audio", beforeAudioTimeMs: 1000 }, state);
    await runner.runKaraokeEffect({ type: "lock_line_assignment", lineId: "line-1" }, state);

    expect(sent).toHaveLength(0);
    expect(outbox.snapshot().size).toBe(0);
  });

  test("summary event uses deterministic idempotency key", async () => {
    const outbox = new InMemoryOutboxStore();
    const sent: KaraokeServerEvent[] = [];
    const runner = new CloudflareKaraokeEffectRunner({
      broadcast: async (event) => {
        sent.push(event);
      },
      outbox: outbox,
    });

    const state = {
      attemptId: "attempt-2",
      assignmentLocks: new Set<string>(),
      pendingCommit: null,
      sttWatermarkMs: 0,
      currentTimeMs: 0,
      finalizedLineScores: [],
      lines: [],
      recognizedWords: [],
      scoringPolicy: ENABLED_POLICY,
      sessionId: "session-2",
      status: "finalized" as const,
      summary: {
        confidenceMean: null,
        finalScore: 1,
        lineCount: 1,
        lowConfidenceLineCount: 0,
        lyricsScore: 1,
        missedWords: [],
        noRecognitionLineCount: 0,
        phoneticUnavailableLineCount: 0,
        scoredLineCount: 1,
        strongestLines: [],
        timingScore: null,
        timingTrend: "on_time" as const,
        uncertainLineCount: 0,
        weakestLines: [],
      },
    };

    await runner.runKaraokeEffect({ summary: state.summary, type: "emit_summary" }, state);
    const summaryRows = [...outbox.snapshot().values()].filter((row) => row.eventId.includes(":summary"));
    expect(summaryRows).toHaveLength(1);
    expect(summaryRows[0]?.eventId).toBe("session-2:attempt-2:summary");
  });

  test("retries the same event id when delivery marking fails after broadcast", async () => {
    const outbox = new InMemoryOutboxStore();
    const sent: KaraokeServerEvent[] = [];
    let failMarkDelivered = true;
    const runner = new CloudflareKaraokeEffectRunner({
      broadcast: async (event) => {
        sent.push(event);
      },
      outbox: {
        loadPending: (input) => outbox.loadPending(input),
        markPending: (input) => outbox.markPending(input),
        async markDelivered(input) {
          if (failMarkDelivered) throw new Error("delivery mark failed");
          await outbox.markDelivered(input);
        },
      },
    });
    const state = {
      attemptId: "attempt-1",
      assignmentLocks: new Set<string>(),
      pendingCommit: null,
      sttWatermarkMs: 0,
      currentTimeMs: 0,
      finalizedLineScores: [],
      lines: [],
      recognizedWords: [],
      scoringPolicy: ENABLED_POLICY,
      sessionId: "session-1",
      status: "finalized" as const,
      summary: {
        confidenceMean: null,
        finalScore: 0,
        lineCount: 0,
        lowConfidenceLineCount: 0,
        lyricsScore: 0,
        missedWords: [],
        noRecognitionLineCount: 0,
        phoneticUnavailableLineCount: 0,
        scoredLineCount: 0,
        strongestLines: [],
        timingScore: null,
        timingTrend: "on_time" as const,
        uncertainLineCount: 0,
        weakestLines: [],
      },
    };

    await expect(runner.runKaraokeEffect({ summary: state.summary, type: "emit_summary" }, state))
      .rejects.toThrow("delivery mark failed");
    failMarkDelivered = false;
    await runner.flushPending({ attemptId: state.attemptId, sessionId: state.sessionId });

    expect(sent).toHaveLength(2);
    expect(sent[0]?.eventId).toBe(sent[1]?.eventId);
  });
});

describe("FakeKaraokeStreamingSttAdapter", () => {
  test("emits events through the registered onMessage callback", async () => {
    const adapter = new FakeKaraokeStreamingSttAdapter();
    const received: string[] = [];
    await adapter.start({
      attemptId: "attempt-1",
      initialSequence: 0,
      onMessage: async (message) => {
        received.push(message.event.text);
      },
      sessionId: "session-1",
    });
    expect(adapter.streamGeneration).toBeTruthy();
    await adapter.emit({
      ...envelope("stt_partial", { text: "hold", words: [] }),
      deliveredAtAudioMs: 100,
    } as unknown as Parameters<FakeKaraokeStreamingSttAdapter["emit"]>[0]);
    expect(received).toEqual(["hold"]);
    expect(adapter.startCount).toBe(1);
    await adapter.close();
    expect(adapter.closeCount).toBe(1);
    expect(adapter.streamGeneration).toBeNull();
  });
});
