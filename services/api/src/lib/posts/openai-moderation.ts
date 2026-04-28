import type { Community, CreatePostRequest, Env, Post } from "../../types"

type ModerationDecisionLevel = "allow" | "review" | "disallow"

type OpenAIModerationSettings = NonNullable<Community["openai_moderation_settings"]>

type OpenAIModerationResult = {
  flagged?: boolean
  categories?: Record<string, boolean>
  category_scores?: Record<string, number>
  category_applied_input_types?: Record<string, string[]>
}

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

function trimEnv(value: string | undefined): string {
  return String(value || "").trim()
}

function mergeSettings(settings: OpenAIModerationSettings | null | undefined): Required<OpenAIModerationSettings> {
  return {
    ...DEFAULT_OPENAI_MODERATION_SETTINGS,
    ...(settings ?? {}),
  }
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function isModeratableImageUrl(value: unknown): value is string {
  return typeof value === "string" && /^https?:\/\//i.test(value.trim())
}

function collectModerationInput(body: CreatePostRequest, settings: Required<OpenAIModerationSettings>): Array<string | {
  type: "text"
  text: string
} | {
  type: "image_url"
  image_url: { url: string }
}> {
  const input: Array<string | { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = []
  const textParts: string[] = []

  if (settings.scan_titles && hasText(body.title)) {
    textParts.push(`Title:\n${body.title.trim()}`)
  }
  if (settings.scan_post_bodies && hasText(body.body)) {
    textParts.push(`Body:\n${body.body.trim()}`)
  }
  if (settings.scan_captions && hasText(body.caption)) {
    textParts.push(`Caption:\n${body.caption.trim()}`)
  }

  if (textParts.length) {
    input.push({ type: "text", text: textParts.join("\n\n") })
  }

  if (settings.scan_images && Array.isArray(body.media_refs)) {
    for (const ref of body.media_refs) {
      if (isModeratableImageUrl(ref.storage_ref) && String(ref.mime_type || "").toLowerCase().startsWith("image/")) {
        input.push({
          type: "image_url",
          image_url: { url: ref.storage_ref.trim() },
        })
      }
    }
  }

  return input
}

function highestDecision(left: ModerationDecisionLevel, right: ModerationDecisionLevel): ModerationDecisionLevel {
  const precedence: Record<ModerationDecisionLevel, number> = {
    disallow: 3,
    review: 2,
    allow: 1,
  }
  return precedence[left] >= precedence[right] ? left : right
}

function flagged(categories: Record<string, boolean>, category: string): boolean {
  return categories[category] === true
}

function resolvePolicyDecision(
  community: Community,
  categories: Record<string, boolean>,
): ModerationDecisionLevel {
  let decision: ModerationDecisionLevel = "allow"

  if (flagged(categories, "sexual/minors")) {
    decision = highestDecision(decision, "disallow")
  }
  if (flagged(categories, "sexual")) {
    decision = highestDecision(decision, community.adult_content_policy.explicit_sexual_content)
  }
  if (flagged(categories, "violence/graphic")) {
    decision = highestDecision(decision, community.graphic_content_policy.gore)
  }
  if (flagged(categories, "violence")) {
    decision = highestDecision(decision, community.graphic_content_policy.injury_medical)
  }
  if (flagged(categories, "harassment")) {
    decision = highestDecision(decision, community.civility_policy.targeted_harassment)
  }
  if (flagged(categories, "harassment/threatening")) {
    decision = highestDecision(decision, community.civility_policy.threatening_language === "disallow" ? "disallow" : "review")
  }
  if (flagged(categories, "hate")) {
    decision = highestDecision(decision, community.civility_policy.group_directed_demeaning_language)
  }
  if (flagged(categories, "hate/threatening")) {
    decision = highestDecision(decision, community.civility_policy.threatening_language === "disallow" ? "disallow" : "review")
  }
  if (
    flagged(categories, "self-harm")
    || flagged(categories, "self-harm/intent")
    || flagged(categories, "self-harm/instructions")
    || flagged(categories, "illicit")
    || flagged(categories, "illicit/violent")
  ) {
    decision = highestDecision(decision, "review")
  }

  return decision
}

function resolveContentSafetyState(categories: Record<string, boolean>): Post["content_safety_state"] {
  if (flagged(categories, "sexual") || flagged(categories, "sexual/minors")) {
    return "adult"
  }
  if (Object.values(categories).some(Boolean)) {
    return "sensitive"
  }
  return "safe"
}

function outcomeFromDecision(
  decision: ModerationDecisionLevel,
  contentSafetyState: Post["content_safety_state"],
  providerResult: Record<string, unknown> | null,
): PostModerationOutcome {
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
  return {
    analysis_state: "allow",
    content_safety_state: contentSafetyState,
    status: "published",
    age_gate_policy: contentSafetyState === "adult" ? "18_plus" : "none",
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

function formatModerationInput(
  input: ReturnType<typeof collectModerationInput>,
): string | ReturnType<typeof collectModerationInput> {
  if (input.length === 1) {
    const single = input[0]
    if (typeof single === "object" && "type" in single && single.type === "text") {
      return single.text
    }
  }

  return input
}

export async function resolveOpenAIModerationOutcome(input: {
  env: Env
  community: Community
  body: CreatePostRequest
}): Promise<PostModerationOutcome> {
  const settings = mergeSettings(input.community.openai_moderation_settings)
  const moderationInput = collectModerationInput(input.body, settings)
  if (!moderationInput.length) {
    return outcomeFromDecision("allow", "safe", null)
  }

  const apiKey = trimEnv(input.env.OPENAI_API_KEY)
  if (!apiKey) {
    return outcomeFromDecision("allow", "safe", {
      provider: "openai",
      error: "missing_configuration",
    })
  }

  const baseUrl = trimEnv(input.env.OPENAI_MODERATION_BASE_URL) || "https://api.openai.com/v1"
  const model = trimEnv(input.env.OPENAI_MODERATION_MODEL) || "omni-moderation-latest"
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
        input: formatModerationInput(moderationInput),
      }),
      signal: controller.signal,
    })
    if (!response.ok) {
      return outcomeFromDecision("review", "pending", {
        provider: "openai",
        model,
        error: `http_${response.status}`,
      })
    }

    const parsed = await response.json().catch(() => null)
    const results = normalizeModerationResults(parsed)
    if (!results) {
      return outcomeFromDecision("review", "pending", {
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
    const decision = resolvePolicyDecision(input.community, categories)
    const contentSafetyState = resolveContentSafetyState(categories)
    return outcomeFromDecision(decision, contentSafetyState, {
      provider: "openai",
      model,
      provider_result: parsed as Record<string, unknown>,
      categories,
      decision,
    })
  } catch (error) {
    return outcomeFromDecision("review", "pending", {
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
