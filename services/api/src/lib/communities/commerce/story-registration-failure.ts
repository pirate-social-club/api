// Pure, dependency-free mapping of internal Story registration failures to a
// safe user-facing message + a coarse class for logs/metrics. Raw SDK / contract
// / RPC text (e.g. `mintAndRegisterIpAndAttachPILTerms reverted ... RPC Request
// failed`) must NEVER reach users — it stays in server logs and the story_error
// column only.

export type StoryRegistrationFailureClass =
  | "config_missing"
  | "insufficient_funds"
  | "gas_policy"
  | "transient"

export function sanitizeStoryRegistrationFailure(value: string | null): string | null {
  const normalized = value?.replace(/\s+/g, " ").trim()
  if (!normalized) return null
  return normalized.length > 600 ? `${normalized.slice(0, 600)}...` : normalized
}

export function classifyStoryRegistrationFailure(storyError: string | null): StoryRegistrationFailureClass {
  const value = storyError ?? ""
  if (value.includes("story_royalty_config_missing")) return "config_missing"
  if (/exceeds the balance|insufficient funds|funding below floor|funding_below_floor/i.test(value)) {
    return "insufficient_funds"
  }
  if (value.includes("story_royalty_gas_limit_exceeds_policy")) return "gas_policy"
  return "transient"
}

// Only a genuinely transient failure (e.g. an RPC blip) can succeed on a plain
// retry. The other classes are operator-side blockers (empty signer wallet,
// gas-policy cap, missing config): retrying the same request loops forever and
// never self-heals, so we neither promise a retry in the message nor mark the
// HTTP error retryable.
export function isStoryRegistrationFailureRetryable(failureClass: StoryRegistrationFailureClass): boolean {
  return failureClass === "transient"
}

export function storyRegistrationFailureMessage(storyError: string | null): string {
  switch (classifyStoryRegistrationFailure(storyError)) {
    case "config_missing":
      return "This asset could not be published because Story registration is not configured. Please contact support."
    case "insufficient_funds":
      // Operator signer wallet is below its funding floor — only an operator
      // top-up fixes it. Be honest and suppress the retry prompt so users don't
      // loop; raw wallet/balance detail stays in server logs + the story_error column.
      return "Publishing is temporarily blocked by an operator funding issue on our side. Our team has been notified — you don't need to retry."
    case "gas_policy":
      // Gas estimate exceeded the configured policy cap — an operator/config fix,
      // not something a user retry resolves.
      return "Publishing is temporarily blocked by a configuration issue on our side. Our team has been notified — you don't need to retry."
    default:
      // Genuinely transient (e.g. an RPC blip) — retrying can succeed.
      return "Story registration is temporarily unavailable, so this asset was not published. Please try again in a few minutes."
  }
}
