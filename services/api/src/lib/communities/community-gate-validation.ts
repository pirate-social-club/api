import { eligibilityFailed } from "../errors"
import { validateGatePolicy } from "./membership/gate-policy-validation"
import type { GatePolicy } from "./membership/gate-types"

type PublicV0GateValidationBody = {
  membership_mode?: "open" | "request" | "gated" | null
  default_age_gate_policy?: "none" | "18_plus" | null
  anonymous_identity_scope?: "community_stable" | "thread_stable" | "post_ephemeral" | null
  gate_policy?: GatePolicy | unknown
}

export function assertPublicV0GateConfiguration(
  body: PublicV0GateValidationBody,
  input: {
    ageOver18Verified: boolean
  },
): void {
  if (body.gate_policy != null) {
    body.gate_policy = validateGatePolicy(body.gate_policy)
  }
  assertPublicV0MembershipBasics(body, input)
}

function assertPublicV0MembershipBasics(
  body: PublicV0GateValidationBody,
  input: {
    ageOver18Verified: boolean
  },
): void {
  const membershipMode = body.membership_mode ?? "gated"
  if (!["request", "gated"].includes(membershipMode)) {
    throw eligibilityFailed("Public v0 community creation only allows request or gated membership")
  }
  if ((body.anonymous_identity_scope ?? null) === "post_ephemeral") {
    throw eligibilityFailed("post_ephemeral anonymous scope is not allowed in public v0 community creation")
  }
  if ((body.default_age_gate_policy ?? "none") === "18_plus" && !input.ageOver18Verified) {
    throw eligibilityFailed("age_over_18 verification is required for 18_plus communities")
  }
  if (membershipMode !== "gated" && body.gate_policy != null) {
    throw eligibilityFailed("Membership gate policy requires gated membership")
  }
  if (membershipMode === "gated" && body.gate_policy == null) {
    throw eligibilityFailed("Gated membership requires a membership gate policy")
  }
}
