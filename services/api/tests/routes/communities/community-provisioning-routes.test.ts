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
          group_name: "club-cmt-operator-test",
          group_id: "grp_operator_test",
          database_name: "main-cmt-operator-test",
          database_id: "db_operator_test",
          database_url: "libsql://main-cmt-operator-test-pirate-org.iad.turso.io",
          location: "iad",
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
        COMMUNITY_PROVISION_DEFAULT_GROUP_LOCATION: "iad",
        COMMUNITY_PROVISION_OPERATOR_TIMEOUT_MS: "2000",
        TURSO_COMMUNITY_DB_WRAP_KEY: wrapKey,
        TURSO_COMMUNITY_DB_WRAP_KEY_VERSION: "7",
      })
      cleanup = ctx.cleanup

      const session = await exchangeJwt(ctx.env, "community-operator-user")
      const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken)

      const response = await requestJson("http://pirate.test/communities", {
        display_name: "Operator Club",
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
      expect(operatorRequest["group_location"]).toBe("iad")
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
      expect(bindingRows.rows[0]?.group_name).toBe("club-cmt-operator-test")
      expect(bindingRows.rows[0]?.database_name).toBe("main-cmt-operator-test")
      expect(bindingRows.rows[0]?.database_url).toBe("libsql://main-cmt-operator-test-pirate-org.iad.turso.io")
      expect(bindingRows.rows[0]?.location).toBe("iad")
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

  test("community create generates a fallback credential id when operator omits credential_id", async () => {
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
          group_name: "club-cmt-no-cred",
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
          group_name: "club-cmt-operator-namespaceless",
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
})
