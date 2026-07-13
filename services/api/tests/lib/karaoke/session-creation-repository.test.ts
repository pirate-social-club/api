import { afterEach, describe, expect, test } from "bun:test"
import { createClient, type Client as LibsqlClient } from "@libsql/client"
import type { Client } from "../../../src/lib/sql-client"
import {
  claimKaraokeSessionCreation,
  failKaraokeSessionCreation,
  finalizeKaraokeSessionCreation,
  getKaraokeSessionCreationRecord,
  rotateKaraokeGatewayClaims,
} from "../../../src/lib/karaoke/session-creation-repository"

let database: LibsqlClient | null = null

afterEach(() => {
  database?.close()
  database = null
})

async function setup(): Promise<Client> {
  database = createClient({ url: "file::memory:" })
  await database.executeMultiple(`
    CREATE TABLE karaoke_session_creation_requests (
      subject_user_id TEXT NOT NULL,
      community_id TEXT NOT NULL,
      post_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'initialized', 'failed')),
      session_id TEXT,
      attempt_id TEXT,
      websocket_base_url TEXT,
      protocol_version INTEGER,
      scoring_policy_json TEXT,
      session_expires_at TEXT,
      token_issued_at INTEGER,
      token_expires_at INTEGER,
      token_nonce TEXT,
      failure_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      PRIMARY KEY (subject_user_id, community_id, post_id, idempotency_key)
    );
  `)
  return database as unknown as Client
}

const key = {
  communityId: "community-1",
  idempotencyKey: "5a59af75-bf63-41d7-b181-fc3620d2c7c7", // gitleaks:allow — test idempotency UUID, not a secret
  postId: "post-1",
  subjectUserId: "user-1",
}

describe("karaoke session creation repository", () => {
  test("claims once, finalizes durable claims, and never stores a signed token", async () => {
    const client = await setup()
    const first = await claimKaraokeSessionCreation({
      client,
      key,
      now: "2026-06-13T10:00:00.000Z",
      pendingExpiresAt: "2026-06-13T10:00:30.000Z",
    })
    const concurrent = await claimKaraokeSessionCreation({
      client,
      key,
      now: "2026-06-13T10:00:01.000Z",
      pendingExpiresAt: "2026-06-13T10:00:31.000Z",
    })

    expect(first.kind).toBe("claimed")
    expect(concurrent.kind).toBe("pending")

    const finalized = await finalizeKaraokeSessionCreation({
      attemptId: "attempt-1",
      client,
      key,
      now: "2026-06-13T10:00:02.000Z",
      protocolVersion: 1,
      scoringPolicyJson: JSON.stringify({ kind: "enabled", model: "scribe_v2", provider: "elevenlabs", retention: "not_stored" }),
      sessionExpiresAt: "2026-06-13T11:00:00.000Z",
      sessionId: "session-1",
      tokenExpiresAt: 1_800_000_060,
      tokenIssuedAt: 1_800_000_000,
      tokenNonce: "nonce-1",
      websocketBaseUrl: "wss://api.example/karaoke/sessions/session-1/websocket",
    })
    const replay = await claimKaraokeSessionCreation({
      client,
      key,
      now: "2026-06-13T10:00:03.000Z",
      pendingExpiresAt: "2026-06-13T10:00:33.000Z",
    })
    const raw = await database!.execute("SELECT * FROM karaoke_session_creation_requests")

    expect(finalized.status).toBe("initialized")
    expect(replay.kind).toBe("initialized")
    expect(Object.keys(raw.rows[0] ?? {})).not.toContain("token")
    expect(JSON.stringify(raw.rows[0])).not.toContain("eyJ")
  })

  test("rotates only the stored nonce and token timestamps", async () => {
    const client = await setup()
    await claimKaraokeSessionCreation({
      client,
      key,
      now: "2026-06-13T10:00:00.000Z",
      pendingExpiresAt: "2026-06-13T10:00:30.000Z",
    })
    await finalizeKaraokeSessionCreation({
      attemptId: "attempt-1",
      client,
      key,
      now: "2026-06-13T10:00:01.000Z",
      protocolVersion: 1,
      scoringPolicyJson: '{"kind":"enabled"}',
      sessionExpiresAt: "2026-06-13T11:00:00.000Z",
      sessionId: "session-1",
      tokenExpiresAt: 100,
      tokenIssuedAt: 40,
      tokenNonce: "nonce-1",
      websocketBaseUrl: "wss://api.example/karaoke/sessions/session-1/websocket",
    })

    const rotated = await rotateKaraokeGatewayClaims({
      client,
      key,
      now: "2026-06-13T10:01:00.000Z",
      previousTokenExpiresAt: 100,
      tokenExpiresAt: 160,
      tokenIssuedAt: 100,
      tokenNonce: "nonce-2",
    })
    const stored = await getKaraokeSessionCreationRecord({ client, key })

    expect(rotated.kind).toBe("rotated")
    expect(rotated.record).toMatchObject({ sessionId: "session-1", attemptId: "attempt-1", tokenNonce: "nonce-2" })
    expect(stored?.tokenExpiresAt).toBe(160)
  })

  test("reports a concurrent rotation when the previous token expiry was preempted", async () => {
    const client = await setup()
    await claimKaraokeSessionCreation({
      client,
      key,
      now: "2026-06-13T10:00:00.000Z",
      pendingExpiresAt: "2026-06-13T10:00:30.000Z",
    })
    await finalizeKaraokeSessionCreation({
      attemptId: "attempt-1",
      client,
      key,
      now: "2026-06-13T10:00:01.000Z",
      protocolVersion: 1,
      scoringPolicyJson: '{"kind":"enabled"}',
      sessionExpiresAt: "2026-06-13T11:00:00.000Z",
      sessionId: "session-1",
      tokenExpiresAt: 100,
      tokenIssuedAt: 40,
      tokenNonce: "nonce-1",
      websocketBaseUrl: "wss://api.example/karaoke/sessions/session-1/websocket",
    })

    const first = await rotateKaraokeGatewayClaims({
      client,
      key,
      now: "2026-06-13T10:01:00.000Z",
      previousTokenExpiresAt: 100,
      tokenExpiresAt: 200,
      tokenIssuedAt: 150,
      tokenNonce: "nonce-winner",
    })
    const second = await rotateKaraokeGatewayClaims({
      client,
      key,
      now: "2026-06-13T10:01:01.000Z",
      previousTokenExpiresAt: 100,
      tokenExpiresAt: 260,
      tokenIssuedAt: 210,
      tokenNonce: "nonce-loser",
    })
    const stored = await getKaraokeSessionCreationRecord({ client, key })

    expect(first.kind).toBe("rotated")
    expect(second.kind).toBe("concurrent")
    expect(second.record).toMatchObject({ tokenNonce: "nonce-winner", tokenExpiresAt: 200, tokenIssuedAt: 150 })
    expect(stored?.tokenNonce).toBe("nonce-winner")
    expect(stored?.tokenExpiresAt).toBe(200)
  })

  test("fails the pending claim and records the failure code", async () => {
    const client = await setup()
    await claimKaraokeSessionCreation({
      client,
      key,
      now: "2026-06-13T10:00:00.000Z",
      pendingExpiresAt: "2026-06-13T10:00:30.000Z",
    })

    await failKaraokeSessionCreation({
      client,
      failureCode: "runtime_init_failed",
      key,
      now: "2026-06-13T10:00:01.000Z",
      expiresAt: "2026-06-13T10:05:00.000Z",
    })
    const stored = await getKaraokeSessionCreationRecord({ client, key })

    expect(stored?.status).toBe("failed")
    expect(stored?.failureCode).toBe("runtime_init_failed")
    expect(stored?.sessionId).toBeNull()
    expect(stored?.attemptId).toBeNull()
    expect(stored?.tokenNonce).toBeNull()
  })

  test("reaps an expired pending claim and returns a fresh claim", async () => {
    const client = await setup()
    await claimKaraokeSessionCreation({
      client,
      key,
      now: "2026-06-13T10:00:00.000Z",
      pendingExpiresAt: "2026-06-13T10:00:30.000Z",
    })

    const reaped = await claimKaraokeSessionCreation({
      client,
      key,
      now: "2026-06-13T10:00:31.000Z",
      pendingExpiresAt: "2026-06-13T10:01:01.000Z",
    })
    const stored = await getKaraokeSessionCreationRecord({ client, key })

    expect(reaped.kind).toBe("claimed")
    expect(stored?.status).toBe("pending")
    expect(stored?.sessionId).toBeNull()
    expect(stored?.attemptId).toBeNull()
    expect(stored?.failureCode).toBeNull()
    expect(stored?.expiresAt).toBe("2026-06-13T10:01:01.000Z")
  })

  test("caches a failed claim until its expiry, then permits a fresh claim", async () => {
    const client = await setup()
    await claimKaraokeSessionCreation({
      client,
      key,
      now: "2026-06-13T10:00:00.000Z",
      pendingExpiresAt: "2026-06-13T10:00:30.000Z",
    })
    await failKaraokeSessionCreation({
      client,
      failureCode: "runtime_init_failed",
      key,
      now: "2026-06-13T10:00:01.000Z",
      expiresAt: "2026-06-13T10:05:00.000Z",
    })

    const cached = await claimKaraokeSessionCreation({
      client,
      key,
      now: "2026-06-13T10:00:02.000Z",
      pendingExpiresAt: "2026-06-13T10:00:32.000Z",
    })
    expect(cached.kind).toBe("failed")

    const reaped = await claimKaraokeSessionCreation({
      client,
      key,
      now: "2026-06-13T10:05:01.000Z",
      pendingExpiresAt: "2026-06-13T10:05:31.000Z",
    })
    const stored = await getKaraokeSessionCreationRecord({ client, key })

    expect(reaped.kind).toBe("claimed")
    expect(stored?.status).toBe("pending")
    expect(stored?.failureCode).toBeNull()
    expect(stored?.expiresAt).toBe("2026-06-13T10:05:31.000Z")
  })
})
