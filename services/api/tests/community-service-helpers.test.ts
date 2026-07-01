import { describe, expect, test } from "bun:test"
import {
  isExpired,
  buildPendingD1CommunityBindingUrl,
  isPendingD1CommunityBindingUrl,
  assertCreateRequest,
} from "../src/lib/communities/create/service"
import { satisfiesBaselineJoinGate } from "../src/lib/communities/membership/eligibility-service"
import { getPrimaryWalletSnapshot, parseStoredLabelPolicy, parseStoredReferenceLinks } from "../src/lib/communities/community-serialization"
import type { User, CreateCommunityRequest } from "../src/types"

function makeTestUser(overrides: Partial<User["verification_capabilities"]> = {}): User {
  return {
    user_id: "usr_test",
    verification_state: "verified",
    capability_provider: "self",
    verification_capabilities: {
      unique_human: { state: "verified", provider: "self" },
      age_over_18: { state: "unverified", provider: null },
      minimum_age: { state: "unverified", provider: null, value: null },
      nationality: { state: "unverified", provider: null, value: null },
      gender: { state: "unverified", provider: null, value: null },
      wallet_score: { state: "unverified", provider: null, passing_score: null, score_decimal: null },
      ...overrides,
    },
    primary_wallet_attachment_id: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
}

function makeCreateBody(overrides: Record<string, unknown> = {}): CreateCommunityRequest {
  const gateRules = Array.isArray(overrides.gate_rules) ? overrides.gate_rules : null
  const gatePolicy = gateRules
    ? {
        version: 1,
        expression: {
          op: "and",
          children: gateRules.map((rule) => ({
            op: "gate",
            gate: gateRuleToAtom(rule as Record<string, unknown>),
          })),
        },
      }
    : undefined
  const { gate_rules: _gateRules, ...rest } = overrides
  return {
    display_name: "Test Community",
    allow_anonymous_identity: false,
    handle_policy: { policy_template: "standard" },
    governance_mode: "centralized",
    membership_mode: gatePolicy ? "gated" : "request",
    ...rest,
    ...(gatePolicy ? { gate_policy: gatePolicy } : {}),
  } as CreateCommunityRequest
}

function gateRuleToAtom(rule: Record<string, unknown>): Record<string, unknown> {
  if (rule.gate_type === "gender") {
    const requirement = Array.isArray(rule.proof_requirements)
      ? rule.proof_requirements[0] as { accepted_providers?: string[]; config?: { required_value?: unknown } } | undefined
      : undefined
    return {
      type: "gender",
      provider: requirement?.accepted_providers?.[0] ?? "self",
      allowed: [requirement?.config?.required_value],
    }
  }
  if (rule.gate_type === "erc721_holding") {
    const config = rule.gate_config as Record<string, unknown> | undefined
    return {
      type: "erc721_holding",
      chain_namespace: rule.chain_namespace,
      contract_address: config?.contract_address,
    }
  }
  if (rule.gate_type === "erc721_inventory_match") {
    const config = rule.gate_config as Record<string, unknown> | undefined
    return {
      type: "erc721_inventory_match",
      provider: config?.inventory_provider,
      chain_namespace: rule.chain_namespace,
      contract_address: config?.contract_address,
      min_quantity: config?.min_quantity,
      match: config?.match ?? config?.asset_filter,
    }
  }
  return { type: rule.gate_type }
}

describe("community helper functions", () => {
  describe("isExpired", () => {
    test("returns false for future timestamps", () => {
      const future = new Date(Date.now() + 60_000).toISOString()
      expect(isExpired(future)).toBe(false)
    })

    test("returns true for past timestamps", () => {
      const past = new Date(Date.now() - 60_000).toISOString()
      expect(isExpired(past)).toBe(true)
    })

    test("rejects invalid ISO timestamps", () => {
      expect(() => isExpired("not-a-date")).toThrow()
    })
  })

  describe("pending D1 community binding URL", () => {
    test("builds a d1://pending- sentinel that round-trips", () => {
      const url = buildPendingD1CommunityBindingUrl("cmt_abc")
      expect(url).toBe("d1://pending-cmt_abc.invalid")
      expect(isPendingD1CommunityBindingUrl(url)).toBe(true)
    })

    test("does not treat a resolved d1://shard/<binding> URL as pending", () => {
      expect(isPendingD1CommunityBindingUrl("d1://shard/DB_CMTY_0001")).toBe(false)
    })

    test("does not treat a Turso pending sentinel as a D1 pending URL", () => {
      expect(isPendingD1CommunityBindingUrl("libsql://pending-cmt_abc.invalid")).toBe(false)
    })

    test("returns false for empty/null/undefined", () => {
      expect(isPendingD1CommunityBindingUrl("")).toBe(false)
      expect(isPendingD1CommunityBindingUrl(null)).toBe(false)
      expect(isPendingD1CommunityBindingUrl(undefined)).toBe(false)
    })
  })

  describe("satisfiesBaselineJoinGate", () => {
    test("returns true when unique_human is verified", () => {
      const user = makeTestUser()
      expect(satisfiesBaselineJoinGate(user)).toBe(true)
    })

    test("returns true when wallet_score is passing via passport", () => {
      const user = makeTestUser({
        unique_human: { state: "unverified", provider: null },
        wallet_score: { state: "verified", provider: "passport", passing_score: true, score_decimal: "85" },
      })
      expect(satisfiesBaselineJoinGate(user)).toBe(true)
    })

    test("returns false when wallet_score is verified but not passing", () => {
      const user = makeTestUser({
        unique_human: { state: "unverified", provider: null },
        wallet_score: { state: "verified", provider: "passport", passing_score: false, score_decimal: "30" },
      })
      expect(satisfiesBaselineJoinGate(user)).toBe(false)
    })

    test("returns false when neither is verified", () => {
      const user = makeTestUser({
        unique_human: { state: "unverified", provider: null },
      })
      expect(satisfiesBaselineJoinGate(user)).toBe(false)
    })
  })

  describe("getPrimaryWalletSnapshot", () => {
    const attachments = [
      { wallet_attachment: "wa_1", wallet_address: "0xaaa", is_primary: false },
      { wallet_attachment: "wa_2", wallet_address: "0xbbb", is_primary: true },
    ]

    test("returns the wallet matching primary_wallet_attachment", () => {
      const user = { primary_wallet_attachment_id: "wa_1" } as User
      expect(getPrimaryWalletSnapshot(user, attachments)).toBe("0xaaa")
    })

    test("falls back to is_primary attachment", () => {
      const user = { primary_wallet_attachment_id: null } as User
      expect(getPrimaryWalletSnapshot(user, attachments)).toBe("0xbbb")
    })

    test("falls back to first attachment", () => {
      const user = { primary_wallet_attachment_id: null } as User
      const noPrimary = [
        { wallet_attachment: "wa_1", wallet_address: "0xaaa", is_primary: false },
      ]
      expect(getPrimaryWalletSnapshot(user, noPrimary)).toBe("0xaaa")
    })

    test("returns null when no attachments", () => {
      const user = { primary_wallet_attachment_id: null } as User
      expect(getPrimaryWalletSnapshot(user, [])).toBe(null)
    })
  })

  describe("parseStoredLabelPolicy", () => {
    test("reads label definitions saved with the current label_id field", () => {
      expect(parseStoredLabelPolicy({
        label_policy: {
          label_enabled: true,
          require_label_on_top_level_posts: false,
          definitions: [{
            label_id: "lbl_news",
            label: "News",
            color_token: "#6377f0",
            status: "active",
            position: 0,
          }],
        },
      })?.definitions).toEqual([{
        id: "cld_lbl_news",
        object: "community_label_definition",
        label: "News",
        description: null,
        color_token: "#6377f0",
        status: "active",
        position: 0,
        allowed_post_types: null,
      }])
    })
  })

  describe("parseStoredReferenceLinks", () => {
    test("reads reference links saved with the current community_reference_link field", () => {
      expect(parseStoredReferenceLinks({
        reference_links: [{
          community_reference_link: "lnk_site",
          object: "community_reference_link",
          platform: "official_website",
          url: "https://pirate.example",
          label: "Site",
          metadata: { display_name: "Site", image_url: null },
          position: 0,
          verified: false,
        }],
      })).toEqual([{
        community_reference_link: "lnk_site",
        platform: "official_website",
        url: "https://pirate.example",
        label: "Site",
        link_status: "active",
        verified: false,
        metadata: { display_name: "Site", image_url: null },
        position: 0,
      }])
    })
  })

  describe("assertCreateRequest", () => {
    test("passes for valid minimal request", () => {
      expect(() =>
        assertCreateRequest(makeCreateBody(), { ageOver18Verified: false }),
      ).not.toThrow()
    })

    test("rejects missing display_name", () => {
      expect(() =>
        assertCreateRequest(makeCreateBody({ display_name: "" }), { ageOver18Verified: false }),
      ).toThrow()
    })

    test("rejects 18_plus age gate without age verification", () => {
      expect(() =>
        assertCreateRequest(makeCreateBody({ default_age_gate_policy: "18_plus" }), { ageOver18Verified: false }),
      ).toThrow()
    })

    test("allows 18_plus age gate with age verification", () => {
      expect(() =>
        assertCreateRequest(makeCreateBody({ default_age_gate_policy: "18_plus" }), { ageOver18Verified: true }),
      ).not.toThrow()
    })

    test("rejects donation_policy in v0", () => {
      expect(() =>
        assertCreateRequest(makeCreateBody({ donation_policy: { mode: "optional" } as any }), { ageOver18Verified: false }),
      ).toThrow()
    })

    test("allows erc721_holding gate family in v0 with valid Ethereum config", () => {
      expect(() =>
        assertCreateRequest(makeCreateBody({
          gate_rules: [{
            scope: "membership",
            gate_family: "token_holding",
            gate_type: "erc721_holding",
            chain_namespace: "eip155:1",
            gate_config: { contract_address: "0x1111111111111111111111111111111111111111" },
          }],
        }), { ageOver18Verified: false }),
      ).not.toThrow()
    })

    test("allows Courtyard erc721 inventory match gate with valid Polygon config", () => {
      expect(() =>
        assertCreateRequest(makeCreateBody({
          gate_rules: [{
            scope: "membership",
            gate_family: "token_holding",
            gate_type: "erc721_inventory_match",
            chain_namespace: "eip155:137",
            gate_config: {
              contract_address: "0x251BE3A17Af4892035C37ebf5890F4a4D889dcAD",
              inventory_provider: "courtyard",
              min_quantity: 3,
              asset_filter: { category: "trading_card", franchise: "pokemon", subject: "charizard" },
            },
          }],
        }), { ageOver18Verified: false }),
      ).not.toThrow()
    })

    test("allows Courtyard erc721 inventory match gate with canonical match config", () => {
      expect(() =>
        assertCreateRequest(makeCreateBody({
          gate_rules: [{
            scope: "membership",
            gate_family: "token_holding",
            gate_type: "erc721_inventory_match",
            chain_namespace: "eip155:137",
            gate_config: {
              contract_address: "0x251BE3A17Af4892035C37ebf5890F4a4D889dcAD",
              inventory_provider: "courtyard",
              min_quantity: 5,
              match: {
                category: "watch",
                brand: "rolex",
                model: "submariner",
                reference: "124060",
              },
            },
          }],
        }), { ageOver18Verified: false }),
      ).not.toThrow()
    })

    test("allows Courtyard erc721 inventory match gate with valid Ethereum config", () => {
      expect(() =>
        assertCreateRequest(makeCreateBody({
          gate_rules: [{
            scope: "membership",
            gate_family: "token_holding",
            gate_type: "erc721_inventory_match",
            chain_namespace: "eip155:1",
            gate_config: {
              contract_address: "0xd4ac3CE8e1E14CD60666D49AC34Ff2d2937cF6FA",
              inventory_provider: "courtyard",
              min_quantity: 1,
              match: { category: "watch", brand: "rolex" },
            },
          }],
        }), { ageOver18Verified: false }),
      ).not.toThrow()
    })

    test("rejects Courtyard inventory gate with mismatched chain and registry contract", () => {
      expect(() =>
        assertCreateRequest(makeCreateBody({
          gate_rules: [{
            scope: "membership",
            gate_family: "token_holding",
            gate_type: "erc721_inventory_match",
            chain_namespace: "eip155:1",
            gate_config: {
              contract_address: "0x251BE3A17Af4892035C37ebf5890F4a4D889dcAD",
              inventory_provider: "courtyard",
              min_quantity: 3,
              asset_filter: { category: "trading_card", franchise: "pokemon", subject: "charizard" },
            },
          }],
        }), { ageOver18Verified: false }),
      ).toThrow("erc721_inventory_match gate requires an allowlisted Courtyard contract")
    })

    test("rejects Courtyard inventory gate with unsupported filter key", () => {
      expect(() =>
        assertCreateRequest(makeCreateBody({
          gate_rules: [{
            scope: "membership",
            gate_family: "token_holding",
            gate_type: "erc721_inventory_match",
            chain_namespace: "eip155:137",
            gate_config: {
              contract_address: "0x251BE3A17Af4892035C37ebf5890F4a4D889dcAD",
              inventory_provider: "courtyard",
              min_quantity: 3,
              asset_filter: { category: "trading_card", franchise: "pokemon", subject: "charizard", regex: ".*" },
            },
          }],
        }), { ageOver18Verified: false }),
      ).toThrow("erc721_inventory_match has unsupported keys: regex")
    })

    test("rejects Courtyard inventory gate with invalid quantity", () => {
      expect(() =>
        assertCreateRequest(makeCreateBody({
          gate_rules: [{
            scope: "membership",
            gate_family: "token_holding",
            gate_type: "erc721_inventory_match",
            chain_namespace: "eip155:137",
            gate_config: {
              contract_address: "0x251BE3A17Af4892035C37ebf5890F4a4D889dcAD",
              inventory_provider: "courtyard",
              min_quantity: 0,
              asset_filter: { category: "watch", brand: "rolex" },
            },
          }],
        }), { ageOver18Verified: false }),
      ).toThrow("erc721_inventory_match gate min_quantity must be from 1 to 100")
    })

    test("rejects Courtyard inventory gate with empty category-only filter", () => {
      expect(() =>
        assertCreateRequest(makeCreateBody({
          gate_rules: [{
            scope: "membership",
            gate_family: "token_holding",
            gate_type: "erc721_inventory_match",
            chain_namespace: "eip155:137",
            gate_config: {
              contract_address: "0x251BE3A17Af4892035C37ebf5890F4a4D889dcAD",
              inventory_provider: "courtyard",
              min_quantity: 5,
              asset_filter: { category: "watch" },
            },
          }],
        }), { ageOver18Verified: false }),
      ).toThrow("erc721_inventory_match must include category plus a supported matching field")
    })

    test("rejects erc721_holding gate with invalid chain namespace", () => {
      expect(() =>
        assertCreateRequest(makeCreateBody({
          gate_rules: [{
            scope: "membership",
            gate_family: "token_holding",
            gate_type: "erc721_holding",
            chain_namespace: "eip155:8453",
            gate_config: { contract_address: "0x1111111111111111111111111111111111111111" },
          }],
        }), { ageOver18Verified: false }),
      ).toThrow("erc721_holding gate must target Ethereum mainnet (eip155:1)")
    })

    test("allows gender gate in public v0 with valid self config", () => {
      expect(() =>
        assertCreateRequest(makeCreateBody({
          gate_rules: [{
            scope: "membership",
            gate_family: "identity_proof",
            gate_type: "gender",
            proof_requirements: [{ proof_type: "gender", accepted_providers: ["self"], config: { required_value: "M" } }],
          }],
        }), { ageOver18Verified: false }),
      ).not.toThrow()
    })

    test("rejects gender gate without valid required_value", () => {
      expect(() =>
        assertCreateRequest(makeCreateBody({
          gate_rules: [{
            scope: "membership",
            gate_family: "identity_proof",
            gate_type: "gender",
            proof_requirements: [{ proof_type: "gender", accepted_providers: ["self"], config: { required_value: "male" } }],
          }],
        }), { ageOver18Verified: false }),
      ).toThrow("gender gate allowed values must be M or F")
    })

    test("rejects post_ephemeral anonymous scope in v0", () => {
      expect(() =>
        assertCreateRequest(makeCreateBody({
          allow_anonymous_identity: true,
          anonymous_identity_scope: "post_ephemeral",
        }), { ageOver18Verified: false }),
      ).toThrow()
    })

    test("rejects namespace without namespace_verification", () => {
      expect(() =>
        assertCreateRequest(makeCreateBody({ namespace: {} as any }), { ageOver18Verified: false }),
      ).toThrow()
    })
  })
})
