import { describe, expect, test } from "bun:test"
import type { DbExecutor } from "../../db-helpers"
import { HttpError } from "../../errors"
import {
  assertWritableHandleIssuanceMode,
  getNamespacePolicy,
} from "./handle-policy-service"
import { requireProtocolIssuanceSupport } from "./handle-protocol-issuance"

describe("community handle safety controls", () => {
  test("missing namespace policy rows fail closed", async () => {
    let query = ""
    const executor = {
      execute: async (statement: { sql: string }) => {
        query = statement.sql
        return { rows: [] }
      },
    } as unknown as DbExecutor

    expect(await getNamespacePolicy(executor, "cmt_1")).toBeNull()
    expect(query).toMatch(/\bJOIN\s+namespace_handle_policies\b/i)
    expect(query).not.toMatch(/\bLEFT\s+JOIN\s+namespace_handle_policies\b/i)
  })

  test("a malformed null claims_enabled value fails closed", async () => {
    const executor = {
      execute: async () => ({
        rows: [{
          namespace_handle_policy_id: "nhp_1",
          community_id: "cmt_1",
          namespace_id: "ns_1",
          display_label: "pirate",
          normalized_label: "pirate",
          route_family: "hns",
          policy_template: "standard",
          pricing_model: null,
          claims_enabled: null,
          settings_json: null,
          updated_at: null,
        }],
      }),
    } as unknown as DbExecutor

    expect((await getNamespacePolicy(executor, "cmt_1"))?.claims_enabled).toBe(false)
  })

  test("policy writes reject spaces_subspace issuance", () => {
    expect(() => assertWritableHandleIssuanceMode("spaces_subspace")).toThrow(
      "Protocol-issued community names are temporarily unavailable",
    )
    expect(assertWritableHandleIssuanceMode("app_internal")).toBeUndefined()
  })

  test("existing spaces_subspace policies cannot quote or claim", () => {
    const policy = {
      display_label: "@pirate",
      normalized_label: "@pirate",
      route_family: "spaces",
    }

    try {
      requireProtocolIssuanceSupport(policy, { issuance_mode: "spaces_subspace" })
      throw new Error("expected protocol issuance to be disabled")
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError)
      expect((error as HttpError).status).toBe(403)
      expect((error as HttpError).code).toBe("eligibility_failed")
      expect((error as Error).message).toBe("Protocol-issued community names are temporarily unavailable")
    }
  })
})
