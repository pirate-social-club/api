import { describe, expect, test } from "bun:test"
import {
  moreRestrictive,
  resolveAdultContentPolicy,
  resolveVisualPlatformDecision,
  outcomeFromDecision,
} from "./openai-moderation"
import type { Community } from "../../types"

type AdultContentPolicy = Community["adult_content_policy"]

const defaultAdultPolicy: AdultContentPolicy = {
  community: "com_test",
  policy_origin: "default",
  suggestive: "review",
  artistic_nudity: "disallow",
  explicit_nudity: "disallow",
  explicit_sexual_content: "disallow",
  fetish_content: "disallow",
}

const permissiveAdultPolicy: AdultContentPolicy = {
  community: "com_permissive",
  policy_origin: "explicit",
  suggestive: "allow",
  artistic_nudity: "allow",
  explicit_nudity: "allow",
  explicit_sexual_content: "allow",
  fetish_content: "allow",
}

const mixedAdultPolicy: AdultContentPolicy = {
  community: "com_mixed",
  policy_origin: "explicit",
  suggestive: "allow",
  artistic_nudity: "review",
  explicit_nudity: "allow",
  explicit_sexual_content: "disallow",
  fetish_content: "disallow",
}

const reviewOnlyPolicy: AdultContentPolicy = {
  community: "com_review",
  policy_origin: "explicit",
  suggestive: "allow",
  artistic_nudity: "review",
  explicit_nudity: "review",
  explicit_sexual_content: "review",
  fetish_content: "review",
}

function makeResults(scores: Record<string, number> = {}) {
  return [{ categories: { sexual: true, "sexual/minors": false }, category_scores: scores }]
}

function makeResultsWithMinors(minorsScore: number) {
  return [{ categories: { sexual: true, "sexual/minors": true }, category_scores: { "sexual/minors": minorsScore } }]
}

const BLOCK_THRESHOLD = 0.95

describe("moreRestrictive", () => {
  test("returns the more restrictive policy level", () => {
    expect(moreRestrictive("allow", "review")).toBe("review")
    expect(moreRestrictive("review", "allow")).toBe("review")
    expect(moreRestrictive("allow", "disallow")).toBe("disallow")
    expect(moreRestrictive("disallow", "review")).toBe("disallow")
    expect(moreRestrictive("allow", "allow")).toBe("allow")
    expect(moreRestrictive("review", "review")).toBe("review")
    expect(moreRestrictive("disallow", "disallow")).toBe("disallow")
  })
})

describe("resolveVisualPlatformDecision", () => {
  test("sexual/minors with high score returns disallow regardless of policy", () => {
    const categories = { sexual: true, "sexual/minors": true }
    const results = makeResultsWithMinors(0.97)
    const decision = resolveVisualPlatformDecision(categories, results, BLOCK_THRESHOLD, permissiveAdultPolicy)
    expect(decision).toBe("disallow")
  })

  test("sexual/minors below threshold does not hard-block", () => {
    const categories = { sexual: true, "sexual/minors": true }
    const results = makeResultsWithMinors(0.5)
    const decision = resolveVisualPlatformDecision(categories, results, BLOCK_THRESHOLD, permissiveAdultPolicy)
    expect(decision).toBe("allow_with_gate")
  })

  test("sexual flagged with disallow policy returns disallow", () => {
    const categories = { sexual: true }
    const results = makeResults({ sexual: 0.8 })
    const decision = resolveVisualPlatformDecision(categories, results, BLOCK_THRESHOLD, defaultAdultPolicy)
    expect(decision).toBe("disallow")
  })

  test("sexual flagged with review policy returns review", () => {
    const categories = { sexual: true }
    const results = makeResults({ sexual: 0.8 })
    const decision = resolveVisualPlatformDecision(categories, results, BLOCK_THRESHOLD, reviewOnlyPolicy)
    expect(decision).toBe("review")
  })

  test("sexual flagged with allow policy returns allow_with_gate", () => {
    const categories = { sexual: true }
    const results = makeResults({ sexual: 0.8 })
    const decision = resolveVisualPlatformDecision(categories, results, BLOCK_THRESHOLD, permissiveAdultPolicy)
    expect(decision).toBe("allow_with_gate")
  })

  test("mixed policy: more restrictive field wins for disallow", () => {
    const categories = { sexual: true }
    const results = makeResults({ sexual: 0.8 })
    const decision = resolveVisualPlatformDecision(categories, results, BLOCK_THRESHOLD, mixedAdultPolicy)
    expect(decision).toBe("disallow")
  })

  test("mixed policy: review + allow produces review", () => {
    const mixedReviewPolicy: AdultContentPolicy = {
      ...mixedAdultPolicy,
      explicit_nudity: "review",
      explicit_sexual_content: "allow",
    }
    const categories = { sexual: true }
    const results = makeResults({ sexual: 0.8 })
    const decision = resolveVisualPlatformDecision(categories, results, BLOCK_THRESHOLD, mixedReviewPolicy)
    expect(decision).toBe("review")
  })

  test("no sexual flag returns allow", () => {
    const categories = {}
    const results = [{ categories: {}, category_scores: {} }]
    const decision = resolveVisualPlatformDecision(categories, results, BLOCK_THRESHOLD, defaultAdultPolicy)
    expect(decision).toBe("allow")
  })

  test("violence flag without sexual returns allow (no violence mapping yet)", () => {
    const categories = { violence: true }
    const results = [{ categories: { violence: true }, category_scores: { violence: 0.9 } }]
    const decision = resolveVisualPlatformDecision(categories, results, BLOCK_THRESHOLD, defaultAdultPolicy)
    expect(decision).toBe("allow")
  })
})

describe("outcomeFromDecision", () => {
  test("disallow produces blocked draft with no age gate", () => {
    const out = outcomeFromDecision("disallow", null)
    expect(out.analysis_state).toBe("blocked")
    expect(out.content_safety_state).toBe("pending")
    expect(out.status).toBe("draft")
    expect(out.age_gate_policy).toBe("none")
  })

  test("review produces review_required draft with no age gate", () => {
    const out = outcomeFromDecision("review", null)
    expect(out.analysis_state).toBe("review_required")
    expect(out.content_safety_state).toBe("pending")
    expect(out.status).toBe("draft")
    expect(out.age_gate_policy).toBe("none")
  })

  test("allow_with_gate produces published adult with 18_plus gate", () => {
    const out = outcomeFromDecision("allow_with_gate", null)
    expect(out.analysis_state).toBe("allow")
    expect(out.content_safety_state).toBe("adult")
    expect(out.status).toBe("published")
    expect(out.age_gate_policy).toBe("18_plus")
  })

  test("allow produces published safe with no age gate", () => {
    const out = outcomeFromDecision("allow", null)
    expect(out.analysis_state).toBe("allow")
    expect(out.content_safety_state).toBe("safe")
    expect(out.status).toBe("published")
    expect(out.age_gate_policy).toBe("none")
  })
})

describe("resolveAdultContentPolicy", () => {
  test("returns community policy when set", () => {
    const community = {
      community_id: "com_test",
      adult_content_policy: permissiveAdultPolicy,
    } as Community
    const policy = resolveAdultContentPolicy(community)
    expect(policy).toBe(permissiveAdultPolicy)
  })

  test("returns default policy when community has no policy set", () => {
    const community = {
      community_id: "com_new",
      default_age_gate_policy: "none" as const,
    } as Community
    const policy = resolveAdultContentPolicy(community)
    expect(policy.explicit_nudity).toBe("disallow")
    expect(policy.explicit_sexual_content).toBe("disallow")
    expect(policy.suggestive).toBe("review")
  })

  test("returns 18+ default policy for community with 18_plus gate", () => {
    const community = {
      community_id: "com_adult",
      default_age_gate_policy: "18_plus" as const,
    } as Community
    const policy = resolveAdultContentPolicy(community)
    expect(policy.explicit_nudity).toBe("disallow")
    expect(policy.explicit_sexual_content).toBe("disallow")
    expect(policy.suggestive).toBe("allow")
    expect(policy.artistic_nudity).toBe("review")
  })
})