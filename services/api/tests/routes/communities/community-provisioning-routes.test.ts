import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import app from "../../../src/index"
import { decryptCommunityDbCredential } from "../../../src/lib/communities/community-db-credential-crypto"
import { createRouteTestContext, json, resetRuntimeCaches } from "../../helpers"
import {
  completeUniqueHumanVerification,
  exchangeJwt,
  getCommunityControlPlaneState,
  prepareVerifiedNamespace,
  requestJson,
} from "./community-routes-test-helpers"

let cleanup: (() => Promise<void>) | null = null
const testWithTimeout = test as unknown as (name: string, fn: () => Promise<void>, timeout: number) => void

beforeEach(() => {
  resetRuntimeCaches()
})

afterEach(async () => {
  if (cleanup) {
    await cleanup()
    cleanup = null
  }
})

describe("community provisioning routes", () => {
  testWithTimeout("community create provisions through the private operator when configured", async () => {
    const operatorBaseUrl = "https://operator.test"
    const operatorToken = "operator-secret"
    const wrapKey = "11".repeat(32)
    const originalFetch = globalThis.fetch
    let provisionBody: Record<string, unknown> | null = null

    globalThis.fetch = (async (input, init) => {
      const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (requestUrl.startsWith(`${operatorBaseUrl}/internal/v0/community-provisioning/provision`)) {
        const authHeader = init?.headers instanceof Headers
          ? init.headers.get("authorization")
          : Array.isArray(init?.headers)
            ? init.headers.find(([key]) => key.toLowerCase() === "authorization")?.[1]
            : init?.headers && "authorization" in init.headers
              ? String((init.headers as Record<string, unknown>).authorization)
              : null
        expect(authHeader).toBe(`Bearer ${operatorToken}`)
        provisionBody = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null

        return new Response(JSON.stringify({
          community_id: "cmt_operator_test",
          job_id: "job_operator_runtime",
          binding_id: "cdb_operator_runtime",
          credential_id: "cdc_operator_runtime",
          organization_slug: "pirate-org",
          group_name: "region-aws-ap-south-1",
          group_id: "grp_operator_test",
          database_name: "main-cmt-operator-test",
          database_id: "db_operator_test",
          database_url: "libsql://main-cmt-operator-test-pirate-org.aws-ap-south-1.turso.io",
          location: "aws-ap-south-1",
          token_name: "worker-cmt_operator_test-v1",
          plaintext_token: "db-token-operator-test",
          issued_at: "2026-04-15T18:00:00.000Z",
          expires_at: null,
          rotation_number: 1,
        }), {
          headers: { "content-type": "application/json" },
        })
      }

      if (requestUrl.includes(".turso.io")) {
        return new Response("remote db unavailable in test", { status: 503 })
      }

      return originalFetch(input as never, init)
    }) as typeof globalThis.fetch

    try {
      const ctx = await createRouteTestContext({
        LOCAL_COMMUNITY_DB_ROOT: "",
        COMMUNITY_PROVISION_OPERATOR_BASE_URL: operatorBaseUrl,
        COMMUNITY_PROVISION_OPERATOR_AUTH_TOKEN: operatorToken,
        COMMUNITY_PROVISION_DEFAULT_GROUP_LOCATION: "aws-us-east-1",
        COMMUNITY_PROVISION_ALLOWED_GROUP_LOCATIONS: "aws-us-east-1,aws-ap-south-1",
        COMMUNITY_PROVISION_OPERATOR_TIMEOUT_MS: "2000",
        TURSO_COMMUNITY_DB_WRAP_KEY: wrapKey,
        TURSO_COMMUNITY_DB_WRAP_KEY_VERSION: "7",
      })
      cleanup = ctx.cleanup

      const session = await exchangeJwt(ctx.env, "community-operator-user")
      const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken)

      const response = await requestJson("http://pirate.test/communities", {
        display_name: "Operator Club",
        database_region: "aws-ap-south-1",
        namespace: {
          namespace_verification_id: namespaceVerificationId,
        },
      }, ctx.env, session.accessToken)

      expect(response.status).toBe(202)
      const body = await json(response) as {
        community: {
          community_id: string
          namespace_verification_id: string | null
          provisioning_state: string
        }
        job: {
          job_id: string
          status: string
        }
      }

      expect(body.community.provisioning_state).toBe("active")
      expect(body.community.namespace_verification_id).toBe(namespaceVerificationId)
      expect(body.job.status).toBe("succeeded")
      if (!provisionBody) {
        throw new Error("operator provision request was not captured")
      }
      const operatorRequest = provisionBody
      expect(operatorRequest["community_id"]).toBe(body.community.community_id)
      expect(operatorRequest["group_location"]).toBe("aws-ap-south-1")
      expect((operatorRequest["bootstrap_payload"] as Record<string, unknown> | null)?.["namespace_label"]).toBe("piratecommunityroot")

      const bindingRows = await ctx.client.execute({
        sql: `
          SELECT community_database_binding_id, organization_slug, group_name, database_name, database_url, location, status
          FROM community_database_bindings
          WHERE community_id = ?1
            AND binding_role = 'primary'
          LIMIT 1
        `,
        args: [body.community.community_id],
      })
      expect(bindingRows.rows[0]?.organization_slug).toBe("pirate-org")
      expect(bindingRows.rows[0]?.group_name).toBe("region-aws-ap-south-1")
      expect(bindingRows.rows[0]?.database_name).toBe("main-cmt-operator-test")
      expect(bindingRows.rows[0]?.database_url).toBe("libsql://main-cmt-operator-test-pirate-org.aws-ap-south-1.turso.io")
      expect(bindingRows.rows[0]?.location).toBe("aws-ap-south-1")
      expect(bindingRows.rows[0]?.status).toBe("active")

      const bindingId = String(bindingRows.rows[0]?.community_database_binding_id ?? "")
      const credentialRows = await ctx.client.execute({
        sql: `
          SELECT token_name, encrypted_token, encryption_key_version, status
          FROM community_db_credentials
          WHERE community_database_binding_id = ?1
          LIMIT 1
        `,
        args: [bindingId],
      })
      expect(credentialRows.rows[0]?.token_name).toBe("worker-cmt_operator_test-v1")
      expect(credentialRows.rows[0]?.status).toBe("active")
      expect(
        decryptCommunityDbCredential({
          encryptedToken: String(credentialRows.rows[0]?.encrypted_token ?? ""),
          encryptionKeyVersion: Number(credentialRows.rows[0]?.encryption_key_version ?? 0),
          wrapKey,
        }),
      ).toBe("db-token-operator-test")

      const communityGet = await app.request(
        `http://pirate.test/communities/${body.community.community_id}`,
        {
          headers: {
            authorization: `Bearer ${session.accessToken}`,
          },
        },
        ctx.env,
      )
      expect(communityGet.status).toBe(200)
      const communityGetBody = await json(communityGet) as { namespace_verification_id: string | null }
      expect(communityGetBody.namespace_verification_id).toBe(namespaceVerificationId)
    } finally {
      globalThis.fetch = originalFetch
    }
  }, 10_000)

  testWithTimeout("community create generates a fallback credential id when operator omits credential_id", async () => {
    const operatorBaseUrl = "https://operator.test"
    const operatorToken = "operator-secret"
    const originalFetch = globalThis.fetch

    globalThis.fetch = (async (input, init) => {
      const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (requestUrl.startsWith(`${operatorBaseUrl}/internal/v0/community-provisioning/provision`)) {
        return new Response(JSON.stringify({
          community_id: "cmt_operator_no_cred",
          job_id: "job_operator_no_cred",
          binding_id: "cdb_operator_no_cred",
          credential_id: "",
          organization_slug: "pirate-org",
          group_name: "region-iad",
          group_id: "grp_no_cred",
          database_name: "main-cmt-no-cred",
          database_id: "db_no_cred",
          database_url: "libsql://main-cmt-no-cred-pirate-org.iad.turso.io",
          location: "iad",
          token_name: "worker-cmt_no_cred-v1",
          plaintext_token: "db-token-no-cred",
          issued_at: "2026-04-15T18:00:00.000Z",
          expires_at: null,
          rotation_number: 1,
        }), {
          headers: { "content-type": "application/json" },
        })
      }

      if (requestUrl.includes(".turso.io")) {
        return new Response("remote db unavailable in test", { status: 503 })
      }

      return originalFetch(input as never, init)
    }) as typeof globalThis.fetch

    try {
      const ctx = await createRouteTestContext({
        LOCAL_COMMUNITY_DB_ROOT: "",
        COMMUNITY_PROVISION_OPERATOR_BASE_URL: operatorBaseUrl,
        COMMUNITY_PROVISION_OPERATOR_AUTH_TOKEN: operatorToken,
        COMMUNITY_PROVISION_DEFAULT_GROUP_LOCATION: "iad",
        COMMUNITY_PROVISION_OPERATOR_TIMEOUT_MS: "2000",
        TURSO_COMMUNITY_DB_WRAP_KEY: "11".repeat(32),
        TURSO_COMMUNITY_DB_WRAP_KEY_VERSION: "7",
      })
      cleanup = ctx.cleanup

      const session = await exchangeJwt(ctx.env, "community-fallback-cred-user")
      const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken)

      const response = await requestJson("http://pirate.test/communities", {
        display_name: "Fallback Cred Club",
        namespace: {
          namespace_verification_id: namespaceVerificationId,
        },
      }, ctx.env, session.accessToken)

      expect(response.status).toBe(202)

      const credentialRows = await ctx.client.execute({
        sql: `
          SELECT community_db_credential_id
          FROM community_db_credentials
          WHERE token_name = ?1
        `,
        args: ["worker-cmt_no_cred-v1"],
      })
      expect(credentialRows.rows.length).toBe(1)
      expect(String(credentialRows.rows[0]?.community_db_credential_id)).toMatch(/^cdc_/)
    } finally {
      globalThis.fetch = originalFetch
    }
  }, 10_000)

  test("community create rejects unsupported database regions before provisioning", async () => {
    const operatorBaseUrl = "https://operator.test"
    const operatorToken = "operator-secret"
    const originalFetch = globalThis.fetch
    let operatorCalled = false

    globalThis.fetch = (async (input, init) => {
      const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (requestUrl.startsWith(`${operatorBaseUrl}/internal/v0/community-provisioning/provision`)) {
        operatorCalled = true
      }
      return originalFetch(input as never, init)
    }) as typeof globalThis.fetch

    try {
      const ctx = await createRouteTestContext({
        LOCAL_COMMUNITY_DB_ROOT: "",
        COMMUNITY_PROVISION_OPERATOR_BASE_URL: operatorBaseUrl,
        COMMUNITY_PROVISION_OPERATOR_AUTH_TOKEN: operatorToken,
        COMMUNITY_PROVISION_DEFAULT_GROUP_LOCATION: "aws-us-east-1",
        COMMUNITY_PROVISION_ALLOWED_GROUP_LOCATIONS: "aws-us-east-1,aws-ap-south-1",
        COMMUNITY_PROVISION_OPERATOR_TIMEOUT_MS: "2000",
        TURSO_COMMUNITY_DB_WRAP_KEY: "11".repeat(32),
        TURSO_COMMUNITY_DB_WRAP_KEY_VERSION: "7",
      })
      cleanup = ctx.cleanup

      const session = await exchangeJwt(ctx.env, "community-unsupported-region-user")
      await completeUniqueHumanVerification(ctx.env, session.accessToken)

      const response = await requestJson("http://pirate.test/communities", {
        display_name: "Unsupported Region Club",
        database_region: "aws-eu-west-1",
      }, ctx.env, session.accessToken)

      expect(response.status).toBe(400)
      const body = await json(response) as { message?: string }
      expect(body.message).toBe("database_region is not supported")
      expect(operatorCalled).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  testWithTimeout("community create without a namespace uses the provision operator when configured", async () => {
    const operatorBaseUrl = "https://operator.test"
    const operatorToken = "operator-secret"
    const wrapKey = "11".repeat(32)
    let provisionBody: Record<string, unknown> | null = null
    const originalFetch = globalThis.fetch

    globalThis.fetch = (async (input, init) => {
      const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (requestUrl.startsWith(`${operatorBaseUrl}/internal/v0/community-provisioning/provision`)) {
        provisionBody = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null
        return new Response(JSON.stringify({
          community_id: "cmt_operator_namespaceless",
          job_id: "job_operator_namespaceless",
          binding_id: "cdb_operator_namespaceless",
          credential_id: "cdc_operator_namespaceless",
          organization_slug: "pirate-org",
          group_name: "region-iad",
          group_id: "grp_operator_namespaceless",
          database_name: "main-cmt-operator-namespaceless",
          database_id: "db_operator_namespaceless",
          database_url: "libsql://main-cmt-operator-namespaceless-pirate-org.iad.turso.io",
          location: "iad",
          token_name: "worker-cmt_operator_namespaceless-v1",
          plaintext_token: "db-token-operator-namespaceless",
          issued_at: "2026-04-18T18:00:00.000Z",
          expires_at: null,
          rotation_number: 1,
        }), {
          headers: { "content-type": "application/json" },
        })
      }

      if (requestUrl.includes(".turso.io")) {
        return new Response("remote db unavailable in test", { status: 503 })
      }

      return originalFetch(input as never, init)
    }) as typeof globalThis.fetch

    try {
      const ctx = await createRouteTestContext({
        LOCAL_COMMUNITY_DB_ROOT: "",
        COMMUNITY_PROVISION_OPERATOR_BASE_URL: operatorBaseUrl,
        COMMUNITY_PROVISION_OPERATOR_AUTH_TOKEN: operatorToken,
        COMMUNITY_PROVISION_DEFAULT_GROUP_LOCATION: "iad",
        COMMUNITY_PROVISION_OPERATOR_TIMEOUT_MS: "2000",
        TURSO_COMMUNITY_DB_WRAP_KEY: wrapKey,
        TURSO_COMMUNITY_DB_WRAP_KEY_VERSION: "7",
      })
      cleanup = ctx.cleanup

      const session = await exchangeJwt(ctx.env, "community-operator-namespaceless-user")
      await completeUniqueHumanVerification(ctx.env, session.accessToken)

      const response = await requestJson("http://pirate.test/communities", {
        display_name: "Operator Namespaceless Club",
      }, ctx.env, session.accessToken)

      expect(response.status).toBe(202)
      const body = await json(response) as {
        community: {
          community_id: string
          namespace_verification_id: string | null
          provisioning_state: string
        }
        job: {
          status: string
        }
      }

      expect(body.community.namespace_verification_id).toBeNull()
      expect(body.community.provisioning_state).toBe("active")
      expect(body.job.status).toBe("succeeded")
      if (!provisionBody) {
        throw new Error("operator provision request was not captured")
      }
      expect(provisionBody["community_id"]).toBe(body.community.community_id)
      expect(provisionBody["namespace_verification_id"]).toBeNull()
      expect(provisionBody["group_location"]).toBe("iad")
      expect((provisionBody["bootstrap_payload"] as Record<string, unknown> | null)?.["namespace_label"]).toBeNull()

      const bindingRows = await ctx.client.execute({
        sql: `
          SELECT community_database_binding_id, database_url, status
          FROM community_database_bindings
          WHERE community_id = ?1
            AND binding_role = 'primary'
          LIMIT 1
        `,
        args: [body.community.community_id],
      })
      expect(bindingRows.rows[0]?.database_url).toBe("libsql://main-cmt-operator-namespaceless-pirate-org.iad.turso.io")
      expect(bindingRows.rows[0]?.status).toBe("active")

      const createdState = await getCommunityControlPlaneState(ctx.env, body.community.community_id)
      expect(createdState.namespaceVerificationId).toBeNull()
    } finally {
      globalThis.fetch = originalFetch
    }
  }, 10_000)

  testWithTimeout("community create sends agent posting settings in the operator bootstrap payload", async () => {
    const operatorBaseUrl = "https://operator.test"
    const operatorToken = "operator-secret"
    const wrapKey = "11".repeat(32)
    let provisionBody: Record<string, unknown> | null = null
    const originalFetch = globalThis.fetch

    globalThis.fetch = (async (input, init) => {
      const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (requestUrl.startsWith(`${operatorBaseUrl}/internal/v0/community-provisioning/provision`)) {
        provisionBody = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null
        return new Response(JSON.stringify({
          community_id: "cmt_operator_agent",
          job_id: "job_operator_agent",
          binding_id: "cdb_operator_agent",
          credential_id: "cdc_operator_agent",
          organization_slug: "pirate-org",
          group_name: "region-aws-us-east-1",
          group_id: "grp_operator_agent",
          database_name: "main-cmt-operator-agent",
          database_id: "db_operator_agent",
          database_url: "libsql://main-cmt-operator-agent-pirate-org.aws-us-east-1.turso.io",
          location: "aws-us-east-1",
          token_name: "worker-cmt_operator_agent-v1",
          plaintext_token: "db-token-operator-agent",
          issued_at: "2026-04-27T18:00:00.000Z",
          expires_at: null,
          rotation_number: 1,
        }), {
          headers: { "content-type": "application/json" },
        })
      }

      if (requestUrl.includes(".turso.io")) {
        return new Response("remote db unavailable in test", { status: 503 })
      }

      return originalFetch(input as never, init)
    }) as typeof globalThis.fetch

    try {
      const ctx = await createRouteTestContext({
        LOCAL_COMMUNITY_DB_ROOT: "",
        COMMUNITY_PROVISION_OPERATOR_BASE_URL: operatorBaseUrl,
        COMMUNITY_PROVISION_OPERATOR_AUTH_TOKEN: operatorToken,
        COMMUNITY_PROVISION_DEFAULT_GROUP_LOCATION: "aws-us-east-1",
        COMMUNITY_PROVISION_ALLOWED_GROUP_LOCATIONS: "aws-us-east-1",
        COMMUNITY_PROVISION_OPERATOR_TIMEOUT_MS: "2000",
        TURSO_COMMUNITY_DB_WRAP_KEY: wrapKey,
        TURSO_COMMUNITY_DB_WRAP_KEY_VERSION: "7",
      })
      cleanup = ctx.cleanup

      const session = await exchangeJwt(ctx.env, "community-operator-agent-user")
      const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken)

      const response = await requestJson("http://pirate.test/communities", {
        display_name: "Operator Agent Club",
        namespace: {
          namespace_verification_id: namespaceVerificationId,
        },
        human_verification_lane: "very",
        agent_posting_policy: "allow",
        agent_posting_scope: "top_level_and_replies",
        agent_daily_post_cap: 10,
        agent_daily_reply_cap: 50,
        accepted_agent_ownership_providers: ["clawkey"],
        gate_rules: [{
          scope: "membership",
          gate_family: "identity_proof",
          gate_type: "unique_human",
          proof_requirements: [{
            proof_type: "unique_human",
            accepted_providers: ["very"],
          }],
        }],
      }, ctx.env, session.accessToken)

      expect(response.status).toBe(202)

      if (!provisionBody) {
        throw new Error("operator provision request was not captured")
      }

      const bootstrapPayload = provisionBody["bootstrap_payload"] as Record<string, unknown> | null
      expect(bootstrapPayload).not.toBeNull()

      const initialSettings = bootstrapPayload!["initial_settings"] as Record<string, unknown> | null
      expect(initialSettings).not.toBeNull()
      expect(initialSettings!["agent_posting_policy"]).toBe("allow")
      expect(initialSettings!["agent_posting_scope"]).toBe("top_level_and_replies")
      expect(initialSettings!["agent_daily_post_cap"]).toBe(10)
      expect(initialSettings!["agent_daily_reply_cap"]).toBe(50)
      expect(initialSettings!["human_verification_lane"]).toBe("very")
      expect(initialSettings!["accepted_agent_ownership_providers"]).toEqual(["clawkey"])

      expect(bootstrapPayload!["membership_unique_human_provider"]).toBe("very")
      expect(bootstrapPayload!["namespace_label"]).toBe("piratecommunityroot")
    } finally {
      globalThis.fetch = originalFetch
    }
  }, 10_000)
})
