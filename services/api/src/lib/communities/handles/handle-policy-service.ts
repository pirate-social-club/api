import type {
  CommunityHandlePolicy,
  CommunityHandlePolicySettings,
  CommunityHandleQuote,
  Env,
  UpdateCommunityHandlePolicyRequest,
} from "../../../types"
import type { DbExecutor } from "../../db-helpers"
import { badRequestError, eligibilityFailed, internalError } from "../../errors"
import { makeId, nowIso } from "../../helpers"
import { nullableUnixSeconds } from "../../../serializers/time"
import { numberOrNull, requiredString, rowValue, stringOrNull } from "../../sql-row"
import { openCommunityWriteClient } from "../community-read-access"
import type { CommunityDatabaseBindingRepository, CommunityReadRepository } from "../db-community-repository"
import { requireCommunityOwner } from "../commerce/access"
import { validateGatePolicy } from "../membership/gate-policy-validation"
import type { GatePolicy } from "../membership/gate-types"
import {
  type LabelClaimRuleRow,
  type ValidatedLabelClaimRule,
  assertNoLabelPlaceholder,
  listNamespaceLabelClaimRules,
  serializeLabelClaimRules,
  validateLabelClaimRulesInput,
} from "./handle-label-claim-rules"

export type HandlePricingModel = NonNullable<CommunityHandleQuote["pricing_model"]>
export type HandleCommunityRepository = CommunityReadRepository & CommunityDatabaseBindingRepository

export type NamespacePolicyRow = {
  namespace_handle_policy_id: string
  community_id: string
  namespace_id: string
  display_label: string
  normalized_label: string
  route_family: string | null
  policy_template: CommunityHandlePolicy["policy_template"]
  pricing_model: HandlePricingModel | null
  claims_enabled: boolean
  claim_gate_mode: CommunityHandlePolicy["claim_gate_mode"]
  claim_gate_expression_ref: string | null
  claim_gate_expression_json: string | null
  eligibility_timing: CommunityHandlePolicy["eligibility_timing"]
  settings_json: string | null
  updated_at: string | null
}

export type HandleClaimSettings = {
  flat_price_cents?: number
  premium_price_cents?: number
  premium_max_length?: number
  min_length?: number
  max_length?: number
  quote_ttl_seconds?: number
  reserved_labels?: string[]
  special_price_cents_by_label?: Record<string, number>
  issuance_mode?: "app_internal" | "spaces_subspace"
}

export function normalizeCommunityHandleLabel(desiredLabel: unknown): {
  labelNormalized: string
  labelDisplay: string
} {
  if (typeof desiredLabel !== "string") {
    throw badRequestError("Invalid desired_label")
  }
  const trimmed = desiredLabel.trim().toLowerCase()
  const withoutAt = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed
  const withoutSuffix = withoutAt.includes("@") ? withoutAt.slice(0, withoutAt.indexOf("@")) : withoutAt

  const isAsciiLabel = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(withoutSuffix)
  const isPunycodeLabel = /^xn--[a-z0-9-]+$/u.test(withoutSuffix)
  if (!withoutSuffix || (!isAsciiLabel && !isPunycodeLabel)) {
    throw badRequestError("Invalid desired_label")
  }
  return { labelNormalized: withoutSuffix, labelDisplay: withoutSuffix }
}

export function parseHandleClaimSettings(raw: string | null): HandleClaimSettings {
  if (!raw?.trim()) return {}
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return {
      flat_price_cents: finiteNonNegativeInteger(parsed.flat_price_cents),
      premium_price_cents: finiteNonNegativeInteger(parsed.premium_price_cents),
      premium_max_length: finitePositiveInteger(parsed.premium_max_length),
      min_length: finitePositiveInteger(parsed.min_length),
      max_length: finitePositiveInteger(parsed.max_length),
      quote_ttl_seconds: finitePositiveInteger(parsed.quote_ttl_seconds),
      issuance_mode: parsed.issuance_mode === "spaces_subspace" ? "spaces_subspace" : undefined,
      reserved_labels: Array.isArray(parsed.reserved_labels)
        ? parsed.reserved_labels.filter((value): value is string => typeof value === "string")
        : undefined,
      special_price_cents_by_label: parseSpecialPrices(parsed.special_price_cents_by_label),
    }
  } catch {
    throw internalError("Community handle policy settings are malformed", { reason: "invalid_settings_json" })
  }
}

function parseSpecialPrices(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const entries = Object.entries(value)
    .map(([label, price]) => {
      const parsedPrice = finiteNonNegativeInteger(price)
      if (parsedPrice == null) return null
      return [normalizeCommunityHandleLabel(label).labelNormalized, parsedPrice] as const
    })
    .filter((entry): entry is readonly [string, number] => entry != null)
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

function finiteNonNegativeInteger(value: unknown): number | undefined {
  const numeric = typeof value === "number" ? value : Number(value)
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : undefined
}

function finitePositiveInteger(value: unknown): number | undefined {
  const numeric = typeof value === "number" ? value : Number(value)
  return Number.isInteger(numeric) && numeric > 0 ? numeric : undefined
}

export function withHandlePrefix(prefix: string, value: string): string {
  return value.startsWith(`${prefix}_`) ? value : `${prefix}_${value}`
}

export function serializeHandlePolicy(
  row: NamespacePolicyRow,
  labelClaimRules?: LabelClaimRuleRow[],
): CommunityHandlePolicy {
  return {
    ...(labelClaimRules
      ? { label_claim_rules: serializeLabelClaimRules(labelClaimRules, withHandlePrefix) }
      : {}),
    id: withHandlePrefix("nhp", row.namespace_handle_policy_id),
    object: "community_handle_policy",
    community: withHandlePrefix("com", row.community_id),
    namespace: withHandlePrefix("ns", row.namespace_id),
    policy_template: row.policy_template,
    pricing_model: row.pricing_model,
    claims_enabled: row.claims_enabled,
    claim_gate_mode: row.claim_gate_mode,
    claim_gate_expression_ref: row.claim_gate_expression_ref,
    claim_gate_expression: parseClaimGateExpression(row.claim_gate_expression_json),
    eligibility_timing: row.eligibility_timing,
    settings: parseHandleClaimSettings(row.settings_json),
    updated_at: nullableUnixSeconds(row.updated_at),
  }
}

export function protocolIssuanceRequired(settings: HandleClaimSettings): boolean {
  return settings.issuance_mode === "spaces_subspace"
}

export function assertWritableHandleIssuanceMode(value: unknown): HandleClaimSettings["issuance_mode"] {
  if (value == null || value === "app_internal") return undefined
  if (value === "spaces_subspace") {
    throw eligibilityFailed("Protocol-issued community names are temporarily unavailable")
  }
  throw badRequestError("issuance_mode must be app_internal or spaces_subspace")
}

export function namespaceSupportsSpacesSubspace(
  policy: Pick<NamespacePolicyRow, "display_label" | "normalized_label" | "route_family">,
): boolean {
  return policy.route_family === "spaces"
    || policy.display_label.startsWith("@")
    || policy.normalized_label.startsWith("@")
}

export async function getNamespacePolicy(
  executor: DbExecutor,
  communityId: string,
  selector?: { namespaceId?: string | null; namespaceVerificationId?: string | null },
): Promise<NamespacePolicyRow | null> {
  const result = await executor.execute({
    sql: `
      SELECT nb.community_id, nb.namespace_id, nb.display_label, nb.normalized_label, nb.route_family,
             nhp.namespace_handle_policy_id, nhp.policy_template, nhp.pricing_model,
             nhp.claims_enabled, nhp.claim_gate_mode, nhp.claim_gate_expression_ref,
             nhp.eligibility_timing, hcg.expression_json AS claim_gate_expression_json,
             nhp.settings_json, nhp.updated_at
      FROM namespace_bindings nb
      JOIN namespace_handle_policies nhp
        ON nhp.namespace_id = nb.namespace_id
      LEFT JOIN namespace_handle_claim_gate_policies hcg
        ON hcg.namespace_handle_policy_id = nhp.namespace_handle_policy_id
       AND hcg.claim_gate_expression_ref = nhp.claim_gate_expression_ref
      WHERE nb.community_id = ?1
        AND nb.status = 'active'
        AND (?2 IS NULL OR nb.namespace_id = ?2)
        AND (?3 IS NULL OR nb.namespace_verification_id = ?3)
      ORDER BY CASE nb.namespace_role WHEN 'primary' THEN 0 ELSE 1 END
      LIMIT 1
    `,
    args: [
      communityId,
      selector?.namespaceId ?? null,
      selector?.namespaceVerificationId ?? null,
    ],
  })
  const row = result.rows[0]
  if (!row) return null
  return {
    namespace_handle_policy_id: requiredString(row, "namespace_handle_policy_id"),
    community_id: requiredString(row, "community_id"),
    namespace_id: requiredString(row, "namespace_id"),
    display_label: requiredString(row, "display_label"),
    normalized_label: requiredString(row, "normalized_label"),
    route_family: stringOrNull(rowValue(row, "route_family")),
    policy_template: requiredString(row, "policy_template") as CommunityHandlePolicy["policy_template"],
    pricing_model: stringOrNull(rowValue(row, "pricing_model")) as HandlePricingModel | null,
    claims_enabled: numberOrNull(rowValue(row, "claims_enabled")) === 1,
    claim_gate_mode: assertClaimGateMode(rowValue(row, "claim_gate_mode")),
    claim_gate_expression_ref: stringOrNull(rowValue(row, "claim_gate_expression_ref")),
    claim_gate_expression_json: stringOrNull(rowValue(row, "claim_gate_expression_json")),
    eligibility_timing: assertEligibilityTiming(rowValue(row, "eligibility_timing")),
    settings_json: stringOrNull(rowValue(row, "settings_json")),
    updated_at: stringOrNull(rowValue(row, "updated_at")),
  }
}

function assertClaimGateMode(value: unknown): CommunityHandlePolicy["claim_gate_mode"] {
  if (value === "none" || value === "inherit_community" || value === "explicit") return value
  throw internalError("Community handle claim gate mode is malformed")
}

function assertWritableClaimGateMode(value: unknown): CommunityHandlePolicy["claim_gate_mode"] {
  if (value === "none" || value === "inherit_community" || value === "explicit") return value
  throw badRequestError("claim_gate_mode must be none, inherit_community, or explicit")
}

function assertEligibilityTiming(value: unknown): CommunityHandlePolicy["eligibility_timing"] {
  if (value === "claim_time" || value === "continuous") return value
  throw internalError("Community handle eligibility timing is malformed")
}

function assertWritableEligibilityTiming(value: unknown): CommunityHandlePolicy["eligibility_timing"] {
  if (value === "claim_time") return value
  if (value === "continuous") {
    throw eligibilityFailed("Continuous handle eligibility is unavailable until suspension and restoration semantics ship")
  }
  throw badRequestError("eligibility_timing must be claim_time or continuous")
}

function parseClaimGateExpression(raw: string | null): GatePolicy | null {
  if (!raw?.trim()) return null
  try {
    return validateGatePolicy(JSON.parse(raw))
  } catch {
    throw internalError("Community handle claim gate expression is malformed")
  }
}

function assertPolicyTemplate(value: unknown): CommunityHandlePolicy["policy_template"] {
  if (value === "standard" || value === "premium" || value === "membership_gated" || value === "custom") return value
  throw badRequestError("Invalid policy_template")
}

function assertPricingModel(value: unknown): HandlePricingModel | null {
  if (value == null) return null
  if (value === "free" || value === "flat_by_length" || value === "custom_curve" || value === "gated_then_flat") return value
  throw badRequestError("Invalid pricing_model")
}

function optionalIntegerSetting(value: unknown, key: keyof CommunityHandlePolicySettings, options: { min: number }): number | undefined {
  if (value == null) return undefined
  const numeric = typeof value === "number" ? value : Number(value)
  if (!Number.isInteger(numeric) || numeric < options.min) {
    throw badRequestError(`${String(key)} must be an integer >= ${options.min}`)
  }
  return numeric
}

function sanitizeSettings(input: CommunityHandlePolicySettings | null | undefined): HandleClaimSettings {
  if (!input) return {}
  const settings: HandleClaimSettings = {
    flat_price_cents: optionalIntegerSetting(input.flat_price_cents, "flat_price_cents", { min: 0 }),
    premium_price_cents: optionalIntegerSetting(input.premium_price_cents, "premium_price_cents", { min: 0 }),
    premium_max_length: optionalIntegerSetting(input.premium_max_length, "premium_max_length", { min: 1 }),
    min_length: optionalIntegerSetting(input.min_length, "min_length", { min: 1 }),
    max_length: optionalIntegerSetting(input.max_length, "max_length", { min: 1 }),
    quote_ttl_seconds: optionalIntegerSetting(input.quote_ttl_seconds, "quote_ttl_seconds", { min: 60 }),
    issuance_mode: assertWritableHandleIssuanceMode(input.issuance_mode),
    reserved_labels: Array.isArray(input.reserved_labels)
      ? input.reserved_labels.map((label) => normalizeCommunityHandleLabel(label).labelNormalized)
      : undefined,
    special_price_cents_by_label: parseSpecialPrices(input.special_price_cents_by_label),
  }
  if (settings.min_length != null && settings.max_length != null && settings.min_length > settings.max_length) {
    throw badRequestError("min_length must be <= max_length")
  }
  return Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined)) as HandleClaimSettings
}

export async function updateCommunityHandlePolicy(input: {
  env: Env
  userId: string
  communityId: string
  namespaceVerificationId?: string | null
  body: UpdateCommunityHandlePolicyRequest
  communityRepository: HandleCommunityRepository
}): Promise<CommunityHandlePolicy> {
  await requireCommunityOwner({ communityId: input.communityId, userId: input.userId, communityRepository: input.communityRepository })
  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.communityId)
  try {
    const selector = { namespaceVerificationId: input.namespaceVerificationId }
    const current = await getNamespacePolicy(db.client, input.communityId, selector)
    if (!current) throw eligibilityFailed("Community names are not available for this community")
    const nextSettings = "settings" in input.body
      ? sanitizeSettings(input.body.settings ?? null)
      : parseHandleClaimSettings(current.settings_json)
    if (protocolIssuanceRequired(nextSettings)) {
      throw eligibilityFailed("Protocol-issued community names are temporarily unavailable")
    }
    const nextClaimGateMode = "claim_gate_mode" in input.body
      ? assertWritableClaimGateMode(input.body.claim_gate_mode)
      : current.claim_gate_mode
    const nextEligibilityTiming = "eligibility_timing" in input.body
      ? assertWritableEligibilityTiming(input.body.eligibility_timing)
      : current.eligibility_timing
    const submittedExpression = "claim_gate_expression" in input.body
      ? input.body.claim_gate_expression == null ? null : validateGatePolicy(input.body.claim_gate_expression)
      : parseClaimGateExpression(current.claim_gate_expression_json)
    if (submittedExpression) assertNoLabelPlaceholder(submittedExpression)
    if (nextClaimGateMode === "explicit" && !submittedExpression) {
      throw badRequestError("claim_gate_expression is required when claim_gate_mode is explicit")
    }
    if (nextClaimGateMode !== "explicit" && submittedExpression) {
      throw badRequestError("claim_gate_expression is only allowed when claim_gate_mode is explicit")
    }
    const nextExpressionRef = submittedExpression
      ? current.claim_gate_expression_ref ?? makeId("hcgp")
      : null
    const submittedLabelClaimRules: ValidatedLabelClaimRule[] | null =
      "label_claim_rules" in input.body && input.body.label_claim_rules != null
        ? validateLabelClaimRulesInput(input.body.label_claim_rules)
        : null
    const updatedAt = nowIso()
    const tx = await db.client.transaction("write")
    try {
      await tx.execute({
      sql: `
        INSERT INTO namespace_handle_policies (
          namespace_handle_policy_id, community_id, namespace_id, policy_template, pricing_model,
          membership_required_for_claim, claims_enabled, claim_gate_mode, claim_gate_expression_ref,
          eligibility_timing, settings_json, created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12
        )
        ON CONFLICT(namespace_handle_policy_id) DO UPDATE SET
          policy_template = excluded.policy_template,
          pricing_model = excluded.pricing_model,
          membership_required_for_claim = excluded.membership_required_for_claim,
          claims_enabled = excluded.claims_enabled,
          claim_gate_mode = excluded.claim_gate_mode,
          claim_gate_expression_ref = excluded.claim_gate_expression_ref,
          eligibility_timing = excluded.eligibility_timing,
          settings_json = excluded.settings_json,
          updated_at = excluded.updated_at
      `,
      args: [
        current.namespace_handle_policy_id,
        input.communityId,
        current.namespace_id,
        "policy_template" in input.body ? assertPolicyTemplate(input.body.policy_template) : current.policy_template,
        "pricing_model" in input.body ? assertPricingModel(input.body.pricing_model) : current.pricing_model,
        1,
        "claims_enabled" in input.body
          ? input.body.claims_enabled === true ? 1 : 0
          : current.claims_enabled ? 1 : 0,
        nextClaimGateMode,
        nextExpressionRef,
        nextEligibilityTiming,
        JSON.stringify(nextSettings),
        updatedAt,
      ],
      })
      if (submittedExpression && nextExpressionRef) {
        await tx.execute({
          sql: `
            INSERT INTO namespace_handle_claim_gate_policies (
              claim_gate_expression_ref, namespace_handle_policy_id, version,
              expression_json, created_at, updated_at
            ) VALUES (?1, ?2, 1, ?3, ?4, ?4)
            ON CONFLICT(namespace_handle_policy_id) DO UPDATE SET
              claim_gate_expression_ref = excluded.claim_gate_expression_ref,
              version = excluded.version,
              expression_json = excluded.expression_json,
              updated_at = excluded.updated_at
          `,
          args: [nextExpressionRef, current.namespace_handle_policy_id, JSON.stringify(submittedExpression), updatedAt],
        })
      } else {
        await tx.execute({
          sql: `DELETE FROM namespace_handle_claim_gate_policies WHERE namespace_handle_policy_id = ?1`,
          args: [current.namespace_handle_policy_id],
        })
      }
      if (submittedLabelClaimRules) {
        await tx.execute({
          sql: `DELETE FROM namespace_handle_label_claim_rules WHERE namespace_handle_policy_id = ?1`,
          args: [current.namespace_handle_policy_id],
        })
        for (const [position, rule] of submittedLabelClaimRules.entries()) {
          await tx.execute({
            sql: `
              INSERT INTO namespace_handle_label_claim_rules (
                label_claim_rule_id, namespace_handle_policy_id, position,
                selector_type, selector_labels_json, version, expression_json,
                created_at, updated_at
              ) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?7, ?7)
            `,
            args: [
              makeId("hlcr"),
              current.namespace_handle_policy_id,
              position,
              rule.selector_type,
              rule.selector_labels ? JSON.stringify(rule.selector_labels) : null,
              JSON.stringify(rule.expression),
              updatedAt,
            ],
          })
        }
      }
      await tx.commit()
    } catch (error) {
      await tx.rollback()
      throw error
    }
    const updated = await getNamespacePolicy(db.client, input.communityId, selector)
    if (!updated) throw internalError("Updated community handle policy row is missing")
    const rules = await listNamespaceLabelClaimRules(db.client, updated.namespace_handle_policy_id)
    return serializeHandlePolicy(updated, rules)
  } finally {
    db.close()
  }
}
