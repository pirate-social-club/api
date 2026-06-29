import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { app } from "../../../src/index"
import { decryptCommunityDbCredential } from "../../../src/lib/communities/community-db-credential-crypto"
import { createRouteTestContext, json, resetRuntimeCaches } from "../../helpers"
import {
  completeUniqueHumanVerification,
  exchangeJwt,
  getCommunityControlPlaneState,
  prepareVerifiedNamespace,
  requestJson,
} from "./community-routes-test-helpers"
import type { ShardRpc } from "@pirate/api-shared"

let cleanup: (() => Promise<void>) | null = null
const COMMUNITY_PROVISIONING_TEST_TIMEOUT_MS = 30_000
const testWithTimeout = test as unknown as (name: string, fn: () => Promise<void>, timeout: number) => void

function mockProvisionOperatorBinding(input: {
  authToken: string
  onProvision: (body: Record<string, unknown>, request: Request) => Response | Promise<Response>
}): Fetcher {
  return {
    fetch: async (request: Request | string) => {
      const normalizedRequest = typeof request === "string" ? new Request(request) : request
      expect(new URL(normalizedRequest.url).pathname).toBe("/internal/v0/community-provisioning/provision")
      expect(normalizedRequest.headers.get("authorization")).toBe(`Bearer ${input.authToken}`)
      const body = await normalizedRequest.json() as Record<string, unknown>
      return input.onProvision(body, normalizedRequest)
    },
  } as Fetcher
}

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
  test("development community create uses local provisioning when service binding is absent", async () => {
    const ctx = await createRouteTestContext({
      ENVIRONMENT: "development",
      TURSO_COMMUNITY_DB_WRAP_KEY: "11".repeat(32),
      TURSO_COMMUNITY_DB_WRAP_KEY_VERSION: "7",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-dev-local-fallback-user")

    const response = await requestJson("http://pirate.test/communities", {
      display_name: "Local Fallback Club",
membership_mode: "request",
      handle_policy: {
        policy_template: "standard",
      },
    }, ctx.env, session.accessToken)

    expect(response.status).toBe(202)
    const body = await json(response) as {
      community: {
        id: string
        display_name: string
        provisioning_state: string
      }
      job: {
        status: string
      }
    }
    expect(body.community.display_name).toBe("Local Fallback Club")
    expect(body.community.provisioning_state).toBe("active")
    expect(body.job.status).toBe("succeeded")
  })

  testWithTimeout("community create provisions through the private operator when configured", async () => {
    const operatorToken = "operator-secret"
    const wrapKey = "11".repeat(32)
    const originalFetch = globalThis.fetch
    let provisionBody: Record<string, unknown> | null = null
    const operator = mockProvisionOperatorBinding({
      authToken: operatorToken,
      onProvision: (body) => {
        provisionBody = body

        return new Response(JSON.stringify({
          community_id: "cmt_operator_test",
          id: "job_operator_runtime",
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
      },
    })

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (requestUrl.includes(".turso.io")) {
        return new Response("remote db unavailable in test", { status: 503 })
      }

      return originalFetch(input as never, init)
    }) as unknown as typeof fetch

    try {
      const ctx = await createRouteTestContext({
        LOCAL_COMMUNITY_DB_ROOT: "",
        COMMUNITY_PROVISION_OPERATOR: operator,
        COMMUNITY_PROVISION_OPERATOR_AUTH_TOKEN: operatorToken,
        COMMUNITY_PROVISION_DEFAULT_GROUP_LOCATION: "aws-us-east-1",
        COMMUNITY_PROVISION_ALLOWED_GROUP_LOCATIONS: "aws-us-east-1,aws-ap-south-1",
        TURSO_COMMUNITY_DB_WRAP_KEY: wrapKey,
        TURSO_COMMUNITY_DB_WRAP_KEY_VERSION: "7",
      })
      cleanup = ctx.cleanup

      const session = await exchangeJwt(ctx.env, "community-operator-user")
      const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken)

      const response = await requestJson("http://pirate.test/communities", {
        display_name: "Operator Club",
membership_mode: "request",
        database_region: "aws-ap-south-1",
        namespace: {
          namespace_verification: namespaceVerificationId,
        },
      }, ctx.env, session.accessToken)

      expect(response.status).toBe(202)
      const body = await json(response) as {
        community: {
          id: string
          namespace_verification: string | null
          provisioning_state: string
        }
        job: {
          id: string
          status: string
        }
      }

      expect(body.community.provisioning_state).toBe("active")
      expect(body.community.namespace_verification).toBe(namespaceVerificationId)
      expect(body.job.status).toBe("succeeded")
      if (!provisionBody) {
        throw new Error("operator provision request was not captured")
      }
      const operatorRequest = provisionBody
      expect(operatorRequest["community_id"]).toBe(body.community.id.replace(/^com_/, ""))
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
        args: [body.community.id.replace(/^com_/, "")],
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
        `http://pirate.test/communities/${body.community.id.replace(/^com_/, "")}`,
        {
          headers: {
            authorization: `Bearer ${session.accessToken}`,
          },
        },
        ctx.env,
      )
      expect(communityGet.status).toBe(200)
      const communityGetBody = await json(communityGet) as { namespace_verification: string | null }
      expect(communityGetBody.namespace_verification).toBe(namespaceVerificationId)
    } finally {
      globalThis.fetch = originalFetch
    }
  }, COMMUNITY_PROVISIONING_TEST_TIMEOUT_MS)

  testWithTimeout("community create generates a fallback credential id when operator omits credential_id", async () => {
    const operatorToken = "operator-secret"
    const originalFetch = globalThis.fetch
    const operator = mockProvisionOperatorBinding({
      authToken: operatorToken,
      onProvision: () => new Response(JSON.stringify({
        community_id: "cmt_operator_no_cred",
        id: "job_operator_no_cred",
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
      }),
    })

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (requestUrl.includes(".turso.io")) {
        return new Response("remote db unavailable in test", { status: 503 })
      }

      return originalFetch(input as never, init)
    }) as unknown as typeof fetch

    try {
      const ctx = await createRouteTestContext({
        LOCAL_COMMUNITY_DB_ROOT: "",
        COMMUNITY_PROVISION_OPERATOR: operator,
        COMMUNITY_PROVISION_OPERATOR_AUTH_TOKEN: operatorToken,
        COMMUNITY_PROVISION_DEFAULT_GROUP_LOCATION: "iad",
        TURSO_COMMUNITY_DB_WRAP_KEY: "11".repeat(32),
        TURSO_COMMUNITY_DB_WRAP_KEY_VERSION: "7",
      })
      cleanup = ctx.cleanup

      const session = await exchangeJwt(ctx.env, "community-fallback-cred-user")
      const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken)

      const response = await requestJson("http://pirate.test/communities", {
        display_name: "Fallback Cred Club",
membership_mode: "request",
        namespace: {
          namespace_verification: namespaceVerificationId,
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
  }, COMMUNITY_PROVISIONING_TEST_TIMEOUT_MS)

  test("community create rejects unsupported database regions before provisioning", async () => {
    const operatorToken = "operator-secret"
    let operatorCalled = false
    const operator = mockProvisionOperatorBinding({
      authToken: operatorToken,
      onProvision: () => {
        operatorCalled = true
        return new Response("unexpected", { status: 500 })
      },
    })

    const ctx = await createRouteTestContext({
      LOCAL_COMMUNITY_DB_ROOT: "",
      COMMUNITY_PROVISION_OPERATOR: operator,
      COMMUNITY_PROVISION_OPERATOR_AUTH_TOKEN: operatorToken,
      COMMUNITY_PROVISION_DEFAULT_GROUP_LOCATION: "aws-us-east-1",
      COMMUNITY_PROVISION_ALLOWED_GROUP_LOCATIONS: "aws-us-east-1,aws-ap-south-1",
      TURSO_COMMUNITY_DB_WRAP_KEY: "11".repeat(32),
      TURSO_COMMUNITY_DB_WRAP_KEY_VERSION: "7",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-unsupported-region-user")
    await completeUniqueHumanVerification(ctx.env, session.accessToken)

    const response = await requestJson("http://pirate.test/communities", {
      display_name: "Unsupported Region Club",
membership_mode: "request",
      database_region: "aws-eu-west-1",
    }, ctx.env, session.accessToken)

    expect(response.status).toBe(400)
    const body = await json(response) as { message?: string }
    expect(body.message).toBe("database_region is not supported")
    expect(operatorCalled).toBe(false)
  })

  testWithTimeout("community create without a namespace uses the provision operator when configured", async () => {
    const operatorToken = "operator-secret"
    const wrapKey = "11".repeat(32)
    let provisionBody: Record<string, unknown> | null = null
    const originalFetch = globalThis.fetch
    const operator = mockProvisionOperatorBinding({
      authToken: operatorToken,
      onProvision: (body) => {
        provisionBody = body

        return new Response(JSON.stringify({
          community_id: "cmt_operator_namespaceless",
          id: "job_operator_namespaceless",
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
      },
    })

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (requestUrl.includes(".turso.io")) {
        return new Response("remote db unavailable in test", { status: 503 })
      }

      return originalFetch(input as never, init)
    }) as unknown as typeof fetch

    try {
      const ctx = await createRouteTestContext({
        LOCAL_COMMUNITY_DB_ROOT: "",
        COMMUNITY_PROVISION_OPERATOR: operator,
        COMMUNITY_PROVISION_OPERATOR_AUTH_TOKEN: operatorToken,
        COMMUNITY_PROVISION_DEFAULT_GROUP_LOCATION: "iad",
        TURSO_COMMUNITY_DB_WRAP_KEY: wrapKey,
        TURSO_COMMUNITY_DB_WRAP_KEY_VERSION: "7",
      })
      cleanup = ctx.cleanup

      const session = await exchangeJwt(ctx.env, "community-operator-namespaceless-user")
      await completeUniqueHumanVerification(ctx.env, session.accessToken)

      const response = await requestJson("http://pirate.test/communities", {
        display_name: "Operator Namespaceless Club",
membership_mode: "request",
      }, ctx.env, session.accessToken)

      expect(response.status).toBe(202)
      const body = await json(response) as {
        community: {
          id: string
          namespace_verification: string | null
          provisioning_state: string
        }
        job: {
          status: string
        }
      }

      expect(body.community.namespace_verification).toBeNull()
      expect(body.community.provisioning_state).toBe("active")
      expect(body.job.status).toBe("succeeded")
      if (!provisionBody) {
        throw new Error("operator provision request was not captured")
      }
      expect(provisionBody["community_id"]).toBe(body.community.id.replace(/^com_/, ""))
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
        args: [body.community.id.replace(/^com_/, "")],
      })
      expect(bindingRows.rows[0]?.database_url).toBe("libsql://main-cmt-operator-namespaceless-pirate-org.iad.turso.io")
      expect(bindingRows.rows[0]?.status).toBe("active")

      const createdState = await getCommunityControlPlaneState(ctx.env, body.community.id.replace(/^com_/, ""))
      expect(createdState.namespaceVerificationId).toBeNull()
    } finally {
      globalThis.fetch = originalFetch
    }
  }, COMMUNITY_PROVISIONING_TEST_TIMEOUT_MS)

  testWithTimeout("community create sends agent posting settings in the operator bootstrap payload", async () => {
    const operatorToken = "operator-secret"
    const wrapKey = "11".repeat(32)
    let provisionBody: Record<string, unknown> | null = null
    const originalFetch = globalThis.fetch
    const operator = mockProvisionOperatorBinding({
      authToken: operatorToken,
      onProvision: (body) => {
        provisionBody = body

        return new Response(JSON.stringify({
          community_id: "cmt_operator_agent",
          id: "job_operator_agent",
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
      },
    })

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (requestUrl.includes(".turso.io")) {
        return new Response("remote db unavailable in test", { status: 503 })
      }

      return originalFetch(input as never, init)
    }) as unknown as typeof fetch

    try {
      const ctx = await createRouteTestContext({
        LOCAL_COMMUNITY_DB_ROOT: "",
        COMMUNITY_PROVISION_OPERATOR: operator,
        COMMUNITY_PROVISION_OPERATOR_AUTH_TOKEN: operatorToken,
        COMMUNITY_PROVISION_DEFAULT_GROUP_LOCATION: "aws-us-east-1",
        COMMUNITY_PROVISION_ALLOWED_GROUP_LOCATIONS: "aws-us-east-1",
        TURSO_COMMUNITY_DB_WRAP_KEY: wrapKey,
        TURSO_COMMUNITY_DB_WRAP_KEY_VERSION: "7",
      })
      cleanup = ctx.cleanup

      const session = await exchangeJwt(ctx.env, "community-operator-agent-user")
      const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken)

      const response = await requestJson("http://pirate.test/communities", {
        display_name: "Operator Agent Club",
membership_mode: "request",
        namespace: {
          namespace_verification: namespaceVerificationId,
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
  }, COMMUNITY_PROVISIONING_TEST_TIMEOUT_MS)
})

describe("d1_native community provisioning (step 4 of the D1-native workstream)", () => {
  // §8.1 acceptance criterion: a namespaceless community create with
  // COMMUNITY_PROVISION_BACKEND=d1_native and a (fake) COMMUNITY_D1_SHARD
  // reaches markCommunityProvisioningSucceeded AND produces a
  // community_database_routing row at backend='d1', provisioning_state='ready'.
  // This is the test slice 4 of PR #57 couldn't reach: the d1_native
  // orchestrator (step 4) was not wired. Now that the orchestrator runs
  // bind → load → upsertRouting('ready') → persistProvisionedD1Binding, the
  // service test exercises the full route end-to-end.
  testWithTimeout("§8.1 — namespaceless d1_native create reaches provisioning_succeeded with a backend='d1' routing row at 'ready'", async () => {
    const calls: Array<{ m: string; input: unknown }> = []
    const fakeShard: ShardRpc = {
      async communityD1Bind(input: { communityId: string; now: string }) {
        calls.push({ m: "communityD1Bind", input })
        return {
          ok: true,
          value: {
            bindingName: "DB_CMTY_ROUTE_TEST",
            shardWorkerId: "community-d1-shard-staging",
            allocated: true,
          },
        }
      },
      async communityD1LoadSnapshot(input: { communityId: string; bindingName: string; statements: unknown[] }) {
        calls.push({ m: "communityD1LoadSnapshot", input })
        return { ok: true, value: { rowsAffected: 0, loaded: true } }
      },
    } as unknown as ShardRpc

    const ctx = await createRouteTestContext({
      COMMUNITY_PROVISION_BACKEND: "d1_native",
      COMMUNITY_D1_SHARD: fakeShard,
      COMMUNITY_D1_SHARD_REGION: "weur",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-d1-native-route-test")

    const response = await requestJson("http://pirate.test/communities", {
      display_name: "D1 Native Route Club",
      membership_mode: "request",
    }, ctx.env, session.accessToken)

    if (response.status !== 202) {
      const errBody = await json(response)
      throw new Error(`expected 202, got ${response.status}: ${JSON.stringify(errBody)}`)
    }
    const body = (await response.json()) as {
      community: { id: string; display_name: string; provisioning_state: string }
      job: { status: string }
    }
    expect(body.community.display_name).toBe("D1 Native Route Club")
    expect(body.community.provisioning_state).toBe("active")
    expect(body.job.status).toBe("succeeded")

    // The community ID is com_xxx; the underlying id (no com_ prefix) is what
    // the routing row uses for the d1_native path.
    const communityIdBare = body.community.id.replace(/^com_/, "")

    // Orchestrator call sequence: bind → load (the upsertRouting and
    // persistBinding are repo calls, not shard RPCs, so they don't appear
    // in `calls`).
    expect(calls.map((c) => c.m)).toEqual([
      "communityD1Bind",
      "communityD1LoadSnapshot",
    ])

    // Query the control plane directly: routing row at backend='d1',
    // provisioning_state='ready'; binding row's URL updated to d1://shard/<binding>.
    const routingRow = (await ctx.client.execute({
      sql: `SELECT backend, provisioning_state, shard_worker_id, binding_name, region
            FROM community_database_routing WHERE community_id = ?1`,
      args: [communityIdBare],
    })).rows[0] as Record<string, unknown>
    expect(routingRow).toMatchObject({
      backend: "d1",
      provisioning_state: "ready",
      shard_worker_id: "community-d1-shard-staging",
      binding_name: "DB_CMTY_ROUTE_TEST",
      region: "weur",
    })

    const bindingRow = (await ctx.client.execute({
      sql: `SELECT database_url, database_name, organization_slug, group_name, location, requires_credentials, status
            FROM community_database_bindings WHERE community_id = ?1`,
      args: [communityIdBare],
    })).rows[0] as Record<string, unknown>
    expect(bindingRow).toMatchObject({
      database_url: "d1://shard/DB_CMTY_ROUTE_TEST",
      database_name: "DB_CMTY_ROUTE_TEST",
      organization_slug: "shard",
      group_name: "shard",
      location: "weur",
      requires_credentials: 0,
      status: "active",
    })
  }, COMMUNITY_PROVISIONING_TEST_TIMEOUT_MS)
})
