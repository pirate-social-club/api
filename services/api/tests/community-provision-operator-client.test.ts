import { describe, expect, test } from "bun:test"
import { HttpError } from "../src/lib/errors"
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

  test("sends a request id and preserves operator error details", async () => {
    const originalFetch = globalThis.fetch
    let requestId: string | null = null
    globalThis.fetch = (async (_input, init) => {
      requestId = new Headers(init?.headers).get("x-request-id")
      return new Response(JSON.stringify({
        error_code: "community_provision_operator_failed",
        message: "SQLite error: no such table: community_gate_rules",
      }), {
        status: 500,
        headers: { "content-type": "application/json" },
      })
    }) as typeof globalThis.fetch

    try {
      await provisionCommunityViaOperator({
        env: {
          COMMUNITY_PROVISION_OPERATOR_BASE_URL: "https://operator.test",
          COMMUNITY_PROVISION_OPERATOR_AUTH_TOKEN: "operator-token",
        } satisfies Env,
        communityId: "cmt_operator_error",
        creatorUserId: "usr_01",
        displayName: "Operator Error Club",
        namespaceVerificationId: null,
        groupLocation: "aws-us-east-1",
        bootstrapPayload: {},
      })
      throw new Error("expected provisionCommunityViaOperator to throw")
    } catch (error) {
      expect(requestId).toMatch(/^opr_/)
      expect(error instanceof HttpError).toBe(true)
      expect((error as HttpError).message).toBe("community_provision_operator_failed")
      expect((error as HttpError).details).toMatchObject({
        community_id: "cmt_operator_error",
        operator_error_code: "community_provision_operator_failed",
        operator_message: "SQLite error: no such table: community_gate_rules",
        operator_status: 500,
        operator_request_id: requestId,
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
