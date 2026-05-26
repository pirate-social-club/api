import { describe, expect, test } from "bun:test"
import type { GatePolicy } from "../src/lib/communities/membership/gate-types"
import { addZkPassportAcceptedProviders } from "./community-document-providers-migration"

function policy(children: GatePolicy["expression"][]): GatePolicy {
  return {
    version: 1,
    expression: {
      op: "and",
      children,
    },
  }
}

function gate(gateAtom: Record<string, unknown>): GatePolicy["expression"] {
  return {
    op: "gate",
    gate: gateAtom,
  } as GatePolicy["expression"]
}

describe("community document providers migration", () => {
  test("adds Self OR ZKPassport accepted providers to missing document gates", () => {
    const result = addZkPassportAcceptedProviders(policy([
      gate({ type: "altcha_pow" }),
      gate({ type: "nationality", provider: "self", allowed: ["US"] }),
      gate({ type: "minimum_age", provider: "self", minimum_age: 21 }),
    ]))

    expect(result.changed).toBe(true)
    expect(result.gateTypes).toEqual(["minimum_age", "nationality"])
    expect(result.policy.expression).toEqual({
      op: "and",
      children: [
        { op: "gate", gate: { type: "altcha_pow" } },
        {
          op: "gate",
          gate: {
            type: "nationality",
            provider: "self",
            accepted_providers: ["self", "zkpassport"],
            allowed: ["US"],
          },
        },
        {
          op: "gate",
          gate: {
            type: "minimum_age",
            provider: "self",
            accepted_providers: ["self", "zkpassport"],
            minimum_age: 21,
          },
        },
      ],
    })
  })

  test("walks nested OR expressions", () => {
    const result = addZkPassportAcceptedProviders({
      version: 1,
      expression: {
        op: "or",
        children: [
          gate({ type: "wallet_score", provider: "passport", minimum_score: 20 }),
          {
            op: "and",
            children: [
              gate({ type: "gender", provider: "self", allowed: ["F"] }),
            ],
          },
        ],
      },
    })

    expect(result.changed).toBe(true)
    expect(result.gateTypes).toEqual(["gender"])
    expect(result.policy.expression).toEqual({
      op: "or",
      children: [
        { op: "gate", gate: { type: "wallet_score", provider: "passport", minimum_score: 20 } },
        {
          op: "and",
          children: [{
            op: "gate",
            gate: {
              type: "gender",
              provider: "self",
              accepted_providers: ["self", "zkpassport"],
              allowed: ["F"],
            },
          }],
        },
      ],
    })
  })

  test("does not change gates that already declare accepted providers by default", () => {
    const input = policy([
      gate({
        type: "nationality",
        provider: "self",
        accepted_providers: ["self"],
        allowed: ["US"],
      }),
    ])

    const result = addZkPassportAcceptedProviders(input)

    expect(result.changed).toBe(false)
    expect(result.policy.expression).toEqual(input.expression)
  })

  test("can upgrade explicit Self-only accepted providers when requested", () => {
    const result = addZkPassportAcceptedProviders(policy([
      gate({
        type: "nationality",
        provider: "self",
        accepted_providers: ["self"],
        allowed: ["US"],
      }),
    ]), { includeSelfOnly: true })

    expect(result.changed).toBe(true)
    expect(result.policy.expression).toEqual({
      op: "and",
      children: [{
        op: "gate",
        gate: {
          type: "nationality",
          provider: "self",
          accepted_providers: ["self", "zkpassport"],
          allowed: ["US"],
        },
      }],
    })
  })

  test("ignores non-document and non-Self gates", () => {
    const result = addZkPassportAcceptedProviders(policy([
      gate({ type: "altcha_pow" }),
      gate({ type: "unique_human", provider: "very" }),
      gate({ type: "wallet_score", provider: "passport", minimum_score: 20 }),
    ]))

    expect(result.changed).toBe(false)
    expect(result.gateTypes).toEqual([])
  })
})
