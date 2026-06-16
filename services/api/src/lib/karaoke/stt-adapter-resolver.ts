import type { KaraokeScoringPolicy, KaraokeStreamingSttAdapter } from "@pirate/karaoke-runtime"

import type { Env } from "../../env"
import { ElevenLabsKaraokeSttAdapter } from "./elevenlabs-stt-adapter"
import { FakeKaraokeStreamingSttAdapter } from "./fake-stt-adapter"

export interface ResolveKaraokeSttAdapterInput {
  env: Env
  policy: KaraokeScoringPolicy
  sessionId: string
  attemptId: string
}

/** Raised when an enabled scoring policy has no usable real STT adapter in production. */
export class KaraokeSttConfigurationError extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.name = "KaraokeSttConfigurationError"
    this.code = code
  }
}

function buildProviderAdapter(env: Env, policy: Extract<KaraokeScoringPolicy, { kind: "enabled" }>): KaraokeStreamingSttAdapter | null {
  switch (policy.provider) {
    case "elevenlabs": {
      const apiKey = env.ELEVENLABS_API_KEY?.trim()
      if (!apiKey) return null
      return new ElevenLabsKaraokeSttAdapter({
        apiKey,
        model: env.ELEVENLABS_STT_MODEL?.trim() || policy.model,
        retention: policy.retention,
        websocketUrl: env.ELEVENLABS_STT_WEBSOCKET_URL?.trim() || undefined,
      })
    }
    // openai / mistral / assistant adapters land here as they are implemented.
    case "openai":
    case "mistral":
    case "assistant":
      return null
  }
}

/**
 * Selects the concrete streaming STT adapter for a karaoke session.
 *
 * This is the single seam where provider-specific adapters are wired in, keyed
 * off the resolved scoring policy provider and the environment configuration.
 *
 * When no real adapter is available for an enabled policy (provider not yet
 * implemented or credentials missing) the behavior depends on the environment:
 * in production a KaraokeSttConfigurationError is thrown so the caller rejects
 * the session rather than running a session that silently never recognizes
 * speech; in dev/test it falls back to the in-memory fake adapter so local runs
 * and the workerd integration suite work without external STT services.
 */
export function resolveKaraokeSttAdapter(input: ResolveKaraokeSttAdapterInput): KaraokeStreamingSttAdapter {
  const { env, policy } = input
  if (policy.kind !== "enabled") {
    return new FakeKaraokeStreamingSttAdapter()
  }

  const adapter = buildProviderAdapter(env, policy)
  if (adapter) return adapter

  if ((env.ENVIRONMENT ?? "").toLowerCase() === "production") {
    throw new KaraokeSttConfigurationError(`karaoke_stt_unconfigured_${policy.provider}`)
  }
  return new FakeKaraokeStreamingSttAdapter()
}
