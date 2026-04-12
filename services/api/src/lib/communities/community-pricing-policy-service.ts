import type {
  CommunityPricingCountryAssignment,
  CommunityPricingPolicy,
  CommunityPricingTier,
  Env,
  UpdateCommunityPricingPolicyRequest,
} from "../../types"
import type { CommunityPricingPolicyRow, CommunityRow } from "../auth/control-plane-auth-rows"
import type { CommunityRepository } from "./control-plane-community-repository"
import { badRequestError, eligibilityFailed, notFoundError } from "../errors"
import { verifyPirateAccessToken } from "../auth/pirate-session-token"
import { nowIso } from "../helpers"
import { assertNonEmptyString, assertNullableString, isRecord } from "../validation"

function parseJsonArray<T>(value: string, fieldName: string): T[] {
  const parsed = JSON.parse(value) as unknown
  if (!Array.isArray(parsed)) {
    throw badRequestError(`${fieldName} stored value is invalid`)
  }
  return parsed as T[]
}

function resolveDefaultCommunityPricingPolicy(community: CommunityRow): CommunityPricingPolicy {
  return {
    community_id: community.community_id,
    policy_origin: "default",
    pricing_policy_version: "default",
    regional_pricing_enabled: false,
    verification_provider_requirement: null,
    default_tier_key: null,
    tiers: [],
    country_assignments: [],
    source_template_id: null,
    source_template_version: null,
    updated_at: community.updated_at,
  }
}

function serializeCommunityPricingPolicy(
  community: CommunityRow,
  row: CommunityPricingPolicyRow | null,
): CommunityPricingPolicy {
  if (!row) {
    return resolveDefaultCommunityPricingPolicy(community)
  }

  return {
    community_id: community.community_id,
    policy_origin: "explicit",
    pricing_policy_version: row.pricing_policy_version,
    regional_pricing_enabled: row.regional_pricing_enabled === 1,
    verification_provider_requirement: row.verification_provider_requirement ?? null,
    default_tier_key: row.default_tier_key,
    tiers: parseJsonArray<CommunityPricingTier>(row.tiers_json, "tiers"),
    country_assignments: parseJsonArray<CommunityPricingCountryAssignment>(
      row.country_assignments_json,
      "country_assignments",
    ),
    source_template_id: row.source_template_id,
    source_template_version: row.source_template_version,
    updated_at: row.updated_at,
  }
}

function assertCommunityPricingTier(value: unknown, fieldName: string): asserts value is CommunityPricingTier {
  if (!isRecord(value)) {
    throw badRequestError(`${fieldName} must be an object`)
  }
  assertNonEmptyString(value.tier_key, `${fieldName}.tier_key`)
  assertNullableString(value.display_name, `${fieldName}.display_name`)
  if (value.adjustment_type !== "multiplier" && value.adjustment_type !== "fixed_price_usd") {
    throw badRequestError(`${fieldName}.adjustment_type is invalid`)
  }
  if (typeof value.adjustment_value !== "number" || !Number.isFinite(value.adjustment_value) || value.adjustment_value < 0) {
    throw badRequestError(`${fieldName}.adjustment_value must be a non-negative number`)
  }
}

function assertCommunityPricingCountryAssignment(
  value: unknown,
  fieldName: string,
): asserts value is CommunityPricingCountryAssignment {
  if (!isRecord(value)) {
    throw badRequestError(`${fieldName} must be an object`)
  }
  assertNonEmptyString(value.country_code, `${fieldName}.country_code`)
  assertNonEmptyString(value.tier_key, `${fieldName}.tier_key`)
  if (String(value.country_code).trim().length !== 2) {
    throw badRequestError(`${fieldName}.country_code must be a two-letter country code`)
  }
}

function assertCommunityPricingPolicyRequest(
  value: unknown,
): asserts value is UpdateCommunityPricingPolicyRequest {
  if (!isRecord(value)) {
    throw badRequestError("Invalid community pricing policy payload")
  }

  if (typeof value.regional_pricing_enabled !== "boolean") {
    throw badRequestError("regional_pricing_enabled must be a boolean")
  }
  if (value.verification_provider_requirement != null && value.verification_provider_requirement !== "self") {
    throw badRequestError("verification_provider_requirement is invalid")
  }
  assertNullableString(value.default_tier_key, "default_tier_key")
  assertNullableString(value.source_template_id, "source_template_id")
  assertNullableString(value.source_template_version, "source_template_version")

  if (!Array.isArray(value.tiers)) {
    throw badRequestError("tiers must be an array")
  }
  if (!Array.isArray(value.country_assignments)) {
    throw badRequestError("country_assignments must be an array")
  }

  value.tiers.forEach((tier, index) => assertCommunityPricingTier(tier, `tiers[${index}]`))
  value.country_assignments.forEach((assignment, index) => {
    assertCommunityPricingCountryAssignment(assignment, `country_assignments[${index}]`)
  })

  const tierKeys = new Set<string>()
  for (const tier of value.tiers) {
    const tierKey = tier.tier_key.trim()
    if (tierKeys.has(tierKey)) {
      throw eligibilityFailed(`Duplicate pricing tier key: ${tierKey}`)
    }
    tierKeys.add(tierKey)
  }

  if (value.default_tier_key != null && !tierKeys.has(value.default_tier_key.trim())) {
    throw eligibilityFailed("default_tier_key must reference an existing tier")
  }

  const assignedCountryCodes = new Set<string>()
  for (const assignment of value.country_assignments) {
    const countryCode = assignment.country_code.trim().toUpperCase()
    if (assignedCountryCodes.has(countryCode)) {
      throw eligibilityFailed(`Duplicate country assignment: ${countryCode}`)
    }
    assignedCountryCodes.add(countryCode)
    if (!tierKeys.has(assignment.tier_key.trim())) {
      throw eligibilityFailed(`country assignment references unknown tier: ${assignment.tier_key}`)
    }
  }

  if (value.regional_pricing_enabled) {
    if (value.tiers.length === 0) {
      throw eligibilityFailed("regional_pricing_enabled communities must define at least one pricing tier")
    }
    if (value.verification_provider_requirement !== "self") {
      throw eligibilityFailed("regional pricing currently requires verification_provider_requirement = self")
    }
  }
}

async function requireCommunity(repo: CommunityRepository, communityId: string): Promise<CommunityRow> {
  const community = await repo.getCommunityById(communityId)
  if (!community) {
    throw notFoundError("Community not found")
  }
  return community
}

export async function resolveCommunityPricingPolicy(input: {
  repository: CommunityRepository
  communityId: string
}): Promise<CommunityPricingPolicy> {
  const community = await requireCommunity(input.repository, input.communityId)
  const row = await input.repository.getCommunityPricingPolicyByCommunityId(input.communityId)
  return serializeCommunityPricingPolicy(community, row)
}

export async function getCommunityPricingPolicy(input: {
  env: Env
  bearerToken: string
  communityId: string
  repository: CommunityRepository
}): Promise<CommunityPricingPolicy> {
  await verifyPirateAccessToken({
    token: input.bearerToken,
    env: input.env,
  })
  return resolveCommunityPricingPolicy({
    repository: input.repository,
    communityId: input.communityId,
  })
}

export async function updateCommunityPricingPolicy(input: {
  env: Env
  bearerToken: string
  communityId: string
  body: unknown
  repository: CommunityRepository
}): Promise<CommunityPricingPolicy> {
  const session = await verifyPirateAccessToken({
    token: input.bearerToken,
    env: input.env,
  })
  assertCommunityPricingPolicyRequest(input.body)

  const community = await requireCommunity(input.repository, input.communityId)
  if (community.creator_user_id !== session.userId) {
    throw notFoundError("Community not found")
  }

  const updatedAt = nowIso()
  await input.repository.upsertCommunityPricingPolicy({
    communityId: input.communityId,
    regionalPricingEnabled: input.body.regional_pricing_enabled,
    verificationProviderRequirement: input.body.verification_provider_requirement ?? null,
    defaultTierKey: input.body.default_tier_key ?? null,
    tiersJson: JSON.stringify(input.body.tiers),
    countryAssignmentsJson: JSON.stringify(
      input.body.country_assignments.map((assignment) => ({
        ...assignment,
        country_code: assignment.country_code.trim().toUpperCase(),
        tier_key: assignment.tier_key.trim(),
      })),
    ),
    sourceTemplateId: input.body.source_template_id ?? null,
    sourceTemplateVersion: input.body.source_template_version ?? null,
    pricingPolicyVersion: updatedAt,
    updatedAt,
  })

  const row = await input.repository.getCommunityPricingPolicyByCommunityId(input.communityId)
  if (!row) {
    throw notFoundError("Community pricing policy not found")
  }
  return serializeCommunityPricingPolicy(community, row)
}
