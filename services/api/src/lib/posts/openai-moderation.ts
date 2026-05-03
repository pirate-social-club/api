import type { Env } from "../../env"
import type { Community, CreatePostRequest, Post } from "../../types"
import { buildDefaultAdultContentPolicy } from "../communities/community-policy-defaults"

type ModerationDecisionLevel = "allow" | "allow_with_gate" | "review" | "disallow"

type AdultContentPolicy = Community["adult_content_policy"]

type OpenAIModerationSettings = NonNullable<Community["openai_moderation_settings"]>

type OpenAIModerationResult = {
  flagged?: boolean
  categories?: Record<string, boolean>
  category_scores?: Record<string, number>
  category_applied_input_types?: Record<string, string[]>
}

type ModerationInput = Array<{
  type: "image_url"
  image_url: { url: string }
}>

export type PostModerationOutcome = Pick<Post, "analysis_state" | "content_safety_state" | "status" | "age_gate_policy"> & {
  providerResult: Record<string, unknown> | null
}

const DEFAULT_OPENAI_MODERATION_SETTINGS: Required<OpenAIModerationSettings> = {
  scan_titles: true,
  scan_post_bodies: true,
  scan_captions: true,
  scan_link_preview_text: true,
  scan_images: true,
}
const DEFAULT_SEXUAL_MINORS_BLOCK_THRESHOLD = 0.95

function trimEnv(value: string | undefined): string {
  return String(value || "").trim()
}

function mergeSettings(settings: OpenAIModerationSettings | null | undefined): Required<OpenAIModerationSettings> {
  return {
    ...DEFAULT_OPENAI_MODERATION_SETTINGS,
    ...(settings ?? {}),
  }
}

function isModeratableImageUrl(value: unknown): value is string {
  return typeof value === "string" && /^https?:\/\//i.test(value.trim())
}

function collectModerationInput(body: CreatePostRequest, settings: Required<OpenAIModerationSettings>): ModerationInput {
  const input: ModerationInput = []

  if (!settings.scan_images || !Array.isArray(body.media_refs)) {
    return input
  }

  if (body.post_type === "image") {
    for (const ref of body.media_refs) {
      if (isModeratableImageUrl(ref.storage_ref) && String(ref.mime_type || "").toLowerCase().startsWith("image/")) {
        input.push({
          type: "image_url",
          image_url: { url: ref.storage_ref.trim() },
        })
      }
    }
  }

  if (body.post_type === "video") {
    for (const ref of body.media_refs) {
      if (isModeratableImageUrl(ref.poster_ref)) {
        input.push({
          type: "image_url",
          image_url: { url: ref.poster_ref.trim() },
        })
      }
    }
  }

  return input
}

function flagged(categories: Record<string, boolean>, category: string): boolean {
  return categories[category] === true
}

function parseThreshold(value: string | undefined): number {
  const parsed = Number.parseFloat(trimEnv(value))
  if (!Number.isFinite(parsed)) {
    return DEFAULT_SEXUAL_MINORS_BLOCK_THRESHOLD
  }
  return Math.min(1, Math.max(0, parsed))
}

function highestCategoryScore(results: OpenAIModerationResult[], category: string): number {
  return results.reduce((highest, result) => {
    const score = result.category_scores?.[category]
    return typeof score === "number" && Number.isFinite(score) ? Math.max(highest, score) : highest
  }, 0)
}

type PolicyDecisionLevel = "allow" | "review" | "disallow"

export function moreRestrictive(left: PolicyDecisionLevel, right: PolicyDecisionLevel): PolicyDecisionLevel {
  const precedence: Record<PolicyDecisionLevel, number> = { disallow: 3, review: 2, allow: 1 }
  return precedence[left] >= precedence[right] ? left : right
}

export function resolveAdultContentPolicy(community: Community): AdultContentPolicy {
  if (community.adult_content_policy) {
    return community.adult_content_policy
  }
  return buildDefaultAdultContentPolicy(
    community.community_id,
    community.updated_at ?? new Date().toISOString(),
    community.default_age_gate_policy ?? "none",
  )
}

export function resolveVisualPlatformDecision(
  categories: Record<string, boolean>,
  results: OpenAIModerationResult[],
  sexualMinorsBlockThreshold: number,
  adultContentPolicy: AdultContentPolicy,
): ModerationDecisionLevel {
  const sexualMinorsScore = highestCategoryScore(results, "sexual/minors")
  if (flagged(categories, "sexual/minors") && sexualMinorsScore >= sexualMinorsBlockThreshold) {
    return "disallow"
  }

  if (flagged(categories, "sexual")) {
    const nudityPolicy: PolicyDecisionLevel = adultContentPolicy.explicit_nudity
    const sexualContentPolicy: PolicyDecisionLevel = adultContentPolicy.explicit_sexual_content
    const combined = moreRestrictive(nudityPolicy, sexualContentPolicy)

    if (combined === "disallow") {
      return "disallow"
    }
    if (combined === "review") {
      return "review"
    }
    return "allow_with_gate"
  }

  return "allow"
}

export function outcomeFromDecision(decision: ModerationDecisionLevel, providerResult: Record<string, unknown> | null): PostModerationOutcome {
  if (decision === "disallow") {
    return {
      analysis_state: "blocked",
      content_safety_state: "pending",
      status: "draft",
      age_gate_policy: "none",
      providerResult,
    }
  }
  if (decision === "review") {
    return {
      analysis_state: "review_required",
      content_safety_state: "pending",
      status: "draft",
      age_gate_policy: "none",
      providerResult,
    }
  }
  if (decision === "allow_with_gate") {
    return {
      analysis_state: "allow",
      content_safety_state: "adult",
      status: "published",
      age_gate_policy: "18_plus",
      providerResult,
    }
  }
  return {
    analysis_state: "allow",
    content_safety_state: "safe",
    status: "published",
    age_gate_policy: "none",
    providerResult,
  }
}

function normalizeModerationResults(body: unknown): OpenAIModerationResult[] | null {
  if (!body || typeof body !== "object") {
    return null
  }
  const results = (body as { results?: unknown }).results
  if (!Array.isArray(results)) {
    return null
  }
  return results.filter((result): result is OpenAIModerationResult => Boolean(result && typeof result === "object"))
}

export async function resolveOpenAIModerationOutcome(input: {
  env: Env
  community: Community
  body: CreatePostRequest
}): Promise<PostModerationOutcome> {
  const settings = mergeSettings(input.community.openai_moderation_settings)
  const moderationInput = collectModerationInput(input.body, settings)
  if (!moderationInput.length) {
    return outcomeFromDecision("allow", null)
  }

  const apiKey = trimEnv(input.env.OPENAI_API_KEY)
  if (!apiKey) {
    return outcomeFromDecision("allow", {
      provider: "openai",
      error: "missing_configuration",
    })
  }

  const baseUrl = trimEnv(input.env.OPENAI_MODERATION_BASE_URL) || "https://api.openai.com/v1"
  const model = trimEnv(input.env.OPENAI_MODERATION_MODEL) || "omni-moderation-latest"
  const sexualMinorsBlockThreshold = parseThreshold(input.env.OPENAI_MODERATION_SEXUAL_MINORS_BLOCK_THRESHOLD)
  const timeoutMs = Number.parseInt(trimEnv(input.env.OPENAI_MODERATION_TIMEOUT_MS) || "", 10)
  const controller = new AbortController()
  const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null

  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/moderations`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: moderationInput,
      }),
      signal: controller.signal,
    })
    if (!response.ok) {
      return outcomeFromDecision("review", {
        provider: "openai",
        model,
        error: `http_${response.status}`,
      })
    }

    const parsed = await response.json().catch(() => null)
    const results = normalizeModerationResults(parsed)
    if (!results) {
      return outcomeFromDecision("review", {
        provider: "openai",
        model,
        error: "invalid_response",
        provider_result: parsed,
      })
    }

    const categories = results.reduce<Record<string, boolean>>((merged, result) => {
      const resultCategories = result.categories ?? {}
      for (const [category, value] of Object.entries(resultCategories)) {
        merged[category] = merged[category] === true || value === true
      }
      return merged
    }, {})
    const adultContentPolicy = resolveAdultContentPolicy(input.community)
    const decision = resolveVisualPlatformDecision(categories, results, sexualMinorsBlockThreshold, adultContentPolicy)
    return outcomeFromDecision(decision, {
      provider: "openai",
      model,
      provider_result: parsed as Record<string, unknown>,
      categories,
      sexual_minors_score: highestCategoryScore(results, "sexual/minors"),
      sexual_score: highestCategoryScore(results, "sexual"),
      sexual_minors_block_threshold: sexualMinorsBlockThreshold,
      decision,
    })
  } catch (error) {
    return outcomeFromDecision("review", {
      provider: "openai",
      model,
      error: error instanceof Error ? error.message : String(error),
    })
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}
