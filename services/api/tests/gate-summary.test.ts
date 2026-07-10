import { describe, expect, test } from "bun:test"
import { buildMembershipGateExpressionFromPolicy } from "../src/lib/communities/membership/gate-summary"
import type { GatePolicy } from "../src/lib/communities/membership/gate-types"

describe("membership gate expression summaries", () => {
  test("preserves nested AND/OR structure", () => {
    const policy: GatePolicy = {
      version: 1,
      expression: {
        op: "and",
        children: [
          { op: "gate", gate: { type: "unique_human", provider: "self" } },
          {
            op: "or",
            children: [
              { op: "gate", gate: { type: "altcha_pow" } },
              { op: "gate", gate: { type: "wallet_score", provider: "passport", minimum_score: 20 } },
            ],
          },
        ],
      },
    }

    expect(buildMembershipGateExpressionFromPolicy(policy)).toEqual({
      op: "and",
      children: [
        { op: "gate", gate: { gate_type: "unique_human", accepted_providers: ["self"] } },
        {
          op: "or",
          children: [
            { op: "gate", gate: { gate_type: "altcha_pow" } },
            { op: "gate", gate: { gate_type: "wallet_score", accepted_providers: ["passport"], minimum_score: 20 } },
          ],
        },
      ],
    })
  })

  test("returns null when no policy exists", () => {
    expect(buildMembershipGateExpressionFromPolicy(null)).toBeNull()
  })
})
