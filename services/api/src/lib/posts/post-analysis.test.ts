import { describe, expect, test } from "bun:test"
import { resolveStubAnalysisOutcome } from "./post-analysis"
import type { CreatePostRequest } from "../../types"

function textPost(title: string): CreatePostRequest {
  return {
    post_type: "text",
    idempotency_key: "post-analysis-test",
    title,
    body: "body",
  }
}

describe("resolveStubAnalysisOutcome", () => {
  test("ignores marker text unless dev markers are enabled", () => {
    expect(resolveStubAnalysisOutcome(textPost("[blocked] literal title")).analysis_state).toBe("allow")
    expect(resolveStubAnalysisOutcome(textPost("[review-required] literal title")).analysis_state).toBe("allow")
  })

  test("honors marker text when dev markers are enabled", () => {
    expect(resolveStubAnalysisOutcome(textPost("[blocked] test title"), { enableDevMarkers: true }).analysis_state).toBe("blocked")
    expect(resolveStubAnalysisOutcome(textPost("[review-required] test title"), { enableDevMarkers: true }).analysis_state).toBe("review_required")
  })
})
