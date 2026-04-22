import { describe, expect, test } from "bun:test"
import {
  isExpired,
  isPendingCommunityDatabaseUrl,
  satisfiesBaselineJoinGate,
  getPrimaryWalletSnapshot,
  assertCreateRequest,
} from "../src/lib/communities/community-service"
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
      sanctions_clear: { state: "unverified", provider: null },
      wallet_score: { state: "unverified", provider: null, passing_score: null, score: null },
      ...overrides,
    },
    primary_wallet_attachment_id: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
}

function makeCreateBody(overrides: Record<string, unknown> = {}): CreateCommunityRequest {
  return {
    display_name: "Test Community",
    allow_anonymous_identity: false,
    handle_policy: { policy_template: "standard" },
    governance_mode: "centralized",
    membership_mode: "open",
    ...overrides,
  } as CreateCommunityRequest
}

describe("community-service helpers", () => {
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

  describe("isPendingCommunityDatabaseUrl", () => {
    test("detects libsql://pending- prefix", () => {
      expect(isPendingCommunityDatabaseUrl("libsql://pending-cmt_abc.invalid")).toBe(true)
    })

    test("detects .invalid suffix", () => {
      expect(isPendingCommunityDatabaseUrl("https://example.com/database.invalid")).toBe(true)
    })

    test("returns false for normal URLs", () => {
      expect(isPendingCommunityDatabaseUrl("libsql://my-db.turso.io")).toBe(false)
    })

    test("returns false for empty/null/undefined", () => {
      expect(isPendingCommunityDatabaseUrl("")).toBe(false)
      expect(isPendingCommunityDatabaseUrl(null)).toBe(false)
      expect(isPendingCommunityDatabaseUrl(undefined)).toBe(false)
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
        wallet_score: { state: "verified", provider: "passport", passing_score: true, score: 85 },
      })
      expect(satisfiesBaselineJoinGate(user)).toBe(true)
    })

    test("returns false when wallet_score is verified but not passing", () => {
      const user = makeTestUser({
        unique_human: { state: "unverified", provider: null },
        wallet_score: { state: "verified", provider: "passport", passing_score: false, score: 30 },
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
      { wallet_attachment_id: "wa_1", wallet_address: "0xaaa", is_primary: false },
      { wallet_attachment_id: "wa_2", wallet_address: "0xbbb", is_primary: true },
    ]

    test("returns the wallet matching primary_wallet_attachment_id", () => {
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
        { wallet_attachment_id: "wa_1", wallet_address: "0xaaa", is_primary: false },
      ]
      expect(getPrimaryWalletSnapshot(user, noPrimary)).toBe("0xaaa")
    })

    test("returns null when no attachments", () => {
      const user = { primary_wallet_attachment_id: null } as User
      expect(getPrimaryWalletSnapshot(user, [])).toBe(null)
    })
  })

  describe("assertCreateRequest", () => {
    test("passes for valid minimal request with unique_human verified", () => {
      expect(() =>
        assertCreateRequest(makeCreateBody(), { uniqueHumanVerified: true, ageOver18Verified: false }),
      ).not.toThrow()
    })

    test("rejects missing display_name", () => {
      expect(() =>
        assertCreateRequest(makeCreateBody({ display_name: "" }), { uniqueHumanVerified: true, ageOver18Verified: false }),
      ).toThrow()
    })

    test("rejects when unique_human is not verified", () => {
      expect(() =>
        assertCreateRequest(makeCreateBody(), { uniqueHumanVerified: false, ageOver18Verified: false }),
      ).toThrow()
    })

    test("rejects 18_plus age gate without age verification", () => {
      expect(() =>
        assertCreateRequest(makeCreateBody({ default_age_gate_policy: "18_plus" }), { uniqueHumanVerified: true, ageOver18Verified: false }),
      ).toThrow()
    })

    test("allows 18_plus age gate with age verification", () => {
      expect(() =>
        assertCreateRequest(makeCreateBody({ default_age_gate_policy: "18_plus" }), { uniqueHumanVerified: true, ageOver18Verified: true }),
      ).not.toThrow()
    })

    test("rejects donation_policy in v0", () => {
      expect(() =>
        assertCreateRequest(makeCreateBody({ donation_policy: { mode: "optional" } as any }), { uniqueHumanVerified: true, ageOver18Verified: false }),
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
        }), { uniqueHumanVerified: true, ageOver18Verified: false }),
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
        }), { uniqueHumanVerified: true, ageOver18Verified: false }),
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
        }), { uniqueHumanVerified: true, ageOver18Verified: false }),
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
        }), { uniqueHumanVerified: true, ageOver18Verified: false }),
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
        }), { uniqueHumanVerified: true, ageOver18Verified: false }),
      ).toThrow("Courtyard inventory gates require an allowlisted Courtyard contract")
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
        }), { uniqueHumanVerified: true, ageOver18Verified: false }),
      ).toThrow("ERC-721 inventory match has unsupported keys: regex")
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
        }), { uniqueHumanVerified: true, ageOver18Verified: false }),
      ).toThrow("ERC-721 inventory gates require min_quantity from 1 to 100")
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
        }), { uniqueHumanVerified: true, ageOver18Verified: false }),
      ).toThrow("ERC-721 inventory match must include category plus a supported matching field")
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
        }), { uniqueHumanVerified: true, ageOver18Verified: false }),
      ).toThrow("ERC-721 community gates must target Ethereum mainnet (eip155:1)")
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
        }), { uniqueHumanVerified: true, ageOver18Verified: false }),
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
        }), { uniqueHumanVerified: true, ageOver18Verified: false }),
      ).toThrow("Gender gate required_value must be either \"M\" or \"F\"")
    })

    test("rejects sanctions_clear gate in public v0", () => {
      expect(() =>
        assertCreateRequest(makeCreateBody({
          gate_rules: [{
            scope: "membership",
            gate_family: "identity_proof",
            gate_type: "sanctions_clear",
            proof_requirements: [{ proof_type: "sanctions_clear", accepted_providers: ["passport"] }],
          }],
        }), { uniqueHumanVerified: true, ageOver18Verified: false }),
      ).toThrow("Public v0 community creation does not support sanctions_clear gates")
    })

    test("rejects post_ephemeral anonymous scope in v0", () => {
      expect(() =>
        assertCreateRequest(makeCreateBody({
          allow_anonymous_identity: true,
          anonymous_identity_scope: "post_ephemeral",
        }), { uniqueHumanVerified: true, ageOver18Verified: false }),
      ).toThrow()
    })

    test("rejects namespace without namespace_verification_id", () => {
      expect(() =>
        assertCreateRequest(makeCreateBody({ namespace: {} as any }), { uniqueHumanVerified: true, ageOver18Verified: false }),
      ).toThrow()
    })
  })
})
