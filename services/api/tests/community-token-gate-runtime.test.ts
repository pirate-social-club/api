import { describe, expect, test } from "bun:test"

import { normalizeGateRuleInput } from "../src/lib/communities/community-gate-rule-normalization"
import {
  type CommunityGateRuleRow,
  satisfiesCommunityGateRules,
} from "../src/lib/communities/community-membership-store"
import { evaluateTokenHoldingGate } from "../src/lib/communities/community-token-gate-runtime"
import { buildDefaultVerificationCapabilities } from "../src/lib/verification/verification-capabilities"
import type { Env, User, WalletAttachmentSummary } from "../src/types"

function makeUser(): User {
  return {
    user_id: "usr_test",
    profile_id: "pro_test",
    primary_wallet_attachment_id: "wal_primary",
    verification_capabilities: buildDefaultVerificationCapabilities(),
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  } as User
}

function makeTokenRule(overrides: Partial<CommunityGateRuleRow> = {}): CommunityGateRuleRow {
  return {
    gate_rule_id: "gate_1",
    community_id: "cmt_1",
    scope: "membership",
    gate_family: "token_holding",
    gate_type: "erc721_holding",
    proof_requirements_json: null,
    chain_namespace: "eip155:1",
    gate_config_json: JSON.stringify({
      contract_address: "0x00000000000000000000000000000000000000AA",
    }),
    status: "active",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  }
}

describe("community token gate normalization", () => {
  test("normalizes ERC-721 gates with checksummed contract addresses", () => {
    const normalized = normalizeGateRuleInput({
      gate_family: "token_holding",
      gate_type: "erc721_holding",
      chain_namespace: "eip155:1",
      gate_config: {
        contract_address: "0x00000000000000000000000000000000000000aa",
      },
    })

    expect(normalized.chainNamespace).toBe("eip155:1")
    expect(normalized.proofRequirementsJson).toBeNull()
    expect(normalized.gateConfigJson).toBe(JSON.stringify({
      contract_address: "0x00000000000000000000000000000000000000AA",
    }))
  })

  test("requires token id and min balance for ERC-1155 gates", () => {
    expect(() => normalizeGateRuleInput({
      gate_family: "token_holding",
      gate_type: "erc1155_holding",
      chain_namespace: "eip155:137",
      gate_config: {
        contract_address: "0x00000000000000000000000000000000000000aa",
        token_id: "42",
      },
    })).toThrow("gate_config.min_balance must be an integer string")
  })

  test("normalizes numeric ERC-1155 config values to canonical strings", () => {
    const normalized = normalizeGateRuleInput({
      gate_family: "token_holding",
      gate_type: "erc1155_holding",
      chain_namespace: "eip155:137",
      gate_config: {
        contract_address: "0x00000000000000000000000000000000000000aa",
        token_id: 42,
        min_balance: 3,
      },
    })

    expect(normalized.gateConfigJson).toBe(JSON.stringify({
      contract_address: "0x00000000000000000000000000000000000000AA",
      token_id: "42",
      min_balance: "3",
    }))
  })
})

describe("community token gate evaluation", () => {
  test("passes when a matching-chain wallet holds an ERC-721 token", async () => {
    const wallets: WalletAttachmentSummary[] = [
      {
        wallet_attachment_id: "wal_1",
        chain_namespace: "eip155:1",
        wallet_address: "0x00000000000000000000000000000000000000bb",
        is_primary: true,
      },
    ]

    const passes = await evaluateTokenHoldingGate({
      env: {} as Env,
      rule: makeTokenRule(),
      gateConfig: {
        contract_address: "0x00000000000000000000000000000000000000AA",
      },
      wallets,
      readTokenOwnership: async () => 1n,
    })

    expect(passes).toBe(true)
  })

  test("fails when no wallet matches the configured chain namespace", async () => {
    const wallets: WalletAttachmentSummary[] = [
      {
        wallet_attachment_id: "wal_1",
        chain_namespace: "eip155:137",
        wallet_address: "0x00000000000000000000000000000000000000bb",
        is_primary: true,
      },
    ]

    const passes = await evaluateTokenHoldingGate({
      env: {} as Env,
      rule: makeTokenRule(),
      gateConfig: {
        contract_address: "0x00000000000000000000000000000000000000AA",
      },
      wallets,
      readTokenOwnership: async () => 1n,
    })

    expect(passes).toBe(false)
  })

  test("integrates with async gate evaluation and preserves AND semantics", async () => {
    const tokenRule = makeTokenRule()
    const identityRule = {
      ...makeTokenRule({
        gate_rule_id: "gate_2",
        gate_family: "identity_proof",
        gate_type: "unique_human",
        proof_requirements_json: JSON.stringify([{ proof_type: "unique_human" }]),
        gate_config_json: null,
        chain_namespace: null,
      }),
    }
    const user = makeUser()
    user.verification_capabilities.unique_human = {
      state: "verified",
      provider: "self",
      proof_type: "unique_human",
      mechanism: null,
      verified_at: "2026-01-01T00:00:00Z",
    }

    const passes = await satisfiesCommunityGateRules(
      [tokenRule, identityRule],
      {
        user,
        wallets: [
          {
            wallet_attachment_id: "wal_1",
            chain_namespace: "eip155:1",
            wallet_address: "0x00000000000000000000000000000000000000bb",
            is_primary: true,
          },
        ],
        tokenGateEvaluator: async () => true,
      },
    )

    expect(passes).toBe(true)
  })
})
