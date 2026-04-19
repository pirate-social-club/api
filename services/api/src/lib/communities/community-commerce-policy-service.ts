import { executeFirst } from "../db-helpers"
import { nowIso } from "../helpers"
import { getControlPlaneClient } from "../runtime-deps"
import type { CommunityRepository } from "./db-community-repository"
import {
  boolToSqlite,
  numberOrNull,
  parseJsonValue,
  requireCommunityOwner,
  requiredString,
  sqliteToBool,
  stringOrNull,
} from "./community-commerce-shared"
import type {
  CommunityMoneyPolicy,
  CommunityPricingPolicy,
  Env,
  UpdateCommunityMoneyPolicyRequest,
  UpdateCommunityPricingPolicyRequest,
} from "../../types"

function defaultMoneyPolicy(communityId: string): CommunityMoneyPolicy {
  return {
    community_id: communityId,
    policy_origin: "default",
    funding_preference: "WIP",
    accepted_funding_assets: [{
      asset_symbol: "WIP",
      chain_namespace: "eip155",
      chain_id: 1315,
      display_name: "WIP",
    }],
    accepted_source_chains: [{
      chain_namespace: "eip155",
      chain_id: 1315,
      display_name: "Story Aeneid",
    }],
    approved_route_providers: null,
    destination_settlement_chain: {
      chain_namespace: "eip155",
      chain_id: 1315,
      display_name: "Story Aeneid",
    },
    destination_settlement_token: "WIP",
    treasury_denomination: "WIP",
    max_slippage_bps: 150,
    quote_ttl_seconds: 900,
    route_required: false,
    route_status_policy: "fail",
    route_hop_tolerance: 0,
    updated_at: new Date(0).toISOString(),
  }
}

function defaultPricingPolicy(communityId: string): CommunityPricingPolicy {
  return {
    community_id: communityId,
    policy_origin: "default",
    pricing_policy_version: "default",
    regional_pricing_enabled: false,
    verification_provider_requirement: null,
    default_tier_key: null,
    tiers: [],
    country_assignments: [],
    source_template_id: null,
    source_template_version: null,
    updated_at: new Date(0).toISOString(),
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
    return defaultMoneyPolicy(input.communityId)
  }
  return {
    community_id: requiredString(row, "community_id"),
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
    updated_at: requiredString(row, "updated_at"),
  }
}

export async function updateCommunityMoneyPolicy(input: {
  env: Env
  userId: string
  communityId: string
  body: UpdateCommunityMoneyPolicyRequest
  communityRepository: CommunityRepository
}): Promise<CommunityMoneyPolicy> {
  await requireCommunityOwner({
    communityId: input.communityId,
    userId: input.userId,
    communityRepository: input.communityRepository,
  })
  const client = getControlPlaneClient(input.env)
  const updatedAt = nowIso()
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
      input.body.funding_preference,
      JSON.stringify(input.body.accepted_funding_assets),
      JSON.stringify(input.body.accepted_source_chains),
      input.body.approved_route_providers ? JSON.stringify(input.body.approved_route_providers) : null,
      JSON.stringify(input.body.destination_settlement_chain),
      input.body.destination_settlement_token,
      input.body.treasury_denomination ?? null,
      input.body.max_slippage_bps,
      input.body.quote_ttl_seconds,
      boolToSqlite(input.body.route_required),
      input.body.route_status_policy,
      input.body.route_hop_tolerance,
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
    community_id: requiredString(row, "community_id"),
    policy_origin: "explicit",
    pricing_policy_version: requiredString(row, "pricing_policy_version"),
    regional_pricing_enabled: sqliteToBool((row as Record<string, unknown>).regional_pricing_enabled),
    verification_provider_requirement: stringOrNull(row, "verification_provider_requirement") as CommunityPricingPolicy["verification_provider_requirement"],
    default_tier_key: stringOrNull(row, "default_tier_key"),
    tiers: parseJsonValue(requiredString(row, "tiers_json"), []),
    country_assignments: parseJsonValue(requiredString(row, "country_assignments_json"), []),
    source_template_id: stringOrNull(row, "source_template_id"),
    source_template_version: stringOrNull(row, "source_template_version"),
    updated_at: requiredString(row, "updated_at"),
  }
}

export async function updateCommunityPricingPolicy(input: {
  env: Env
  userId: string
  communityId: string
  body: UpdateCommunityPricingPolicyRequest
  communityRepository: CommunityRepository
}): Promise<CommunityPricingPolicy> {
  await requireCommunityOwner({
    communityId: input.communityId,
    userId: input.userId,
    communityRepository: input.communityRepository,
  })
  const client = getControlPlaneClient(input.env)
  const updatedAt = nowIso()
  const policyVersion = `cpp_${updatedAt}`
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
      boolToSqlite(input.body.regional_pricing_enabled),
      input.body.verification_provider_requirement ?? null,
      input.body.default_tier_key ?? null,
      JSON.stringify(input.body.tiers),
      JSON.stringify(input.body.country_assignments),
      input.body.source_template_id ?? null,
      input.body.source_template_version ?? null,
      policyVersion,
      updatedAt,
    ],
  })
  return await getCommunityPricingPolicy({ env: input.env, communityId: input.communityId })
}
