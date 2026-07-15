import { beforeEach, describe, expect, mock, test } from "bun:test"
import type { KaraokeScoringPolicy } from "@pirate-social-club/karaoke-runtime"

import type { Env } from "../../../src/env"
import { CommunityAssistantCredentialNotFoundError } from "../../../src/lib/communities/assistant-policy/credential-service"
import { ElevenLabsKaraokeSttAdapter } from "../../../src/lib/karaoke/elevenlabs-stt-adapter"
import { FakeKaraokeStreamingSttAdapter } from "../../../src/lib/karaoke/fake-stt-adapter"
import {
  KaraokeSttConfigurationError,
  resolveKaraokeSttAdapter,
} from "../../../src/lib/karaoke/stt-adapter-resolver"

const decryptActiveCommunityElevenLabsKeyMock = mock(async () => "secret-key")

const ENABLED: KaraokeScoringPolicy = {
  kind: "enabled",
  model: "scribe_v2_realtime",
  provider: "elevenlabs",
  retention: "not_stored",
}

async function resolve(env: Partial<Env>, policy: KaraokeScoringPolicy = ENABLED) {
  return resolveKaraokeSttAdapter({
    attemptId: "attempt-1",
    communityId: "com_1",
    env: env as Env,
    policy,
    sessionId: "session-1",
  }, {
    decryptActiveCommunityElevenLabsKey: decryptActiveCommunityElevenLabsKeyMock,
  })
}

describe("resolveKaraokeSttAdapter", () => {
  beforeEach(() => {
    decryptActiveCommunityElevenLabsKeyMock.mockReset()
    decryptActiveCommunityElevenLabsKeyMock.mockResolvedValue("secret-key")
  })

  test("returns the ElevenLabs adapter when the community ElevenLabs key is configured", async () => {
    const adapter = await resolve({ CONTROL_PLANE_DATABASE_URL: "file:test.db" })
    expect(adapter).toBeInstanceOf(ElevenLabsKaraokeSttAdapter)
  })

  test("falls back to the fake adapter when the community ElevenLabs key is absent", async () => {
    decryptActiveCommunityElevenLabsKeyMock.mockRejectedValue(
      new CommunityAssistantCredentialNotFoundError("elevenlabs", "missing"),
    )
    const adapter = await resolve({ CONTROL_PLANE_DATABASE_URL: "file:test.db" })
    expect(adapter).toBeInstanceOf(FakeKaraokeStreamingSttAdapter)
  })

  test("falls back to the fake adapter for providers without an implementation", async () => {
    for (const provider of ["openai", "mistral", "assistant"] as const) {
      const adapter = await resolve({ OPENAI_API_KEY: "secret-key" }, { ...ENABLED, provider })
      expect(adapter).toBeInstanceOf(FakeKaraokeStreamingSttAdapter)
    }
  })

  test("falls back to the fake adapter when scoring is disabled", async () => {
    const adapter = await resolve({}, { kind: "disabled" })
    expect(adapter).toBeInstanceOf(FakeKaraokeStreamingSttAdapter)
  })

  test("in production, returns the real adapter when the community key is configured", async () => {
    const adapter = await resolve({ ENVIRONMENT: "production" })
    expect(adapter).toBeInstanceOf(ElevenLabsKaraokeSttAdapter)
  })

  test("in production, throws instead of silently faking when the community key is missing", async () => {
    decryptActiveCommunityElevenLabsKeyMock.mockRejectedValue(
      new CommunityAssistantCredentialNotFoundError("elevenlabs", "missing"),
    )
    await expect(resolve({ ENVIRONMENT: "production" })).rejects.toBeInstanceOf(KaraokeSttConfigurationError)
  })

  test("in production, throws for a provider without an implementation", async () => {
    await expect(
      resolve({ ENVIRONMENT: "production", OPENAI_API_KEY: "secret-key" }, { ...ENABLED, provider: "openai" }),
    ).rejects.toBeInstanceOf(KaraokeSttConfigurationError)
  })
})
