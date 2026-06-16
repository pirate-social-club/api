import {
  KARAOKE_TRANSPORT_PROTOCOL_VERSION,
  encodeKaraokeBinaryFrame,
  type KaraokeScoringPolicy,
  type ScorableKaraokeLine,
} from "@pirate/karaoke-runtime"
import { SELF, env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"

import type { KaraokeSessionRuntimeDO } from "../../src/lib/karaoke/session-do"
import { issueKaraokeGatewayToken } from "../../src/lib/karaoke/gateway-token"

// Phase 3 — real workerd integration coverage for the karaoke gateway route and
// the KaraokeSessionRuntimeDO Durable Object. Unlike the unit suite (which fakes
// the DO context), these tests run inside workerd via @cloudflare/vitest-pool-workers:
// the real Worker route forwards a real authenticated WebSocket upgrade to a real
// hibernatable Durable Object backed by real SQLite storage. Fake STT injection
// (the DO's default FakeKaraokeStreamingSttAdapter, driven through the test-only
// /internal/stt route) remains acceptable at this layer.

const PV = KARAOKE_TRANSPORT_PROTOCOL_VERSION
const ALLOWED_ORIGIN = "http://localhost:5173"

const ENABLED_POLICY: KaraokeScoringPolicy = {
  kind: "enabled",
  model: "test-model",
  provider: "elevenlabs",
  retention: "not_stored",
}

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
]

const STT_WORDS = [
  { confidence: 0.95, endMs: 400, final: true, startMs: 0, text: "hold" },
  { confidence: 0.95, endMs: 900, final: true, startMs: 500, text: "on" },
]

interface Fixture {
  attemptId: string
  communityId: string
  postId: string
  sessionId: string
  subject: string
}

let fixtureCounter = 0
function nextFixture(): Fixture {
  fixtureCounter += 1
  const n = fixtureCounter
  return {
    attemptId: `attempt-${n}`,
    communityId: `community-${n}`,
    postId: `post-${n}`,
    sessionId: `session-${n}`,
    subject: `user-${n}`,
  }
}

function stubFor(fx: Fixture) {
  const namespace = env.KARAOKE_SESSION_RUNTIME!
  return namespace.get(namespace.idFromName(fx.sessionId))
}

function initBody(fx: Fixture, sessionExpiresAtMs: number) {
  return {
    attemptId: fx.attemptId,
    lines: LINES,
    scoringPolicy: ENABLED_POLICY,
    sessionExpiresAtMs,
    sessionId: fx.sessionId,
    subjectUserId: fx.subject,
  }
}

async function initSession(fx: Fixture, sessionExpiresAtMs = Date.now() + 60 * 60 * 1000): Promise<void> {
  const response = await stubFor(fx).fetch("https://karaoke-runtime.internal/init", {
    body: JSON.stringify(initBody(fx, sessionExpiresAtMs)),
    headers: { "content-type": "application/json" },
    method: "POST",
  })
  expect(response.status).toBe(200)
}

async function mintToken(
  fx: Fixture,
  overrides: { expiresAt?: number; issuedAt?: number; sessionId?: string } = {},
): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000)
  const issuedAt = overrides.issuedAt ?? nowSeconds
  return await issueKaraokeGatewayToken({
    claims: {
      attemptId: fx.attemptId,
      communityId: fx.communityId,
      expiresAt: overrides.expiresAt ?? issuedAt + 60,
      issuedAt,
      nonce: `nonce-${fx.sessionId}`,
      postId: fx.postId,
      protocolVersion: PV,
      sessionId: overrides.sessionId ?? fx.sessionId,
      subject: fx.subject,
      tokenVersion: 1,
    },
    secret: env.KARAOKE_GATEWAY_SIGNING_KEY!,
  })
}

function gatewayUrl(sessionId: string, token: string): string {
  return `https://gateway.test/karaoke/sessions/${encodeURIComponent(sessionId)}/websocket?token=${encodeURIComponent(token)}`
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

interface ServerEvent {
  type: string
  sequence?: number
  [key: string]: unknown
}

// Buffers parsed server messages over a real WebSocket and lets a sequential
// test consume them in arrival order.
class TestSocket {
  readonly events: ServerEvent[] = []
  readonly closes: { code: number; reason: string }[] = []
  private cursor = 0
  private waiter: (() => void) | null = null
  private closeWaiter: (() => void) | null = null

  constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return
      this.events.push(JSON.parse(event.data) as ServerEvent)
      this.waiter?.()
    })
    socket.addEventListener("close", (event) => {
      this.closes.push({ code: event.code, reason: event.reason })
      this.closeWaiter?.()
    })
  }

  send(data: string | ArrayBuffer): void {
    this.socket.send(data)
  }

  async waitForType(type: string, timeoutMs = 2000): Promise<ServerEvent> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      while (this.cursor < this.events.length) {
        const event = this.events[this.cursor]!
        this.cursor += 1
        if (event.type === type) return event
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for "${type}"; saw [${this.events.map((e) => e.type).join(", ")}]`)
      }
      await this.race(deadline)
    }
  }

  async waitForClose(timeoutMs = 2000): Promise<{ code: number; reason: string }> {
    const deadline = Date.now() + timeoutMs
    while (this.closes.length === 0) {
      if (Date.now() >= deadline) throw new Error("Timed out waiting for socket close")
      await new Promise<void>((resolve) => {
        this.closeWaiter = resolve
        setTimeout(resolve, 25)
      })
      this.closeWaiter = null
    }
    return this.closes[0]!
  }

  private async race(deadline: number): Promise<void> {
    await new Promise<void>((resolve) => {
      this.waiter = resolve
      setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now())))
    })
    this.waiter = null
  }
}

async function openSocket(
  fx: Fixture,
  token: string,
  options: { origin?: string; urlSessionId?: string } = {},
): Promise<TestSocket> {
  const response = await SELF.fetch(gatewayUrl(options.urlSessionId ?? fx.sessionId, token), {
    headers: { Origin: options.origin ?? ALLOWED_ORIGIN, Upgrade: "websocket" },
  })
  expect(response.status).toBe(101)
  const socket = response.webSocket
  if (!socket) throw new Error("Expected a WebSocket on the 101 response")
  socket.accept()
  return new TestSocket(socket)
}

type DurableStub = ReturnType<typeof stubFor>

// Reaches into private DO state to observe/force conditions the public surface
// cannot express (adapter readiness, simulated eviction, crash-before-delivery).
interface DoInternals {
  host: unknown
  effectRunner: unknown
  meta: unknown
  sttAdapter: { started?: boolean } | null
}

async function waitForSttStarted(stub: DurableStub, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const started = await runInDurableObject(stub, (instance: KaraokeSessionRuntimeDO) =>
      Boolean((instance as unknown as DoInternals).sttAdapter?.started),
    )
    if (started) return
    if (Date.now() >= deadline) throw new Error("STT adapter never started")
    await delay(15)
  }
}

async function waitForPendingCommit(stub: DurableStub, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const pending = await runInDurableObject(stub, (instance: KaraokeSessionRuntimeDO) =>
      instance.snapshotForTests()?.pendingCommit ?? null,
    )
    if (pending) return
    if (Date.now() >= deadline) throw new Error("no commit was scheduled")
    await delay(15)
  }
}

// Simulates the provider acknowledging the in-flight commit (the committed
// final). Binary audio + commit scheduling still flow the real socket path.
async function ackSttFinal(fx: Fixture): Promise<void> {
  const response = await stubFor(fx).fetch("https://karaoke-runtime.internal/internal/stt-ack", {
    body: JSON.stringify({ words: STT_WORDS }),
    headers: { "content-type": "application/json" },
    method: "POST",
  })
  expect(response.status).toBe(200)
}

function startEvent(fx: Fixture, sequence: number) {
  return JSON.stringify({
    attemptId: fx.attemptId,
    postId: fx.postId,
    protocolVersion: PV,
    sequence,
    sessionId: fx.sessionId,
    startedAtAudioMs: 0,
    type: "start",
  })
}

function playbackSync(fx: Fixture, sequence: number, audioTimeMs: number) {
  return JSON.stringify({
    attemptId: fx.attemptId,
    audioTimeMs,
    playing: true,
    protocolVersion: PV,
    sequence,
    sessionId: fx.sessionId,
    type: "playback_sync",
  })
}

function finishEvent(fx: Fixture, sequence: number, audioTimeMs: number) {
  return JSON.stringify({
    attemptId: fx.attemptId,
    audioTimeMs,
    protocolVersion: PV,
    sequence,
    sessionId: fx.sessionId,
    type: "finish",
  })
}

function audioFrame(fx: Fixture, sequence: number, chunkId: number, songEndMs = 200): ArrayBuffer {
  return encodeKaraokeBinaryFrame({
    attemptId: fx.attemptId,
    chunkId,
    pcm16: new Uint8Array([1, 2, 3, 4]).buffer,
    protocolVersion: PV,
    sampleRate: 16_000,
    sequence,
    sessionId: fx.sessionId,
    songEndMs,
    songStartMs: 100,
    type: "audio_chunk",
  })
}

describe("karaoke gateway → DO authenticated upgrade", () => {
  it("rejects non-WebSocket requests with 426", async () => {
    const fx = nextFixture()
    const token = await mintToken(fx)
    const response = await SELF.fetch(gatewayUrl(fx.sessionId, token), {
      headers: { Origin: ALLOWED_ORIGIN },
    })
    expect(response.status).toBe(426)
    expect(await response.json()).toMatchObject({ code: "websocket_upgrade_required" })
  })

  it("rejects a disallowed origin with 403", async () => {
    const fx = nextFixture()
    const token = await mintToken(fx)
    const response = await SELF.fetch(gatewayUrl(fx.sessionId, token), {
      headers: { Origin: "https://evil.example", Upgrade: "websocket" },
    })
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: "karaoke_origin_not_allowed" })
  })

  it("rejects a missing token with 401", async () => {
    const fx = nextFixture()
    const response = await SELF.fetch(
      `https://gateway.test/karaoke/sessions/${fx.sessionId}/websocket`,
      { headers: { Origin: ALLOWED_ORIGIN, Upgrade: "websocket" } },
    )
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ code: "karaoke_gateway_invalid_token" })
  })

  it("rejects an expired token with 401 token_expired", async () => {
    const fx = nextFixture()
    const past = Math.floor(Date.now() / 1000) - 120
    const token = await mintToken(fx, { expiresAt: past + 60, issuedAt: past })
    const response = await SELF.fetch(gatewayUrl(fx.sessionId, token), {
      headers: { Origin: ALLOWED_ORIGIN, Upgrade: "websocket" },
    })
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ code: "karaoke_gateway_token_expired" })
  })

  it("rejects a token bound to another session with 403", async () => {
    const fx = nextFixture()
    const token = await mintToken(fx, { sessionId: "some-other-session" })
    const response = await SELF.fetch(gatewayUrl(fx.sessionId, token), {
      headers: { Origin: ALLOWED_ORIGIN, Upgrade: "websocket" },
    })
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: "karaoke_gateway_session_mismatch" })
  })

  it("accepts a valid capability and upgrades to a WebSocket", async () => {
    const fx = nextFixture()
    await initSession(fx)
    const token = await mintToken(fx)
    const socket = await openSocket(fx, token)
    expect(socket).toBeInstanceOf(TestSocket)
  })
})

describe("karaoke gateway → DO message flow", () => {
  it("scores a line and summarizes a session over JSON frames", async () => {
    const fx = nextFixture()
    await initSession(fx)
    const stub = stubFor(fx)
    const socket = await openSocket(fx, await mintToken(fx))

    socket.send(startEvent(fx, 1))
    await waitForSttStarted(stub)

    // Real path: binary audio advances the committed frontier past line-1, a
    // playback tick makes the scheduler issue a commit, then the provider acks.
    socket.send(audioFrame(fx, 2, 1, 1100))
    socket.send(playbackSync(fx, 3, 1100))
    await waitForPendingCommit(stub)
    await ackSttFinal(fx)

    const sttFinal = await socket.waitForType("stt_final")
    expect(sttFinal.sessionId).toBe(fx.sessionId)
    const lineScore = await socket.waitForType("line_score")
    expect((lineScore as unknown as { result: { lineId: string } }).result.lineId).toBe("line-1")

    socket.send(finishEvent(fx, 4, 1300))
    const summary = await socket.waitForType("summary")
    expect((summary as unknown as { summary: { lineCount: number } }).summary.lineCount).toBe(1)
  })

  it("forwards valid binary PCM frames to the STT adapter", async () => {
    const fx = nextFixture()
    await initSession(fx)
    const stub = stubFor(fx)
    const socket = await openSocket(fx, await mintToken(fx))

    socket.send(startEvent(fx, 1))
    await waitForSttStarted(stub)

    socket.send(audioFrame(fx, 2, 1))

    await runInDurableObject(stub, async (instance: KaraokeSessionRuntimeDO) => {
      const adapter = (instance as unknown as { sttAdapter: { frames: unknown[] } }).sttAdapter
      // give the in-flight webSocketMessage time to land the frame
      for (let i = 0; i < 50 && adapter.frames.length === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(adapter.frames.length).toBe(1)
    })
  })

  it("emits a session_error for a malformed binary frame", async () => {
    const fx = nextFixture()
    await initSession(fx)
    const socket = await openSocket(fx, await mintToken(fx))

    socket.send(startEvent(fx, 1))
    await waitForSttStarted(stubFor(fx))

    socket.send(new ArrayBuffer(8))
    const error = await socket.waitForType("session_error")
    expect((error as unknown as { code: string }).code).toBe("binary_truncated")
  })
})

describe("karaoke DO SQLite rehydration and outbox replay", () => {
  // NOTE: the test framework has no primitive to force real DO eviction
  // (destruction + constructor rerun + hibernatable-socket wake-up). These tests
  // simulate in-memory state loss by nulling the runtime fields on the live
  // instance, which verifies the ensureHost() restore-from-SQLite path while an
  // accepted socket remains usable — not runtime-driven hibernation itself.
  it("rehydrates from SQLite after simulated in-memory state loss", async () => {
    const fx = nextFixture()
    await initSession(fx)
    const stub = stubFor(fx)
    const socket = await openSocket(fx, await mintToken(fx))

    socket.send(startEvent(fx, 1))
    await waitForSttStarted(stub)
    socket.send(audioFrame(fx, 2, 1, 1100))
    socket.send(playbackSync(fx, 3, 1100))
    await waitForPendingCommit(stub)
    await ackSttFinal(fx)
    await socket.waitForType("line_score") // line-1 scored, snapshot persisted, no pending

    // Simulate in-memory state loss (as would occur on eviction): drop all
    // runtime fields while the accepted socket stays open and SQLite persists.
    // This does NOT destroy the DO or rerun its constructor.
    await runInDurableObject(stub, (instance: KaraokeSessionRuntimeDO) => {
      const internals = instance as unknown as DoInternals
      internals.host = null
      internals.effectRunner = null
      internals.meta = null
      internals.sttAdapter = null
    })

    // A finish over the surviving socket must trigger rehydration via ensureHost()
    // and summarize the restored session (line-1 survives in the snapshot).
    socket.send(finishEvent(fx, 4, 1300))
    const summary = await socket.waitForType("summary")
    expect((summary as unknown as { summary: { lineCount: number } }).summary.lineCount).toBe(1)
    expect(summary.sequence).toBeGreaterThan(0)
  })

  it("replays an undelivered outbox row on rehydration", async () => {
    const fx = nextFixture()
    await initSession(fx)
    const stub = stubFor(fx)
    const socket = await openSocket(fx, await mintToken(fx))

    socket.send(startEvent(fx, 1))
    await waitForSttStarted(stub)
    socket.send(audioFrame(fx, 2, 1, 1100))
    socket.send(playbackSync(fx, 3, 1100))
    await waitForPendingCommit(stub)
    await ackSttFinal(fx)
    const firstLineScore = await socket.waitForType("line_score")
    expect((firstLineScore as unknown as { result: { lineId: string } }).result.lineId).toBe("line-1")

    // Simulate a crash in the window after persisting the outbox row but before
    // delivery was confirmed: mark the row undelivered, then evict in-memory state.
    await runInDurableObject(stub, (instance: KaraokeSessionRuntimeDO, state) => {
      state.storage.sql.exec(
        "UPDATE karaoke_session_outbox SET delivered_at = NULL WHERE event_id LIKE '%line_score%'",
      )
      const internals = instance as unknown as DoInternals
      internals.host = null
      internals.effectRunner = null
      internals.meta = null
      internals.sttAdapter = null
    })

    // Any frame triggers ensureHost() → flushPending(), which must redeliver the
    // undelivered line_score over the socket and then mark it delivered.
    socket.send(playbackSync(fx, 4, 1200))
    const replayed = await socket.waitForType("line_score")
    expect((replayed as unknown as { result: { lineId: string } }).result.lineId).toBe("line-1")

    await runInDurableObject(stub, (_instance, state) => {
      const rows = state.storage.sql
        .exec("SELECT COUNT(*) AS n FROM karaoke_session_outbox WHERE delivered_at IS NULL")
        .toArray() as { n: number }[]
      expect(rows[0]!.n).toBe(0)
    })
  })
})

describe("karaoke DO expiry alarm", () => {
  it("closes the socket and clears persisted state when the expiry alarm fires", async () => {
    const fx = nextFixture()
    await initSession(fx)
    const stub = stubFor(fx)
    const socket = await openSocket(fx, await mintToken(fx))

    socket.send(startEvent(fx, 1))
    await waitForSttStarted(stub)

    const ran = await runDurableObjectAlarm(stub)
    expect(ran).toBe(true)

    const close = await socket.waitForClose()
    expect(close.code).toBe(4001)

    await runInDurableObject(stub, (_instance, state) => {
      const snapshots = state.storage.sql
        .exec("SELECT COUNT(*) AS n FROM karaoke_session_snapshots")
        .toArray() as { n: number }[]
      const outbox = state.storage.sql
        .exec("SELECT COUNT(*) AS n FROM karaoke_session_outbox")
        .toArray() as { n: number }[]
      expect(snapshots[0]!.n).toBe(0)
      expect(outbox[0]!.n).toBe(0)
    })

    const ranAgain = await runDurableObjectAlarm(stub)
    expect(ranAgain).toBe(false)
  })
})
