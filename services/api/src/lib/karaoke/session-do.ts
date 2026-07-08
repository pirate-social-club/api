import {
  createKaraokeSessionState,
  decodeKaraokeBinaryFrame,
  deserializeKaraokeSessionSnapshot,
  KaraokeSessionHost,
  parseKaraokeClientEvent,
  parseKaraokeStreamingSttEvent,
  serializeKaraokeSessionSnapshot,
  type KaraokeScoringPolicy,
  type KaraokeServerEvent,
  type KaraokeSessionState,
  type KaraokeStreamingSttAdapter,
  type ScorableKaraokeLine,
  type StoredKaraokeSessionSnapshot,
} from "@pirate-social-club/karaoke-runtime";

import type { Env } from "../../env";
import {
  CloudflareKaraokeEffectRunner,
  type OutboxRow,
  type OutboxStore,
} from "./cloudflare-effect-runner";
import { FakeKaraokeStreamingSttAdapter } from "./fake-stt-adapter";
import {
  KARAOKE_ATTEMPT_FINALIZE_INDEX_DDL,
  KARAOKE_ATTEMPT_FINALIZE_TABLE_DDL,
  KARAOKE_OUTBOX_INDEX_DDL,
  KARAOKE_OUTBOX_TABLE_DDL,
  KARAOKE_SNAPSHOT_TABLE_DDL,
} from "./snapshot-migrations";
import { KaraokeSttConfigurationError, resolveKaraokeSttAdapter } from "./stt-adapter-resolver";

const WS_ATTEMPT_TAG_PREFIX = "attempt:";
const TRUSTED_GATEWAY_HEADERS = [
  "x-karaoke-attempt-id",
  "x-karaoke-nonce",
  "x-karaoke-request-id",
  "x-karaoke-session-id",
  "x-karaoke-subject",
] as const;
const SESSION_EXPIRED_CLOSE_CODE = 4001;
const FINALIZE_RETRY_BASE_MS = 5_000;
const FINALIZE_RETRY_MAX_MS = 5 * 60_000;

export interface InitializeRequest {
  communityId: string;
  postId: string;
  sessionId: string;
  attemptId: string;
  subjectUserId: string;
  sessionExpiresAtMs: number;
  lines: ScorableKaraokeLine[];
  scoringPolicy: KaraokeScoringPolicy;
}

type SqlStorageValueLike = ArrayBuffer | string | number | null;

interface SqlStorageCursorLike<T> {
  toArray(): T[];
}

interface SqlStorageLike {
  exec<T extends Record<string, SqlStorageValueLike>>(
    sql: string,
    ...bindings: SqlStorageValueLike[]
  ): SqlStorageCursorLike<T>;
}

export interface DurableObjectStorage {
  sql: SqlStorageLike;
  transactionSync?<T>(callback: () => T): T;
  setAlarm?(scheduledTime: number | Date): Promise<void>;
  deleteAlarm?(): Promise<void>;
}

export interface DurableObjectContextLike {
  storage: DurableObjectStorage;
  acceptWebSocket?(server: WebSocket, tags?: string[]): void;
  getWebSockets?(tag?: string): WebSocket[];
  setHibernatableWebSocketEventTimeout?(durationMs: number): void;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}

export interface SqliteOutboxStoreOptions {
  storage: DurableObjectStorage;
  now?: () => number;
}

export class SqliteOutboxStore implements OutboxStore {
  private readonly storage: DurableObjectStorage;
  private readonly now: () => number;

  constructor(options: SqliteOutboxStoreOptions) {
    this.storage = options.storage;
    this.now = options.now ?? (() => Date.now());
  }

  async loadPending(input: { sessionId: string; attemptId: string }): Promise<{ event: KaraokeServerEvent; eventId: string }[]> {
    const rows = this.storage.sql.exec<{ event_id: string; event_json: string }>(
      "SELECT event_id, event_json FROM karaoke_session_outbox WHERE session_id = ? AND attempt_id = ? AND delivered_at IS NULL ORDER BY sequence ASC",
      input.sessionId,
      input.attemptId,
    ).toArray();
    return rows.map((row) => ({
      event: JSON.parse(row.event_json) as KaraokeServerEvent,
      eventId: row.event_id,
    }));
  }

  async markPending(input: { sessionId: string; attemptId: string; rows: { event: KaraokeServerEvent; eventId: string }[] }): Promise<void> {
    for (const row of input.rows) {
      this.storage.sql.exec(
        "INSERT OR IGNORE INTO karaoke_session_outbox (session_id, attempt_id, event_id, sequence, event_json, created_at, delivered_at) VALUES (?, ?, ?, ?, ?, ?, NULL)",
        input.sessionId,
        input.attemptId,
        row.eventId,
        row.event.sequence,
        JSON.stringify(row.event),
        this.now(),
      );
    }
  }

  async markDelivered(input: { sessionId: string; attemptId: string; eventIds: readonly string[] }): Promise<void> {
    if (input.eventIds.length === 0) return;
    for (const eventId of input.eventIds) {
      this.storage.sql.exec(
        "UPDATE karaoke_session_outbox SET delivered_at = ? WHERE session_id = ? AND attempt_id = ? AND event_id = ?",
        this.now(),
        input.sessionId,
        input.attemptId,
        eventId,
      );
    }
  }
}

interface PersistedRuntimeMeta {
  communityId: string;
  postId: string;
  sessionId: string;
  attemptId: string;
  subjectUserId: string;
  sessionStartedAtMs: number;
  sessionExpiresAtMs: number;
}

interface StoredRuntimeSnapshot extends StoredKaraokeSessionSnapshot {
  runtimeMetadata: PersistedRuntimeMeta;
}

interface KaraokeWebSocketAttachment {
  version: 1;
  sessionId: string;
  attemptId: string;
  subjectUserId: string;
  nonce: string;
  requestId: string;
  connectedAtMs: number;
}

export interface KaraokeSessionRuntimeDOOptions {
  sttAdapter?: KaraokeStreamingSttAdapter;
  outboxStore?: OutboxStore;
  broadcast?: (event: KaraokeServerEvent) => Promise<void>;
  now?: () => number;
}

export class KaraokeSessionRuntimeDO {
  private readonly ctx: DurableObjectContextLike;
  private readonly env: Env;
  private readonly options: KaraokeSessionRuntimeDOOptions;

  private host: KaraokeSessionHost | null = null;
  private effectRunner: CloudflareKaraokeEffectRunner | null = null;
  private sttAdapter: KaraokeStreamingSttAdapter | null = null;
  private meta: PersistedRuntimeMeta | null = null;
  private readonly schemaReady: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env);
  constructor(ctx: DurableObjectContextLike, env: Env, options: KaraokeSessionRuntimeDOOptions);
  constructor(ctx: DurableObjectContextLike, env: Env, options: KaraokeSessionRuntimeDOOptions = {}) {
    this.ctx = ctx;
    this.env = env;
    this.options = options;
    this.schemaReady = this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(KARAOKE_ATTEMPT_FINALIZE_TABLE_DDL);
      this.ctx.storage.sql.exec(KARAOKE_ATTEMPT_FINALIZE_INDEX_DDL);
      this.ctx.storage.sql.exec(KARAOKE_SNAPSHOT_TABLE_DDL);
      this.ctx.storage.sql.exec(KARAOKE_OUTBOX_TABLE_DDL);
      this.ctx.storage.sql.exec(KARAOKE_OUTBOX_INDEX_DDL);
    });
  }

  async fetch(request: Request): Promise<Response> {
    await this.schemaReady;
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/init") {
      return await this.handleInit(request);
    }
    if (request.method === "POST" && url.pathname === "/internal/stt") {
      if (!this.internalTestRoutesEnabled()) return this.notFound();
      return await this.handleInternalStt(request);
    }
    if (request.method === "POST" && url.pathname === "/internal/client-event") {
      if (!this.internalTestRoutesEnabled()) return this.notFound();
      return await this.handleInternalClientEvent(request);
    }
    if (request.method === "POST" && url.pathname === "/internal/stt-ack") {
      if (!this.internalTestRoutesEnabled()) return this.notFound();
      return await this.handleInternalSttAck(request);
    }
    if (request.method === "GET" && url.pathname === "/health") {
      if (!this.internalTestRoutesEnabled()) return this.notFound();
      return Response.json({ ok: true, initialized: this.host !== null });
    }
    if (request.method === "GET" && url.pathname === "/websocket") {
      return await this.handleWebSocketUpgrade(request);
    }

    return this.notFound();
  }

  async webSocketMessage(server: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.schemaReady;
    if (await this.rejectExpiredSocket(server)) return;
    if (typeof message !== "string") {
      await this.ensureHost();
      const decoded = decodeKaraokeBinaryFrame(message, {
        attemptId: this.meta!.attemptId,
        sessionId: this.meta!.sessionId,
      });
      if (decoded.error) {
        await this.effectRunner!.reportTransportError(decoded.error, this.host!.snapshot().state);
        return;
      }
      await this.host!.handleAudioFrame(decoded.frame);
      await this.persistSnapshotIfNeeded();
      return;
    }
    await this.ensureHost();
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      await this.sendSessionError(server, "WebSocket message is not valid JSON");
      return;
    }
    const clientEvent = parseKaraokeClientEvent(parsed);
    if (!clientEvent) {
      await this.sendSessionError(server, "WebSocket message is not a KaraokeClientEvent");
      return;
    }
    await this.host!.handleClientEvent(clientEvent);
    await this.persistSnapshotIfNeeded();
  }

  async webSocketClose(server: WebSocket): Promise<void> {
    try {
      server.close();
    } catch {
      // best-effort
    }
  }

  async webSocketError(server: WebSocket): Promise<void> {
    try {
      server.close();
    } catch {
      // best-effort
    }
  }

  async alarm(): Promise<void> {
    await this.schemaReady;
    await this.deliverPendingFinalizations();
    if (this.hasPendingFinalizations()) {
      this.scheduleNextFinalizationAlarm();
      return;
    }
    if (this.meta && !this.isExpired()) {
      const expiresAt = this.meta?.sessionExpiresAtMs;
      if (typeof expiresAt === "number" && Number.isFinite(expiresAt)) {
        await this.ctx.storage.setAlarm?.(expiresAt);
      }
      return;
    }
    // V1 stores exactly one attempt per DO. Multi-attempt sessions must schedule
    // the nearest attempt expiry instead of deleting the whole object here.
    for (const socket of this.ctx.getWebSockets?.() ?? []) {
      try {
        socket.close(SESSION_EXPIRED_CLOSE_CODE, "Karaoke session expired");
      } catch {
        // best-effort
      }
    }
    await this.sttAdapter?.close().catch(() => undefined);
    this.ctx.storage.sql.exec("DELETE FROM karaoke_session_outbox");
    this.ctx.storage.sql.exec("DELETE FROM karaoke_session_snapshots");
    await this.ctx.storage.deleteAlarm?.();
    this.host = null;
    this.effectRunner = null;
    this.sttAdapter = null;
    this.meta = null;
  }

  snapshotForTests(): KaraokeSessionState | null {
    return this.host?.snapshot().state ?? null;
  }

  private async handleInit(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => null)) as InitializeRequest | null;
    if (
      !body
      || !body.communityId
      || !body.postId
      || !body.sessionId
      || !body.attemptId
      || !body.subjectUserId
      || !Number.isSafeInteger(body.sessionExpiresAtMs)
      || body.sessionExpiresAtMs <= this.now()
      || !Array.isArray(body.lines)
      || !body.scoringPolicy
    ) {
      return Response.json({ error: "invalid_init_request" }, { status: 400 });
    }

    const existingSnapshot = this.loadStoredSnapshot();
    if (existingSnapshot) {
      return Response.json({ error: "session_already_initialized" }, { status: 409 });
    }

    const state = createKaraokeSessionState({
      attemptId: body.attemptId,
      lines: body.lines,
      scoringPolicy: body.scoringPolicy,
      sessionId: body.sessionId,
    });

    // Resolve the STT adapter before persisting anything so a production
    // misconfiguration rejects session creation instead of starting a session
    // that silently never recognizes speech.
    let sttAdapter: KaraokeStreamingSttAdapter;
    try {
      sttAdapter = await this.resolveSttAdapter(state, body.communityId);
    } catch (error) {
      if (error instanceof KaraokeSttConfigurationError) {
        return Response.json({ error: error.code }, { status: 503 });
      }
      throw error;
    }

    this.meta = {
      attemptId: body.attemptId,
      communityId: body.communityId,
      postId: body.postId,
      sessionStartedAtMs: this.now(),
      sessionExpiresAtMs: body.sessionExpiresAtMs,
      sessionId: body.sessionId,
      subjectUserId: body.subjectUserId,
    };
    await this.persistSnapshot(state);
    await this.ctx.storage.setAlarm?.(body.sessionExpiresAtMs);
    await this.initializeHost(state, sttAdapter);

    return Response.json({ ok: true, status: "initialized" });
  }

  private async handleInternalStt(request: Request): Promise<Response> {
    await this.ensureHost();
    const body: unknown = await request.json().catch(() => null);
    const sttEvent = parseKaraokeStreamingSttEvent(body);
    if (!sttEvent) {
      return Response.json({ error: "invalid_stt_event" }, { status: 400 });
    }
    if (sttEvent.sessionId !== this.meta?.sessionId || sttEvent.attemptId !== this.meta?.attemptId) {
      return Response.json({ error: "session_identity_mismatch" }, { status: 400 });
    }
    // The /internal/stt route only drives the in-memory fake adapter (test/dev).
    const adapter = this.sttAdapter;
    if (!(adapter instanceof FakeKaraokeStreamingSttAdapter)) {
      return Response.json({ error: "stt_internal_route_requires_fake_adapter" }, { status: 409 });
    }
    if (!adapter.started) {
      return Response.json({ error: "stt_adapter_not_started" }, { status: 409 });
    }
    await adapter.emit(sttEvent);
    await this.persistSnapshotIfNeeded();
    return Response.json({ ok: true });
  }

  private async handleInternalClientEvent(request: Request): Promise<Response> {
    await this.ensureHost();
    const body: unknown = await request.json().catch(() => null);
    const clientEvent = parseKaraokeClientEvent(body);
    if (!clientEvent) {
      return Response.json({ error: "invalid_client_event" }, { status: 400 });
    }
    if (clientEvent.sessionId !== this.meta?.sessionId || clientEvent.attemptId !== this.meta?.attemptId) {
      return Response.json({ error: "session_identity_mismatch" }, { status: 400 });
    }
    const error = await this.host!.handleClientEvent(clientEvent);
    if (error) {
      return Response.json({ error: error.code, message: error.message }, { status: 400 });
    }
    await this.persistSnapshotIfNeeded();
    return Response.json({ ok: true });
  }

  // Test-only: simulate the provider acknowledging the in-flight commit with a
  // committed final. Binary audio + commit scheduling still flow the real path;
  // only the provider's response is injected (the provider itself is faked).
  private async handleInternalSttAck(request: Request): Promise<Response> {
    await this.ensureHost();
    const adapter = this.sttAdapter;
    if (!(adapter instanceof FakeKaraokeStreamingSttAdapter)) {
      return Response.json({ error: "stt_ack_requires_fake_adapter" }, { status: 409 });
    }
    const body = (await request.json().catch(() => null)) as { words?: unknown } | null;
    const words = Array.isArray(body?.words) ? (body?.words as Parameters<typeof adapter.ackCommit>[0]) : [];
    // Let a pending commit scheduled by a prior playback tick be issued first.
    await this.host?.drainCommitChain();
    await adapter.ackCommit(words);
    await this.host?.drainCommitChain();
    return Response.json({ ok: true });
  }

  private async handleWebSocketUpgrade(request: Request): Promise<Response> {
    if (!this.ctx.acceptWebSocket) {
      return Response.json({ error: "websockets_not_supported" }, { status: 501 });
    }
    await this.ensureHost();
    const requestId = request.headers.get("x-karaoke-request-id")?.trim() ?? "";
    if (this.isExpired()) {
      return Response.json({ error: "karaoke_session_expired" }, {
        headers: requestId ? { "x-request-id": requestId } : undefined,
        status: 410,
      });
    }
    const trusted = this.readTrustedGatewayHeaders(request.headers);
    if (!trusted.ok) {
      return Response.json({ error: trusted.error }, {
        headers: requestId ? { "x-request-id": requestId } : undefined,
        status: 400,
      });
    }
    for (const socket of this.ctx.getWebSockets?.(this.attemptTag()) ?? []) {
      const attachment = this.readAttachment(socket);
      if (attachment?.nonce === trusted.attachment.nonce) {
        return Response.json({ error: "karaoke_gateway_token_replayed" }, {
          headers: { "x-request-id": trusted.attachment.requestId },
          status: 409,
        });
      }
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.serializeAttachment(trusted.attachment);
    this.ctx.acceptWebSocket(server, [this.attemptTag()]);
    return new Response(null, {
      headers: { "x-request-id": trusted.attachment.requestId },
      status: 101,
      webSocket: client,
    });
  }

  private async sendSessionError(server: WebSocket, message: string): Promise<void> {
    try {
      const envelope = {
        attemptId: this.meta?.attemptId ?? "",
        code: "session_aborted",
        eventId: `${this.meta?.sessionId ?? ""}:${this.meta?.attemptId ?? ""}:session_error:socket`,
        message,
        protocolVersion: 1,
        sequence: 0,
        sessionId: this.meta?.sessionId ?? "",
        type: "session_error",
      };
      server.send(JSON.stringify(envelope));
    } catch {
      // best-effort
    }
  }

  private async ensureHost(): Promise<void> {
    if (this.host) return;
    const stored = this.loadStoredSnapshot();
    if (!stored) {
      throw new Error("Karaoke session is not initialized");
    }
    const restored = deserializeKaraokeSessionSnapshot(stored);
    this.meta = stored.runtimeMetadata;
    // The session was already validated at creation; on restore, degrade to the
    // fake adapter rather than crash a live session if config has since broken.
    let sttAdapter: KaraokeStreamingSttAdapter;
    try {
      sttAdapter = await this.resolveSttAdapter(restored.state, stored.runtimeMetadata.communityId);
    } catch (error) {
      if (error instanceof KaraokeSttConfigurationError) {
        console.error("[karaoke-stt] STT config error on restore; degrading to fake", { code: error.code });
        sttAdapter = new FakeKaraokeStreamingSttAdapter();
      } else {
        throw error;
      }
    }
    await this.initializeHost(restored.state, sttAdapter, {
      lastClientSequence: restored.lastClientSequence,
      lastSttSequence: restored.lastSttSequence,
      serverSequence: restored.serverSequence,
    });
    await this.effectRunner!.flushPending({
      attemptId: restored.state.attemptId,
      sessionId: restored.state.sessionId,
    });
    // Restart STT if the restored session is mid-recording (F7).
    await this.host!.resumeSttIfRecording();
    // A pending commit persisted by the evicted stream can never be acknowledged
    // by this fresh stream — finalize it as provider_failed (infra loss). Persist
    // is handled inside the host.
    await this.host!.invalidateOrphanedPendingCommit(this.sttAdapter?.streamGeneration ?? null);
  }

  /** Test-only: await the host's serialized commit chain (commit/ack/timeout/finish). */
  async drainCommitChainForTests(): Promise<void> {
    await this.host?.drainCommitChain();
  }

  private async resolveSttAdapter(state: KaraokeSessionState, communityId: string): Promise<KaraokeStreamingSttAdapter> {
    return this.options.sttAdapter ?? resolveKaraokeSttAdapter({
      attemptId: state.attemptId,
      communityId,
      env: this.env,
      policy: state.scoringPolicy,
      sessionId: state.sessionId,
    });
  }

  private async initializeHost(
    state: KaraokeSessionState,
    sttAdapter: KaraokeStreamingSttAdapter,
    restore: {
      lastClientSequence?: number | null;
      lastSttSequence?: number | null;
      serverSequence?: number;
    } = {},
  ): Promise<void> {
    const outbox = this.options.outboxStore ?? new SqliteOutboxStore({ storage: this.ctx.storage });
    const broadcast = this.options.broadcast ?? ((event) => this.broadcastToAttempt(event));
    const effectRunner = new CloudflareKaraokeEffectRunner({
      broadcast,
      initialServerSequence: restore.serverSequence,
      outbox,
      persistBeforeBroadcast: async (input) => {
        await this.persistSnapshotAndPendingRows(input);
      },
    });
    this.sttAdapter = sttAdapter;
    this.effectRunner = effectRunner;
    this.host = new KaraokeSessionHost(state, effectRunner, sttAdapter, {
      // Persist after every commit-lifecycle transition driven on the host's
      // serialized chain (commit_sent/ack/timeout/finish), since those happen
      // outside a DO request and the DO would otherwise not persist them.
      persist: () => this.persistSnapshotIfNeeded(),
      restore: {
        lastClientSequence: restore.lastClientSequence,
        lastSttSequence: restore.lastSttSequence,
      },
    });
  }

  private async persistSnapshotIfNeeded(): Promise<void> {
    if (!this.host) return;
    const snapshot = this.host.snapshot();
    const stored = this.withRuntimeMetadata(serializeKaraokeSessionSnapshot({
      ...snapshot,
      serverSequence: this.effectRunner?.nextServerSequence() ?? 0,
    }));
    this.writeStoredSnapshot(stored);
  }

  private async persistSnapshot(state: KaraokeSessionState): Promise<void> {
    const snap = this.host?.snapshot() ?? {
      lastClientSequence: null,
      lastSttSequence: null,
      serverSequence: this.effectRunner?.nextServerSequence() ?? 0,
      state,
    };
    const stored = this.withRuntimeMetadata(serializeKaraokeSessionSnapshot(snap));
    this.writeStoredSnapshot(stored);
  }

  private loadStoredSnapshot(): StoredRuntimeSnapshot | null {
    const rows = this.ctx.storage.sql.exec<{
      last_client_sequence: number | null;
      last_stt_sequence: number | null;
      state_json: string;
    }>(
      "SELECT state_json, last_client_sequence, last_stt_sequence FROM karaoke_session_snapshots LIMIT 1",
    ).toArray();
    const row = rows[0];
    if (!row) return null;
    const parsed = JSON.parse(row.state_json) as StoredRuntimeSnapshot;
    if (!parsed.runtimeMetadata) return null;
    return parsed;
  }

  private writeStoredSnapshot(stored: StoredRuntimeSnapshot): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO karaoke_session_snapshots
        (session_id, attempt_id, state_json, last_client_sequence, last_stt_sequence, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, attempt_id) DO UPDATE SET
        state_json = excluded.state_json,
        last_client_sequence = excluded.last_client_sequence,
        last_stt_sequence = excluded.last_stt_sequence,
        updated_at = excluded.updated_at`,
      stored.state.sessionId,
      stored.state.attemptId,
      JSON.stringify(stored),
      stored.lastClientSequence,
      stored.lastSttSequence,
      this.options.now?.() ?? Date.now(),
    );
  }

  private async persistSnapshotAndPendingRows(input: {
    nextServerSequence: number;
    rows: OutboxRow[];
    state: KaraokeSessionState;
  }): Promise<void> {
    if (!this.host) return;
    const stored = this.withRuntimeMetadata(serializeKaraokeSessionSnapshot({
      ...this.host.snapshot(),
      serverSequence: input.nextServerSequence,
      state: input.state,
    }));
    const persist = () => {
      this.writeStoredSnapshot(stored);
      if (this.options.outboxStore) return;
      for (const row of input.rows) {
        this.ctx.storage.sql.exec(
          "INSERT OR IGNORE INTO karaoke_session_outbox (session_id, attempt_id, event_id, sequence, event_json, created_at, delivered_at) VALUES (?, ?, ?, ?, ?, ?, NULL)",
          input.state.sessionId,
          input.state.attemptId,
          row.eventId,
          row.event.sequence,
          JSON.stringify(row.event),
          this.options.now?.() ?? Date.now(),
        );
      }
    };
    if (!this.options.outboxStore && this.ctx.storage.transactionSync) {
      this.ctx.storage.transactionSync(persist);
    } else {
      persist();
    }
    if (this.options.outboxStore) {
      await this.options.outboxStore.markPending({
        attemptId: input.state.attemptId,
        rows: input.rows,
        sessionId: input.state.sessionId,
      });
    }
    await this.enqueueSummaryFinalization(input.state, input.rows);
  }

  private activityDateFromMeta(): string {
    const startedAt = this.meta?.sessionStartedAtMs;
    const ms = typeof startedAt === "number" && Number.isFinite(startedAt) ? startedAt : this.now();
    return new Date(ms).toISOString().slice(0, 10);
  }

  private async enqueueSummaryFinalization(state: KaraokeSessionState, rows: OutboxRow[]): Promise<void> {
    if (!this.meta || !state.summary) return;
    if (!rows.some((row) => row.event.type === "summary")) return;
    const now = this.now();
    const payload = {
      activity_date: this.activityDateFromMeta(),
      attempt_id: state.attemptId,
      completed_at: new Date(now).toISOString(),
      completion_reason: "completed",
      session_id: state.sessionId,
      summary: state.summary,
    };
    this.ctx.storage.sql.exec(
      `INSERT INTO karaoke_attempt_finalize_outbox (
        session_id, attempt_id, payload_json, attempts, next_attempt_at, delivered_at, created_at, updated_at
      ) VALUES (?, ?, ?, 0, ?, NULL, ?, ?)
      ON CONFLICT(session_id, attempt_id) DO UPDATE SET
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at`,
      state.sessionId,
      state.attemptId,
      JSON.stringify(payload),
      now,
      now,
      now,
    );
    await this.deliverPendingFinalizations();
    if (this.hasPendingFinalizations()) {
      this.scheduleNextFinalizationAlarm();
    }
  }

  private hasPendingFinalizations(): boolean {
    const rows = this.ctx.storage.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM karaoke_attempt_finalize_outbox WHERE delivered_at IS NULL",
    ).toArray();
    return Number(rows[0]?.count ?? 0) > 0;
  }

  private scheduleNextFinalizationAlarm(): void {
    const rows = this.ctx.storage.sql.exec<{ next_attempt_at: number }>(
      "SELECT next_attempt_at FROM karaoke_attempt_finalize_outbox WHERE delivered_at IS NULL ORDER BY next_attempt_at ASC LIMIT 1",
    ).toArray();
    const nextAttemptAt = Number(rows[0]?.next_attempt_at ?? 0);
    if (Number.isFinite(nextAttemptAt) && nextAttemptAt > 0) {
      void this.ctx.storage.setAlarm?.(Math.max(nextAttemptAt, this.now() + 1000));
    }
  }

  private finalizeEndpoint(sessionId: string): string | null {
    const origin = this.env.PIRATE_API_PUBLIC_ORIGIN?.trim().replace(/\/+$/u, "");
    if (!origin) return null;
    return `${origin}/karaoke/sessions/${encodeURIComponent(sessionId)}/finalize`;
  }

  private async deliverPendingFinalizations(): Promise<void> {
    const rows = this.ctx.storage.sql.exec<{
      session_id: string;
      attempt_id: string;
      payload_json: string;
      attempts: number;
    }>(
      "SELECT session_id, attempt_id, payload_json, attempts FROM karaoke_attempt_finalize_outbox WHERE delivered_at IS NULL AND next_attempt_at <= ? ORDER BY next_attempt_at ASC LIMIT 3",
      this.now(),
    ).toArray();
    const secret = this.env.KARAOKE_GATEWAY_SIGNING_KEY?.trim();
    if (!secret || secret.length < 32) return;
    for (const row of rows) {
      const endpoint = this.finalizeEndpoint(row.session_id);
      if (!endpoint) return;
      const now = this.now();
      try {
        const response = await fetch(endpoint, {
          body: row.payload_json,
          headers: {
            "content-type": "application/json",
            "x-karaoke-finalize-secret": secret,
            "x-request-id": crypto.randomUUID(),
          },
          method: "POST",
        });
        if (response.ok) {
          this.ctx.storage.sql.exec(
            "UPDATE karaoke_attempt_finalize_outbox SET delivered_at = ?, updated_at = ? WHERE session_id = ? AND attempt_id = ?",
            now,
            now,
            row.session_id,
            row.attempt_id,
          );
          continue;
        }
      } catch {
        // Retry below.
      }
      const attempts = Number(row.attempts ?? 0) + 1;
      const delay = Math.min(FINALIZE_RETRY_MAX_MS, FINALIZE_RETRY_BASE_MS * 2 ** Math.min(attempts, 6));
      this.ctx.storage.sql.exec(
        "UPDATE karaoke_attempt_finalize_outbox SET attempts = ?, next_attempt_at = ?, updated_at = ? WHERE session_id = ? AND attempt_id = ?",
        attempts,
        now + delay,
        now,
        row.session_id,
        row.attempt_id,
      );
    }
  }

  private attemptTag(): string {
    return `${WS_ATTEMPT_TAG_PREFIX}${this.meta?.attemptId ?? ""}`;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private internalTestRoutesEnabled(): boolean {
    return this.env.ENVIRONMENT === "development" || this.env.ENVIRONMENT === "test";
  }

  private notFound(): Response {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  private isExpired(): boolean {
    return Boolean(this.meta && this.meta.sessionExpiresAtMs <= this.now());
  }

  private async rejectExpiredSocket(server: WebSocket): Promise<boolean> {
    await this.ensureHost();
    if (!this.isExpired()) return false;
    try {
      server.close(SESSION_EXPIRED_CLOSE_CODE, "Karaoke session expired");
    } catch {
      // best-effort
    }
    return true;
  }

  private withRuntimeMetadata(snapshot: StoredKaraokeSessionSnapshot): StoredRuntimeSnapshot {
    if (!this.meta) throw new Error("Karaoke runtime metadata is not initialized");
    return { ...snapshot, runtimeMetadata: this.meta };
  }

  private readAttachment(socket: WebSocket): KaraokeWebSocketAttachment | null {
    try {
      const value: unknown = socket.deserializeAttachment();
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      const attachment = value as Record<string, unknown>;
      if (
        attachment.version !== 1
        || typeof attachment.sessionId !== "string"
        || typeof attachment.attemptId !== "string"
        || typeof attachment.subjectUserId !== "string"
        || typeof attachment.nonce !== "string"
        || typeof attachment.requestId !== "string"
        || typeof attachment.connectedAtMs !== "number"
      ) return null;
      return {
        attemptId: attachment.attemptId,
        connectedAtMs: attachment.connectedAtMs,
        nonce: attachment.nonce,
        requestId: attachment.requestId,
        sessionId: attachment.sessionId,
        subjectUserId: attachment.subjectUserId,
        version: 1,
      };
    } catch {
      return null;
    }
  }

  private readTrustedGatewayHeaders(headers: Headers):
    | { ok: true; attachment: KaraokeWebSocketAttachment }
    | { ok: false; error: string } {
    const allowed = new Set<string>(TRUSTED_GATEWAY_HEADERS);
    for (const [name] of headers) {
      if (name.startsWith("x-karaoke-") && !allowed.has(name)) {
        return { error: "unknown_karaoke_gateway_header", ok: false };
      }
    }
    const sessionId = headers.get("x-karaoke-session-id")?.trim() ?? "";
    const attemptId = headers.get("x-karaoke-attempt-id")?.trim() ?? "";
    const subjectUserId = headers.get("x-karaoke-subject")?.trim() ?? "";
    const nonce = headers.get("x-karaoke-nonce")?.trim() ?? "";
    const requestId = headers.get("x-karaoke-request-id")?.trim() ?? "";
    if (!sessionId || !attemptId || !subjectUserId || !nonce || !requestId) {
      return { error: "missing_karaoke_gateway_headers", ok: false };
    }
    if (!this.meta || sessionId !== this.meta.sessionId || attemptId !== this.meta.attemptId || subjectUserId !== this.meta.subjectUserId) {
      return { error: "karaoke_gateway_identity_mismatch", ok: false };
    }
    if (nonce.length > 256 || requestId.length > 256) {
      return { error: "invalid_karaoke_gateway_headers", ok: false };
    }
    return {
      attachment: {
        attemptId,
        connectedAtMs: this.now(),
        nonce,
        requestId,
        sessionId,
        subjectUserId,
        version: 1,
      },
      ok: true,
    };
  }

  private async broadcastToAttempt(event: KaraokeServerEvent): Promise<void> {
    const sockets = this.ctx.getWebSockets?.(this.attemptTag()) ?? [];
    const payload = JSON.stringify(event);
    for (const socket of sockets) {
      try {
        socket.send(payload);
      } catch {
        // Hibernated sockets can close between enumeration and send.
      }
    }
  }
}
