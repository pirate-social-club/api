import { describe, expect, test } from "bun:test"
import { resolvePostAnalysisProvider } from "./post-analysis"
import type { Community, CreatePostRequest, Env } from "../../types"

function textPost(title: string): CreatePostRequest {
  return {
    post_type: "text",
    idempotency_key: "post-analysis-test",
    title,
    body: "body",
  }
}

const community = {
  openai_moderation_settings: null,
} as Community

async function analyze(env: Partial<Env>, body: CreatePostRequest) {
  return resolvePostAnalysisProvider(env).analyze({
    env,
    community,
    body,
  })
}

describe("post analysis provider", () => {
  test("ignores dev marker text outside local environments", async () => {
    expect((await analyze({ ENVIRONMENT: "production" }, textPost("[blocked] literal title"))).analysis_state).toBe("allow")
    expect((await analyze({ ENVIRONMENT: "production" }, textPost("[review-required] literal title"))).analysis_state).toBe("allow")
  })

  test("honors marker text in local environments", async () => {
    expect((await analyze({ ENVIRONMENT: "development" }, textPost("[blocked] test title"))).analysis_state).toBe("blocked")
    expect((await analyze({ ENVIRONMENT: "development" }, textPost("[review-required] test title"))).analysis_state).toBe("review_required")
  })
})
