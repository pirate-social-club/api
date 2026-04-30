import { executeFirst } from "../../db-helpers"
import { nowIso } from "../../helpers"
import { getControlPlaneClient } from "../../runtime-deps"
import type { CommunityReadRepository } from "../db-community-repository"
import {
  boolToSqlite,
  numberOrNull,
  parseJsonValue,
  requiredString,
  sqliteToBool,
  stringOrNull,
} from "./row-types"
import { requireCommunityOwner } from "./access"
import {
  buildDefaultPirateCheckoutMoneyPolicy,
} from "./checkout-config"
import type {
  CommunityMoneyPolicy,
  CommunityPricingPolicy,
  Env,
  UpdateCommunityMoneyPolicyRequest,
  UpdateCommunityPricingPolicyRequest,
} from "../../../types"

function defaultMoneyPolicy(env: Env, communityId: string): CommunityMoneyPolicy {
  return buildDefaultPirateCheckoutMoneyPolicy({ env, communityId })
}

function defaultPricingPolicy(communityId: string): CommunityPricingPolicy {
  return {
    id: `cpp_${communityId}`,
    object: "community_pricing_policy",
    policy_origin: "default",
    pricing_policy_version: "default",
    regional_pricing_enabled: false,
    verification_provider_requirement: null,
    default_tier_key: null,
    tiers: [],
    country_assignments: [],
    source_template: null,
    source_template_version: null,
  }
}

export async function getCommunityMoneyPolicy(input: {
  env: Env
  communityId: string
}): Promise<CommunityMoneyPolicy> {
  const client = getControlPlaneClient(input.env)
  const row = await executeFirst(client, {
    sql: `
      SELECT community_id, funding_preference, accepted_funding_assets_json, accepted_source_chains_json,
             approved_route_providers_json, destination_settlement_chain_json, destination_settlement_token,
             treasury_denomination, max_slippage_bps, quote_ttl_seconds, route_required, route_status_policy,
             route_hop_tolerance, updated_at
      FROM community_money_policies
      WHERE community_id = ?1
      LIMIT 1
    `,
    args: [input.communityId],
  })
  if (!row) {
    return defaultMoneyPolicy(input.env, input.communityId)
  }
  return {
    id: `cmp_${requiredString(row, "community_id")}`,
    object: "community_money_policy",
    policy_origin: "explicit",
    funding_preference: requiredString(row, "funding_preference"),
    accepted_funding_assets: parseJsonValue(requiredString(row, "accepted_funding_assets_json"), []),
    accepted_source_chains: parseJsonValue(requiredString(row, "accepted_source_chains_json"), []),
    approved_route_providers: parseJsonValue(stringOrNull(row, "approved_route_providers_json"), null),
    destination_settlement_chain: parseJsonValue(requiredString(row, "destination_settlement_chain_json"), {
      chain_namespace: "eip155",
      chain_id: 1315,
      display_name: "Story Aeneid",
    }),
    destination_settlement_token: requiredString(row, "destination_settlement_token"),
    treasury_denomination: stringOrNull(row, "treasury_denomination"),
    max_slippage_bps: Number(numberOrNull(row, "max_slippage_bps") ?? 0),
    quote_ttl_seconds: Number(numberOrNull(row, "quote_ttl_seconds") ?? 0),
    route_required: sqliteToBool((row as Record<string, unknown>).route_required),
    route_status_policy: requiredString(row, "route_status_policy") as CommunityMoneyPolicy["route_status_policy"],
    route_hop_tolerance: Number(numberOrNull(row, "route_hop_tolerance") ?? 0),
  }
}

export async function updateCommunityMoneyPolicy(input: {
  env: Env
  userId: string
  communityId: string
  body: UpdateCommunityMoneyPolicyRequest
  communityRepository: CommunityReadRepository
}): Promise<CommunityMoneyPolicy> {
  await requireCommunityOwner({
    communityId: input.communityId,
    userId: input.userId,
    communityRepository: input.communityRepository,
  })
  const client = getControlPlaneClient(input.env)
  const updatedAt = nowIso()
  const current = await getCommunityMoneyPolicy({ env: input.env, communityId: input.communityId })
  const body = input.body as Partial<UpdateCommunityMoneyPolicyRequest>
  const next = {
    funding_preference: body.funding_preference ?? current.funding_preference,
    accepted_funding_assets: body.accepted_funding_assets ?? current.accepted_funding_assets,
    accepted_source_chains: body.accepted_source_chains ?? current.accepted_source_chains,
    approved_route_providers: "approved_route_providers" in body
      ? body.approved_route_providers ?? null
      : current.approved_route_providers,
    destination_settlement_chain: body.destination_settlement_chain ?? current.destination_settlement_chain,
    destination_settlement_token: body.destination_settlement_token ?? current.destination_settlement_token,
    treasury_denomination: "treasury_denomination" in body
      ? body.treasury_denomination ?? null
      : current.treasury_denomination,
    max_slippage_bps: body.max_slippage_bps ?? current.max_slippage_bps,
    quote_ttl_seconds: body.quote_ttl_seconds ?? current.quote_ttl_seconds,
    route_required: body.route_required ?? current.route_required,
    route_status_policy: body.route_status_policy ?? current.route_status_policy,
    route_hop_tolerance: body.route_hop_tolerance ?? current.route_hop_tolerance,
  }
  await client.execute({
    sql: `
      INSERT INTO community_money_policies (
        community_id, funding_preference, accepted_funding_assets_json, accepted_source_chains_json,
        approved_route_providers_json, destination_settlement_chain_json, destination_settlement_token,
        treasury_denomination, max_slippage_bps, quote_ttl_seconds, route_required, route_status_policy,
        route_hop_tolerance, updated_at
      ) VALUES (
        ?1, ?2, ?3, ?4,
        ?5, ?6, ?7,
        ?8, ?9, ?10, ?11, ?12,
        ?13, ?14
      )
      ON CONFLICT(community_id) DO UPDATE SET
        funding_preference = excluded.funding_preference,
        accepted_funding_assets_json = excluded.accepted_funding_assets_json,
        accepted_source_chains_json = excluded.accepted_source_chains_json,
        approved_route_providers_json = excluded.approved_route_providers_json,
        destination_settlement_chain_json = excluded.destination_settlement_chain_json,
        destination_settlement_token = excluded.destination_settlement_token,
        treasury_denomination = excluded.treasury_denomination,
        max_slippage_bps = excluded.max_slippage_bps,
        quote_ttl_seconds = excluded.quote_ttl_seconds,
        route_required = excluded.route_required,
        route_status_policy = excluded.route_status_policy,
        route_hop_tolerance = excluded.route_hop_tolerance,
        updated_at = excluded.updated_at
    `,
    args: [
      input.communityId,
      next.funding_preference,
      JSON.stringify(next.accepted_funding_assets),
      JSON.stringify(next.accepted_source_chains),
      next.approved_route_providers ? JSON.stringify(next.approved_route_providers) : null,
      JSON.stringify(next.destination_settlement_chain),
      next.destination_settlement_token,
      next.treasury_denomination,
      next.max_slippage_bps,
      next.quote_ttl_seconds,
      boolToSqlite(next.route_required),
      next.route_status_policy,
      next.route_hop_tolerance,
      updatedAt,
    ],
  })
  return await getCommunityMoneyPolicy({ env: input.env, communityId: input.communityId })
}

export async function getCommunityPricingPolicy(input: {
  env: Env
  communityId: string
}): Promise<CommunityPricingPolicy> {
  const client = getControlPlaneClient(input.env)
  const row = await executeFirst(client, {
    sql: `
      SELECT community_id, regional_pricing_enabled, verification_provider_requirement, default_tier_key,
             tiers_json, country_assignments_json, source_template_id, source_template_version,
             pricing_policy_version, updated_at
      FROM community_pricing_policies
      WHERE community_id = ?1
      LIMIT 1
    `,
    args: [input.communityId],
  })
  if (!row) {
    return defaultPricingPolicy(input.communityId)
  }
  return {
    id: `cpp_${requiredString(row, "community_id")}`,
    object: "community_pricing_policy",
    policy_origin: "explicit",
    pricing_policy_version: requiredString(row, "pricing_policy_version"),
    regional_pricing_enabled: sqliteToBool((row as Record<string, unknown>).regional_pricing_enabled),
    verification_provider_requirement: stringOrNull(row, "verification_provider_requirement") as CommunityPricingPolicy["verification_provider_requirement"],
    default_tier_key: stringOrNull(row, "default_tier_key"),
    tiers: parseJsonValue(requiredString(row, "tiers_json"), []),
    country_assignments: parseJsonValue(requiredString(row, "country_assignments_json"), []),
    source_template: stringOrNull(row, "source_template_id"),
    source_template_version: stringOrNull(row, "source_template_version"),
  }
}

export async function updateCommunityPricingPolicy(input: {
  env: Env
  userId: string
  communityId: string
  body: UpdateCommunityPricingPolicyRequest
  communityRepository: CommunityReadRepository
}): Promise<CommunityPricingPolicy> {
  await requireCommunityOwner({
    communityId: input.communityId,
    userId: input.userId,
    communityRepository: input.communityRepository,
  })
  const client = getControlPlaneClient(input.env)
  const updatedAt = nowIso()
  const policyVersion = `cpp_${updatedAt}`
  const current = await getCommunityPricingPolicy({ env: input.env, communityId: input.communityId })
  const body = input.body as Partial<UpdateCommunityPricingPolicyRequest>
  const next = {
    regional_pricing_enabled: body.regional_pricing_enabled ?? current.regional_pricing_enabled,
    verification_provider_requirement: "verification_provider_requirement" in body
      ? body.verification_provider_requirement ?? null
      : current.verification_provider_requirement,
    default_tier_key: "default_tier_key" in body
      ? body.default_tier_key ?? null
      : current.default_tier_key,
    tiers: body.tiers ?? current.tiers,
    country_assignments: body.country_assignments ?? current.country_assignments,
    source_template: "source_template" in body
      ? body.source_template ?? null
      : current.source_template,
    source_template_version: "source_template_version" in body
      ? body.source_template_version ?? null
      : current.source_template_version,
  }
  await client.execute({
    sql: `
      INSERT INTO community_pricing_policies (
        community_id, regional_pricing_enabled, verification_provider_requirement, default_tier_key,
        tiers_json, country_assignments_json, source_template_id, source_template_version,
        pricing_policy_version, updated_at
      ) VALUES (
        ?1, ?2, ?3, ?4,
        ?5, ?6, ?7, ?8,
        ?9, ?10
      )
      ON CONFLICT(community_id) DO UPDATE SET
        regional_pricing_enabled = excluded.regional_pricing_enabled,
        verification_provider_requirement = excluded.verification_provider_requirement,
        default_tier_key = excluded.default_tier_key,
        tiers_json = excluded.tiers_json,
        country_assignments_json = excluded.country_assignments_json,
        source_template_id = excluded.source_template_id,
        source_template_version = excluded.source_template_version,
        pricing_policy_version = excluded.pricing_policy_version,
        updated_at = excluded.updated_at
    `,
    args: [
      input.communityId,
      boolToSqlite(next.regional_pricing_enabled),
      next.verification_provider_requirement,
      next.default_tier_key,
      JSON.stringify(next.tiers),
      JSON.stringify(next.country_assignments),
      next.source_template,
      next.source_template_version,
      policyVersion,
      updatedAt,
    ],
  })
  return await getCommunityPricingPolicy({ env: input.env, communityId: input.communityId })
}
