import { describe, expect, test } from "bun:test"

import { isPowSatisfiableGatePolicy } from "../src/lib/communities/membership/open-participation"
import type { GatePolicy } from "../src/lib/communities/membership/gate-types"

function policy(expression: GatePolicy["expression"]): GatePolicy {
  return { version: 1, expression }
}

const pow = { op: "gate", gate: { type: "altcha_pow" } } as const
const score = { op: "gate", gate: { type: "wallet_score", provider: "passport", minimum_score: 8 } } as const
const human = { op: "gate", gate: { type: "unique_human", provider: "very" } } as const

describe("isPowSatisfiableGatePolicy", () => {
  test("a bare proof-of-work gate is satisfiable", () => {
    expect(isPowSatisfiableGatePolicy(policy(pow))).toBe(true)
  })

  test("an OR branch containing proof-of-work is satisfiable", () => {
    // The dankmeme shape: anyone can clear it with a browser check, so the
    // gate is already open and membership adds nothing.
    expect(isPowSatisfiableGatePolicy(policy({ op: "or", children: [score, human, pow] }))).toBe(true)
  })

  test("an AND requiring identity alongside proof-of-work is not satisfiable", () => {
    expect(isPowSatisfiableGatePolicy(policy({ op: "and", children: [pow, human] }))).toBe(false)
  })

  test("an identity-only gate is not satisfiable", () => {
    expect(isPowSatisfiableGatePolicy(policy({ op: "or", children: [score, human] }))).toBe(false)
  })

  test("nested OR under AND is satisfiable only when every branch admits proof-of-work", () => {
    expect(isPowSatisfiableGatePolicy(policy({
      op: "and",
      children: [{ op: "or", children: [pow, human] }, { op: "or", children: [pow, score] }],
    }))).toBe(true)
    expect(isPowSatisfiableGatePolicy(policy({
      op: "and",
      children: [{ op: "or", children: [pow, human] }, { op: "or", children: [score, human] }],
    }))).toBe(false)
  })

  test("no policy and empty branches are not satisfiable", () => {
    expect(isPowSatisfiableGatePolicy(null)).toBe(false)
    expect(isPowSatisfiableGatePolicy(policy({ op: "or", children: [] }))).toBe(false)
    expect(isPowSatisfiableGatePolicy(policy({ op: "and", children: [] }))).toBe(false)
  })
})
