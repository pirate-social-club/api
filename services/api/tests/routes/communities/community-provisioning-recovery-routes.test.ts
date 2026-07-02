import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { ShardRpc } from "@pirate/api-shared"
import { createRouteTestContext, json, resetRuntimeCaches } from "../../helpers"
import {
  exchangeJwt,
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

describe("community provisioning recovery routes", () => {
  test("community create retries a stale local namespaced provisioning state without binding-table recovery", async () => {
    const ctx = await createRouteTestContext({
      LOCAL_COMMUNITY_DB_ROOT: "/tmp/pirate-api-test-community-dbs",
    })
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
    expect(secondBody.job.id).not.toBe(firstBody.job.id)
    expect(secondBody.job.status).toBe("succeeded")
  })

  testWithTimeout("community create returns a recently running D1 job without re-provisioning", async () => {
    const calls: Array<{ m: string; input: unknown }> = []
    const ctx = await createRouteTestContext({
      LOCAL_COMMUNITY_DB_ROOT: "",
      COMMUNITY_D1_SHARD: fakeProvisioningShard("DB_CMTY_RECENT_JOB_TEST", calls),
      COMMUNITY_D1_SHARD_REGION: "weur",
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
    expect(calls.map((c) => c.m)).toEqual(["communityD1Bind", "communityD1LoadSnapshot"])

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
      args: [firstBody.job.id.replace(/^job_/, ""), new Date().toISOString()],
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
    expect(secondBody.community.id.replace(/^com_/, "")).toBe(firstBody.community.id.replace(/^com_/, ""))
    expect(secondBody.community.provisioning_state).toBe("provisioning")
    expect(secondBody.job.id).toBe(firstBody.job.id)
    expect(secondBody.job.status).toBe("running")
    expect(calls.map((c) => c.m)).toEqual(["communityD1Bind", "communityD1LoadSnapshot"])
  }, 10_000)
})
