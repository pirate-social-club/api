import type { CommunityHandlePolicy } from "../../../types"

type CommunityHandleLabelClaimRule = NonNullable<CommunityHandlePolicy["label_claim_rules"]>[number]
import type { DbExecutor } from "../../db-helpers"
import { badRequestError, internalError } from "../../errors"
import { requiredNumber, requiredString, rowValue, stringOrNull } from "../../sql-row"
import { validateGatePolicy } from "../membership/gate-policy-validation"
import type { GatePolicy } from "../membership/gate-types"

export const MAX_LABEL_CLAIM_RULES = 20
export const MAX_EXACT_SELECTOR_LABELS = 100
export const LABEL_CLAIM_PLACEHOLDER = "{label}"

// Mirrors the ASCII branch of normalizeCommunityHandleLabel; selector entries must
// already be normalized labels, so punycode and suffix stripping do not apply here.
const NORMALIZED_LABEL_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

export type LabelClaimRuleRow = {
  label_claim_rule_id: string
  position: number
  selector_type: "exact" | "any"
  selector_labels_json: string | null
  expression_json: string
}

export type ValidatedLabelClaimRule = {
  selector_type: "exact" | "any"
  selector_labels: string[] | null
  expression: GatePolicy
}

export async function listNamespaceLabelClaimRules(
  executor: DbExecutor,
  namespaceHandlePolicyId: string,
): Promise<LabelClaimRuleRow[]> {
  let result
  try {
    result = await executor.execute({
      sql: `
        SELECT label_claim_rule_id, position, selector_type, selector_labels_json, expression_json
        FROM namespace_handle_label_claim_rules
        WHERE namespace_handle_policy_id = ?1
        ORDER BY position ASC
      `,
      args: [namespaceHandlePolicyId],
    })
  } catch (error) {
    // A shard without migration 1138 cannot hold rules, so an absent table is
    // exactly "no rules configured" — not a fail-open. This keeps handle quotes
    // and claims working while the fleet migration rolls out (and on shards that
    // cannot take migrations at all).
    if (isMissingLabelClaimRuleTableError(error)) return []
    throw error
  }
  return result.rows.map((row) => ({
    label_claim_rule_id: requiredString(row, "label_claim_rule_id"),
    position: requiredNumber(row, "position"),
    selector_type: assertSelectorType(rowValue(row, "selector_type")),
    selector_labels_json: stringOrNull(rowValue(row, "selector_labels_json")),
    expression_json: requiredString(row, "expression_json"),
  }))
}

export function isMissingLabelClaimRuleTableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes("no such table") && message.includes("namespace_handle_label_claim_rules")
}

export function findMatchingLabelClaimRule(
  rules: LabelClaimRuleRow[],
  labelNormalized: string,
): LabelClaimRuleRow | null {
  for (const rule of rules) {
    if (rule.selector_type === "any") return rule
    if (parseSelectorLabels(rule).includes(labelNormalized)) return rule
  }
  return null
}

/**
 * Parses a persisted rule expression and resolves `{label}` bindings against the
 * claim label. Fails closed: malformed persisted state denies the claim rather
 * than falling through to the namespace default.
 */
export function resolveLabelClaimGatePolicy(rule: LabelClaimRuleRow, labelNormalized: string): GatePolicy {
  let parsed: unknown
  try {
    parsed = JSON.parse(rule.expression_json)
  } catch {
    throw internalError("Community handle label claim rule expression is malformed")
  }
  const substituted = substituteLabelPlaceholders(parsed, labelNormalized)
  if (containsPlaceholder(substituted)) {
    throw internalError("Community handle label claim rule binds {label} outside inventory facet values")
  }
  try {
    return validateGatePolicy(substituted)
  } catch {
    throw internalError("Community handle label claim rule expression is malformed")
  }
}

export function validateLabelClaimRulesInput(input: unknown): ValidatedLabelClaimRule[] {
  if (!Array.isArray(input)) {
    throw badRequestError("label_claim_rules must be an array")
  }
  if (input.length > MAX_LABEL_CLAIM_RULES) {
    throw badRequestError(`label_claim_rules supports at most ${MAX_LABEL_CLAIM_RULES} rules`)
  }
  return input.map((raw) => validateLabelClaimRuleInput(raw))
}

/** Namespace-level claim gate expressions never run substitution, so the placeholder is banned there outright. */
export function assertNoLabelPlaceholder(policy: GatePolicy): void {
  if (findStrayPlaceholder(policy, true)) {
    throw badRequestError("{label} is only supported inside label_claim_rules expressions")
  }
}

export function serializeLabelClaimRules(
  rules: LabelClaimRuleRow[],
  withPrefix: (prefix: string, value: string) => string,
): CommunityHandleLabelClaimRule[] {
  return rules.map((rule) => ({
    id: withPrefix("hlcr", rule.label_claim_rule_id),
    position: rule.position,
    selector: rule.selector_type === "any"
      ? { type: "any", labels: null }
      : { type: "exact", labels: parseSelectorLabels(rule) },
    claim_gate_expression: parseStoredRuleExpression(rule),
  }))
}

function parseStoredRuleExpression(rule: LabelClaimRuleRow): GatePolicy {
  try {
    return validateGatePolicy(JSON.parse(rule.expression_json))
  } catch {
    throw internalError("Community handle label claim rule expression is malformed")
  }
}

function validateLabelClaimRuleInput(raw: unknown): ValidatedLabelClaimRule {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw badRequestError("label_claim_rules entries must be objects")
  }
  const rule = raw as Record<string, unknown>
  const selector = rule.selector
  if (!selector || typeof selector !== "object" || Array.isArray(selector)) {
    throw badRequestError("label_claim_rules entries require a selector object")
  }
  const selectorType = (selector as Record<string, unknown>).type
  const selectorLabels = (selector as Record<string, unknown>).labels
  let labels: string[] | null = null
  if (selectorType === "exact") {
    if (!Array.isArray(selectorLabels) || selectorLabels.length === 0) {
      throw badRequestError("exact selectors require a non-empty labels array")
    }
    if (selectorLabels.length > MAX_EXACT_SELECTOR_LABELS) {
      throw badRequestError(`exact selectors support at most ${MAX_EXACT_SELECTOR_LABELS} labels`)
    }
    const seen = new Set<string>()
    labels = selectorLabels.map((value) => {
      if (typeof value !== "string" || !NORMALIZED_LABEL_PATTERN.test(value)) {
        throw badRequestError("exact selector labels must be normalized handle labels")
      }
      if (seen.has(value)) {
        throw badRequestError("exact selector labels must be unique")
      }
      seen.add(value)
      return value
    })
  } else if (selectorType === "any") {
    if (selectorLabels != null && (!Array.isArray(selectorLabels) || selectorLabels.length > 0)) {
      throw badRequestError("any selectors must not carry labels")
    }
  } else {
    throw badRequestError("selector type must be exact or any")
  }
  const expression = validateGatePolicy(rule.claim_gate_expression)
  assertPlaceholderPositions(expression)
  return { selector_type: selectorType, selector_labels: labels, expression }
}

function assertSelectorType(value: unknown): "exact" | "any" {
  if (value === "exact" || value === "any") return value
  throw internalError("Community handle label claim rule selector is malformed")
}

function parseSelectorLabels(rule: LabelClaimRuleRow): string[] {
  if (!rule.selector_labels_json?.trim()) {
    throw internalError("Community handle label claim rule selector is malformed")
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(rule.selector_labels_json)
  } catch {
    throw internalError("Community handle label claim rule selector is malformed")
  }
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
    throw internalError("Community handle label claim rule selector is malformed")
  }
  return parsed as string[]
}

/**
 * `{label}` is only meaningful as an erc721_inventory_match facet value. Any other
 * occurrence is rejected at write time so persisted rules can never bind the label
 * into fields where substitution does not run.
 */
function assertPlaceholderPositions(policy: GatePolicy): void {
  const stray = findStrayPlaceholder(policy, false)
  if (stray) {
    throw badRequestError("{label} may only appear as an erc721_inventory_match facet value")
  }
  assertMatchValuePlaceholders(policy)
}

function assertMatchValuePlaceholders(node: unknown): void {
  if (Array.isArray(node)) {
    for (const child of node) assertMatchValuePlaceholders(child)
    return
  }
  if (!node || typeof node !== "object") return
  const record = node as Record<string, unknown>
  if (record.type === "erc721_inventory_match" && record.match && typeof record.match === "object" && !Array.isArray(record.match)) {
    for (const value of Object.values(record.match as Record<string, unknown>)) {
      const entries = Array.isArray(value) ? value : [value]
      for (const entry of entries) {
        if (typeof entry === "string" && entry.includes(LABEL_CLAIM_PLACEHOLDER) && entry !== LABEL_CLAIM_PLACEHOLDER) {
          throw badRequestError("{label} must be the entire facet value, not part of one")
        }
      }
    }
    return
  }
  for (const value of Object.values(record)) assertMatchValuePlaceholders(value)
}

function substituteLabelPlaceholders(node: unknown, labelNormalized: string): unknown {
  if (Array.isArray(node)) {
    return node.map((child) => substituteLabelPlaceholders(child, labelNormalized))
  }
  if (!node || typeof node !== "object") return node
  const record = node as Record<string, unknown>
  if (record.type === "erc721_inventory_match" && record.match && typeof record.match === "object" && !Array.isArray(record.match)) {
    const match = Object.fromEntries(
      Object.entries(record.match as Record<string, unknown>).map(([key, value]) => {
        if (value === LABEL_CLAIM_PLACEHOLDER) return [key, labelNormalized]
        if (Array.isArray(value)) {
          return [key, value.map((entry) => (entry === LABEL_CLAIM_PLACEHOLDER ? labelNormalized : entry))]
        }
        return [key, value]
      }),
    )
    return { ...record, match }
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, substituteLabelPlaceholders(value, labelNormalized)]),
  )
}

function containsPlaceholder(node: unknown): boolean {
  return findStrayPlaceholder(node, true) != null
}

function findStrayPlaceholder(node: unknown, includeMatchValues: boolean): string | null {
  if (typeof node === "string") {
    return node.includes(LABEL_CLAIM_PLACEHOLDER) ? node : null
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findStrayPlaceholder(child, includeMatchValues)
      if (found) return found
    }
    return null
  }
  if (!node || typeof node !== "object") return null
  const record = node as Record<string, unknown>
  for (const [key, value] of Object.entries(record)) {
    if (!includeMatchValues && key === "match" && record.type === "erc721_inventory_match") {
      continue
    }
    const found = findStrayPlaceholder(value, includeMatchValues)
    if (found) return found
  }
  return null
}
