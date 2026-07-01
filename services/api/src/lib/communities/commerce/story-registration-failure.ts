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

export function storyRegistrationFailureMessage(storyError: string | null): string {
  if (classifyStoryRegistrationFailure(storyError) === "config_missing") {
    return "This asset could not be published because Story registration is not configured. Please contact support."
  }
  // transient / insufficient_funds / gas_policy are all operational failures the
  // user cannot act on beyond retrying — surface a single safe message and keep
  // the underlying detail in logs.
  return "Story registration is temporarily unavailable, so this asset was not published. Please try again in a few minutes."
}
