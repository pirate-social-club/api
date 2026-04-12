import { badRequestError } from "../errors"
import type { CommunityGateRuleRow } from "../communities/community-membership-store"
import type { StartVerificationSessionRequest } from "../../types"

type VerificationCapability = NonNullable<StartVerificationSessionRequest["requested_capabilities"]>[number]
type VerificationIntent = NonNullable<StartVerificationSessionRequest["verification_intent"]>
type VerificationProvider = StartVerificationSessionRequest["provider"]

type VerificationPolicy = {
  policy_id: string
  provider: VerificationProvider
  verification_intent: VerificationIntent
  requested_capabilities: VerificationCapability[]
}

export type VerificationPolicyHint = Pick<VerificationPolicy, "policy_id" | "provider" | "verification_intent">

const VERIFICATION_POLICIES: Record<string, VerificationPolicy> = {
  policy_self_profile_v1: {
    policy_id: "policy_self_profile_v1",
    provider: "self",
    verification_intent: "profile_verification",
    requested_capabilities: ["unique_human", "age_over_18", "nationality"],
  },
  policy_self_join_v1: {
    policy_id: "policy_self_join_v1",
    provider: "self",
    verification_intent: "ucommunity_join",
    requested_capabilities: ["unique_human", "age_over_18", "nationality"],
  },
  policy_very_join_v1: {
    policy_id: "policy_very_join_v1",
    provider: "very",
    verification_intent: "ucommunity_join",
    requested_capabilities: ["unique_human"],
  },
}

export function resolveVerificationSessionPolicy(input: {
  provider: VerificationProvider
  requestedCapabilities: VerificationCapability[]
  verificationIntent?: StartVerificationSessionRequest["verification_intent"] | null
  policyId?: string | null
}): {
  requestedCapabilities: VerificationCapability[]
  verificationIntent: StartVerificationSessionRequest["verification_intent"] | null
  policyId: string | null
} {
  if (!input.policyId) {
    return {
      requestedCapabilities: [...input.requestedCapabilities],
      verificationIntent: input.verificationIntent ?? null,
      policyId: null,
    }
  }

  const policy = VERIFICATION_POLICIES[input.policyId]
  if (!policy) {
    throw badRequestError("Invalid policy_id")
  }

  if (policy.provider !== input.provider) {
    throw badRequestError("policy_id is invalid for provider")
  }

  if (input.verificationIntent != null && input.verificationIntent !== policy.verification_intent) {
    throw badRequestError("policy_id is invalid for verification_intent")
  }

  const disallowedCapabilities = input.requestedCapabilities.filter((capability) => !policy.requested_capabilities.includes(capability))
  if (disallowedCapabilities.length > 0) {
    throw badRequestError(`policy_id does not allow requested_capabilities: ${disallowedCapabilities.join(", ")}`)
  }

  return {
    requestedCapabilities: [...policy.requested_capabilities],
    verificationIntent: policy.verification_intent,
    policyId: policy.policy_id,
  }
}

export function inferMembershipGateFailureVerificationPolicy(
  rules: Array<Pick<CommunityGateRuleRow, "scope" | "gate_family" | "gate_type" | "proof_requirements_json">>,
): VerificationPolicyHint | null {
  const requiresDocumentQualifiedSelfProof = rules.some((rule) => (
    rule.scope === "membership"
    && rule.gate_family === "identity_proof"
    && (rule.gate_type === "nationality" || rule.gate_type === "age_over_18" || rule.gate_type === "gender")
  ))

  if (requiresDocumentQualifiedSelfProof) {
    return {
      policy_id: "policy_self_join_v1",
      provider: "self",
      verification_intent: "ucommunity_join",
    }
  }

  const requiresVeryUniqueHumanProof = rules.some((rule) => {
    if (
      rule.scope !== "membership"
      || rule.gate_family !== "identity_proof"
      || rule.gate_type !== "unique_human"
      || !rule.proof_requirements_json
    ) {
      return false
    }

    try {
      const requirements = JSON.parse(rule.proof_requirements_json) as Array<{
        proof_type?: string
        accepted_providers?: string[] | null
      }>
      return requirements.some((requirement) => (
        requirement.proof_type === "unique_human"
        && Array.isArray(requirement.accepted_providers)
        && requirement.accepted_providers.includes("very")
      ))
    } catch {
      return false
    }
  })

  if (!requiresVeryUniqueHumanProof) {
    return null
  }

  return {
    policy_id: "policy_very_join_v1",
    provider: "very",
    verification_intent: "ucommunity_join",
  }
}
