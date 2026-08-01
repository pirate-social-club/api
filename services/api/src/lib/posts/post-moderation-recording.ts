import type { DbExecutor } from "../db-helpers"
import {
  createModerationCase,
  createModerationSignal,
} from "../moderation/community-moderation-store"
import type { ModerationSignalSeverity } from "../moderation/moderation-types"

const HIGH_SEVERITY_VISUAL_REASON_CODES = new Set([
  "possible_minor_with_adult_content",
  "explicit_sexual_activity",
  "visible_genitals",
  "voyeuristic_or_hidden_camera",
  "deepfake_or_face_swap_risk",
  "celebrity_adult_likeness",
  "gore_or_injury",
  "hate_symbols",
  "weapons",
])

function readProviderCategories(providerResult: unknown): string[] {
  if (!providerResult || typeof providerResult !== "object" || !("categories" in providerResult)) {
    return []
  }
  const categories = (providerResult as { categories?: unknown }).categories
  if (!categories || typeof categories !== "object") {
    return []
  }
  return Object.keys(categories).filter((key) => (categories as Record<string, unknown>)[key] === true)
}

function readVisualPolicyReasonCodes(providerResult: unknown): string[] {
  if (!providerResult || typeof providerResult !== "object") {
    return []
  }
  const visualPolicy = (providerResult as { visual_policy?: unknown }).visual_policy
  if (!visualPolicy || typeof visualPolicy !== "object") {
    return []
  }
  const decision = (visualPolicy as { decision?: unknown }).decision
  if (!decision || typeof decision !== "object") {
    return []
  }
  const reasonCodes = (decision as { reasonCodes?: unknown }).reasonCodes
  return Array.isArray(reasonCodes) ? reasonCodes.filter((code): code is string => typeof code === "string") : []
}

export function moderationSeverityFromProviderResult(providerResult: unknown): ModerationSignalSeverity {
  const categories = readProviderCategories(providerResult)
  if (categories.some((category) => category === "sexual/minors" || category === "violence/graphic" || category === "self-harm/intent")) {
    return "high"
  }
  const visualReasonCodes = readVisualPolicyReasonCodes(providerResult)
  if (visualReasonCodes.some((code) => HIGH_SEVERITY_VISUAL_REASON_CODES.has(code))) {
    return "high"
  }
  if (categories.length > 0 || visualReasonCodes.length > 0) {
    return "medium"
  }
  return "low"
}

export async function recordReviewRequiredPostModeration(input: {
  executor: DbExecutor
  communityId: string
  postId: string
  providerResult: Record<string, unknown> | null | undefined
  now: string
}): Promise<void> {
  const severity = moderationSeverityFromProviderResult(input.providerResult)
  const moderationCase = await createModerationCase({
    executor: input.executor,
    communityId: input.communityId,
    target: { postId: input.postId },
    priority: severity,
    openedBy: "platform_analysis",
    now: input.now,
  })
  const categories = readProviderCategories(input.providerResult)
  const visualReasonCodes = readVisualPolicyReasonCodes(input.providerResult)
  const signalTypes = categories.length > 0 ? categories : visualReasonCodes
  await createModerationSignal({
    executor: input.executor,
    communityId: input.communityId,
    postId: input.postId,
    moderationCaseId: moderationCase.moderation_case_id,
    signalType: signalTypes.length > 0 ? signalTypes.join(",") : "review_required",
    severity,
    provider: (input.providerResult && typeof input.providerResult === "object" && "provider" in input.providerResult
      ? String((input.providerResult as { provider: string }).provider)
      : "openai"),
    providerLabel: signalTypes.length > 0 ? signalTypes[0] as string : "review_required",
    analysisResultRef: null,
    evidenceRef: input.providerResult ? JSON.stringify(input.providerResult) : null,
    now: input.now,
  })
}
