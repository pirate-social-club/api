import { requiredString, rowValue, stringOrNull } from "../../sql-row"
import type { CommunityGateRuleRow } from "./gate-types"

export function toCommunityGateRuleRow(row: unknown): CommunityGateRuleRow {
  return {
    gate_rule_id: requiredString(row, "gate_rule_id"),
    scope: requiredString(row, "scope") as CommunityGateRuleRow["scope"],
    gate_family: requiredString(row, "gate_family") as CommunityGateRuleRow["gate_family"],
    gate_type: requiredString(row, "gate_type"),
    proof_requirements_json: stringOrNull(rowValue(row, "proof_requirements_json")),
    chain_namespace: stringOrNull(rowValue(row, "chain_namespace")),
    gate_config_json: stringOrNull(rowValue(row, "gate_config_json")),
    status: requiredString(row, "status") as CommunityGateRuleRow["status"],
  }
}
