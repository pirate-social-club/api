import { describe, expect, test } from "bun:test"
import {
  communityMembershipRequiredError,
  communityNotFoundError,
  communityShardSettingsMissingError,
  errorResponse,
  notFoundError,
} from "./errors"

describe("community not-found error diagnostics", () => {
  const helpers = [
    { name: "communityNotFoundError", make: () => communityNotFoundError(), logCode: "community_not_found" },
    { name: "communityMembershipRequiredError", make: () => communityMembershipRequiredError(), logCode: "community_membership_required" },
    { name: "communityShardSettingsMissingError", make: () => communityShardSettingsMissingError(), logCode: "community_shard_settings_missing" },
  ]

  test("all three present an identical client-visible body (no membership/existence leak)", () => {
    const bodies = helpers.map((h) => errorResponse(h.make()).body)
    for (const body of bodies) {
      expect(body.code).toBe("not_found")
      expect(body.message).toBe("Community not found")
      expect(body).toEqual(bodies[0])
    }
  })

  test("each carries a distinct log-side logCode", () => {
    for (const h of helpers) {
      expect(h.make().logCode).toBe(h.logCode)
    }
    const logCodes = new Set(helpers.map((h) => h.make().logCode))
    expect(logCodes.size).toBe(helpers.length)
  })

  test("logCode and logContext are never serialized into the response body", () => {
    const err = communityShardSettingsMissingError({ community_id: "cmt_secret" })
    const { body } = errorResponse(err)
    expect(JSON.stringify(body)).not.toContain("logCode")
    expect(JSON.stringify(body)).not.toContain("logContext")
    expect(JSON.stringify(body)).not.toContain("cmt_secret")
    expect(JSON.stringify(body)).not.toContain("community_shard_settings_missing")
  })

  test("logCode defaults to the wire code when no diagnostic override is set", () => {
    expect(notFoundError("nope").logCode).toBe("not_found")
  })
})
