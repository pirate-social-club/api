export type CommunityGateScope = "membership" | "viewer" | "posting"

export type GatePolicy = {
  version: 1
  expression: GateExpression
}

export type GateExpression =
  | { op: "and"; children: GateExpression[] }
  | { op: "or"; children: GateExpression[] }
  | { op: "gate"; gate: GateAtom }

export type DocumentProofProvider = "self" | "zkpassport"

export type GateAtom =
  | { type: "unique_human"; provider: "very" | "self" }
  | { type: "altcha_pow" }
  | { type: "minimum_age"; provider: "self"; accepted_providers?: DocumentProofProvider[]; minimum_age: number }
  | { type: "nationality"; provider: "self"; accepted_providers?: DocumentProofProvider[]; allowed: string[] }
  | { type: "gender"; provider: "self"; accepted_providers?: DocumentProofProvider[]; allowed: Array<"M" | "F"> }
  | { type: "wallet_score"; provider: "passport"; minimum_score: number }
  | { type: "erc721_holding"; chain_namespace: "eip155:1"; contract_address: string; min_count?: number }
  | { type: "asset_balance"; asset_id: string; min_amount_atomic: string }
  | {
    type: "erc721_inventory_match"
    provider: "courtyard"
    chain_namespace: "eip155:1" | "eip155:137"
    contract_address: string
    min_quantity: number
    match: Record<string, string | string[]>
  }

export type GateTraceNode =
  | { kind: "op"; op: "and" | "or"; passed: boolean; children: GateTraceNode[] }
  | {
    kind: "gate"
    gate_type: GateAtom["type"]
    provider?: string
    passed: boolean
    reason?: string
    required_score?: number | null
    actual_score?: number | null
    required_age?: number | null
    asset_id?: string | null
    required_amount_atomic?: string | null
    current_amount_atomic?: string | null
  }

export type RequiredActionNode = RequiredAction | RequiredActionSet

export type RequiredActionSet = {
  kind: "set"
  mode: "all" | "any"
  items: RequiredActionNode[]
}

export type RequiredAction =
  | { kind: "action"; provider: DocumentProofProvider; accepted_providers?: DocumentProofProvider[]; capability: "minimum_age"; required_age: number }
  | { kind: "action"; provider: DocumentProofProvider; accepted_providers?: DocumentProofProvider[]; capability: "nationality"; allowed_countries: string[] }
  | { kind: "action"; provider: DocumentProofProvider; accepted_providers?: DocumentProofProvider[]; capability: "gender"; allowed_markers: Array<"M" | "F"> }
  | { kind: "action"; provider: "self"; capability: "unique_human" }
  | { kind: "action"; provider: "very"; capability: "unique_human" }
  | { kind: "action"; provider: "altcha"; capability: "altcha_pow"; scope: string }
  | { kind: "action"; provider: "passport"; capability: "wallet_score"; minimum_score: number; actual_score: number | null }
  | { kind: "action"; provider: "wallet"; capability: "erc721_holding"; chain_namespace: string; contract_address: string; min_quantity: number }
  | {
    kind: "action"
    provider: "wallet"
    capability: "asset_balance"
    asset_id: string
    required_amount_atomic: string
    current_amount_atomic: string
    shortfall_amount_atomic: string
  }
  | {
    kind: "action"
    provider: "wallet"
    capability: "erc721_inventory_match"
    chain_namespace: string
    contract_address: string
    min_quantity: number
  }

export type GateEvaluationOutcome = "passed" | "action_required" | "terminal_mismatch" | "provider_unavailable"

export type GatePolicyEvaluation = {
  satisfied: boolean
  outcome: GateEvaluationOutcome
  trace: GateTraceNode
  requiredActionSet: RequiredActionSet | null
}

export type CommunityGateRuleRow = {
  gate_rule_id: string
  scope: "membership" | "viewer" | "posting"
  gate_family: "identity_proof" | "token_holding"
  gate_type: string
  proof_requirements_json: string | null
  chain_namespace: string | null
  gate_config_json: string | null
  status: "active" | "disabled"
}

export type ProofRequirement = {
  proof_type: string
  accepted_providers?: string[] | null
  accepted_mechanisms?: string[] | null
  config?: Record<string, unknown> | null
}

type MissingMembershipCapability = "unique_human" | "age_over_18" | "minimum_age" | "nationality" | "gender" | "wallet_score" | "altcha_pow"
export type SuggestedVerificationProvider = "self" | "very" | "passport" | "zkpassport"

export type MembershipGateEvaluation = {
  satisfied: boolean
  missingCapabilities: MissingMembershipCapability[]
  mismatchReasons: string[]
  suggestedVerificationProvider: SuggestedVerificationProvider | null
}
