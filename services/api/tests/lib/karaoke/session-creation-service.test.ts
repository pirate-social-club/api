import { describe, expect, test } from "bun:test"
import type { SongKaraokePayload } from "@pirate/api-contracts"
import type { KaraokeScoringPolicy } from "@pirate/karaoke-runtime"
import { HttpError } from "../../../src/lib/errors"
import {
  createKaraokeSession,
  type KaraokeSessionCreationDependencies,
} from "../../../src/lib/karaoke/session-creation-service"
import type {
  KaraokeSessionCreationRecord,
} from "../../../src/lib/karaoke/session-creation-repository"

const NOW_MS = 1_800_000_000_000
const ENABLED_POLICY: KaraokeScoringPolicy = {
  kind: "enabled",
  model: "scribe_v2",
  provider: "elevenlabs",
  retention: "not_stored",
}

const PAYLOAD: SongKaraokePayload = {
  id: "bundle-1",
  object: "song_karaoke_payload",
  karaoke_lines: [
    { id: "section-1", index: 0, kind: "section", text: "Verse", start_ms: 0, end_ms: 1, words: [] },
    {
      id: "line-1",
      index: 1,
      kind: "lyric",
      text: "hold on",
      start_ms: 100,
      end_ms: 1000,
      words: [
        { text: "hold", start_ms: 100, end_ms: 400 },
        { text: "on", start_ms: 500, end_ms: 900 },
      ],
    },
  ],
}

function initializedRecord(overrides: Partial<KaraokeSessionCreationRecord> = {}): KaraokeSessionCreationRecord {
  return {
    attemptId: "attempt-existing",
    communityId: "community-1",
    createdAt: new Date(NOW_MS).toISOString(),
    expiresAt: new Date(NOW_MS + 3_600_000).toISOString(),
    failureCode: null,
    idempotencyKey: "idem-1",
    postId: "post-1",
    protocolVersion: 1,
    scoringPolicyJson: JSON.stringify(ENABLED_POLICY),
    sessionExpiresAt: new Date(NOW_MS + 3_600_000).toISOString(),
    sessionId: "session-existing",
    status: "initialized",
    subjectUserId: "user-1",
    tokenExpiresAt: Math.floor(NOW_MS / 1000) + 60,
    tokenIssuedAt: Math.floor(NOW_MS / 1000),
    tokenNonce: "nonce-existing",
    updatedAt: new Date(NOW_MS).toISOString(),
    websocketBaseUrl: "wss://api.example/karaoke/sessions/session-existing/websocket",
    ...overrides,
  }
}

function dependencies(overrides: Partial<KaraokeSessionCreationDependencies> = {}) {
  const calls: string[] = []
  const initialized: Parameters<KaraokeSessionCreationDependencies["initializeRuntime"]>[0][] = []
  let uuid = 0
  const deps: KaraokeSessionCreationDependencies = {
    async claim() {
      calls.push("claim")
      return { kind: "claimed", record: initializedRecord({ status: "pending", sessionId: null, attemptId: null }) }
    },
    async fail() { calls.push("fail") },
    async finalize(input) {
      calls.push("finalize")
      return initializedRecord({
        attemptId: input.attemptId,
        protocolVersion: input.protocolVersion,
        scoringPolicyJson: input.scoringPolicyJson,
        sessionExpiresAt: input.sessionExpiresAt,
        sessionId: input.sessionId,
        tokenExpiresAt: input.tokenExpiresAt,
        tokenIssuedAt: input.tokenIssuedAt,
        tokenNonce: input.tokenNonce,
        websocketBaseUrl: input.websocketBaseUrl,
      })
    },
    async initializeRuntime(input) {
      calls.push("initialize")
      initialized.push(input)
      return { status: 200 }
    },
    async issueToken({ claims }) {
      calls.push("sign")
      return `token-${claims.nonce}`
    },
    async loadPayload() { calls.push("payload"); return PAYLOAD },
    randomUUID() { uuid += 1; return `uuid-${uuid}` },
    async resolveScoringPolicy() { calls.push("policy"); return ENABLED_POLICY },
    async rotateClaims({ tokenExpiresAt, tokenIssuedAt, tokenNonce }) {
      calls.push("rotate")
      return { kind: "rotated" as const, record: initializedRecord({ tokenExpiresAt, tokenIssuedAt, tokenNonce }) }
    },
    nowMs() { return NOW_MS },
    websocketBaseUrl(sessionId) { return `wss://api.example/karaoke/sessions/${sessionId}/websocket` },
    ...overrides,
  }
  return { calls, deps, initialized }
}

async function create(deps: KaraokeSessionCreationDependencies) {
  return await createKaraokeSession({
    communityId: "community-1",
    deps,
    idempotencyKey: "idem-1",
    postId: "post-1",
    subjectUserId: "user-1",
  })
}

describe("karaoke session creation service", () => {
  test("filters section cues and signs before initializing the runtime", async () => {
    const { calls, deps, initialized } = dependencies()
    const result = await create(deps)

    expect(calls.indexOf("sign")).toBeLessThan(calls.indexOf("initialize"))
    expect(initialized[0]?.lines).toEqual([{
      endMs: 1000,
      lineId: "line-1",
      lineIndex: 1,
      scoredLineIndex: 0,
      startMs: 100,
      text: "hold on",
      words: [
        { text: "hold", startMs: 100, endMs: 400 },
        { text: "on", startMs: 500, endMs: 900 },
      ],
    }])
    expect(result).toMatchObject({ id: "uuid-1", attempt: "uuid-2", object: "karaoke_session" })
    expect(result.websocket_url).toContain("token=token-uuid-3")
  })

  test("does not claim idempotency or initialize when scoring is disabled", async () => {
    const { calls, deps } = dependencies({
      async resolveScoringPolicy() { calls.push("policy"); return { kind: "disabled" } },
    })
    await expect(create(deps)).rejects.toMatchObject({
      code: "karaoke_scoring_disabled",
      status: 409,
    } satisfies Partial<HttpError>)
    expect(calls).toEqual(["payload", "policy"])
  })

  test("retries one runtime collision using a new session and attempt", async () => {
    let runtimeCalls = 0
    const { deps, initialized } = dependencies({
      async initializeRuntime(input) {
        runtimeCalls += 1
        initialized.push(input)
        return { status: runtimeCalls === 1 ? 409 : 200 }
      },
    })
    const result = await create(deps)
    expect(initialized.map((entry) => [entry.sessionId, entry.attemptId])).toEqual([
      ["uuid-1", "uuid-2"],
      ["uuid-4", "uuid-5"],
    ])
    expect(result.id).toBe("uuid-4")
  })

  test("returns an initialized idempotent session without allocating another runtime", async () => {
    const { calls, deps } = dependencies({
      async claim() { return { kind: "initialized", record: initializedRecord() } },
    })
    const result = await create(deps)
    expect(result.id).toBe("session-existing")
    expect(calls).not.toContain("initialize")
    expect(result.websocket_url).toContain("token=token-nonce-existing")
  })

  test("rotates expired connection claims while preserving session identity", async () => {
    const { calls, deps } = dependencies({
      async claim() {
        return {
          kind: "initialized",
          record: initializedRecord({ tokenExpiresAt: Math.floor(NOW_MS / 1000) - 1 }),
        }
      },
    })
    const result = await create(deps)
    expect(calls).toContain("rotate")
    expect(result.id).toBe("session-existing")
    expect(result.websocket_url).toContain("token=token-uuid-1")
  })
})
