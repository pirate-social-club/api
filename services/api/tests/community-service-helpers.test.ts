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

function makeCreateBody(overrides: Partial<CreateCommunityRequest> = {}): CreateCommunityRequest {
  return {
    display_name: "Test Community",
    handle_policy: { policy_template: "standard" },
    governance_mode: "centralized",
    membership_mode: "open",
    ...overrides,
  }
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

    test("rejects token_holding gate family in v0", () => {
      expect(() =>
        assertCreateRequest(makeCreateBody({
          gate_rules: [{ scope: "membership", gate_family: "token_holding", gate_type: "erc721_holding" }],
        }), { uniqueHumanVerified: true, ageOver18Verified: false }),
      ).toThrow()
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
