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

export type MissingMembershipCapability = "unique_human" | "age_over_18" | "minimum_age" | "nationality" | "gender" | "wallet_score"
export type SuggestedVerificationProvider = "self" | "very" | "passport"

export type MembershipGateEvaluation = {
  satisfied: boolean
  missingCapabilities: MissingMembershipCapability[]
  mismatchReasons: string[]
  suggestedVerificationProvider: SuggestedVerificationProvider | null
}
