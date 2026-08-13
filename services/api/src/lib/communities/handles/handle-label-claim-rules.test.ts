import { describe, expect, test } from "bun:test"
import type { DbExecutor } from "../../db-helpers"
import {
  listNamespaceLabelClaimRules,
  resolveLabelClaimGatePolicy,
  serializeLabelClaimRules,
} from "./handle-label-claim-rules"

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

  test("keeps stored legacy multi-provider conjunctions readable", () => {
    const rule = {
      label_claim_rule_id: "rule_1",
      position: 0,
      selector_type: "any" as const,
      selector_labels_json: null,
      expression_json: JSON.stringify({
        version: 1,
        expression: {
          op: "and",
          children: [
            { op: "gate", gate: { type: "unique_human", provider: "self" } },
            { op: "gate", gate: { type: "unique_human", provider: "zkpassport" } },
          ],
        },
      }),
    }

    expect(resolveLabelClaimGatePolicy(rule, "label").expression.op).toBe("and")
    expect(serializeLabelClaimRules([rule], (prefix, value) => `${prefix}_${value}`)[0]
      ?.claim_gate_expression.expression.op).toBe("and")
  })
})
