import { describe, expect, test } from "bun:test"
import { buildCommunitySeedStatements } from "./community-local-db"

describe("buildCommunitySeedStatements", () => {
  test("seeds namespace claims disabled and preserves later owner configuration", () => {
    const statements = buildCommunitySeedStatements({
      rootDir: "/tmp/unused",
      communityId: "community_test",
      createdByUserId: "user_test",
      displayName: "Test",
      description: null,
      avatarRef: null,
      bannerRef: null,
      namespaceVerificationId: "verification_test",
      namespaceLabel: "pokemon",
      membershipMode: "open",
      defaultAgeGatePolicy: "none",
      allowAnonymousIdentity: false,
      anonymousIdentityScope: null,
      governanceMode: "centralized",
      handlePolicyTemplate: "standard",
      pricingModel: "free",
      gatePolicy: null,
      rules: [],
      now: "2026-07-17T00:00:00.000Z",
    })

    const policy = statements.find((statement) => statement.sql.includes("INSERT INTO namespace_handle_policies"))
    expect(policy).toBeDefined()
    expect(policy!.sql).toContain("?1, ?2, ?3, ?4, ?5, 1, 0, ?6, ?7, ?7")
    expect(policy!.sql).not.toContain("claims_enabled = excluded.claims_enabled")
  })
})
