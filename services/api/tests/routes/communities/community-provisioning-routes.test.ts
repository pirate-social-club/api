import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { ShardRpc } from "@pirate/api-shared"
import { createRouteTestContext, json, resetRuntimeCaches } from "../../helpers"
import {
  completeUniqueHumanVerification,
  exchangeJwt,
  getCommunityControlPlaneState,
  prepareVerifiedNamespace,
  requestJson,
} from "./community-routes-test-helpers"

let cleanup: (() => Promise<void>) | null = null
const COMMUNITY_PROVISIONING_TEST_TIMEOUT_MS = 30_000
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

function fakeProvisioningShard(bindingName: string, calls: Array<{ m: string; input: unknown }>): ShardRpc {
  return {
    async communityD1Bind(input: { communityId: string; now: string }) {
      calls.push({ m: "communityD1Bind", input })
      return {
        ok: true,
        value: {
          bindingName,
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
}

describe("community provisioning routes", () => {
  test("development community create uses local provisioning when LOCAL_COMMUNITY_DB_ROOT is configured", async () => {
    const ctx = await createRouteTestContext({
      ENVIRONMENT: "development",
      LOCAL_COMMUNITY_DB_ROOT: "/tmp/pirate-api-test-community-dbs",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-dev-local-user")

    const response = await requestJson("http://pirate.test/communities", {
      display_name: "Local Dev Club",
      membership_mode: "request",
      handle_policy: {
        policy_template: "standard",
      },
    }, ctx.env, session.accessToken)

    expect(response.status).toBe(202)
    const body = await json(response) as {
      community: {
        display_name: string
        provisioning_state: string
      }
      job: {
        status: string
      }
    }
    expect(body.community.display_name).toBe("Local Dev Club")
    expect(body.community.provisioning_state).toBe("active")
    expect(body.job.status).toBe("succeeded")
  })

  test("community create rejects unsupported database regions before D1 provisioning", async () => {
    const calls: Array<{ m: string; input: unknown }> = []
    const ctx = await createRouteTestContext({
      LOCAL_COMMUNITY_DB_ROOT: "",
      COMMUNITY_D1_SHARD: fakeProvisioningShard("DB_CMTY_UNSUPPORTED_REGION", calls),
      COMMUNITY_D1_SHARD_REGION: "weur",
      COMMUNITY_PROVISION_ALLOWED_GROUP_LOCATIONS: "aws-us-east-1,aws-ap-south-1",
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
    expect(calls).toEqual([])
  })
})

describe("d1_native community provisioning", () => {
  testWithTimeout("namespaceless create reaches provisioning_succeeded with a ready d1 routing row", async () => {
    const calls: Array<{ m: string; input: unknown }> = []
    const ctx = await createRouteTestContext({
      LOCAL_COMMUNITY_DB_ROOT: "",
      COMMUNITY_D1_SHARD: fakeProvisioningShard("DB_CMTY_ROUTE_TEST", calls),
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
    const body = await json(response) as {
      community: { id: string; display_name: string; provisioning_state: string }
      job: { status: string }
    }
    expect(body.community.display_name).toBe("D1 Native Route Club")
    expect(body.community.provisioning_state).toBe("active")
    expect(body.job.status).toBe("succeeded")
    expect(calls.map((c) => c.m)).toEqual(["communityD1Bind", "communityD1LoadSnapshot"])

    const communityIdBare = body.community.id.replace(/^com_/, "")
    const routingRow = (await ctx.client.execute({
      sql: `SELECT provisioning_state, shard_worker_id, binding_name, region
            FROM community_database_routing WHERE community_id = ?1`,
      args: [communityIdBare],
    })).rows[0] as Record<string, unknown>
    expect(routingRow).toMatchObject({
      provisioning_state: "ready",
      shard_worker_id: "community-d1-shard-staging",
      binding_name: "DB_CMTY_ROUTE_TEST",
      region: "weur",
    })

  }, COMMUNITY_PROVISIONING_TEST_TIMEOUT_MS)

  testWithTimeout("namespaced create reaches provisioning_succeeded with namespace metadata and a ready d1 routing row", async () => {
    const calls: Array<{ m: string; input: unknown }> = []
    const ctx = await createRouteTestContext({
      LOCAL_COMMUNITY_DB_ROOT: "",
      COMMUNITY_D1_SHARD: fakeProvisioningShard("DB_CMTY_ROUTE_NS_TEST", calls),
      COMMUNITY_D1_SHARD_REGION: "weur",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-d1-native-namespace-route-test")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken)

    const response = await requestJson("http://pirate.test/communities", {
      display_name: "D1 Native Namespace Club",
      membership_mode: "request",
      namespace: {
        namespace_verification: namespaceVerificationId,
      },
    }, ctx.env, session.accessToken)

    if (response.status !== 202) {
      const errBody = await json(response)
      throw new Error(`expected 202, got ${response.status}: ${JSON.stringify(errBody)}`)
    }
    const body = await json(response) as {
      community: { id: string; display_name: string; provisioning_state: string; namespace_verification: string | null }
      job: { status: string }
    }
    expect(body.community.display_name).toBe("D1 Native Namespace Club")
    expect(body.community.provisioning_state).toBe("active")
    expect(body.community.namespace_verification).toBe(namespaceVerificationId)
    expect(body.job.status).toBe("succeeded")
    expect(calls.map((c) => c.m)).toEqual(["communityD1Bind", "communityD1LoadSnapshot"])

    const load = calls[1]!.input as { statements: Array<{ args?: unknown[] }> }
    expect(load.statements.some((statement) =>
      Array.isArray(statement.args) && statement.args.includes(namespaceVerificationId.replace(/^nv_/, ""))
    )).toBe(true)

    const communityIdBare = body.community.id.replace(/^com_/, "")
    const routingRow = (await ctx.client.execute({
      sql: `SELECT provisioning_state, shard_worker_id, binding_name, region
            FROM community_database_routing WHERE community_id = ?1`,
      args: [communityIdBare],
    })).rows[0] as Record<string, unknown>
    expect(routingRow).toMatchObject({
      provisioning_state: "ready",
      shard_worker_id: "community-d1-shard-staging",
      binding_name: "DB_CMTY_ROUTE_NS_TEST",
      region: "weur",
    })

    const communityRow = (await ctx.client.execute({
      sql: `SELECT namespace_verification_id, route_slug
            FROM communities WHERE community_id = ?1`,
      args: [communityIdBare],
    })).rows[0] as Record<string, unknown>
    expect(communityRow).toMatchObject({
      namespace_verification_id: namespaceVerificationId.replace(/^nv_/, ""),
      route_slug: "piratecommunityroot",
    })

    const createdState = await getCommunityControlPlaneState(ctx.env, communityIdBare)
    expect(createdState.namespaceVerificationId).toBe(namespaceVerificationId.replace(/^nv_/, ""))
  }, COMMUNITY_PROVISIONING_TEST_TIMEOUT_MS)
})
