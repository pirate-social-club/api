import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createRouteTestContext, json, resetRuntimeCaches } from "../../helpers"
import {
  exchangeJwt,
  prepareVerifiedNamespace,
  requestJson,
} from "./community-routes-test-helpers"

let cleanup: (() => Promise<void>) | null = null
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

describe("community provisioning recovery routes", () => {
  test("community create finalizes a local namespaced community after a provisioning-state crash without creating a new job", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-local-finalize-user")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken)

    const firstResponse = await requestJson("http://pirate.test/communities", {
      display_name: "Local Finalize Club",
membership_mode: "request",
      namespace: {
        namespace_verification: namespaceVerificationId,
      },
    }, ctx.env, session.accessToken)

    expect(firstResponse.status).toBe(202)
    const firstBody = await json(firstResponse) as {
      community: {
        id: string
        provisioning_state: string
      }
      job: {
        id: string
        status: string
      }
    }
    expect(firstBody.community.provisioning_state).toBe("active")
    expect(firstBody.job.status).toBe("succeeded")

    const bindingRows = await ctx.client.execute({
      sql: `
        SELECT community_database_binding_id
        FROM community_database_bindings
        WHERE community_id = ?1
          AND binding_role = 'primary'
        LIMIT 1
      `,
      args: [firstBody.community.id.replace(/^com_/, "")],
    })
    const bindingId = String(bindingRows.rows[0]?.community_database_binding_id ?? "")
    const credentialRows = await ctx.client.execute({
      sql: `
        SELECT COUNT(*) AS count
        FROM community_db_credentials
        WHERE community_database_binding_id = ?1
      `,
      args: [bindingId],
    })
    expect(Number(credentialRows.rows[0]?.count ?? 0)).toBe(0)

    await ctx.client.execute({
      sql: `
        UPDATE communities
        SET provisioning_state = 'provisioning',
            updated_at = ?2
        WHERE community_id = ?1
      `,
      args: [firstBody.community.id.replace(/^com_/, ""), new Date(Date.now() - 60_000).toISOString()],
    })

    const secondResponse = await requestJson("http://pirate.test/communities", {
      display_name: "Local Finalize Club",
membership_mode: "request",
      namespace: {
        namespace_verification: namespaceVerificationId,
      },
    }, ctx.env, session.accessToken)

    expect(secondResponse.status).toBe(202)
    const secondBody = await json(secondResponse) as {
      community: {
        id: string
        provisioning_state: string
      }
      job: {
        id: string
        status: string
      }
    }
    expect(secondBody.community.id.replace(/^com_/, "")).toBe(firstBody.community.id.replace(/^com_/, ""))
    expect(secondBody.community.provisioning_state).toBe("active")
    expect(secondBody.job.id).toBe(firstBody.job.id)
    expect(secondBody.job.status).toBe("succeeded")
  })

  testWithTimeout("community create finalizes a stuck community that has real binding and credential but provisioning not active", async () => {
    const operatorToken = "operator-secret"
    const wrapKey = "11".repeat(32)
    const originalFetch = globalThis.fetch
    let operatorCallCount = 0
    const operator = mockProvisionOperatorBinding({
      authToken: operatorToken,
      onProvision: () => {
        operatorCallCount += 1

        return new Response(JSON.stringify({
          community_id: "cmt_finalize_test",
          id: "job_finalize_test",
          binding_id: "cdb_finalize_test",
          credential_id: "cdc_finalize_test",
          organization_slug: "pirate-org",
          group_name: "region-iad",
          group_id: "grp_finalize_test",
          database_name: "main-cmt-finalize-test",
          database_id: "db_finalize_test",
          database_url: "libsql://main-cmt-finalize-test-pirate-org.iad.turso.io",
          location: "iad",
          token_name: "worker-cmt_finalize_test-v1",
          plaintext_token: "db-token-finalize-test",
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
        COMMUNITY_PROVISION_DEFAULT_GROUP_LOCATION: "iad",
        TURSO_COMMUNITY_DB_WRAP_KEY: wrapKey,
        TURSO_COMMUNITY_DB_WRAP_KEY_VERSION: "7",
      })
      cleanup = ctx.cleanup

      const session = await exchangeJwt(ctx.env, "community-finalize-user")
      const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken)

      const firstResponse = await requestJson("http://pirate.test/communities", {
        display_name: "Finalize Club",
membership_mode: "request",
        namespace: {
          namespace_verification: namespaceVerificationId,
        },
      }, ctx.env, session.accessToken)

      expect(firstResponse.status).toBe(202)
      const firstBody = await json(firstResponse) as {
        community: {
          id: string
          provisioning_state: string
        }
        job: {
          id: string
          status: string
        }
      }
      expect(firstBody.community.provisioning_state).toBe("active")

      await ctx.client.execute({
        sql: `
          UPDATE communities
          SET provisioning_state = 'provisioning',
              updated_at = ?2
          WHERE community_id = ?1
        `,
        args: [firstBody.community.id.replace(/^com_/, ""), new Date(Date.now() - 60_000).toISOString()],
      })

      const secondResponse = await requestJson("http://pirate.test/communities", {
        display_name: "Finalize Club",
membership_mode: "request",
        namespace: {
          namespace_verification: namespaceVerificationId,
        },
      }, ctx.env, session.accessToken)

      expect(secondResponse.status).toBe(202)
      const secondBody = await json(secondResponse) as {
        community: {
          id: string
          provisioning_state: string
        }
        job: {
          status: string
        }
      }
      expect(secondBody.community.provisioning_state).toBe("active")
      expect(secondBody.job.status).toBe("succeeded")
      expect(operatorCallCount).toBe(1)
    } finally {
      globalThis.fetch = originalFetch
    }
  }, 10_000)

  testWithTimeout("community create returns in-progress state for a recently running job without re-provisioning", async () => {
    const operatorToken = "operator-secret"
    const wrapKey = "11".repeat(32)
    const originalFetch = globalThis.fetch
    let operatorCallCount = 0
    const operator = mockProvisionOperatorBinding({
      authToken: operatorToken,
      onProvision: () => {
        operatorCallCount += 1

        return new Response(JSON.stringify({
          community_id: "cmt_recent_job_test",
          id: "job_recent_job_test",
          binding_id: "cdb_recent_job_test",
          credential_id: "cdc_recent_job_test",
          organization_slug: "pirate-org",
          group_name: "region-iad",
          group_id: "grp_recent_job_test",
          database_name: "main-cmt-recent-job-test",
          database_id: "db_recent_job_test",
          database_url: "libsql://main-cmt-recent-job-test-pirate-org.iad.turso.io",
          location: "iad",
          token_name: "worker-cmt_recent_job_test-v1",
          plaintext_token: "db-token-recent-job-test",
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
        COMMUNITY_PROVISION_DEFAULT_GROUP_LOCATION: "iad",
        TURSO_COMMUNITY_DB_WRAP_KEY: wrapKey,
        TURSO_COMMUNITY_DB_WRAP_KEY_VERSION: "7",
      })
      cleanup = ctx.cleanup

      const session = await exchangeJwt(ctx.env, "community-recent-job-user")
      const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken)

      const firstResponse = await requestJson("http://pirate.test/communities", {
        display_name: "Recent Job Club",
membership_mode: "request",
        namespace: {
          namespace_verification: namespaceVerificationId,
        },
      }, ctx.env, session.accessToken)

      expect(firstResponse.status).toBe(202)
      const firstBody = await json(firstResponse) as {
        community: {
          id: string
          provisioning_state: string
        }
        job: {
          id: string
          status: string
        }
      }
      expect(firstBody.community.provisioning_state).toBe("active")

      await ctx.client.execute({
        sql: `
          UPDATE communities
          SET provisioning_state = 'provisioning',
              updated_at = ?2
          WHERE community_id = ?1
        `,
        args: [firstBody.community.id.replace(/^com_/, ""), new Date().toISOString()],
      })

      await ctx.client.execute({
        sql: `
          UPDATE jobs
          SET status = 'running',
              updated_at = ?2
          WHERE job_id = ?1
        `,
        args: [firstBody.job.id, new Date().toISOString()],
      })

      const secondResponse = await requestJson("http://pirate.test/communities", {
        display_name: "Recent Job Club",
membership_mode: "request",
        namespace: {
          namespace_verification: namespaceVerificationId,
        },
      }, ctx.env, session.accessToken)

      expect(secondResponse.status).toBe(202)
      const secondBody = await json(secondResponse) as {
        community: {
          id: string
          provisioning_state: string
        }
        job: {
          id: string
          status: string
        }
      }
      expect(secondBody.community.provisioning_state).toBe("active")
      expect(secondBody.job.status).toBe("succeeded")
      expect(operatorCallCount).toBe(1)
    } finally {
      globalThis.fetch = originalFetch
    }
  }, 10_000)
})
