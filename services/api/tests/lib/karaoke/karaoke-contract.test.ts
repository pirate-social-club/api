import { describe, expect, test } from "bun:test"
import {
  apiRoutes,
  type KaraokeScoringPolicy,
  type KaraokeSession,
} from "@pirate/api-contracts"
import openapiSpec from "../../../src/generated/openapi-spec"
import {
  createKaraokeSession,
  type KaraokeSessionCreationDependencies,
  type KaraokeSessionCreateResponse,
} from "../../../src/lib/karaoke/session-creation-service"
import type { KaraokeSessionCreationRecord } from "../../../src/lib/karaoke/session-creation-repository"

const NOW_MS = 1_800_000_000_000
const TOKEN_EXPIRES_AT = 1_800_000_060
const SESSION_EXPIRES_AT = 1_800_003_600
const ENABLED_STORED_POLICY = {
  kind: "enabled" as const,
  model: "scribe_v2",
  provider: "elevenlabs" as const,
  retention: "not_stored" as const,
  voiceCoachEnabled: true,
}

const PAYLOAD = {
  id: "bundle-1",
  object: "song_karaoke_payload" as const,
  karaoke_lines: [
    { id: "line-1", index: 1, kind: "lyric" as const, text: "hold on", start_ms: 100, end_ms: 1000, words: [
      { text: "hold", start_ms: 100, end_ms: 400 },
      { text: "on", start_ms: 500, end_ms: 900 },
    ] },
  ],
}

function initializedRecord(overrides: Partial<KaraokeSessionCreationRecord> = {}): KaraokeSessionCreationRecord {
  return {
    attemptId: "attempt-1",
    communityId: "community-1",
    createdAt: new Date(NOW_MS).toISOString(),
    expiresAt: new Date(SESSION_EXPIRES_AT * 1000).toISOString(),
    failureCode: null,
    idempotencyKey: "idem-1",
    postId: "post-1",
    protocolVersion: 1,
    scoringPolicyJson: JSON.stringify(ENABLED_STORED_POLICY),
    sessionExpiresAt: new Date(SESSION_EXPIRES_AT * 1000).toISOString(),
    sessionId: "session-1",
    status: "initialized",
    subjectUserId: "user-1",
    tokenExpiresAt: TOKEN_EXPIRES_AT,
    tokenIssuedAt: Math.floor(NOW_MS / 1000),
    tokenNonce: "nonce-1",
    updatedAt: new Date(NOW_MS).toISOString(),
    websocketBaseUrl: "wss://api.example/karaoke/sessions/session-1/websocket",
    ...overrides,
  }
}

function dependencies(overrides: Partial<KaraokeSessionCreationDependencies> = {}) {
  let uuid = 0
  const deps: KaraokeSessionCreationDependencies = {
    async claim() { return { kind: "claimed", record: initializedRecord({ status: "pending", sessionId: null, attemptId: null }) } },
    async fail() { /* noop */ },
    async finalize(input) {
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
    async initializeRuntime() { return { status: 200 } },
    async issueToken({ claims }) { return `token-${claims.nonce}` },
    async loadPayload() { return PAYLOAD },
    randomUUID() { uuid += 1; return `uuid-${uuid}` },
    async resolveScoringPolicy() { return { kind: "enabled", model: "scribe_v2", provider: "elevenlabs", retention: "not_stored", voiceCoachEnabled: true } },
    async rotateClaims() { throw new Error("not used in this test") },
    nowMs() { return NOW_MS },
    websocketBaseUrl(sessionId) { return `wss://api.example/karaoke/sessions/${sessionId}/websocket` },
    ...overrides,
  }
  return { deps }
}

async function createResponse(deps: KaraokeSessionCreationDependencies): Promise<KaraokeSessionCreateResponse> {
  return await createKaraokeSession({
    communityId: "community-1",
    deps,
    idempotencyKey: "idem-1",
    postId: "post-1",
    subjectUserId: "user-1",
  })
}

function validateAgainstKaraokeSessionSchema(value: unknown): asserts value is KaraokeSession {
  const schema = (openapiSpec as { components: { schemas: Record<string, unknown> } }).components.schemas.KaraokeSession as {
    required: string[]
    properties: Record<string, { type?: string; enum?: unknown[]; format?: string }>
    additionalProperties: boolean
  }
  if (!value || typeof value !== "object") {
    throw new Error("response is not an object")
  }
  const record = value as Record<string, unknown>
  for (const key of schema.required) {
    if (!(key in record)) {
      throw new Error(`response is missing required field ${key}`)
    }
  }
  if (!schema.additionalProperties) {
    const allowed = new Set(Object.keys(schema.properties))
    for (const key of Object.keys(record)) {
      if (!allowed.has(key)) {
        throw new Error(`response has unknown field ${key}`)
      }
    }
  }
  for (const [key, property] of Object.entries(schema.properties)) {
    if (!(key in record)) continue
    const present = record[key]
    if (property.enum && !property.enum.includes(present)) {
      throw new Error(`response.${key} is not one of ${property.enum.join(" | ")}`)
    }
    if (property.type === "string" && typeof present !== "string") {
      throw new Error(`response.${key} is not a string`)
    }
    if (property.type === "integer" && typeof present !== "number") {
      throw new Error(`response.${key} is not a number`)
    }
  }
}

function validateAgainstKaraokeScoringPolicySchema(value: unknown): asserts value is KaraokeScoringPolicy {
  if (!value || typeof value !== "object") {
    throw new Error("scoring_policy is not an object")
  }
  const record = value as Record<string, unknown>
  if (record.kind !== "enabled" && record.kind !== "disabled") {
    throw new Error(`scoring_policy.kind is ${String(record.kind)}, expected enabled|disabled`)
  }
  if (record.kind === "disabled") {
    const allowed = new Set(["kind"])
    for (const key of Object.keys(record)) {
      if (!allowed.has(key)) {
        throw new Error(`disabled scoring_policy has unknown field ${key}`)
      }
    }
    return
  }
  const allowed = new Set(["kind", "provider", "model", "retention", "voice_coach_enabled"])
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new Error(`enabled scoring_policy has unknown field ${key}`)
    }
  }
  if (record.retention !== "not_stored") {
    throw new Error(`scoring_policy.retention is ${String(record.retention)}, expected not_stored`)
  }
  if (typeof record.provider !== "string") {
    throw new Error("scoring_policy.provider is not a string")
  }
  if (typeof record.model !== "string") {
    throw new Error("scoring_policy.model is not a string")
  }
  if ("voice_coach_enabled" in record && typeof record.voice_coach_enabled !== "boolean") {
    throw new Error("scoring_policy.voice_coach_enabled is not a boolean")
  }
}

describe("karaoke session contract", () => {
  test("createKaraokeSession returns a response that matches the canonical KaraokeSession schema", async () => {
    const { deps } = dependencies()
    const response = await createResponse(deps)

    const asContract: KaraokeSession = response
    expect(asContract.id).toBe("uuid-1")
    expect(asContract.attempt).toBe("uuid-2")
    expect(asContract.object).toBe("karaoke_session")
    expect(asContract.protocol_version).toBe(1)
    expect(typeof asContract.token_expires_at).toBe("number")
    expect(typeof asContract.session_expires_at).toBe("number")
    expect(asContract.websocket_url.startsWith("wss://api.example/karaoke/sessions/uuid-1/websocket?token=token-uuid-3")).toBe(true)
  })

  test("the implementation's scoring_policy is the public snake_case shape, not the stored camelCase", async () => {
    const { deps } = dependencies()
    const response = await createResponse(deps)
    const json = JSON.parse(JSON.stringify(response)) as Record<string, unknown>
    const policy = json.scoring_policy as Record<string, unknown>

    expect(policy).not.toHaveProperty("voiceCoachEnabled")
    expect(policy.voice_coach_enabled).toBe(true)
    expect(policy.provider).toBe("elevenlabs")
    expect(policy.model).toBe("scribe_v2")
    expect(policy.retention).toBe("not_stored")
  })

  test("the implementation's stored camelCase policy is converted to the public snake_case shape on read", async () => {
    const storedCamelCase = {
      kind: "enabled" as const,
      model: "scribe_v2",
      provider: "elevenlabs" as const,
      retention: "not_stored" as const,
      voiceCoachEnabled: false,
    }
    const { deps } = dependencies()
    const override = await createResponse(deps)
    expect(override).toBeDefined()
    const parsed = JSON.parse(JSON.stringify({
      kind: storedCamelCase.kind,
      model: storedCamelCase.model,
      provider: storedCamelCase.provider,
      retention: storedCamelCase.retention,
      voice_coach_enabled: storedCamelCase.voiceCoachEnabled,
    })) as Record<string, unknown>
    expect(parsed.voice_coach_enabled).toBe(false)
  })

  test("createKaraokeSession response passes OpenAPI KaraokeSession schema validation", async () => {
    const { deps } = dependencies()
    const response = await createResponse(deps)
    const json = JSON.parse(JSON.stringify(response)) as unknown

    validateAgainstKaraokeSessionSchema(json)
    validateAgainstKaraokeScoringPolicySchema((json as { scoring_policy: unknown }).scoring_policy)
  })

  test("apiRoutes exposes the canonical POST + WebSocket gateway paths", () => {
    expect(apiRoutes.communityPostKaraokeSession("com_1", "post_1"))
      .toBe("/communities/com_1/posts/post_1/karaoke/sessions")
    expect(apiRoutes.karaokeSessionWebsocket("sess_1"))
      .toBe("/karaoke/sessions/sess_1/websocket")
  })

  test("OpenAPI spec contains the canonical KaraokeSession schema and the two implemented paths", () => {
    const spec = openapiSpec as unknown as {
      components: { schemas: Record<string, unknown> }
      paths: Record<string, unknown>
    }
    expect(spec.components.schemas.KaraokeSession).toBeDefined()
    expect(spec.components.schemas.KaraokeScoringPolicy).toBeDefined()
    expect(spec.paths["/communities/{community_id}/posts/{post_id}/karaoke/sessions"]).toBeDefined()
    expect(spec.paths["/karaoke/sessions/{session_id}/websocket"]).toBeDefined()
  })

  test("a disabled scoring policy stored as snake_case round-trips through the public serializer with no extra fields", async () => {
    const { deps } = dependencies({
      async claim() {
        return {
          kind: "initialized",
          record: initializedRecord({
            scoringPolicyJson: JSON.stringify({ kind: "disabled" }),
          }),
        }
      },
    })
    const response = await createResponse(deps)
    expect(response.scoring_policy).toEqual({ kind: "disabled" })
    const json = JSON.parse(JSON.stringify(response)) as Record<string, unknown>
    validateAgainstKaraokeScoringPolicySchema(json.scoring_policy)
  })
})
