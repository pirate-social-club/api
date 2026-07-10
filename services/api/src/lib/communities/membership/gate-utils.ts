import type { JoinEligibility } from "../../../types"
import type { RequiredActionNode, RequiredActionSet } from "./gate-types"

function flattenRequiredActions(actionSet: RequiredActionSet | null): RequiredActionNode[] {
  if (!actionSet) {
    return []
  }
  return actionSet.items.flatMap((item) => item.kind === "set" ? flattenRequiredActions(item) : [item])
}

export function missingCapabilitiesFromRequiredActionSet(
  actionSet: RequiredActionSet | null,
): NonNullable<JoinEligibility["missing_capabilities"]> {
  const capabilities = new Set<NonNullable<JoinEligibility["missing_capabilities"]>[number]>()
  for (const item of flattenRequiredActions(actionSet)) {
    if (item.kind !== "action") {
      continue
    }
    if (
      item.capability === "minimum_age"
      || item.capability === "nationality"
      || item.capability === "gender"
      || item.capability === "unique_human"
      || item.capability === "wallet_score"
      || item.capability === "altcha_pow"
    ) {
      capabilities.add(item.capability)
    }
  }
  return [...capabilities]
}

export function suggestedProviderFromRequiredActionSet(
  actionSet: RequiredActionSet | null,
): JoinEligibility["suggested_verification_provider"] {
  const action = flattenRequiredActions(actionSet).find((item) => (
    item.kind === "action"
    && (item.provider === "self" || item.provider === "very" || item.provider === "passport" || item.provider === "zkpassport")
  ))
  return action?.kind === "action"
    && (action.provider === "self" || action.provider === "very" || action.provider === "passport" || action.provider === "zkpassport")
    ? action.provider
    : null
}
