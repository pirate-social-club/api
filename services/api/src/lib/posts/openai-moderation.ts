import type { Env } from "../../env"
import type { Community, CreatePostRequest, Post } from "../../types"
import { buildDefaultAdultContentPolicy } from "../communities/community-policy-defaults"
import {
  resolveVisualPolicyProviderResult,
  type VisualPolicyProviderResult,
} from "./visual-policy-analysis"

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

const ADULT_CATEGORIES = new Set(["sexual", "sexual/minors"])

function hasSexualCategory(categories: Record<string, boolean> | undefined): boolean {
  if (!categories) return false
  return Object.entries(categories).some(([key, flagged]) => flagged && ADULT_CATEGORIES.has(key))
}

function hasVisualAdultSignal(providerResult: Record<string, unknown> | null): boolean {
  const visualPolicy = providerResult?.visual_policy
  if (!visualPolicy || typeof visualPolicy !== "object") return false
  const decision = (visualPolicy as { decision?: unknown }).decision
  return Boolean(decision && typeof decision === "object" && (decision as { adultSignal?: unknown }).adultSignal === true)
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
  options: { ignoreBroadSexualCategory?: boolean } = {},
): ModerationDecisionLevel {
  const sexualMinorsScore = highestCategoryScore(results, "sexual/minors")
  if (flagged(categories, "sexual/minors") && sexualMinorsScore >= sexualMinorsBlockThreshold) {
    return "disallow"
  }

  if (flagged(categories, "sexual") && !options.ignoreBroadSexualCategory) {
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

function moderationDecisionSeverity(decision: ModerationDecisionLevel): number {
  if (decision === "disallow") return 4
  if (decision === "review") return 3
  if (decision === "allow_with_gate") return 2
  return 1
}

export function combineModerationDecision(
  left: ModerationDecisionLevel,
  right: ModerationDecisionLevel,
): ModerationDecisionLevel {
  return moderationDecisionSeverity(left) >= moderationDecisionSeverity(right) ? left : right
}

export function moderationDecisionFromVisualPolicy(result: VisualPolicyProviderResult | null): ModerationDecisionLevel {
  if (!result) return "allow"
  if (result.decision.policyDecision === "reject") return "disallow"
  if (result.decision.policyDecision === "queue") return "review"
  return result.decision.adultSignal ? "allow_with_gate" : "allow"
}

function shouldRunVisualPolicy(community: Community): boolean {
  return community.default_age_gate_policy === "18_plus"
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
    const hasAdultCategories = providerResult && typeof providerResult === "object"
      && "categories" in providerResult
      && hasSexualCategory(providerResult.categories as Record<string, boolean> | undefined)
    const hasAdultSignal = hasAdultCategories || hasVisualAdultSignal(providerResult)
    return {
      analysis_state: "review_required",
      content_safety_state: hasAdultSignal ? "adult" : "pending",
      status: "draft",
      age_gate_policy: hasAdultSignal ? "18_plus" : "none",
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
    console.info("[moderation] skipped — no images to scan", { post_type: input.body.post_type })
    return outcomeFromDecision("allow", null)
  }

  const useVisualPolicy = shouldRunVisualPolicy(input.community)
  const imageUrls = moderationInput.map((item) => item.image_url.url)
  const visualPolicyResult = useVisualPolicy
    ? await resolveVisualPolicyProviderResult({
        env: input.env,
        community: input.community,
        imageUrls,
      })
    : null
  const visualPolicyDecision = moderationDecisionFromVisualPolicy(visualPolicyResult)

  const apiKey = trimEnv(input.env.OPENAI_API_KEY)
  if (!apiKey) {
    console.warn("[moderation] review required — missing OPENAI_API_KEY")
    return outcomeFromDecision(combineModerationDecision("review", visualPolicyDecision), {
      provider: "openai",
      error: "missing_configuration",
      visual_policy: visualPolicyResult,
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
      return outcomeFromDecision(combineModerationDecision("review", visualPolicyDecision), {
        provider: "openai",
        model,
        error: `http_${response.status}`,
        visual_policy: visualPolicyResult,
      })
    }

    const parsed = await response.json().catch(() => null)
    const results = normalizeModerationResults(parsed)
    if (!results) {
      return outcomeFromDecision(combineModerationDecision("review", visualPolicyDecision), {
        provider: "openai",
        model,
        error: "invalid_response",
        provider_result: parsed,
        visual_policy: visualPolicyResult,
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
    const platformDecision = resolveVisualPlatformDecision(categories, results, sexualMinorsBlockThreshold, adultContentPolicy, {
      ignoreBroadSexualCategory: useVisualPolicy,
    })
    const decision = combineModerationDecision(platformDecision, visualPolicyDecision)
    console.info("[moderation] visual decision", {
      categories: Object.keys(categories).filter(k => categories[k]),
      sexual_minors_score: highestCategoryScore(results, "sexual/minors"),
      sexual_score: highestCategoryScore(results, "sexual"),
      sexual_minors_block_threshold: sexualMinorsBlockThreshold,
      adult_content_policy: {
        explicit_nudity: adultContentPolicy.explicit_nudity,
        explicit_sexual_content: adultContentPolicy.explicit_sexual_content,
      },
      platform_decision: platformDecision,
      visual_policy_decision: visualPolicyResult?.decision.policyDecision ?? "not_configured",
      visual_policy_enabled: useVisualPolicy,
      decision,
      community_id: input.community.community_id,
      post_type: input.body.post_type,
    })
    return outcomeFromDecision(decision, {
      provider: "openai",
      model,
      provider_result: parsed as Record<string, unknown>,
      categories,
      sexual_minors_score: highestCategoryScore(results, "sexual/minors"),
      sexual_score: highestCategoryScore(results, "sexual"),
      sexual_minors_block_threshold: sexualMinorsBlockThreshold,
      visual_policy: visualPolicyResult,
      decision,
    })
  } catch (error) {
    return outcomeFromDecision(combineModerationDecision("review", visualPolicyDecision), {
      provider: "openai",
      model,
      error: error instanceof Error ? error.message : String(error),
      visual_policy: visualPolicyResult,
    })
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}
