import type { CreatePostRequest, Post } from "../../types"

export function resolveStubAnalysisOutcome(body: CreatePostRequest): Pick<Post, "analysis_state" | "content_safety_state" | "status"> {
  const contentFields = [body.title, body.body, body.caption]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.toLowerCase())
  const blocked = contentFields.some((value) => value.includes("[blocked]"))
  const reviewRequired = contentFields.some((value) => value.includes("[review-required]"))

  if (blocked) {
    return {
      analysis_state: "blocked",
      content_safety_state: "pending",
      status: "draft",
    }
  }

  if (reviewRequired) {
    return {
      analysis_state: "review_required",
      content_safety_state: "pending",
      status: "draft",
    }
  }

  return {
    analysis_state: "allow",
    content_safety_state: "safe",
    status: "published",
  }
}
