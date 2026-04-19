import type { UserRepository } from "../auth/repositories"
import { badRequestError, eligibilityFailed, internalError } from "../errors"
import { nowIso } from "../helpers"
import type {
  Community,
  CreateCommunityRequest,
  User,
} from "../../types"
import { getPrimaryWalletSnapshot } from "./community-serialization"
import type { LocalCommunitySnapshot } from "./community-local-db"

export type CreateCommunityRequestBody = CreateCommunityRequest

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

export type UpdateGateRuleInput = CreateCommunityRequestBody["gate_rules"] extends
  Array<infer T> | null | undefined
  ? Array<T & { gate_rule_id?: string | null }>
  : never

export type UpdateCommunityGatesRequestBody = {
  membership_mode: "open" | "request" | "gated"
  default_age_gate_policy?: "none" | "18_plus" | null
  allow_anonymous_identity: boolean
  anonymous_identity_scope?: "community_stable" | "thread_stable" | "post_ephemeral" | null
  gate_rules?: UpdateGateRuleInput
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

export function normalizeDonationPolicyMode(
  mode: UpdateCommunityDonationPolicyRequestBody["donation_policy_mode"] | LocalCommunitySnapshot["donation_policy_mode"] | string | null | undefined,
): "none" | "optional_creator_sidecar" {
  if (mode === "optional_creator_sidecar" || mode === "fundraiser_default") {
    return "optional_creator_sidecar"
  }
  return "none"
}

const VALID_PUBLIC_V0_PROVIDERS_BY_PROOF_TYPE = {
  unique_human: new Set(["self", "very"]),
  age_over_18: new Set(["self"]),
  nationality: new Set(["self"]),
  gender: new Set(["self"]),
  wallet_score: new Set(["passport"]),
  sanctions_clear: new Set(["passport"]),
} as const

export function assertPublicV0GateConfiguration(
  body: {
    membership_mode?: "open" | "request" | "gated" | null
    default_age_gate_policy?: "none" | "18_plus" | null
    anonymous_identity_scope?: "community_stable" | "thread_stable" | "post_ephemeral" | null
    gate_rules?: CreateCommunityRequestBody["gate_rules"]
  },
  input: {
    ageOver18Verified: boolean
  },
): void {
  if (!["open", "request", "gated"].includes(body.membership_mode ?? "open")) {
    throw eligibilityFailed("Public v0 community creation only allows open, request, or gated membership")
  }
  if ((body.anonymous_identity_scope ?? null) === "post_ephemeral") {
    throw eligibilityFailed("post_ephemeral anonymous scope is not allowed in public v0 community creation")
  }
  if ((body.default_age_gate_policy ?? "none") === "18_plus" && !input.ageOver18Verified) {
    throw eligibilityFailed("age_over_18 verification is required for 18_plus communities")
  }
  if (
    body.gate_rules?.some(
      (rule) => rule.gate_family === "token_holding" || rule.scope === "viewer" || rule.scope === "posting",
    )
  ) {
    throw eligibilityFailed("Public v0 community creation only allows membership-scope identity-proof gates")
  }
  if (body.gate_rules?.some((rule) => rule.gate_type === "sanctions_clear")) {
    throw eligibilityFailed("Public v0 community creation does not support sanctions_clear gates")
  }
  let nationalityGateCount = 0
  let genderGateCount = 0
  for (const rule of body.gate_rules ?? []) {
    for (const requirement of rule.proof_requirements ?? []) {
      const acceptedProviders = requirement.accepted_providers ?? []
      if (acceptedProviders.length === 0) {
        continue
      }

      const validProviders = VALID_PUBLIC_V0_PROVIDERS_BY_PROOF_TYPE[
        requirement.proof_type as keyof typeof VALID_PUBLIC_V0_PROVIDERS_BY_PROOF_TYPE
      ]
      if (!validProviders) {
        continue
      }

      const invalidProviders = acceptedProviders.filter((provider) => !validProviders.has(provider))
      if (invalidProviders.length > 0) {
        throw eligibilityFailed(
          `Invalid accepted_providers for ${requirement.proof_type}: ${invalidProviders.join(", ")}`,
        )
      }
    }
  }
  for (const rule of body.gate_rules ?? []) {
    if (rule.gate_type !== "nationality") {
      if (rule.gate_type !== "gender") {
        continue
      }

      genderGateCount += 1
      if (genderGateCount > 1) {
        throw eligibilityFailed("Public v0 communities support at most one gender gate")
      }

      const requirements = rule.proof_requirements ?? []
      if (requirements.length !== 1 || requirements[0].proof_type !== "gender") {
        throw eligibilityFailed("Gender gate must have exactly one gender proof requirement")
      }

      const requirement = requirements[0]
      const acceptedProviders = requirement.accepted_providers ?? []
      if (acceptedProviders.length !== 1 || acceptedProviders[0] !== "self") {
        throw eligibilityFailed("Gender gate accepted_providers must be exactly [\"self\"]")
      }

      const config = (requirement.config ?? rule.gate_config ?? {}) as Record<string, unknown>
      const requiredValue = typeof config.required_value === "string" ? config.required_value : null
      if (!requiredValue) {
        throw eligibilityFailed("Gender gate requires a required_value in config")
      }
      if (requiredValue !== "M" && requiredValue !== "F") {
        throw eligibilityFailed("Gender gate required_value must be either \"M\" or \"F\"")
      }
      continue
    }

    nationalityGateCount += 1
    if (nationalityGateCount > 1) {
      throw eligibilityFailed("Public v0 communities support at most one nationality gate")
    }

    const requirements = rule.proof_requirements ?? []
    if (requirements.length !== 1 || requirements[0].proof_type !== "nationality") {
      throw eligibilityFailed("Nationality gate must have exactly one nationality proof requirement")
    }

    const requirement = requirements[0]
    const acceptedProviders = requirement.accepted_providers ?? []
    if (acceptedProviders.length !== 1 || acceptedProviders[0] !== "self") {
      throw eligibilityFailed("Nationality gate accepted_providers must be exactly [\"self\"]")
    }

    const config = (requirement.config ?? rule.gate_config ?? {}) as Record<string, unknown>
    const requiredValue = typeof config.required_value === "string" ? config.required_value : null
    if (!requiredValue) {
      throw eligibilityFailed("Nationality gate requires a required_value in config")
    }
    if (!/^[A-Z]{2}$/.test(requiredValue)) {
      throw eligibilityFailed("Nationality gate required_value must match ^[A-Z]{2}$")
    }
  }
}

export function assertCreateRequest(
  body: CreateCommunityRequestBody,
  input: {
    uniqueHumanVerified: boolean
    ageOver18Verified: boolean
  },
): asserts body is CreateCommunityRequestBody & {
  display_name: string
} {
  if (!body.display_name?.trim()) {
    throw badRequestError("display_name is required")
  }
  if (body.avatar_ref != null && typeof body.avatar_ref !== "string") {
    throw badRequestError("avatar_ref must be a string or null")
  }
  if (body.banner_ref != null && typeof body.banner_ref !== "string") {
    throw badRequestError("banner_ref must be a string or null")
  }
  if (body.namespace != null && !body.namespace.namespace_verification_id?.trim()) {
    throw badRequestError("namespace.namespace_verification_id is required when namespace is provided")
  }
  if (!input.uniqueHumanVerified) {
    throw eligibilityFailed("unique_human verification is required")
  }
  if ((body.governance_mode ?? "centralized") !== "centralized") {
    throw eligibilityFailed("Only centralized community creation is allowed in public v0")
  }
  if ((body.handle_policy?.policy_template ?? "standard") !== "standard") {
    throw eligibilityFailed("Public v0 community creation requires the standard handle policy")
  }
  if (body.donation_policy != null) {
    throw eligibilityFailed("Public v0 community creation does not accept donation payloads")
  }
  if (body.community_bootstrap?.label_policy != null || body.community_bootstrap?.resource_links != null) {
    throw eligibilityFailed("Public v0 community creation does not support labels or resource links yet")
  }
  assertPublicV0GateConfiguration(body, input)
}

export type CreateCommunityAuth = {
  userId: string
  user: User
  communityDisplayName: string
  actorPrimaryWalletSnapshot: string | null
  namespaceVerificationId: string | null
  createdAt: string
}

export async function resolveCreateCommunityAuth(input: {
  userId: string
  body: CreateCommunityRequestBody
  userRepository: UserRepository
}): Promise<CreateCommunityAuth> {
  const user = await input.userRepository.getUserById(input.userId)
  if (!user) {
    throw internalError("Resolved user row is missing for community create")
  }

  assertCreateRequest(input.body, {
    uniqueHumanVerified: user.verification_capabilities.unique_human.state === "verified",
    ageOver18Verified: user.verification_capabilities.age_over_18.state === "verified",
  })

  const walletAttachments = await input.userRepository.getWalletAttachmentsByUserId(input.userId)
  const actorPrimaryWalletSnapshot = getPrimaryWalletSnapshot(user, walletAttachments)

  return {
    userId: input.userId,
    user,
    communityDisplayName: input.body.display_name.trim(),
    actorPrimaryWalletSnapshot,
    namespaceVerificationId: input.body.namespace?.namespace_verification_id?.trim() || null,
    createdAt: nowIso(),
  }
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

  if (!["open", "request", "gated"].includes(body.membership_mode)) {
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

  if (body.gate_rules != null && !Array.isArray(body.gate_rules)) {
    throw badRequestError("Invalid gate_rules payload")
  }

  if (Array.isArray(body.gate_rules)) {
    const seenGateRuleIds = new Set<string>()
    for (const rule of body.gate_rules) {
      if (rule.gate_rule_id != null) {
        if (typeof rule.gate_rule_id !== "string") {
          throw badRequestError("Invalid gate_rule_id payload")
        }

        const normalizedGateRuleId = rule.gate_rule_id.trim()
        if (normalizedGateRuleId.length === 0) {
          throw badRequestError("gate_rule_id must not be blank")
        }
        if (seenGateRuleIds.has(normalizedGateRuleId)) {
          throw badRequestError("Duplicate gate_rule_id payload")
        }
        seenGateRuleIds.add(normalizedGateRuleId)
      }
    }
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

export function parseCommunitySettingsJson(
  rawSettingsJson: unknown,
): Record<string, unknown> {
  if (typeof rawSettingsJson !== "string" || rawSettingsJson.trim().length === 0) {
    return {}
  }

  try {
    const parsed = JSON.parse(rawSettingsJson) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {}

  return {}
}

export function parseStoredDonationPartnerSummary(
  settings: Record<string, unknown>,
): (NonNullable<Community["donation_partner"]> & { image_url?: string | null }) | null {
  const rawPartner = settings.donation_partner
  if (!rawPartner || typeof rawPartner !== "object" || Array.isArray(rawPartner)) {
    return null
  }

  const partner = rawPartner as Record<string, unknown>
  if (
    typeof partner.donation_partner_id !== "string"
    || typeof partner.display_name !== "string"
    || partner.provider !== "endaoment"
  ) {
    return null
  }

  return {
    donation_partner_id: partner.donation_partner_id,
    display_name: partner.display_name,
    provider: "endaoment",
    provider_partner_ref: typeof partner.provider_partner_ref === "string" ? partner.provider_partner_ref : null,
    image_url: typeof partner.image_url === "string" ? partner.image_url : null,
    review_status: partner.review_status === "pending" || partner.review_status === "rejected"
      ? partner.review_status
      : "approved",
    status: partner.status === "paused" || partner.status === "retired"
      ? partner.status
      : "active",
  }
}

export function parseEndaomentLookupTerm(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) {
    return null
  }

  if (/^\d{9}$/u.test(trimmed)) {
    return trimmed
  }

  try {
    const url = new URL(trimmed)
    const host = url.hostname.toLowerCase()
    if (!host.endsWith("endaoment.org")) {
      return null
    }

    const segments = url.pathname.split("/").filter(Boolean)
    if (segments.length >= 2 && segments[0] === "orgs" && segments[1].trim()) {
      return decodeURIComponent(segments[1].trim())
    }
  } catch {
    return null
  }

  return null
}

export type EndaomentOrganizationSearchResult = {
  id: string
  ein?: string | null
  name: string
  logo?: string | null
  isCompliant?: boolean
}

export function selectEndaomentOrganizationMatch(
  organizations: EndaomentOrganizationSearchResult[],
  lookupTerm: string,
): EndaomentOrganizationSearchResult | null {
  const normalizedLookupTerm = lookupTerm.trim().toLowerCase()
  const exactEin = organizations.find((org) => (org.ein ?? "").trim().toLowerCase() === normalizedLookupTerm)
  if (exactEin) {
    return exactEin
  }

  return organizations.find((org) => org.id.trim().toLowerCase() === normalizedLookupTerm) ?? organizations[0] ?? null
}
