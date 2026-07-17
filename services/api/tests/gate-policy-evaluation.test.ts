import { afterEach, describe, expect, test } from "bun:test"
import { evaluateMembershipGatePolicy } from "../src/lib/communities/membership/gate-policy-evaluation"
import { validateGatePolicy } from "../src/lib/communities/membership/gate-policy-validation"
import { buildDefaultVerificationCapabilities } from "../src/lib/verification/verification-capabilities"
import type { GateAtom, GatePolicy } from "../src/lib/communities/membership/gate-types"
import type { User } from "../src/types"
import { setAssetBalanceReaderForTests } from "../src/lib/communities/community-asset-balance"
import { buildMembershipGateSummariesFromPolicy } from "../src/lib/communities/membership/gate-summary"

afterEach(() => setAssetBalanceReaderForTests(null))

function makeUser(overrides: {
  uniqueHuman?: { state: "unverified" | "verified"; provider?: "self" | "very" }
  walletScore?: { state: "unverified" | "verified"; score?: number; passing?: boolean }
  minimumAge?: { state: "unverified" | "verified"; provider?: "self" | "zkpassport"; value?: number }
  nationality?: { state: "unverified" | "verified"; provider?: "self" | "zkpassport"; value?: string }
  gender?: { state: "unverified" | "verified"; provider?: "self" | "zkpassport"; value?: "M" | "F" }
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
        ? { ...caps.minimum_age, state: "verified", provider: overrides.minimumAge.provider ?? "self", value: overrides.minimumAge.value ?? 30 }
        : caps.minimum_age,
      nationality: overrides.nationality?.state === "verified"
        ? { ...caps.nationality, state: "verified", provider: overrides.nationality.provider ?? "self", value: overrides.nationality.value ?? "US" }
        : caps.nationality,
      gender: overrides.gender?.state === "verified"
        ? { ...caps.gender, state: "verified", provider: overrides.gender.provider ?? "self", value: overrides.gender.value ?? "M" }
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

type RequiredActionNode = NonNullable<Awaited<ReturnType<typeof evaluateMembershipGatePolicy>>["requiredActionSet"]>["items"][number]

function flattenActionNodes(items: RequiredActionNode[]): RequiredActionNode[] {
  return items.flatMap((item) => item.kind === "set" ? flattenActionNodes(item.items as RequiredActionNode[]) : [item])
}

const passportAtom: GateAtom = { type: "wallet_score", provider: "passport", minimum_score: 30 }
const palmAtom: GateAtom = { type: "unique_human", provider: "very" }
const ageAtom: GateAtom = { type: "minimum_age", provider: "self", minimum_age: 18 }
const altchaAtom: GateAtom = { type: "altcha_pow" }

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
    test("validates document accepted providers additively while preserving self provider", () => {
      expect(validateGatePolicy(atomGate({
        type: "nationality",
        provider: "self",
        accepted_providers: ["zkpassport", "self"],
        allowed: ["US"],
      }))).toEqual(atomGate({
        type: "nationality",
        provider: "self",
        accepted_providers: ["self", "zkpassport"],
        allowed: ["USA"],
      }))
      expect(() => validateGatePolicy(atomGate({
        type: "nationality",
        provider: "self",
        accepted_providers: ["passport" as "self"],
        allowed: ["US"],
      }))).toThrow("nationality gate accepted_providers must only include self or zkpassport")
    })

    test("normalizes supported asset balance atoms and rejects unsafe amounts", () => {
      expect(validateGatePolicy(atomGate({
        type: "asset_balance",
        asset_id: " EIP155:1/SLIP44:60 ",
        min_amount_atomic: "1000000000000000000",
      }))).toEqual(atomGate({
        type: "asset_balance",
        asset_id: "eip155:1/slip44:60",
        min_amount_atomic: "1000000000000000000",
      }))

      for (const min_amount_atomic of ["0", "01", "-1", "1.5", "1e18", 10]) {
        expect(() => validateGatePolicy({
          version: 1,
          expression: { op: "gate", gate: {
            type: "asset_balance",
            asset_id: "eip155:1/slip44:60",
            min_amount_atomic,
          } },
        })).toThrow("asset_balance gate min_amount_atomic must be a positive atomic integer string")
      }
      expect(() => validateGatePolicy(atomGate({
        type: "asset_balance",
        asset_id: "eip155:1/erc20:0x1111111111111111111111111111111111111111",
        min_amount_atomic: "10",
      }))).toThrow("asset_balance gate requires a supported canonical asset_id")
    })

    test("reports an atomic shortfall for an insufficient attached-wallet balance", async () => {
      setAssetBalanceReaderForTests(async () => 7n)
      const result = await evaluateMembershipGatePolicy({
        env: {},
        policy: atomGate({ type: "asset_balance", asset_id: "eip155:1/slip44:60", min_amount_atomic: "10" }),
        user: makeUser({}),
        walletAttachments: [{
          wallet_attachment: "wa_1",
          chain_namespace: "eip155:1",
          wallet_address: "0x0000000000000000000000000000000000000001",
          is_primary: true,
        }],
      })
      expect(result.outcome).toBe("action_required")
      expect(result.requiredActionSet?.items[0]).toMatchObject({
        capability: "asset_balance",
        current_amount_atomic: "7",
        required_amount_atomic: "10",
        shortfall_amount_atomic: "3",
        evaluated_wallet_count: 1,
      })
    })

    test("separates an unattached wallet from an attached wallet holding nothing", async () => {
      // Both report current "0" and a full-requirement shortfall, but they need
      // opposite remedies: connect a wallet versus acquire more of the asset.
      // Only the observed wallet count tells them apart.
      setAssetBalanceReaderForTests(async () => 0n)
      const policy = atomGate({ type: "asset_balance", asset_id: "eip155:1/slip44:60", min_amount_atomic: "10" })

      const withoutWallet = await evaluateMembershipGatePolicy({
        env: {},
        policy,
        user: makeUser({}),
        walletAttachments: [],
      })
      const withEmptyWallet = await evaluateMembershipGatePolicy({
        env: {},
        policy,
        user: makeUser({}),
        walletAttachments: [{
          wallet_attachment: "wa_1",
          chain_namespace: "eip155:1",
          wallet_address: "0x0000000000000000000000000000000000000001",
          is_primary: true,
        }],
      })

      // Indistinguishable on every other field.
      for (const result of [withoutWallet, withEmptyWallet]) {
        expect(result.outcome).toBe("action_required")
        expect(result.requiredActionSet?.items[0]).toMatchObject({
          capability: "asset_balance",
          current_amount_atomic: "0",
          shortfall_amount_atomic: "10",
        })
      }

      expect(withoutWallet.requiredActionSet?.items[0]).toMatchObject({ evaluated_wallet_count: 0 })
      expect(withEmptyWallet.requiredActionSet?.items[0]).toMatchObject({ evaluated_wallet_count: 1 })
    })

    test("counts only wallets whose balance was actually read", async () => {
      // A wallet on a chain this asset does not live on is never read, so it
      // must not be counted as an observation.
      setAssetBalanceReaderForTests(async () => 0n)
      const result = await evaluateMembershipGatePolicy({
        env: {},
        policy: atomGate({ type: "asset_balance", asset_id: "eip155:1/slip44:60", min_amount_atomic: "10" }),
        user: makeUser({}),
        walletAttachments: [{
          wallet_attachment: "wa_btc",
          chain_namespace: "bip122:000000000019d6689c085ae165831e93",
          wallet_address: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
          is_primary: true,
        }],
      })

      expect(result.requiredActionSet?.items[0]).toMatchObject({ evaluated_wallet_count: 0 })
    })

    test("includes canonical atomic amounts in public summaries", () => {
      // Symbol and decimals travel on the summary because members are shown this
      // gate by a synchronous formatter that cannot reach the authenticated
      // capability catalog. Without them "10000000" is unrenderable.
      expect(buildMembershipGateSummariesFromPolicy(atomGate({
        type: "asset_balance",
        asset_id: "eip155:1/erc20:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        min_amount_atomic: "10000000",
      }))).toEqual([{
        gate_type: "asset_balance",
        asset_id: "eip155:1/erc20:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        min_amount_atomic: "10000000",
        asset_symbol: "USDC",
        asset_decimals: 6,
      }])
    })

    test("keeps summaries self-describing for assets with different precision", () => {
      expect(buildMembershipGateSummariesFromPolicy(atomGate({
        type: "asset_balance",
        asset_id: "eip155:8453/slip44:60",
        min_amount_atomic: "500000000000000000",
      }))).toEqual([{
        gate_type: "asset_balance",
        asset_id: "eip155:8453/slip44:60",
        min_amount_atomic: "500000000000000000",
        asset_symbol: "ETH",
        asset_decimals: 18,
      }])
    })

    test("accepts canonical Base USDC and evaluates it through the asset-specific adapter", async () => {
      const assetId = "eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
      let queriedAssetId = ""
      setAssetBalanceReaderForTests(async (candidate) => {
        queriedAssetId = candidate
        return 10_000_000n
      })
      const policy = validateGatePolicy(atomGate({ type: "asset_balance", asset_id: assetId, min_amount_atomic: "10000000" }))
      const result = await evaluateMembershipGatePolicy({
        env: {},
        policy,
        user: makeUser({}),
        walletAttachments: [{
          wallet_attachment: "wa_base",
          chain_namespace: "eip155:8453",
          wallet_address: "0x0000000000000000000000000000000000000001",
          is_primary: true,
        }],
      })
      expect(result.outcome).toBe("passed")
      expect(queriedAssetId).toBe(assetId)
    })

    test("briefly caches successful balance reads by asset and address", async () => {
      let calls = 0
      setAssetBalanceReaderForTests(async () => {
        calls += 1
        return 10n
      })
      const input = {
        env: {},
        policy: atomGate({ type: "asset_balance", asset_id: "eip155:1/slip44:60", min_amount_atomic: "10" } as GateAtom),
        user: makeUser({}),
        walletAttachments: [{
          wallet_attachment: "wa_cache",
          chain_namespace: "eip155:1",
          wallet_address: "0x0000000000000000000000000000000000000001",
          is_primary: true,
        }],
      }
      expect((await evaluateMembershipGatePolicy(input)).outcome).toBe("passed")
      expect((await evaluateMembershipGatePolicy(input)).outcome).toBe("passed")
      expect(calls).toBe(1)
    })

    test("queries an EVM address attached through Polygon for an Ethereum-mainnet asset", async () => {
      setAssetBalanceReaderForTests(async () => 10n)
      const result = await evaluateMembershipGatePolicy({
        env: {},
        policy: atomGate({ type: "asset_balance", asset_id: "eip155:1/slip44:60", min_amount_atomic: "10" }),
        user: makeUser({}),
        walletAttachments: [{
          wallet_attachment: "wa_polygon",
          chain_namespace: "eip155:137",
          wallet_address: "0x0000000000000000000000000000000000000001",
          is_primary: true,
        }],
      })
      expect(result.outcome).toBe("passed")
    })

    test("passes from a successful subtotal even when a later wallet would fail", async () => {
      setAssetBalanceReaderForTests(async (_assetId, address) => {
        if (address.endsWith("01")) return 10n
        throw new Error("provider unavailable")
      })
      const result = await evaluateMembershipGatePolicy({
        env: {},
        policy: atomGate({ type: "asset_balance", asset_id: "eip155:1/slip44:60", min_amount_atomic: "10" }),
        user: makeUser({}),
        walletAttachments: [1, 2].map((suffix) => ({
          wallet_attachment: `wa_${suffix}`,
          chain_namespace: "eip155:1",
          wallet_address: `0x${suffix.toString().padStart(40, "0")}`,
          is_primary: suffix === 1,
        })),
      })
      expect(result.outcome).toBe("passed")
    })

    test("reports provider unavailable instead of a false shortfall after a partial query failure", async () => {
      setAssetBalanceReaderForTests(async (_assetId, address) => {
        if (address.endsWith("01")) return 7n
        throw new Error("provider unavailable")
      })
      const result = await evaluateMembershipGatePolicy({
        env: {},
        policy: atomGate({ type: "asset_balance", asset_id: "eip155:1/slip44:60", min_amount_atomic: "10" }),
        user: makeUser({}),
        walletAttachments: [1, 2].map((suffix) => ({
          wallet_attachment: `wa_${suffix}`,
          chain_namespace: "eip155:1",
          wallet_address: `0x${suffix.toString().padStart(40, "0")}`,
          is_primary: suffix === 1,
        })),
      })
      expect(result.outcome).toBe("provider_unavailable")
      expect(result.requiredActionSet).toBeNull()
    })

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
      expect(result.outcome).toBe("terminal_mismatch")
      expect(result.requiredActionSet).toBeNull()
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

    test("passes nationality gate with accepted ZKPassport capability", async () => {
      const result = await evaluateMembershipGatePolicy({
        env: {},
        policy: atomGate({
          type: "nationality",
          provider: "self",
          accepted_providers: ["self", "zkpassport"],
          allowed: ["US"],
        }),
        user: makeUser({ nationality: { state: "verified", provider: "zkpassport", value: "USA" } }),
        walletAttachments: [],
      })
      expect(result.satisfied).toBe(true)
      expect(result.requiredActionSet).toBeNull()
    })

    test("rejects ZKPassport nationality capability when gate is Self-only", async () => {
      const result = await evaluateMembershipGatePolicy({
        env: {},
        policy: atomGate({
          type: "nationality",
          provider: "self",
          accepted_providers: ["self"],
          allowed: ["US"],
        }),
        user: makeUser({ nationality: { state: "verified", provider: "zkpassport", value: "USA" } }),
        walletAttachments: [],
      })
      expect(result.satisfied).toBe(false)
      expect(result.trace).toMatchObject({
        kind: "gate",
        gate_type: "nationality",
        reason: "provider_not_accepted",
      })
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
      expect(result.outcome).toBe("terminal_mismatch")
      expect(result.requiredActionSet).toBeNull()
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

    test("preview exposes ALTCHA as a required action alternative", async () => {
      const result = await evaluateMembershipGatePolicy({
        env: {},
        policy: orPolicy(palmAtom, altchaAtom),
        user: makeUser({ uniqueHuman: { state: "unverified" } }),
        walletAttachments: [],
        altchaScope: "post_create",
      })
      expect(result.satisfied).toBe(false)
      expect(result.requiredActionSet?.mode).toBe("any")
      const actions = flattenActionNodes(result.requiredActionSet?.items ?? []).filter((item) => item.kind === "action")
      expect(actions.some((item) => item.kind === "action" && item.provider === "altcha" && item.capability === "altcha_pow" && item.scope === "post_create")).toBe(true)
    })

    test("enforce short-circuits before ALTCHA when identity passes", async () => {
      const result = await evaluateMembershipGatePolicy({
        env: {},
        policy: orPolicy(palmAtom, altchaAtom),
        user: makeUser({ uniqueHuman: { state: "verified", provider: "very" } }),
        walletAttachments: [],
        mode: "enforce",
        altchaScope: "post_create",
      })
      expect(result.satisfied).toBe(true)
      expect(result.requiredActionSet).toBeNull()
      expect(result.trace.kind).toBe("op")
      if (result.trace.kind === "op") {
        expect(result.trace.children).toHaveLength(1)
        const child = result.trace.children[0]
        expect(child?.kind).toBe("gate")
        if (child?.kind === "gate") {
          expect(child.gate_type).toBe("unique_human")
        }
      }
    })

    test("enforce reports missing ALTCHA proof when identity alternatives fail", async () => {
      const result = await evaluateMembershipGatePolicy({
        env: {},
        policy: orPolicy(palmAtom, altchaAtom),
        user: makeUser({ uniqueHuman: { state: "unverified" } }),
        walletAttachments: [],
        mode: "enforce",
        altchaScope: "comment_create",
      })
      expect(result.satisfied).toBe(false)
      expect(result.requiredActionSet?.mode).toBe("any")
      const actions = flattenActionNodes(result.requiredActionSet?.items ?? []).filter((item) => item.kind === "action")
      expect(actions.some((item) => item.kind === "action" && item.provider === "altcha" && item.capability === "altcha_pow" && item.scope === "comment_create")).toBe(true)
    })

    test("enforce short-circuits ALTCHA when verifiedAltchaProof matches", async () => {
      const result = await evaluateMembershipGatePolicy({
        env: {},
        policy: orPolicy(palmAtom, altchaAtom),
        user: makeUser({ uniqueHuman: { state: "unverified" } }),
        walletAttachments: [],
        mode: "enforce",
        altchaScope: "comment_create",
        altchaProof: {
          payload: "test-payload",
          scope: "comment_create",
          action: "post:post_test",
        },
        verifiedAltchaProof: {
          actorUserId: "usr_policy_test",
          scope: "comment_create",
          action: "post:post_test",
        },
      })
      expect(result.satisfied).toBe(true)
      expect(result.requiredActionSet).toBeNull()
      expect(result.trace.kind).toBe("op")
      if (result.trace.kind === "op") {
        expect(result.trace.children).toHaveLength(2)
        const altchaChild = result.trace.children[1]
        expect(altchaChild?.kind).toBe("gate")
        if (altchaChild?.kind === "gate") {
          expect(altchaChild.gate_type).toBe("altcha_pow")
          expect(altchaChild.passed).toBe(true)
        }
      }
    })

    test("enforce does not short-circuit ALTCHA when verifiedAltchaProof action mismatches", async () => {
      const result = await evaluateMembershipGatePolicy({
        env: {},
        policy: orPolicy(palmAtom, altchaAtom),
        user: makeUser({ uniqueHuman: { state: "unverified" } }),
        walletAttachments: [],
        mode: "enforce",
        altchaScope: "comment_create",
        altchaProof: {
          payload: "test-payload",
          scope: "comment_create",
          action: "post:post_test",
        },
        verifiedAltchaProof: {
          actorUserId: "usr_policy_test",
          scope: "comment_create",
          action: "comment:cmt_test",
        },
      })
      expect(result.satisfied).toBe(false)
      expect(result.requiredActionSet?.mode).toBe("any")
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

    test("verified wallet score mismatch is terminal instead of requesting verification", async () => {
      const result = await evaluateMembershipGatePolicy({
        env: {},
        policy: atomGate(passportAtom),
        user: makeUser({ walletScore: { state: "verified", score: 18, passing: false } }),
        walletAttachments: [],
      })
      expect(result.outcome).toBe("terminal_mismatch")
      expect(result.requiredActionSet).toBeNull()
      expect(result.trace).toMatchObject({
        kind: "gate",
        reason: "wallet_score_too_low",
        required_score: 30,
        actual_score: 18,
      })
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

    test("empty nationality allowed list requires any Self nationality", async () => {
      const unverified = await evaluateMembershipGatePolicy({
        env: {},
        policy: atomGate({ type: "nationality", provider: "self", allowed: [] }),
        user: makeUser({ nationality: { state: "unverified" } }),
        walletAttachments: [],
      })
      expect(unverified.satisfied).toBe(false)
      const action = unverified.requiredActionSet!.items[0]
      expect(action.kind).toBe("action")
      if (action.kind === "action" && action.capability === "nationality") {
        expect(action.allowed_countries).toEqual([])
      }

      const verified = await evaluateMembershipGatePolicy({
        env: {},
        policy: atomGate({ type: "nationality", provider: "self", allowed: [] }),
        user: makeUser({ nationality: { state: "verified", value: "AR" } }),
        walletAttachments: [],
      })
      expect(verified.satisfied).toBe(true)
      expect(verified.requiredActionSet).toBeNull()
    })
  })

  describe("outcome composition", () => {
    const nationalityMismatch: GateAtom = {
      type: "nationality",
      provider: "self",
      allowed: ["CA"],
    }
    const erc721WithoutRpc: GateAtom = {
      type: "erc721_holding",
      chain_namespace: "eip155:1",
      contract_address: "0x0000000000000000000000000000000000000001",
    }

    test("AND terminal mismatch dominates actionable branches in either order", async () => {
      for (const policy of [
        andPolicy(nationalityMismatch, palmAtom),
        andPolicy(palmAtom, nationalityMismatch),
      ]) {
        const result = await evaluateMembershipGatePolicy({
          env: {},
          policy,
          user: makeUser({ nationality: { state: "verified", value: "US" } }),
          walletAttachments: [],
          mode: "enforce",
        })
        expect(result.outcome).toBe("terminal_mismatch")
        expect(result.requiredActionSet).toBeNull()
        expect(result.trace).toMatchObject({ kind: "op", op: "and" })
        if (result.trace.kind === "op") expect(result.trace.children).toHaveLength(2)
      }
    })

    test("OR actionable branches dominate terminal mismatches in either order", async () => {
      for (const policy of [
        orPolicy(nationalityMismatch, palmAtom),
        orPolicy(palmAtom, nationalityMismatch),
      ]) {
        const result = await evaluateMembershipGatePolicy({
          env: {},
          policy,
          user: makeUser({ nationality: { state: "verified", value: "US" } }),
          walletAttachments: [],
          mode: "enforce",
        })
        expect(result.outcome).toBe("action_required")
        expect(result.requiredActionSet?.mode).toBe("any")
      }
    })

    test("provider outages dominate actions in AND but not OR", async () => {
      const originalConsoleError = console.error
      console.error = () => {}
      try {
        for (const policy of [
          andPolicy(erc721WithoutRpc, palmAtom),
          andPolicy(palmAtom, erc721WithoutRpc),
        ]) {
          const result = await evaluateMembershipGatePolicy({
            env: {},
            policy,
            user: makeUser({}),
            walletAttachments: [],
            mode: "enforce",
          })
          expect(result.outcome).toBe("provider_unavailable")
          expect(result.requiredActionSet).toBeNull()
        }

        for (const policy of [
          orPolicy(erc721WithoutRpc, palmAtom),
          orPolicy(palmAtom, erc721WithoutRpc),
        ]) {
          const result = await evaluateMembershipGatePolicy({
            env: {},
            policy,
            user: makeUser({}),
            walletAttachments: [],
            mode: "enforce",
          })
          expect(result.outcome).toBe("action_required")
          expect(result.requiredActionSet?.mode).toBe("any")
        }
      } finally {
        console.error = originalConsoleError
      }
    })

    test("failed AND enforcement diagnoses unvisited proof-of-work without consuming it", async () => {
      const result = await evaluateMembershipGatePolicy({
        env: {},
        policy: andPolicy(nationalityMismatch, altchaAtom),
        user: makeUser({ nationality: { state: "verified", value: "US" } }),
        walletAttachments: [],
        mode: "enforce",
        altchaScope: "community_join",
      })

      expect(result.outcome).toBe("terminal_mismatch")
      expect(result.requiredActionSet).toBeNull()
      if (result.trace.kind === "op") {
        expect(result.trace.children).toHaveLength(2)
        expect(result.trace.children[1]).toMatchObject({
          kind: "gate",
          gate_type: "altcha_pow",
          reason: "missing_altcha_pow",
        })
      }
    })
  })

  describe("collapsed action sets", () => {
    test("erc721 actions carry the required collection quantity", async () => {
      const result = await evaluateMembershipGatePolicy({
        env: { ETHEREUM_RPC_URL: "https://example.invalid" },
        policy: atomGate({
          type: "erc721_holding",
          chain_namespace: "eip155:1",
          contract_address: "0x0000000000000000000000000000000000000001",
          min_count: 10,
        }),
        user: makeUser({}),
        walletAttachments: [],
      })

      expect(result.requiredActionSet?.items[0]).toMatchObject({
        kind: "action",
        capability: "erc721_holding",
        min_quantity: 10,
      })
    })

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
