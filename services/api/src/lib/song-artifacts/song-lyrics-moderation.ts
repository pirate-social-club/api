import type { Env } from "../../env"
import type { Post } from "../../types"
import { trimEnv, type LyricsModerationOutcome } from "./song-artifact-analysis-types"

function resolveProviderLyricsOutcome(result: Record<string, unknown>): {
  analysisState: Post["analysis_state"]
  contentSafetyState: Post["content_safety_state"]
  ageGatePolicy: Post["age_gate_policy"]
} {
  const rating = typeof result.age_gate_rating === "string"
    ? result.age_gate_rating
    : null

  if (rating === "adult") {
    return {
      analysisState: "allow",
      contentSafetyState: "adult",
      ageGatePolicy: "18_plus",
    }
  }

  if (rating === "sensitive") {
    return {
      analysisState: "allow",
      contentSafetyState: "sensitive",
      ageGatePolicy: "none",
    }
  }

  return {
    analysisState: "allow",
    contentSafetyState: "safe",
    ageGatePolicy: "none",
  }
}

async function classifyLyricsAgeGate(input: {
  env: Env
  lyrics: string
}): Promise<Record<string, unknown> | null> {
  const apiKey = trimEnv(input.env.OPENROUTER_API_KEY)
  if (!apiKey) {
    return {
      provider: "openrouter",
      error: "missing_configuration",
    }
  }

  const baseUrl = trimEnv(input.env.OPENROUTER_BASE_URL) || "https://openrouter.ai/api/v1"
  const model = trimEnv(input.env.OPENROUTER_MODEL) || "google/gemini-3.1-flash-lite-preview"
  const timeoutMs = Number.parseInt(trimEnv(input.env.OPENROUTER_TIMEOUT_MS) || "", 10)
  const controller = new AbortController()
  const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null

  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_completion_tokens: 120,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "song_lyrics_age_gate",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["age_gate_rating", "reason"],
              properties: {
                age_gate_rating: {
                  type: "string",
                  enum: ["safe", "sensitive", "adult"],
                },
                reason: {
                  type: "string",
                },
              },
            },
          },
        },
        messages: [
          {
            role: "system",
            content:
              "Classify song lyrics for age-gating only. Never recommend blocking or review. " +
              "Return adult only for explicit sexual content suitable for 18+ gating. " +
              "Return sensitive for profanity or mature themes that do not require 18+ gating. " +
              "Return safe otherwise.",
          },
          {
            role: "user",
            content: input.lyrics,
          },
        ],
      }),
      signal: controller.signal,
    })
    if (!response.ok) {
      return {
        provider: "openrouter",
        error: `http_${response.status}`,
      }
    }
    const body = await response.json().catch(() => null)
    if (!body || typeof body !== "object") {
      return {
        provider: "openrouter",
        error: "invalid_response",
      }
    }
    const content = (body as {
      choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>
    }).choices?.[0]?.message?.content

    const normalizedContent = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
          .filter((part) => part && typeof part === "object" && part.type === "text" && typeof part.text === "string")
          .map((part) => String(part.text))
          .join("")
        : ""

    if (!normalizedContent.trim()) {
      return {
        provider: "openrouter",
        error: "invalid_response",
      }
    }

    const parsed = JSON.parse(normalizedContent) as Record<string, unknown>
    return {
      provider: "openrouter",
      model,
      classification: parsed,
      provider_result: body,
      ...(typeof parsed.age_gate_rating === "string" ? { age_gate_rating: parsed.age_gate_rating } : {}),
      ...(typeof parsed.reason === "string" ? { reason: parsed.reason } : {}),
    }
  } catch (error) {
    return {
      provider: "openrouter",
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

export async function evaluateLyricsModeration(input: {
  env: Env
  lyrics: string
}): Promise<LyricsModerationOutcome> {
  const providerResult = await classifyLyricsAgeGate(input)
  const providerFailed = Boolean(providerResult && typeof providerResult.error === "string")
  const providerOutcome = providerFailed
    ? {
        analysisState: "allow" as const,
        contentSafetyState: "pending" as const,
        ageGatePolicy: "none" as const,
      }
    : resolveProviderLyricsOutcome(providerResult as Record<string, unknown>)

  return {
    analysisState: providerOutcome.analysisState,
    contentSafetyState: providerOutcome.contentSafetyState,
    ageGatePolicy: providerOutcome.ageGatePolicy,
    moderationStatus: providerFailed ? "failed" : "completed",
    moderationError: providerFailed ? String(providerResult?.error || "OpenRouter song lyrics classification failed") : null,
    moderationResult: {
      provider: "openrouter",
      provider_result: providerResult,
      analysis_state: providerOutcome.analysisState,
      content_safety_state: providerOutcome.contentSafetyState,
      age_gate_policy: providerOutcome.ageGatePolicy,
    },
  }
}
