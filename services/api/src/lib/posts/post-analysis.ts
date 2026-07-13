import { isLocalEnvironment } from "../helpers"
import type { Env } from "../../env"
import type { Community, CreatePostRequest, Post } from "../../types"
import {
  type PostModerationOutcome,
  resolveOpenAIModerationOutcome,
} from "./openai-moderation"

type PostAnalysisOutcome = Pick<Post, "analysis_state" | "content_safety_state" | "status" | "age_gate_policy"> & {
  providerResult?: Record<string, unknown> | null
}

export type PostAnalysisProvider = {
  analyze(input: {
    env: Env
    community: Community
    body: CreatePostRequest
  }): Promise<PostAnalysisOutcome>
}

export function mergeAnalysisState(
  left: Post["analysis_state"],
  right: Post["analysis_state"],
): Post["analysis_state"] {
  const precedence: Record<Post["analysis_state"], number> = {
    blocked: 4,
    review_required: 3,
    allow_with_required_reference: 2,
    allow: 1,
    pending: 0,
  }
  return precedence[left] >= precedence[right] ? left : right
}

function resolveDevMarkerAnalysisOutcome(body: CreatePostRequest): PostAnalysisOutcome | null {
  const contentFields = [body.title, body.body, body.caption]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.toLowerCase())
  const blocked = contentFields.some((value) => value.includes("[blocked]"))
  const reviewRequired = contentFields.some((value) => value.includes("[review-required]"))

  if (blocked) {
    return {
      analysis_state: "blocked",
      content_safety_state: "pending",
      age_gate_policy: "none",
      status: "draft",
    }
  }

  if (reviewRequired) {
    return {
      analysis_state: "review_required",
      content_safety_state: "pending",
      age_gate_policy: "none",
      status: "draft",
    }
  }

  return null
}

function normalizeModerationOutcome(outcome: PostModerationOutcome): PostAnalysisOutcome {
  return {
    analysis_state: outcome.analysis_state,
    content_safety_state: outcome.content_safety_state,
    age_gate_policy: outcome.age_gate_policy,
    status: outcome.status,
    providerResult: outcome.providerResult,
  }
}

const openAIPostAnalysisProvider: PostAnalysisProvider = {
  async analyze(input) {
    return normalizeModerationOutcome(await resolveOpenAIModerationOutcome(input))
  },
}

function withDevMarkers(provider: PostAnalysisProvider): PostAnalysisProvider {
  return {
    async analyze(input) {
      const devMarkerOutcome = resolveDevMarkerAnalysisOutcome(input.body)
      if (devMarkerOutcome?.analysis_state === "blocked") {
        return devMarkerOutcome
      }

      const providerOutcome = await provider.analyze(input)
      if (!devMarkerOutcome) {
        return providerOutcome
      }

      const analysisState = mergeAnalysisState(devMarkerOutcome.analysis_state, providerOutcome.analysis_state)
      return {
        analysis_state: analysisState,
        content_safety_state: analysisState === "review_required" ? "pending" : providerOutcome.content_safety_state,
        age_gate_policy: providerOutcome.age_gate_policy,
        status: analysisState === "review_required" ? "draft" : providerOutcome.status,
      }
    },
  }
}

export function resolvePostAnalysisProvider(env: Env): PostAnalysisProvider {
  return isLocalEnvironment(env.ENVIRONMENT)
    ? withDevMarkers(openAIPostAnalysisProvider)
    : openAIPostAnalysisProvider
}
