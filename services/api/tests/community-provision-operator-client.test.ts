import { describe, expect, test } from "bun:test"
import { provisionCommunityViaOperator } from "../src/lib/communities/provisioning/operator-client"
import type { Env } from "../src/types"

describe("community provision operator client", () => {
  test("rejects a provision response from an unexpected Turso organization", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({
      community_id: "cmt_wrong_org",
      job_id: "job_wrong_org",
      binding_id: "cdb_wrong_org",
      credential_id: "cdc_wrong_org",
      organization_slug: "pirate-social",
      group_name: "region-aws-us-east-1",
      group_id: "grp_wrong_org",
      database_name: "main-cmt-wrong-org",
      database_id: "db_wrong_org",
      database_url: "libsql://main-cmt-wrong-org-pirate-social.aws-us-east-1.turso.io",
      location: "aws-us-east-1",
      token_name: "worker-cmt_wrong_org-v1",
      plaintext_token: "db-token-wrong-org",
      issued_at: "2026-04-29T00:00:00.000Z",
      expires_at: null,
      rotation_number: 1,
    }), {
      headers: { "content-type": "application/json" },
    })) as typeof globalThis.fetch

    try {
      await expect(provisionCommunityViaOperator({
        env: {
          COMMUNITY_PROVISION_OPERATOR_BASE_URL: "https://operator.test",
          COMMUNITY_PROVISION_OPERATOR_AUTH_TOKEN: "operator-token",
          COMMUNITY_PROVISION_EXPECTED_ORGANIZATION_SLUG: "pirate-prod",
        } satisfies Env,
        communityId: "cmt_wrong_org",
        creatorUserId: "usr_01",
        displayName: "Wrong Org Club",
        namespaceVerificationId: null,
        groupLocation: "aws-us-east-1",
        bootstrapPayload: {},
      })).rejects.toThrow("community_provision_operator_organization_mismatch")
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
