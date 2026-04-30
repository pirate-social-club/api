import { describe, expect, test } from "bun:test"
import { evaluateMembershipGatePolicy } from "../src/lib/communities/membership/gate-policy-evaluation"
import { buildDefaultVerificationCapabilities } from "../src/lib/verification/verification-capabilities"
import type { GateAtom, GatePolicy } from "../src/lib/communities/membership/gate-types"
import type { User } from "../src/types"

function makeUser(overrides: {
  uniqueHuman?: { state: "unverified" | "verified"; provider?: "self" | "very" }
  walletScore?: { state: "unverified" | "verified"; score?: number; passing?: boolean }
  minimumAge?: { state: "unverified" | "verified"; value?: number }
  nationality?: { state: "unverified" | "verified"; value?: string }
  gender?: { state: "unverified" | "verified"; value?: "M" | "F" }
}): User {
  const caps = buildDefaultVerificationCapabilities()
  return {
    user_id: "usr_policy_test",
    verification_state: "verified",
    verification_capabilities: {
      ...caps,
      unique_human: { ...caps.unique_human, state: "verified", provider: "self", ...(overrides.uniqueHuman ?? {}) },
      wallet_score: overrides.walletScore?.state === "verified"
        ? {
          ...caps.wallet_score,
          state: "verified",
          provider: "passport",
          proof_type: "wallet_score",
          score_decimal: String(overrides.walletScore.score ?? 0),
          score_threshold_decimal: "20",
          passing_score: overrides.walletScore.passing ?? true,
        }
        : caps.wallet_score,
      minimum_age: overrides.minimumAge?.state === "verified"
        ? { ...caps.minimum_age, state: "verified", provider: "self", value: overrides.minimumAge.value ?? 30 }
        : caps.minimum_age,
      nationality: overrides.nationality?.state === "verified"
        ? { ...caps.nationality, state: "verified", provider: "self", value: overrides.nationality.value ?? "US" }
        : caps.nationality,
      gender: overrides.gender?.state === "verified"
        ? { ...caps.gender, state: "verified", provider: "self", value: overrides.gender.value ?? "M" }
        : caps.gender,
    },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
}

function atomGate(atom: GateAtom): GatePolicy {
  return { version: 1, expression: { op: "gate", gate: atom } }
}

function andPolicy(...atoms: GateAtom[]): GatePolicy {
  return {
    version: 1,
    expression: {
      op: "and",
      children: atoms.map((gate) => ({ op: "gate" as const, gate })),
    },
  }
}

function orPolicy(...atoms: GateAtom[]): GatePolicy {
  return {
    version: 1,
    expression: {
      op: "or",
      children: atoms.map((gate) => ({ op: "gate" as const, gate })),
    },
  }
}

const passportAtom: GateAtom = { type: "wallet_score", provider: "passport", minimum_score: 30 }
const palmAtom: GateAtom = { type: "unique_human", provider: "very" }
const ageAtom: GateAtom = { type: "minimum_age", provider: "self", minimum_age: 18 }

describe("evaluateMembershipGatePolicy", () => {
  describe("null policy", () => {
    test("returns not satisfied for null policy", async () => {
      const result = await evaluateMembershipGatePolicy({
        env: {},
        policy: null,
        user: makeUser({}),
        walletAttachments: [],
      })
      expect(result.satisfied).toBe(false)
    })
  })

  describe("single gate", () => {
    test("passes when wallet score meets threshold", async () => {
      const result = await evaluateMembershipGatePolicy({
        env: {},
        policy: atomGate(passportAtom),
        user: makeUser({ walletScore: { state: "verified", score: 30, passing: true } }),
        walletAttachments: [],
      })
      expect(result.satisfied).toBe(true)
      expect(result.requiredActionSet).toBeNull()
    })

    test("fails when wallet score is too low", async () => {
      const result = await evaluateMembershipGatePolicy({
        env: {},
        policy: atomGate(passportAtom),
        user: makeUser({ walletScore: { state: "verified", score: 18, passing: false } }),
        walletAttachments: [],
      })
      expect(result.satisfied).toBe(false)
      expect(result.requiredActionSet).not.toBeNull()
      expect(result.requiredActionSet!.kind).toBe("set")
      expect(result.requiredActionSet!.mode).toBe("all")
      expect(result.requiredActionSet!.items).toHaveLength(1)
    })

    test("fails when wallet score is unverified", async () => {
      const result = await evaluateMembershipGatePolicy({
        env: {},
        policy: atomGate(passportAtom),
        user: makeUser({ walletScore: { state: "unverified" } }),
        walletAttachments: [],
      })
      expect(result.satisfied).toBe(false)
      expect(result.requiredActionSet).not.toBeNull()
    })
  })

  describe("AND expression", () => {
    test("passes when all children pass", async () => {
      const result = await evaluateMembershipGatePolicy({
        env: {},
        policy: andPolicy(passportAtom, ageAtom),
        user: makeUser({
          walletScore: { state: "verified", score: 35, passing: true },
          minimumAge: { state: "verified", value: 25 },
        }),
        walletAttachments: [],
      })
      expect(result.satisfied).toBe(true)
      expect(result.requiredActionSet).toBeNull()
    })

    test("fails when one child fails", async () => {
      const result = await evaluateMembershipGatePolicy({
        env: {},
        policy: andPolicy(passportAtom, ageAtom),
        user: makeUser({
          walletScore: { state: "verified", score: 18, passing: false },
          minimumAge: { state: "verified", value: 25 },
        }),
        walletAttachments: [],
      })
      expect(result.satisfied).toBe(false)
      expect(result.requiredActionSet!.kind).toBe("set")
      expect(result.requiredActionSet!.mode).toBe("all")
      const actions = result.requiredActionSet!.items.filter((i) => i.kind === "action")
      expect(actions.length >= 1).toBe(true)
    })

    test("fails when all children fail", async () => {
      const result = await evaluateMembershipGatePolicy({
        env: {},
        policy: andPolicy(passportAtom, ageAtom),
        user: makeUser({
          walletScore: { state: "unverified" },
          minimumAge: { state: "unverified" },
        }),
        walletAttachments: [],
      })
      expect(result.satisfied).toBe(false)
      expect(result.requiredActionSet!.items.length >= 2).toBe(true)
    })
  })

  describe("OR expression", () => {
    test("passes when one child passes", async () => {
      const result = await evaluateMembershipGatePolicy({
        env: {},
        policy: orPolicy(passportAtom, palmAtom),
        user: makeUser({
          walletScore: { state: "verified", score: 18, passing: false },
          uniqueHuman: { state: "verified", provider: "very" },
        }),
        walletAttachments: [],
      })
      expect(result.satisfied).toBe(true)
      expect(result.requiredActionSet).toBeNull()
    })

    test("passes when the other child passes", async () => {
      const result = await evaluateMembershipGatePolicy({
        env: {},
        policy: orPolicy(passportAtom, palmAtom),
        user: makeUser({
          walletScore: { state: "verified", score: 35, passing: true },
          uniqueHuman: { state: "unverified" },
        }),
        walletAttachments: [],
      })
      expect(result.satisfied).toBe(true)
      expect(result.requiredActionSet).toBeNull()
    })

    test("fails when all children fail", async () => {
      const result = await evaluateMembershipGatePolicy({
        env: {},
        policy: orPolicy(passportAtom, palmAtom),
        user: makeUser({
          walletScore: { state: "unverified" },
          uniqueHuman: { state: "unverified" },
        }),
        walletAttachments: [],
      })
      expect(result.satisfied).toBe(false)
      expect(result.requiredActionSet).not.toBeNull()
      expect(result.requiredActionSet!.kind).toBe("set")
      expect(result.requiredActionSet!.mode).toBe("any")
      expect(result.requiredActionSet!.items.length >= 2).toBe(true)
    })

    test("OR failure action set lists alternatives not cumulative", async () => {
      const result = await evaluateMembershipGatePolicy({
        env: {},
        policy: orPolicy(passportAtom, palmAtom),
        user: makeUser({
          walletScore: { state: "unverified" },
          uniqueHuman: { state: "unverified" },
        }),
        walletAttachments: [],
      })
      expect(result.satisfied).toBe(false)
      expect(result.requiredActionSet!.mode).toBe("any")
    })
  })

  describe("trace structure", () => {
    test("trace exists even on pass", async () => {
      const result = await evaluateMembershipGatePolicy({
        env: {},
        policy: orPolicy(passportAtom, palmAtom),
        user: makeUser({
          walletScore: { state: "verified", score: 18, passing: false },
          uniqueHuman: { state: "verified", provider: "very" },
        }),
        walletAttachments: [],
      })
      expect(result.satisfied).toBe(true)
      expect(result.trace.kind).toBe("op")
      const opTrace = result.trace as Extract<typeof result.trace, { kind: "op" }>
      expect(opTrace.children).toHaveLength(2)
    })

    test("wallet score trace includes required and actual score", async () => {
      const result = await evaluateMembershipGatePolicy({
        env: {},
        policy: atomGate(passportAtom),
        user: makeUser({ walletScore: { state: "verified", score: 18, passing: false } }),
        walletAttachments: [],
      })
      expect(result.satisfied).toBe(false)
      expect(result.trace.kind).toBe("gate")
      const gateTrace = result.trace as Extract<typeof result.trace, { kind: "gate" }>
      expect(gateTrace.required_score).toBe(30)
      expect(gateTrace.actual_score).toBe(18)
    })

    test("gender trace does not include actual value", async () => {
      const result = await evaluateMembershipGatePolicy({
        env: {},
        policy: atomGate({ type: "gender", provider: "self", allowed: ["M"] }),
        user: makeUser({ gender: { state: "verified", value: "F" } }),
        walletAttachments: [],
      })
      expect(result.satisfied).toBe(false)
      expect(result.trace.kind).toBe("gate")
      const gateTrace = result.trace as Record<string, unknown>
      expect(gateTrace.actual_gender).toBe(undefined)
      expect(gateTrace.actual_value).toBe(undefined)
    })

    test("nationality trace does not include actual value", async () => {
      const result = await evaluateMembershipGatePolicy({
        env: {},
        policy: atomGate({ type: "nationality", provider: "self", allowed: ["US"] }),
        user: makeUser({ nationality: { state: "verified", value: "AR" } }),
        walletAttachments: [],
      })
      expect(result.satisfied).toBe(false)
      expect(result.trace.kind).toBe("gate")
      const gateTrace = result.trace as Record<string, unknown>
      expect(gateTrace.actual_nationality).toBe(undefined)
      expect(gateTrace.actual_value).toBe(undefined)
    })
  })

  describe("required action set structure", () => {
    test("single gate failure wraps in all-mode set", async () => {
      const result = await evaluateMembershipGatePolicy({
        env: {},
        policy: atomGate(passportAtom),
        user: makeUser({ walletScore: { state: "unverified" } }),
        walletAttachments: [],
      })
      expect(result.requiredActionSet!.kind).toBe("set")
      expect(result.requiredActionSet!.mode).toBe("all")
      expect(result.requiredActionSet!.items).toHaveLength(1)
      const action = result.requiredActionSet!.items[0]
      expect(action.kind).toBe("action")
    })

    test("wallet score action includes minimum_score and actual_score", async () => {
      const result = await evaluateMembershipGatePolicy({
        env: {},
        policy: atomGate(passportAtom),
        user: makeUser({ walletScore: { state: "verified", score: 18, passing: false } }),
        walletAttachments: [],
      })
      const action = result.requiredActionSet!.items[0]
      expect(action.kind).toBe("action")
      if (action.kind === "action" && action.capability === "wallet_score") {
        expect(action.minimum_score).toBe(30)
        expect(action.actual_score).toBe(18)
      }
    })

    test("nationality action includes allowed_countries", async () => {
      const result = await evaluateMembershipGatePolicy({
        env: {},
        policy: atomGate({ type: "nationality", provider: "self", allowed: ["US", "CA"] }),
        user: makeUser({ nationality: { state: "unverified" } }),
        walletAttachments: [],
      })
      const action = result.requiredActionSet!.items[0]
      expect(action.kind).toBe("action")
      if (action.kind === "action" && action.capability === "nationality") {
        expect(action.allowed_countries).toEqual(["US", "CA"])
      }
    })
  })

  describe("collapsed action sets", () => {
    test("nested same-mode sets collapse", async () => {
      const result = await evaluateMembershipGatePolicy({
        env: {},
        policy: andPolicy(passportAtom, ageAtom),
        user: makeUser({
          walletScore: { state: "unverified" },
          minimumAge: { state: "unverified" },
        }),
        walletAttachments: [],
      })
      expect(result.requiredActionSet!.kind).toBe("set")
      expect(result.requiredActionSet!.mode).toBe("all")
      const leafActions = result.requiredActionSet!.items.filter((i) => i.kind === "action")
      expect(leafActions.length >= 2).toBe(true)
    })
  })
})
