import type { Community } from "../../../types"
import type { GatePolicy } from "../membership/gate-types"
import type { LocalCommunitySnapshot } from "../community-local-db"
import { badRequestError } from "../../errors"
import { validateGatePolicy } from "../membership/gate-policy-validation"

export type UpdateCommunityRulesRequestBody = {
  rules: Array<{
    rule_id?: string | null
    title: string
    body: string
    report_reason?: string | null
    position?: number | null
    status?: "active" | "archived" | null
  }>
}

export type UpdateCommunitySafetyRequestBody = {
  adult_content_policy: {
    suggestive: Community["adult_content_policy"]["suggestive"]
    artistic_nudity: Community["adult_content_policy"]["artistic_nudity"]
    explicit_nudity: Community["adult_content_policy"]["explicit_nudity"]
    explicit_sexual_content: Community["adult_content_policy"]["explicit_sexual_content"]
    fetish_content: Community["adult_content_policy"]["fetish_content"]
  }
  graphic_content_policy: {
    injury_medical: Community["graphic_content_policy"]["injury_medical"]
    gore: Community["graphic_content_policy"]["gore"]
    extreme_gore: Community["graphic_content_policy"]["extreme_gore"]
    body_horror_disturbing: Community["graphic_content_policy"]["body_horror_disturbing"]
    animal_harm: Community["graphic_content_policy"]["animal_harm"]
  }
  civility_policy: {
    group_directed_demeaning_language: Community["civility_policy"]["group_directed_demeaning_language"]
    targeted_insults: Community["civility_policy"]["targeted_insults"]
    targeted_harassment: Community["civility_policy"]["targeted_harassment"]
    threatening_language: Community["civility_policy"]["threatening_language"]
  }
  openai_moderation_settings: NonNullable<Community["openai_moderation_settings"]>
}

export type UpdateCommunityGatesRequestBody = {
  membership_mode: "request" | "gated"
  default_age_gate_policy?: "none" | "18_plus" | null
  allow_anonymous_identity: boolean
  anonymous_identity_scope?: "community_stable" | "thread_stable" | "post_ephemeral" | null
  gate_policy?: GatePolicy | null
}

export type UpdateCommunityReferenceLinksRequestBody = {
  reference_links: Array<{
    community_reference_link_id?: string | null
    platform: NonNullable<Community["reference_links"]>[number]["platform"]
    url: string
    label?: string | null
    position?: number | null
  }>
}

export type UpdateCommunityLabelPolicyRequestBody = {
  label_enabled: boolean
  require_label_on_top_level_posts: boolean
  definitions: Array<{
    label_id?: string | null
    label: string
    color_token?: string | null
    status: "active" | "archived"
    position?: number | null
  }>
}

export type UpdateCommunityDonationPolicyRequestBody = {
  donation_policy_mode: "none" | "optional_creator_sidecar" | "fundraiser_default"
  donation_partner_id?: string | null
  donation_partner?: {
    donation_partner_id: string
    display_name: string
    provider: "endaoment"
    provider_partner_ref?: string | null
    image_url?: string | null
  } | null
}

export type UpdateCommunityRequestBody = {
  display_name?: string | null
  description?: string | null
  avatar_ref?: string | null
  banner_ref?: string | null
  agent_posting_policy?: "disallow" | "review" | "allow_with_disclosure" | "allow" | null
  agent_posting_scope?: "replies_only" | "top_level_and_replies" | null
  agent_daily_post_cap?: number | null
  agent_daily_reply_cap?: number | null
  human_verification_lane?: "self" | "very" | null
  accepted_agent_ownership_providers?: Array<"self_agent_id" | "clawkey"> | null
}

export function normalizeDonationPolicyMode(
  mode: UpdateCommunityDonationPolicyRequestBody["donation_policy_mode"] | LocalCommunitySnapshot["donation_policy_mode"] | string | null | undefined,
): "none" | "optional_creator_sidecar" {
  if (mode === "optional_creator_sidecar" || mode === "fundraiser_default") {
    return "optional_creator_sidecar"
  }
  return "none"
}

function isModerationDecisionLevel(
  value: unknown,
): value is Community["adult_content_policy"]["suggestive"] {
  return value === "allow" || value === "review" || value === "disallow"
}

function isEscalationDecisionLevel(
  value: unknown,
): value is Community["civility_policy"]["threatening_language"] {
  return value === "review" || value === "disallow"
}

export function assertUpdateCommunitySafetyRequest(
  body: UpdateCommunitySafetyRequestBody | null,
): asserts body is UpdateCommunitySafetyRequestBody {
  if (!body) {
    throw badRequestError("Invalid community safety payload")
  }

  const adult = body.adult_content_policy
  const graphic = body.graphic_content_policy
  const civility = body.civility_policy
  const openai = body.openai_moderation_settings

  if (
    !adult
    || !isModerationDecisionLevel(adult.suggestive)
    || !isModerationDecisionLevel(adult.artistic_nudity)
    || !isModerationDecisionLevel(adult.explicit_nudity)
    || !isModerationDecisionLevel(adult.explicit_sexual_content)
    || !isModerationDecisionLevel(adult.fetish_content)
  ) {
    throw badRequestError("Invalid adult_content_policy payload")
  }

  if (
    !graphic
    || !isModerationDecisionLevel(graphic.injury_medical)
    || !isModerationDecisionLevel(graphic.gore)
    || !isModerationDecisionLevel(graphic.extreme_gore)
    || !isModerationDecisionLevel(graphic.body_horror_disturbing)
    || !isModerationDecisionLevel(graphic.animal_harm)
  ) {
    throw badRequestError("Invalid graphic_content_policy payload")
  }

  if (
    !civility
    || !isModerationDecisionLevel(civility.group_directed_demeaning_language)
    || !isModerationDecisionLevel(civility.targeted_insults)
    || !isModerationDecisionLevel(civility.targeted_harassment)
    || !isEscalationDecisionLevel(civility.threatening_language)
  ) {
    throw badRequestError("Invalid civility_policy payload")
  }

  if (
    !openai
    || typeof openai.scan_titles !== "boolean"
    || typeof openai.scan_post_bodies !== "boolean"
    || typeof openai.scan_captions !== "boolean"
    || typeof openai.scan_link_preview_text !== "boolean"
    || typeof openai.scan_images !== "boolean"
  ) {
    throw badRequestError("Invalid openai_moderation_settings payload")
  }
}

export function assertUpdateCommunityGatesRequest(
  body: UpdateCommunityGatesRequestBody | null,
): asserts body is UpdateCommunityGatesRequestBody {
  if (!body) {
    throw badRequestError("Invalid community gates payload")
  }

  if (!["request", "gated"].includes(body.membership_mode)) {
    throw badRequestError("Invalid membership_mode payload")
  }

  if (typeof body.allow_anonymous_identity !== "boolean") {
    throw badRequestError("Invalid allow_anonymous_identity payload")
  }

  if (
    body.anonymous_identity_scope != null
    && body.anonymous_identity_scope !== "community_stable"
    && body.anonymous_identity_scope !== "thread_stable"
    && body.anonymous_identity_scope !== "post_ephemeral"
  ) {
    throw badRequestError("Invalid anonymous_identity_scope payload")
  }

  if (
    body.default_age_gate_policy != null
    && body.default_age_gate_policy !== "none"
    && body.default_age_gate_policy !== "18_plus"
  ) {
    throw badRequestError("Invalid default_age_gate_policy payload")
  }

  if (body.membership_mode === "request" && body.gate_policy != null) {
    throw badRequestError("Request membership cannot include gate_policy")
  }

  if (body.membership_mode === "gated" && body.gate_policy == null) {
    throw badRequestError("Gated membership requires gate_policy")
  }

  if (body.gate_policy != null) {
    body.gate_policy = validateGatePolicy(body.gate_policy)
  }
}

export function assertUpdateCommunityReferenceLinksRequest(
  body: UpdateCommunityReferenceLinksRequestBody | null,
): asserts body is UpdateCommunityReferenceLinksRequestBody {
  if (!body || !Array.isArray(body.reference_links)) {
    throw badRequestError("Invalid community reference links payload")
  }

  for (const link of body.reference_links) {
    if (typeof link?.platform !== "string" || link.platform.trim().length === 0) {
      throw badRequestError("Invalid reference link platform")
    }
    if (typeof link?.url !== "string" || link.url.trim().length === 0) {
      throw badRequestError("Invalid reference link url")
    }
    if (link.community_reference_link_id != null && typeof link.community_reference_link_id !== "string") {
      throw badRequestError("Invalid community_reference_link_id payload")
    }
    if (link.label != null && typeof link.label !== "string") {
      throw badRequestError("Invalid reference link label")
    }
  }
}

export function assertUpdateCommunityLabelPolicyRequest(
  body: UpdateCommunityLabelPolicyRequestBody | null,
): asserts body is UpdateCommunityLabelPolicyRequestBody {
  if (
    !body
    || typeof body.label_enabled !== "boolean"
    || typeof body.require_label_on_top_level_posts !== "boolean"
    || !Array.isArray(body.definitions)
  ) {
    throw badRequestError("Invalid community label policy payload")
  }

  const seenLabelIds = new Set<string>()
  const seenActiveLabelNames = new Set<string>()

  for (const definition of body.definitions) {
    if (!definition || typeof definition !== "object") {
      throw badRequestError("Invalid community label definition payload")
    }
    if (definition.label_id != null) {
      if (typeof definition.label_id !== "string") {
        throw badRequestError("Invalid label_id payload")
      }

      const normalizedLabelId = definition.label_id.trim()
      if (normalizedLabelId.length === 0) {
        throw badRequestError("label_id must not be blank")
      }
      if (seenLabelIds.has(normalizedLabelId)) {
        throw badRequestError("Duplicate label_id payload")
      }
      seenLabelIds.add(normalizedLabelId)
    }
    if (typeof definition.label !== "string" || definition.label.trim().length === 0) {
      throw badRequestError("Invalid label payload")
    }
    if (
      definition.color_token != null
      && (
        typeof definition.color_token !== "string"
        || !/^#[0-9a-fA-F]{6}$/u.test(definition.color_token.trim())
      )
    ) {
      throw badRequestError("Invalid color_token payload")
    }
    if (definition.status !== "active" && definition.status !== "archived") {
      throw badRequestError("Invalid label status payload")
    }
    if (
      definition.position != null
      && (!Number.isInteger(definition.position) || definition.position < 0)
    ) {
      throw badRequestError("Invalid label position payload")
    }

    if (definition.status === "active") {
      const normalizedLabelName = definition.label.trim().toLowerCase()
      if (seenActiveLabelNames.has(normalizedLabelName)) {
        throw badRequestError("Label names must be unique")
      }
      seenActiveLabelNames.add(normalizedLabelName)
    }
  }
}

export function assertUpdateCommunityRequest(
  body: UpdateCommunityRequestBody | null,
): asserts body is UpdateCommunityRequestBody {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw badRequestError("Invalid community update payload")
  }

  const hasSupportedField =
    "display_name" in body
    || "description" in body
    || "avatar_ref" in body
    || "banner_ref" in body
    || "agent_posting_policy" in body
    || "agent_posting_scope" in body
    || "agent_daily_post_cap" in body
    || "agent_daily_reply_cap" in body
    || "human_verification_lane" in body
    || "accepted_agent_ownership_providers" in body

  if (!hasSupportedField) {
    throw badRequestError("No supported community settings were provided")
  }

  if (
    body.display_name !== undefined
    && body.display_name !== null
    && (typeof body.display_name !== "string" || body.display_name.trim().length === 0)
  ) {
    throw badRequestError("Invalid display_name payload")
  }

  if (
    body.description !== undefined
    && body.description !== null
    && typeof body.description !== "string"
  ) {
    throw badRequestError("Invalid description payload")
  }

  if (
    body.avatar_ref !== undefined
    && body.avatar_ref !== null
    && typeof body.avatar_ref !== "string"
  ) {
    throw badRequestError("Invalid avatar_ref payload")
  }

  if (
    body.banner_ref !== undefined
    && body.banner_ref !== null
    && typeof body.banner_ref !== "string"
  ) {
    throw badRequestError("Invalid banner_ref payload")
  }

  if (
    body.agent_posting_policy !== undefined
    && body.agent_posting_policy !== null
    && body.agent_posting_policy !== "disallow"
    && body.agent_posting_policy !== "review"
    && body.agent_posting_policy !== "allow_with_disclosure"
    && body.agent_posting_policy !== "allow"
  ) {
    throw badRequestError("Invalid agent_posting_policy payload")
  }

  if (
    body.agent_posting_scope !== undefined
    && body.agent_posting_scope !== null
    && body.agent_posting_scope !== "replies_only"
    && body.agent_posting_scope !== "top_level_and_replies"
  ) {
    throw badRequestError("Invalid agent_posting_scope payload")
  }

  if (
    body.human_verification_lane !== undefined
    && body.human_verification_lane !== null
    && body.human_verification_lane !== "self"
    && body.human_verification_lane !== "very"
  ) {
    throw badRequestError("Invalid human_verification_lane payload")
  }

  if (
    body.agent_daily_post_cap !== undefined
    && body.agent_daily_post_cap !== null
    && (!Number.isInteger(body.agent_daily_post_cap) || body.agent_daily_post_cap < 1)
  ) {
    throw badRequestError("Invalid agent_daily_post_cap payload")
  }

  if (
    body.agent_daily_reply_cap !== undefined
    && body.agent_daily_reply_cap !== null
    && (!Number.isInteger(body.agent_daily_reply_cap) || body.agent_daily_reply_cap < 1)
  ) {
    throw badRequestError("Invalid agent_daily_reply_cap payload")
  }

  if (body.accepted_agent_ownership_providers !== undefined && body.accepted_agent_ownership_providers !== null) {
    if (!Array.isArray(body.accepted_agent_ownership_providers)) {
      throw badRequestError("Invalid accepted_agent_ownership_providers payload")
    }

    for (const provider of body.accepted_agent_ownership_providers) {
      if (provider !== "self_agent_id" && provider !== "clawkey") {
        throw badRequestError("Invalid accepted_agent_ownership_providers payload")
      }
    }
  }
}
