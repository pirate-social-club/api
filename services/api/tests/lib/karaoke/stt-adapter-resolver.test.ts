import { describe, expect, test } from "bun:test"
import type { KaraokeScoringPolicy } from "@pirate-social-club/karaoke-runtime"

import type { Env } from "../../../src/env"
import { ElevenLabsKaraokeSttAdapter } from "../../../src/lib/karaoke/elevenlabs-stt-adapter"
import { FakeKaraokeStreamingSttAdapter } from "../../../src/lib/karaoke/fake-stt-adapter"
import {
  KaraokeSttConfigurationError,
  resolveKaraokeSttAdapter,
} from "../../../src/lib/karaoke/stt-adapter-resolver"

const ENABLED: KaraokeScoringPolicy = {
  kind: "enabled",
  model: "scribe_v2_realtime",
  provider: "elevenlabs",
  retention: "not_stored",
}

function resolve(env: Partial<Env>, policy: KaraokeScoringPolicy = ENABLED) {
  return resolveKaraokeSttAdapter({
    attemptId: "attempt-1",
    env: env as Env,
    policy,
    sessionId: "session-1",
  })
}

describe("resolveKaraokeSttAdapter", () => {
  test("returns the ElevenLabs adapter when the provider is elevenlabs and a key is configured", () => {
    const adapter = resolve({ ELEVENLABS_API_KEY: "secret-key" })
    expect(adapter).toBeInstanceOf(ElevenLabsKaraokeSttAdapter)
  })

  test("falls back to the fake adapter when the ElevenLabs key is absent", () => {
    const adapter = resolve({})
    expect(adapter).toBeInstanceOf(FakeKaraokeStreamingSttAdapter)
  })

  test("falls back to the fake adapter for providers without an implementation", () => {
    for (const provider of ["openai", "mistral", "assistant"] as const) {
      const adapter = resolve(
        { ELEVENLABS_API_KEY: "secret-key", OPENAI_API_KEY: "secret-key" },
        { ...ENABLED, provider },
      )
      expect(adapter).toBeInstanceOf(FakeKaraokeStreamingSttAdapter)
    }
  })

  test("falls back to the fake adapter when scoring is disabled", () => {
    const adapter = resolve({ ELEVENLABS_API_KEY: "secret-key" }, { kind: "disabled" })
    expect(adapter).toBeInstanceOf(FakeKaraokeStreamingSttAdapter)
  })

  test("in production, returns the real adapter when configured", () => {
    const adapter = resolve({ ELEVENLABS_API_KEY: "secret-key", ENVIRONMENT: "production" })
    expect(adapter).toBeInstanceOf(ElevenLabsKaraokeSttAdapter)
  })

  test("in production, throws instead of silently faking when the key is missing", () => {
    expect(() => resolve({ ENVIRONMENT: "production" })).toThrow(KaraokeSttConfigurationError)
  })

  test("in production, throws for a provider without an implementation", () => {
    expect(() =>
      resolve({ ENVIRONMENT: "production", OPENAI_API_KEY: "secret-key" }, { ...ENABLED, provider: "openai" }),
    ).toThrow(KaraokeSttConfigurationError)
  })
})
