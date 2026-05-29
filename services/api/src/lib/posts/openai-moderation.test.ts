import { describe, expect, test } from "bun:test"
import {
  combineModerationDecision,
  moreRestrictive,
  moderationDecisionFromVisualPolicy,
  resolveAdultContentPolicy,
  resolveOpenAIModerationOutcome,
  resolveVisualPlatformDecision,
  outcomeFromDecision,
} from "./openai-moderation"
import type { Community } from "../../types"
import { buildDefaultVisualPolicySettings } from "../communities/community-policy-defaults"

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

describe("combineModerationDecision", () => {
  test("returns the stricter moderation decision", () => {
    expect(combineModerationDecision("allow", "allow_with_gate")).toBe("allow_with_gate")
    expect(combineModerationDecision("allow_with_gate", "review")).toBe("review")
    expect(combineModerationDecision("review", "disallow")).toBe("disallow")
    expect(combineModerationDecision("disallow", "allow")).toBe("disallow")
  })
})

describe("moderationDecisionFromVisualPolicy", () => {
  test("maps visual policy decisions onto post moderation decisions", () => {
    expect(moderationDecisionFromVisualPolicy(null)).toBe("allow")
    expect(moderationDecisionFromVisualPolicy({
      provider: "visual_policy_vlm",
      model: "x-ai/grok-4.3",
      factsByImage: [],
      decision: { policyDecision: "allow", reasonCodes: [], adultSignal: true },
    })).toBe("allow_with_gate")
    expect(moderationDecisionFromVisualPolicy({
      provider: "visual_policy_vlm",
      model: "x-ai/grok-4.3",
      factsByImage: [],
      decision: { policyDecision: "queue", reasonCodes: ["adult_platform_watermark"], adultSignal: true },
    })).toBe("review")
    expect(moderationDecisionFromVisualPolicy({
      provider: "visual_policy_vlm",
      model: "x-ai/grok-4.3",
      factsByImage: [],
      decision: { policyDecision: "reject", reasonCodes: ["explicit_sexual_activity"], adultSignal: true },
    })).toBe("disallow")
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

  test("sexual flag is ignored when a visual policy pass is authoritative", () => {
    const categories = { sexual: true }
    const results = makeResults({ sexual: 0.8 })
    const decision = resolveVisualPlatformDecision(categories, results, BLOCK_THRESHOLD, defaultAdultPolicy, {
      ignoreBroadSexualCategory: true,
    })
    expect(decision).toBe("allow")
  })

  test("sexual ignore does not short-circuit later category mappings", () => {
    const categories = { sexual: true }
    const results = makeResults({ sexual: 0.8 })
    const decision = resolveVisualPlatformDecision(categories, results, BLOCK_THRESHOLD, defaultAdultPolicy, {
      ignoreBroadSexualCategory: true,
    })
    expect(decision).toBe("allow")
  })

  test("sexual/minors is not ignored when a visual policy pass is authoritative", () => {
    const categories = { sexual: true, "sexual/minors": true }
    const results = makeResultsWithMinors(0.97)
    const decision = resolveVisualPlatformDecision(categories, results, BLOCK_THRESHOLD, permissiveAdultPolicy, {
      ignoreBroadSexualCategory: true,
    })
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

  test("review preserves adult classification for sexual content", () => {
    const out = outcomeFromDecision("review", {
      provider: "openai",
      categories: { sexual: true },
    })
    expect(out.analysis_state).toBe("review_required")
    expect(out.content_safety_state).toBe("adult")
    expect(out.status).toBe("draft")
    expect(out.age_gate_policy).toBe("18_plus")
  })

  test("review preserves adult classification from visual policy adult signals", () => {
    const out = outcomeFromDecision("review", {
      provider: "openai",
      visual_policy: {
        decision: { adultSignal: true },
      },
    })
    expect(out.analysis_state).toBe("review_required")
    expect(out.content_safety_state).toBe("adult")
    expect(out.status).toBe("draft")
    expect(out.age_gate_policy).toBe("18_plus")
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

describe("resolveOpenAIModerationOutcome", () => {
  const originalFetch = globalThis.fetch

  function installModerationFetchMock(visualFacts: Record<string, unknown>, openAiCategories: Record<string, boolean> = {}) {
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      const href = String(url)
      if (href.includes("openrouter.test")) {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify(visualFacts),
            },
          }],
        }), { status: 200, headers: { "content-type": "application/json" } })
      }
      return new Response(JSON.stringify({
        results: [{
          categories: openAiCategories,
          category_scores: {},
        }],
      }), { status: 200, headers: { "content-type": "application/json" } })
    }) as typeof fetch
  }

  function installOpenAIModerationFetchMock(openAiCategories: Record<string, boolean> = {}) {
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      const href = String(url)
      if (href.includes("openrouter.test")) {
        throw new Error("OpenRouter should not be called")
      }
      return new Response(JSON.stringify({
        results: [{
          categories: openAiCategories,
          category_scores: {},
        }],
      }), { status: 200, headers: { "content-type": "application/json" } })
    }) as typeof fetch
  }

  function installOpenAIUnavailableFetchMock() {
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      const href = String(url)
      if (href.includes("openrouter.test")) {
        throw new Error("OpenRouter should not be called")
      }
      return new Response(JSON.stringify({ error: "temporarily unavailable" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch
  }

  function installInvalidOpenAIFetchMock() {
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      const href = String(url)
      if (href.includes("openrouter.test")) {
        throw new Error("OpenRouter should not be called")
      }
      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch
  }

  function installFailingVisualPolicyFetchMock(openAiCategories: Record<string, boolean> = {}, openAiScores: Record<string, number> = {}) {
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      const href = String(url)
      if (href.includes("openrouter.test")) {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: "{not valid json",
            },
          }],
        }), { status: 200, headers: { "content-type": "application/json" } })
      }
      return new Response(JSON.stringify({
        results: [{
          categories: openAiCategories,
          category_scores: openAiScores,
        }],
      }), { status: 200, headers: { "content-type": "application/json" } })
    }) as typeof fetch
  }

  function restoreFetch() {
    globalThis.fetch = originalFetch
  }

  test("visual posts fail creation when OPENAI_API_KEY is missing", async () => {
    await expect(resolveOpenAIModerationOutcome({
      env: {},
      community: {
        community_id: "com_missing_openai_key",
        default_age_gate_policy: "none",
      } as Community,
      body: {
        idempotency_key: "idem_missing_openai_key",
        post_type: "image",
        media_refs: [{
          storage_ref: "https://example.test/image.jpg",
          mime_type: "image/jpeg",
          size_bytes: 12,
        }],
      },
    })).rejects.toMatchObject({
      code: "provider_unavailable",
      details: {
        missing: "OPENAI_API_KEY",
        provider: "openai",
      },
      retryable: true,
      status: 502,
    })
  })

  test("visual posts fail creation when OpenAI moderation is unavailable", async () => {
    installOpenAIUnavailableFetchMock()
    try {
      await expect(resolveOpenAIModerationOutcome({
        env: {
          OPENAI_API_KEY: "test-openai-key",
        },
        community: {
          community_id: "com_openai_unavailable",
          default_age_gate_policy: "none",
        } as Community,
        body: {
          idempotency_key: "idem_openai_unavailable",
          post_type: "image",
          media_refs: [{
            storage_ref: "https://example.test/image.jpg",
            mime_type: "image/jpeg",
            size_bytes: 12,
          }],
        },
      })).rejects.toMatchObject({
        code: "provider_unavailable",
        details: {
          provider: "openai",
          status: 503,
        },
        retryable: true,
        status: 502,
      })
    } finally {
      restoreFetch()
    }
  })

  test("visual posts fail creation when OpenAI moderation returns invalid results", async () => {
    installInvalidOpenAIFetchMock()
    try {
      await expect(resolveOpenAIModerationOutcome({
        env: {
          OPENAI_API_KEY: "test-openai-key",
        },
        community: {
          community_id: "com_openai_invalid",
          default_age_gate_policy: "none",
        } as Community,
        body: {
          idempotency_key: "idem_openai_invalid",
          post_type: "image",
          media_refs: [{
            storage_ref: "https://example.test/image.jpg",
            mime_type: "image/jpeg",
            size_bytes: 12,
          }],
        },
      })).rejects.toMatchObject({
        code: "provider_unavailable",
        details: {
          error: "invalid_response",
          provider: "openai",
        },
        retryable: true,
        status: 502,
      })
    } finally {
      restoreFetch()
    }
  })

  test("Grok visual policy rejection blocks even when OpenAI moderation allows", async () => {
    installModerationFetchMock({
      visualStyle: "photographic",
      characterContext: "real_person",
      apparentAgeRisk: "adult",
      nudity: "topless",
      visibleNipples: true,
      sexualActivity: "explicit",
      sexualizedContact: true,
      masturbation: false,
      oralSex: false,
      sexToy: "none",
      voyeuristicOrHiddenCamera: false,
      commercialSignal: "adult_platform_watermark",
      syntheticRisk: "none",
      imageTextSignal: "url",
      safetySignal: "none",
      quality: "clear",
    })
    try {
      const outcome = await resolveOpenAIModerationOutcome({
        env: {
          OPENAI_API_KEY: "openai-test",
          OPENAI_MODERATION_BASE_URL: "https://openai.test/v1",
          OPENROUTER_API_KEY: "openrouter-test",
          OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
        },
        community: {
          community_id: "com_visual_reject",
          default_age_gate_policy: "18_plus",
          visual_policy_settings: buildDefaultVisualPolicySettings("visual_reject", new Date().toISOString()),
        } as Community,
        body: {
          idempotency_key: "idem_visual_reject",
          post_type: "image",
          media_refs: [{
            storage_ref: "https://example.test/image.jpg",
            mime_type: "image/jpeg",
            size_bytes: 12,
          }],
        },
      })

      expect(outcome.analysis_state).toBe("blocked")
      expect(outcome.status).toBe("draft")
      expect((outcome.providerResult?.visual_policy as { model?: string } | undefined)?.model).toBe("x-ai/grok-4.3")
    } finally {
      restoreFetch()
    }
  })

  test("Grok visual policy adult allow applies the 18+ gate when OpenAI moderation allows", async () => {
    installModerationFetchMock({
      visualStyle: "photographic",
      characterContext: "real_person",
      apparentAgeRisk: "adult",
      nudity: "topless",
      visibleNipples: true,
      sexualActivity: "none",
      sexualizedContact: false,
      masturbation: false,
      oralSex: false,
      sexToy: "none",
      voyeuristicOrHiddenCamera: false,
      commercialSignal: "none",
      syntheticRisk: "none",
      imageTextSignal: "none",
      safetySignal: "none",
      quality: "clear",
    })
    try {
      const outcome = await resolveOpenAIModerationOutcome({
        env: {
          OPENAI_API_KEY: "openai-test",
          OPENAI_MODERATION_BASE_URL: "https://openai.test/v1",
          OPENROUTER_API_KEY: "openrouter-test",
          OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
        },
        community: {
          community_id: "com_visual_adult_allow",
          default_age_gate_policy: "18_plus",
          visual_policy_settings: buildDefaultVisualPolicySettings("visual_adult_allow", new Date().toISOString()),
        } as Community,
        body: {
          idempotency_key: "idem_visual_adult_allow",
          post_type: "image",
          media_refs: [{
            storage_ref: "https://example.test/image.jpg",
            mime_type: "image/jpeg",
            size_bytes: 12,
          }],
        },
      })

      expect(outcome.analysis_state).toBe("allow")
      expect(outcome.content_safety_state).toBe("adult")
      expect(outcome.status).toBe("published")
      expect(outcome.age_gate_policy).toBe("18_plus")
    } finally {
      restoreFetch()
    }
  })

  test("non-18+ image moderation does not call Grok", async () => {
    installOpenAIModerationFetchMock({})
    try {
      const outcome = await resolveOpenAIModerationOutcome({
        env: {
          OPENAI_API_KEY: "openai-test",
          OPENAI_MODERATION_BASE_URL: "https://openai.test/v1",
          OPENROUTER_API_KEY: "openrouter-test",
          OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
        },
        community: {
          community_id: "com_sfw_no_grok",
          default_age_gate_policy: "none",
          visual_policy_settings: buildDefaultVisualPolicySettings("sfw_no_grok", new Date().toISOString()),
        } as Community,
        body: {
          idempotency_key: "idem_sfw_no_grok",
          post_type: "image",
          media_refs: [{
            storage_ref: "https://example.test/image.jpg",
            mime_type: "image/jpeg",
            size_bytes: 12,
          }],
        },
      })

      expect(outcome.analysis_state).toBe("allow")
      expect(outcome.providerResult?.visual_policy).toBeNull()
    } finally {
      restoreFetch()
    }
  })

  test("18+ visual policy ignores OpenAI broad sexual but keeps Grok decision", async () => {
    installModerationFetchMock({
      visualStyle: "photographic",
      characterContext: "real_person",
      apparentAgeRisk: "adult",
      nudity: "topless",
      visibleNipples: true,
      sexualActivity: "none",
      sexualizedContact: false,
      masturbation: false,
      oralSex: false,
      sexToy: "none",
      voyeuristicOrHiddenCamera: false,
      commercialSignal: "none",
      syntheticRisk: "none",
      imageTextSignal: "none",
      safetySignal: "none",
      quality: "clear",
    }, { sexual: true })
    try {
      const outcome = await resolveOpenAIModerationOutcome({
        env: {
          OPENAI_API_KEY: "openai-test",
          OPENAI_MODERATION_BASE_URL: "https://openai.test/v1",
          OPENROUTER_API_KEY: "openrouter-test",
          OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
        },
        community: {
          community_id: "com_visual_ignores_openai_sexual",
          default_age_gate_policy: "18_plus",
          visual_policy_settings: buildDefaultVisualPolicySettings("visual_ignore_openai_sexual", new Date().toISOString()),
        } as Community,
        body: {
          idempotency_key: "idem_visual_ignore_openai_sexual",
          post_type: "image",
          media_refs: [{
            storage_ref: "https://example.test/image.jpg",
            mime_type: "image/jpeg",
            size_bytes: 12,
          }],
        },
      })

      expect(outcome.analysis_state).toBe("allow")
      expect(outcome.content_safety_state).toBe("adult")
      expect(outcome.age_gate_policy).toBe("18_plus")
    } finally {
      restoreFetch()
    }
  })

  test("18+ visual policy failure queues the post", async () => {
    installFailingVisualPolicyFetchMock({})
    try {
      const outcome = await resolveOpenAIModerationOutcome({
        env: {
          OPENAI_API_KEY: "openai-test",
          OPENAI_MODERATION_BASE_URL: "https://openai.test/v1",
          OPENROUTER_API_KEY: "openrouter-test",
          OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
        },
        community: {
          community_id: "com_visual_unavailable",
          default_age_gate_policy: "18_plus",
          visual_policy_settings: buildDefaultVisualPolicySettings("visual_unavailable", new Date().toISOString()),
        } as Community,
        body: {
          idempotency_key: "idem_visual_unavailable",
          post_type: "image",
          media_refs: [{
            storage_ref: "https://example.test/image.jpg",
            mime_type: "image/jpeg",
            size_bytes: 12,
          }],
        },
      })

      expect(outcome.analysis_state).toBe("review_required")
      expect(outcome.content_safety_state).toBe("adult")
      expect(outcome.age_gate_policy).toBe("18_plus")
      expect((outcome.providerResult?.visual_policy as { decision?: { reasonCodes?: string[] } } | undefined)?.decision?.reasonCodes)
        .toContain("visual_classifier_unavailable")
    } finally {
      restoreFetch()
    }
  })

  test("sexual minors still blocks when 18+ visual policy fails", async () => {
    installFailingVisualPolicyFetchMock(
      { sexual: true, "sexual/minors": true },
      { "sexual/minors": 0.98 },
    )
    try {
      const outcome = await resolveOpenAIModerationOutcome({
        env: {
          OPENAI_API_KEY: "openai-test",
          OPENAI_MODERATION_BASE_URL: "https://openai.test/v1",
          OPENROUTER_API_KEY: "openrouter-test",
          OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
        },
        community: {
          community_id: "com_visual_unavailable_minors",
          default_age_gate_policy: "18_plus",
          visual_policy_settings: buildDefaultVisualPolicySettings("visual_unavailable_minors", new Date().toISOString()),
        } as Community,
        body: {
          idempotency_key: "idem_visual_unavailable_minors",
          post_type: "image",
          media_refs: [{
            storage_ref: "https://example.test/image.jpg",
            mime_type: "image/jpeg",
            size_bytes: 12,
          }],
        },
      })

      expect(outcome.analysis_state).toBe("blocked")
      expect(outcome.status).toBe("draft")
    } finally {
      restoreFetch()
    }
  })
})
