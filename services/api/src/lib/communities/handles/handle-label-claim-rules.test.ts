import { describe, expect, test } from "bun:test"
import type { DbExecutor } from "../../db-helpers"
import { listNamespaceLabelClaimRules } from "./handle-label-claim-rules"

function throwingExecutor(message: string): DbExecutor {
  return {
    execute: async () => {
      throw new Error(message)
    },
  } as unknown as DbExecutor
}

describe("listNamespaceLabelClaimRules", () => {
  test("treats an unprovisioned rules table as no rules configured", async () => {
    const rules = await listNamespaceLabelClaimRules(
      throwingExecutor("D1_ERROR: no such table: namespace_handle_label_claim_rules"),
      "nhp_1",
    )
    expect(rules).toEqual([])
  })

  test("rethrows unrelated database errors", async () => {
    await expect(listNamespaceLabelClaimRules(
      throwingExecutor("D1_ERROR: database is locked"),
      "nhp_1",
    )).rejects.toThrow("database is locked")
  })

  test("rethrows missing-table errors for other tables", async () => {
    await expect(listNamespaceLabelClaimRules(
      throwingExecutor("no such table: namespace_handle_policies"),
      "nhp_1",
    )).rejects.toThrow("namespace_handle_policies")
  })
})
