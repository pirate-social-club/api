import type { Env } from "../../env"
import type { Community } from "../../types"
import { buildDefaultVisualPolicySettings } from "../communities/community-policy-defaults"
import {
  firstTrimmedEnv,
  parsePositiveIntegerEnv,
  requestOpenRouterChatCompletion,
} from "../openrouter-client"

type VisualPolicyAction = "allow" | "queue" | "reject"
type VisualPolicyDisclosureAction = "allow" | "allow_with_disclosure" | "queue" | "reject"
type VisualPolicySettings = Community["visual_policy_settings"]

export type VisualClassifierFacts = {
  visualStyle: "photographic" | "anime_manga" | "furry_anthro" | "ai_generated" | "meme_screenshot"
  characterContext: "real_person" | "fictional_stylized" | "synthetic_realistic" | "anthro_furry"
  apparentAgeRisk: "adult" | "possible_minor" | "uncertain" | "not_applicable"
  nudity: "none" | "topless" | "lower_body_unclothed_obscured" | "buttocks_visible" | "genitals_visible"
  visibleNipples: boolean | "uncertain"
  sexualActivity: "none" | "implied" | "explicit"
  sexualizedContact: boolean | "uncertain"
  masturbation: boolean | "uncertain"
  oralSex: boolean | "uncertain"
  sexToy: "none" | "packaging_or_ad" | "visible_not_in_use" | "in_use" | "uncertain"
  voyeuristicOrHiddenCamera: boolean | "uncertain"
  commercialSignal: "none" | "watermark" | "adult_platform_watermark" | "product_promotion" | "payment_handle"
  syntheticRisk: "none" | "likely_ai_generated" | "deepfake_or_face_swap_risk" | "celebrity_adult_likeness"
  imageTextSignal: "none" | "url" | "qr_code" | "payment_handle"
  safetySignal: "none" | "weapons" | "gore_or_injury" | "drugs" | "hate_symbols" | "personal_documents"
  quality: "clear" | "low_quality" | "uncertain"
}

export type VisualPolicyResolvedDecision = {
  policyDecision: VisualPolicyAction
  reasonCodes: string[]
  adultSignal: boolean
}

export type VisualPolicyProviderResult = {
  provider: "visual_policy_vlm"
  model: string
  factsByImage: Array<{
    image_url: string
    facts: VisualClassifierFacts
    decision: VisualPolicyResolvedDecision
  }>
  decision: VisualPolicyResolvedDecision
}

const VISUAL_CLASSIFIER_PROMPT = `You are a visual content classification engine for community safety.

Classify only visible content in the image. Return only valid JSON. Use neutral, clinical labels. Do not identify real people. Do not infer exact age. If the image is unclear, use "uncertain".

Schema:
{
  "visualStyle": "photographic" | "anime_manga" | "furry_anthro" | "ai_generated" | "meme_screenshot",
  "characterContext": "real_person" | "fictional_stylized" | "synthetic_realistic" | "anthro_furry",
  "apparentAgeRisk": "adult" | "possible_minor" | "uncertain" | "not_applicable",
  "nudity": "none" | "topless" | "lower_body_unclothed_obscured" | "buttocks_visible" | "genitals_visible",
  "visibleNipples": true | false | "uncertain",
  "sexualActivity": "none" | "implied" | "explicit",
  "sexualizedContact": true | false | "uncertain",
  "masturbation": true | false | "uncertain",
  "oralSex": true | false | "uncertain",
  "sexToy": "none" | "packaging_or_ad" | "visible_not_in_use" | "in_use" | "uncertain",
  "voyeuristicOrHiddenCamera": true | false | "uncertain",
  "commercialSignal": "none" | "watermark" | "adult_platform_watermark" | "product_promotion" | "payment_handle",
  "syntheticRisk": "none" | "likely_ai_generated" | "deepfake_or_face_swap_risk" | "celebrity_adult_likeness",
  "imageTextSignal": "none" | "url" | "qr_code" | "payment_handle",
  "safetySignal": "none" | "weapons" | "gore_or_injury" | "drugs" | "hate_symbols" | "personal_documents",
  "quality": "clear" | "low_quality" | "uncertain"
}`

function resolveVisualPolicyOpenRouterModel(env: Env): string {
  return firstTrimmedEnv(env.OPENROUTER_VISUAL_POLICY_MODEL) || "x-ai/grok-4.3"
}

function actionSeverity(action: VisualPolicyAction | VisualPolicyDisclosureAction): number {
  if (action === "reject") return 3
  if (action === "queue" || action === "allow_with_disclosure") return 2
  return 1
}

function stricterAction(left: VisualPolicyAction, right: VisualPolicyAction | VisualPolicyDisclosureAction): VisualPolicyAction {
  if (actionSeverity(right) > actionSeverity(left)) {
    return right === "allow_with_disclosure" ? "queue" : right
  }
  return left
}

function isAdultSignal(facts: VisualClassifierFacts): boolean {
  return facts.nudity !== "none"
    || facts.visibleNipples === true
    || facts.sexualActivity !== "none"
    || facts.sexualizedContact === true
    || facts.masturbation === true
    || facts.oralSex === true
    || facts.sexToy === "visible_not_in_use"
    || facts.sexToy === "in_use"
}

export function resolveVisualPolicyDecision(
  settings: VisualPolicySettings,
  facts: VisualClassifierFacts,
): VisualPolicyResolvedDecision {
  let decision: VisualPolicyAction = "allow"
  const reasonCodes: string[] = []

  function apply(action: VisualPolicyAction | VisualPolicyDisclosureAction, reason: string) {
    if (action !== "allow") {
      reasonCodes.push(reason)
    }
    decision = stricterAction(decision, action)
  }

  const adultSignal = isAdultSignal(facts)
  if (facts.apparentAgeRisk === "possible_minor" && adultSignal) apply(settings.possible_minor_with_adult_content, "possible_minor_with_adult_content")
  if (facts.apparentAgeRisk === "uncertain" && adultSignal) apply(settings.uncertain_age_with_adult_content, "uncertain_age_with_adult_content")
  if (facts.quality !== "clear" && adultSignal) apply(settings.low_quality_adult_image, "low_quality_adult_image")

  if (facts.visualStyle === "anime_manga") apply(settings.anime_manga, "anime_manga")
  if (facts.visualStyle === "furry_anthro" || facts.characterContext === "anthro_furry") apply(settings.furry_anthro, "furry_anthro")
  if (facts.characterContext === "fictional_stylized" && facts.nudity !== "none") apply(settings.fictional_nudity, "fictional_nudity")
  if (facts.characterContext === "fictional_stylized" && facts.sexualActivity === "explicit") apply(settings.fictional_explicit_sex, "fictional_explicit_sex")

  if (facts.nudity === "topless") apply(settings.topless, "topless_nudity")
  if (facts.nudity === "lower_body_unclothed_obscured") apply(settings.bottomless_obscured, "bottomless_obscured")
  if (facts.nudity === "buttocks_visible") apply(settings.visible_buttocks, "visible_buttocks")
  if (facts.nudity === "genitals_visible") apply(settings.visible_genitals, "visible_genitals")
  if (facts.visibleNipples === true) apply(settings.visible_nipples, "visible_nipples")

  if (facts.sexualActivity === "implied") apply(settings.implied_sexual_activity, "implied_sexual_activity")
  if (facts.sexualActivity === "explicit") apply(settings.explicit_sexual_activity, "explicit_sexual_activity")
  if (facts.sexualizedContact === true) apply(settings.sexualized_contact, "sexualized_contact")
  if (facts.masturbation === true) apply(settings.masturbation, "masturbation")
  if (facts.oralSex === true) apply(settings.oral_sex, "oral_sex")
  if (facts.sexToy === "packaging_or_ad") apply(settings.sex_toy_packaging, "sex_toy_packaging")
  if (facts.sexToy === "visible_not_in_use") apply(settings.sex_toy_visible, "sex_toy_visible")
  if (facts.sexToy === "in_use") apply(settings.sex_toy_in_use, "sex_toy_in_use")
  if (facts.voyeuristicOrHiddenCamera === true) apply(settings.voyeuristic_or_hidden_camera, "voyeuristic_or_hidden_camera")

  if (
    facts.visibleNipples === "uncertain"
    || facts.sexualizedContact === "uncertain"
    || facts.masturbation === "uncertain"
    || facts.oralSex === "uncertain"
    || facts.sexToy === "uncertain"
    || facts.voyeuristicOrHiddenCamera === "uncertain"
  ) {
    apply(settings.model_uncertain, "model_uncertain")
  }

  if (facts.syntheticRisk === "likely_ai_generated") apply(adultSignal ? settings.ai_generated_adult_images : settings.ai_generated_images, "ai_generated")
  if (facts.syntheticRisk === "deepfake_or_face_swap_risk") apply(settings.deepfake_or_face_swap_risk, "deepfake_or_face_swap_risk")
  if (facts.syntheticRisk === "celebrity_adult_likeness") apply(settings.celebrity_adult_likeness, "celebrity_adult_likeness")

  if (facts.commercialSignal === "watermark") apply(settings.watermark, "watermark")
  if (facts.commercialSignal === "adult_platform_watermark") apply(settings.adult_platform_watermark, "adult_platform_watermark")
  if (facts.commercialSignal === "product_promotion") apply(settings.product_promotion, "product_promotion")
  if (facts.commercialSignal === "payment_handle") apply(settings.payment_handle, "payment_handle_commercial")
  if (facts.imageTextSignal === "url") apply(settings.urls_in_image, "url_in_image")
  if (facts.imageTextSignal === "qr_code") apply(settings.qr_code, "qr_code")
  if (facts.imageTextSignal === "payment_handle") apply(settings.payment_handle, "payment_handle_ocr")

  if (facts.safetySignal === "weapons") apply(settings.weapons, "weapons")
  if (facts.safetySignal === "gore_or_injury") apply(settings.gore_or_injury, "gore_or_injury")
  if (facts.safetySignal === "drugs") apply(settings.drugs, "drugs")
  if (facts.safetySignal === "hate_symbols") apply(settings.hate_symbols, "hate_symbols")
  if (facts.safetySignal === "personal_documents") apply(settings.personal_documents, "personal_documents")

  return {
    policyDecision: decision,
    reasonCodes: [...new Set(reasonCodes)],
    adultSignal,
  }
}

export function combineVisualPolicyDecisions(decisions: VisualPolicyResolvedDecision[]): VisualPolicyResolvedDecision {
  let policyDecision: VisualPolicyAction = "allow"
  const reasonCodes: string[] = []
  let adultSignal = false
  for (const decision of decisions) {
    policyDecision = stricterAction(policyDecision, decision.policyDecision)
    reasonCodes.push(...decision.reasonCodes)
    adultSignal ||= decision.adultSignal
  }
  return {
    policyDecision,
    reasonCodes: [...new Set(reasonCodes)],
    adultSignal,
  }
}

function normalizeBoolean(value: unknown): boolean | "uncertain" | null {
  return value === true || value === false || value === "uncertain" ? value : null
}

function normalizeEnum<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? value as T : null
}

export function normalizeVisualClassifierFacts(value: unknown): VisualClassifierFacts | null {
  if (!value || typeof value !== "object") return null
  const record = value as Record<string, unknown>
  const facts = {
    visualStyle: normalizeEnum(record.visualStyle, ["photographic", "anime_manga", "furry_anthro", "ai_generated", "meme_screenshot"] as const),
    characterContext: normalizeEnum(record.characterContext, ["real_person", "fictional_stylized", "synthetic_realistic", "anthro_furry"] as const),
    apparentAgeRisk: normalizeEnum(record.apparentAgeRisk, ["adult", "possible_minor", "uncertain", "not_applicable"] as const),
    nudity: normalizeEnum(record.nudity, ["none", "topless", "lower_body_unclothed_obscured", "buttocks_visible", "genitals_visible"] as const),
    visibleNipples: normalizeBoolean(record.visibleNipples),
    sexualActivity: normalizeEnum(record.sexualActivity, ["none", "implied", "explicit"] as const),
    sexualizedContact: normalizeBoolean(record.sexualizedContact),
    masturbation: normalizeBoolean(record.masturbation),
    oralSex: normalizeBoolean(record.oralSex),
    sexToy: normalizeEnum(record.sexToy, ["none", "packaging_or_ad", "visible_not_in_use", "in_use", "uncertain"] as const),
    voyeuristicOrHiddenCamera: normalizeBoolean(record.voyeuristicOrHiddenCamera),
    commercialSignal: normalizeEnum(record.commercialSignal, ["none", "watermark", "adult_platform_watermark", "product_promotion", "payment_handle"] as const),
    syntheticRisk: normalizeEnum(record.syntheticRisk, ["none", "likely_ai_generated", "deepfake_or_face_swap_risk", "celebrity_adult_likeness"] as const),
    imageTextSignal: normalizeEnum(record.imageTextSignal, ["none", "url", "qr_code", "payment_handle"] as const),
    safetySignal: normalizeEnum(record.safetySignal, ["none", "weapons", "gore_or_injury", "drugs", "hate_symbols", "personal_documents"] as const),
    quality: normalizeEnum(record.quality, ["clear", "low_quality", "uncertain"] as const),
  }
  return Object.values(facts).every((field) => field != null) ? facts as VisualClassifierFacts : null
}

function extractJsonObject(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    const match = text.match(/\{[\s\S]*\}/)
    return match ? JSON.parse(match[0]) : null
  }
}

export async function classifyVisualFactsWithVlm(input: {
  env: Env
  imageUrl: string
}): Promise<{ facts: VisualClassifierFacts; raw: unknown; model: string } | null> {
  const apiKey = firstTrimmedEnv(input.env.OPENROUTER_API_KEY)
  if (!apiKey) return null
  const model = resolveVisualPolicyOpenRouterModel(input.env)
  const timeoutMs = parsePositiveIntegerEnv(firstTrimmedEnv(
    input.env.OPENROUTER_VISUAL_POLICY_TIMEOUT_MS,
    input.env.OPENROUTER_TIMEOUT_MS,
  ))

  try {
    const { content } = await requestOpenRouterChatCompletion({
      apiKey,
      baseUrl: input.env.OPENROUTER_BASE_URL,
      errorLabel: "visual policy",
      timeoutMs,
      body: {
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [{
          role: "user",
          content: [
            { type: "text", text: VISUAL_CLASSIFIER_PROMPT },
            { type: "image_url", image_url: { url: input.imageUrl } },
          ],
        }],
      },
    })
    const raw = extractJsonObject(content)
    const facts = normalizeVisualClassifierFacts(raw)
    return facts ? { facts, raw, model } : null
  } catch {
    return null
  }
}

export async function resolveVisualPolicyProviderResult(input: {
  env: Env
  community: Community
  imageUrls: string[]
}): Promise<VisualPolicyProviderResult | null> {
  const factsByImage: VisualPolicyProviderResult["factsByImage"] = []
  const settings = input.community.visual_policy_settings
    ?? buildDefaultVisualPolicySettings(
      input.community.community_id,
      input.community.updated_at ?? new Date().toISOString(),
    )
  for (const imageUrl of input.imageUrls) {
    const classified = await classifyVisualFactsWithVlm({ env: input.env, imageUrl })
    if (!classified) return null
    const decision = resolveVisualPolicyDecision(settings, classified.facts)
    factsByImage.push({ image_url: imageUrl, facts: classified.facts, decision })
  }
  if (!factsByImage.length) return null
  return {
    provider: "visual_policy_vlm",
    model: resolveVisualPolicyOpenRouterModel(input.env),
    factsByImage,
    decision: combineVisualPolicyDecisions(factsByImage.map((entry) => entry.decision)),
  }
}
