import { describe, expect, mock, test } from "bun:test"
import { KARAOKE_TRANSPORT_PROTOCOL_VERSION } from "@pirate-social-club/karaoke-runtime"
import { HttpError } from "../errors"
import {
  createKaraokeSession,
  type KaraokeSessionCreationDependencies,
} from "./session-creation-service"
import type {
  KaraokeSessionCreationKey,
  KaraokeSessionCreationRecord,
} from "./session-creation-repository"

const KEY: KaraokeSessionCreationKey = {
  communityId: "com_1",
  idempotencyKey: "idem_1",
  postId: "post_1",
  subjectUserId: "usr_1",
}

function record(overrides: Partial<KaraokeSessionCreationRecord> = {}): KaraokeSessionCreationRecord {
  return {
    ...KEY,
    attemptId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-01T01:00:00.000Z",
    failureCode: null,
    protocolVersion: null,
    scoringPolicyJson: null,
    sessionExpiresAt: null,
    sessionId: null,
    status: "pending",
    tokenExpiresAt: null,
    tokenIssuedAt: null,
    tokenNonce: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    websocketBaseUrl: null,
    ...overrides,
  }
}

function deps(overrides: Partial<KaraokeSessionCreationDependencies> = {}): KaraokeSessionCreationDependencies {
  return {
    claim: mock(async () => ({ kind: "pending" as const, record: record() })),
    fail: mock(async () => {}),
    finalize: mock(async () => record({ status: "initialized" })),
    initializeRuntime: mock(async () => ({ status: 200 })),
    issueToken: mock(async () => "token"),
    loadPayload: mock(async () => ({
      karaoke_lines: [{
        end_ms: 1000,
        id: "line_1",
        index: 0,
        kind: "lyric",
        start_ms: 0,
        text: "hello",
        words: [],
      }],
      raw_lines: [],
    } as never)),
    nowMs: mock(() => Date.parse("2026-01-01T00:00:00.000Z")),
    randomUUID: mock(() => "uuid"),
    resolveScoringPolicy: mock(async () => ({
      kind: "enabled" as const,
      model: "test-model",
      provider: "elevenlabs" as const,
      retention: "not_stored" as const,
    })),
    rotateClaims: mock(async () => ({ kind: "concurrent" as const, record: record() })),
    websocketBaseUrl: mock((sessionId: string) => `https://karaoke.example/${sessionId}`),
    ...overrides,
  }
}

describe("createKaraokeSession", () => {
  test("does not load payload when creation is already pending", async () => {
    const testDeps = deps()

    await expect(createKaraokeSession({
      communityId: KEY.communityId,
      deps: testDeps,
      idempotencyKey: KEY.idempotencyKey,
      postId: KEY.postId,
      subjectUserId: KEY.subjectUserId,
    })).rejects.toBeInstanceOf(HttpError)

    expect(testDeps.claim).toHaveBeenCalledTimes(1)
    expect(testDeps.loadPayload).not.toHaveBeenCalled()
    expect(testDeps.resolveScoringPolicy).not.toHaveBeenCalled()
  })

  test("returns initialized sessions without loading payload", async () => {
    const testDeps = deps({
      claim: mock(async () => ({
        kind: "initialized" as const,
        record: record({
          attemptId: "attempt_1",
          protocolVersion: KARAOKE_TRANSPORT_PROTOCOL_VERSION,
          scoringPolicyJson: JSON.stringify({
            kind: "enabled",
            model: "test-model",
            provider: "elevenlabs",
            retention: "not_stored",
          }),
          sessionExpiresAt: "2026-01-01T01:00:00.000Z",
          sessionId: "session_1",
          status: "initialized",
          tokenExpiresAt: 1767225900,
          tokenIssuedAt: 1767225600,
          tokenNonce: "nonce_1",
          websocketBaseUrl: "https://karaoke.example/session_1",
        }),
      })),
    })

    const result = await createKaraokeSession({
      communityId: KEY.communityId,
      deps: testDeps,
      idempotencyKey: KEY.idempotencyKey,
      postId: KEY.postId,
      subjectUserId: KEY.subjectUserId,
    })

    expect(result.id).toBe("session_1")
    expect(testDeps.loadPayload).not.toHaveBeenCalled()
    expect(testDeps.resolveScoringPolicy).not.toHaveBeenCalled()
  })

  test("claims before loading payload for new sessions", async () => {
    const calls: string[] = []
    const testDeps = deps({
      claim: mock(async () => {
        calls.push("claim")
        return { kind: "claimed" as const, record: record() }
      }),
      finalize: mock(async () => record({
        attemptId: "uuid",
        protocolVersion: KARAOKE_TRANSPORT_PROTOCOL_VERSION,
        scoringPolicyJson: JSON.stringify({
          kind: "enabled",
          model: "test-model",
          provider: "elevenlabs",
          retention: "not_stored",
        }),
        sessionExpiresAt: "2026-01-01T01:00:00.000Z",
        sessionId: "uuid",
        status: "initialized",
        tokenExpiresAt: 1767225900,
        tokenIssuedAt: 1767225600,
        tokenNonce: "uuid",
        websocketBaseUrl: "https://karaoke.example/uuid",
      })),
      loadPayload: mock(async () => {
        calls.push("loadPayload")
        return {
          karaoke_lines: [{
            end_ms: 1000,
            id: "line_1",
            index: 0,
            kind: "lyric",
            start_ms: 0,
            text: "hello",
            words: [],
          }],
          raw_lines: [],
        } as never
      }),
    })

    await createKaraokeSession({
      communityId: KEY.communityId,
      deps: testDeps,
      idempotencyKey: KEY.idempotencyKey,
      postId: KEY.postId,
      subjectUserId: KEY.subjectUserId,
    })

    expect(calls).toEqual(["claim", "loadPayload"])
    expect(testDeps.initializeRuntime).toHaveBeenCalledWith(expect.objectContaining({
      communityId: KEY.communityId,
    }))
  })
})
