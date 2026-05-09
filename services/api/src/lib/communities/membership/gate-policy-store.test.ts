import { afterEach, describe, expect, test } from "bun:test"
import type { Client, InStatement, QueryResult, Transaction } from "../../sql-client"
import type { Env } from "../../../env"
import type { GatePolicy } from "./gate-types"
import {
  getCachedMembershipGatePolicy,
  invalidateMembershipGatePolicyCache,
} from "./gate-policy-store"

const altchaPolicy: GatePolicy = {
  version: 1,
  expression: { op: "gate", gate: { type: "altcha_pow" } },
}

function buildClient(policy: GatePolicy | null): Client & { queryCount: number } {
  return {
    queryCount: 0,
    async execute(_statement: InStatement | string): Promise<QueryResult> {
      this.queryCount += 1
      return {
        rows: policy
          ? [{ expression_json: JSON.stringify(policy) }]
          : [],
      }
    },
    async batch(): Promise<QueryResult[]> {
      throw new Error("not implemented")
    },
    async transaction(): Promise<Transaction> {
      throw new Error("not implemented")
    },
  }
}

afterEach(() => {
  invalidateMembershipGatePolicyCache()
})

describe("membership gate policy cache", () => {
  test("reuses the cached policy within the TTL", async () => {
    const env: Env = { COMMUNITY_GATE_POLICY_CACHE_TTL_MS: "60000" }
    const client = buildClient(altchaPolicy)

    expect(await getCachedMembershipGatePolicy({ env, client, communityId: "cmt_test" })).toEqual(altchaPolicy)
    expect(await getCachedMembershipGatePolicy({ env, client, communityId: "cmt_test" })).toEqual(altchaPolicy)

    expect(client.queryCount).toBe(1)
  })

  test("can invalidate one community cache entry", async () => {
    const env: Env = { COMMUNITY_GATE_POLICY_CACHE_TTL_MS: "60000" }
    const client = buildClient(altchaPolicy)

    await getCachedMembershipGatePolicy({ env, client, communityId: "cmt_test" })
    invalidateMembershipGatePolicyCache("cmt_test")
    await getCachedMembershipGatePolicy({ env, client, communityId: "cmt_test" })

    expect(client.queryCount).toBe(2)
  })

  test("bypasses the cache when TTL is zero", async () => {
    const env: Env = { COMMUNITY_GATE_POLICY_CACHE_TTL_MS: "0" }
    const client = buildClient(null)

    expect(await getCachedMembershipGatePolicy({ env, client, communityId: "cmt_test" })).toBeNull()
    expect(await getCachedMembershipGatePolicy({ env, client, communityId: "cmt_test" })).toBeNull()

    expect(client.queryCount).toBe(2)
  })
})
