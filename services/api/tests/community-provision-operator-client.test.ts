import { describe, expect, test } from "bun:test"
import { HttpError } from "../src/lib/errors"
import {
  migrateCommunityDatabaseViaOperator,
  provisionCommunityViaOperator,
} from "../src/lib/communities/provisioning/operator-client"
import type { Env } from "../src/types"

function mockOperatorBinding(handler: (request: Request) => Promise<Response> | Response): Fetcher {
  return {
    fetch: (request: Request | string) => handler(typeof request === "string" ? new Request(request) : request),
  } as Fetcher
}

describe("community provision operator client", () => {
  test("migrates a community database through the operator", async () => {
    let requestId: string | null = null
    let requestBody: Record<string, unknown> | null = null
    const operator = mockOperatorBinding(async (request) => {
      requestId = request.headers.get("x-request-id")
      requestBody = await request.json() as Record<string, unknown>
      expect(new URL(request.url).pathname).toBe("/internal/v0/community-provisioning/migrate")
      expect(request.headers.get("authorization")).toBe("Bearer operator-token")
      return new Response(JSON.stringify({
        applied: 1,
        skipped: 61,
      }), {
        headers: { "content-type": "application/json" },
      })
    })

    const result = await migrateCommunityDatabaseViaOperator({
      env: {
        COMMUNITY_PROVISION_OPERATOR: operator,
        COMMUNITY_PROVISION_OPERATOR_AUTH_TOKEN: "operator-token",
      } satisfies Env,
      communityId: "cmt_migrate",
      databaseUrl: "libsql://community.test.turso.io",
      databaseAuthToken: "community-db-token",
    })

    expect(requestId).toMatch(/^opr_/)
    expect(requestBody).toEqual({
      database_url: "libsql://community.test.turso.io",
      database_auth_token: "community-db-token",
    })
    expect(result).toEqual({
      applied: 1,
      skipped: 61,
    })
  })

  test("preserves migrate operator error details", async () => {
    let requestId: string | null = null
    const operator = mockOperatorBinding((request) => {
      requestId = request.headers.get("x-request-id")
      return new Response(JSON.stringify({
        error_code: "community_provision_operator_failed",
        message: "schema_migration_checksum_mismatch:1001_community_core.sql",
      }), {
        status: 500,
        headers: { "content-type": "application/json" },
      })
    })

    try {
      await migrateCommunityDatabaseViaOperator({
        env: {
          COMMUNITY_PROVISION_OPERATOR: operator,
          COMMUNITY_PROVISION_OPERATOR_AUTH_TOKEN: "operator-token",
        } satisfies Env,
        communityId: "cmt_migrate_error",
        databaseUrl: "libsql://community.test.turso.io",
        databaseAuthToken: "community-db-token",
      })
      throw new Error("expected migrateCommunityDatabaseViaOperator to throw")
    } catch (error) {
      expect(requestId).toMatch(/^opr_/)
      expect(error instanceof HttpError).toBe(true)
      expect((error as HttpError).message).toBe("community_provision_operator_failed")
      expect((error as HttpError).details).toMatchObject({
        community_id: "cmt_migrate_error",
        operator_error_code: "community_provision_operator_failed",
        operator_message: "schema_migration_checksum_mismatch:1001_community_core.sql",
        operator_status: 500,
        operator_request_id: requestId,
      })
    }
  })

  test("rejects a provision response from an unexpected Turso organization", async () => {
    const operator = mockOperatorBinding(() => new Response(JSON.stringify({
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
    }))

    await expect(provisionCommunityViaOperator({
      env: {
        COMMUNITY_PROVISION_OPERATOR: operator,
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
  })

  test("sends a request id and preserves operator error details", async () => {
    let requestId: string | null = null
    const operator = mockOperatorBinding((request) => {
      requestId = request.headers.get("x-request-id")
      return new Response(JSON.stringify({
        error_code: "community_provision_operator_failed",
        message: "SQLite error: no such table: community_gate_rules",
      }), {
        status: 500,
        headers: { "content-type": "application/json" },
      })
    })

    try {
      await provisionCommunityViaOperator({
        env: {
          COMMUNITY_PROVISION_OPERATOR: operator,
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
    }
  })
})
