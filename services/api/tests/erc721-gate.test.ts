import { afterEach, describe, expect, test } from "bun:test"
import { buildMembershipGateSummary, evaluateMembershipGateRules } from "../src/lib/communities/community-membership-store"
import { setErc721OwnershipCheckerForTests } from "../src/lib/communities/community-token-gates"
import { setErc721InventoryMatcherForTests } from "../src/lib/communities/community-token-inventory-gates"
import { buildDefaultVerificationCapabilities } from "../src/lib/verification/verification-capabilities"
import type { User, WalletAttachmentSummary } from "../src/types"

type CommunityGateRuleRow = {
  gate_rule_id: string
  scope: "membership" | "viewer" | "posting"
  gate_family: "identity_proof" | "token_holding"
  gate_type: string
  proof_requirements_json: string | null
  chain_namespace: string | null
  gate_config_json: string | null
  status: "active" | "disabled"
}

function makeErc721Rule(contractAddress: string): CommunityGateRuleRow {
  return {
    gate_rule_id: "gr_erc721",
    scope: "membership",
    gate_family: "token_holding",
    gate_type: "erc721_holding",
    proof_requirements_json: null,
    chain_namespace: "eip155:1",
    gate_config_json: JSON.stringify({ contract_address: contractAddress }),
    status: "active",
  }
}

function makeCourtyardInventoryRule(config: Record<string, unknown> = {}): CommunityGateRuleRow {
  return {
    gate_rule_id: "gr_inventory",
    scope: "membership",
    gate_family: "token_holding",
    gate_type: "erc721_inventory_match",
    proof_requirements_json: null,
    chain_namespace: "eip155:137",
    gate_config_json: JSON.stringify({
      contract_address: "0x251BE3A17Af4892035C37ebf5890F4a4D889dcAD",
      inventory_provider: "courtyard",
      min_quantity: 3,
      asset_filter: { category: "trading_card", franchise: "pokemon", subject: "charizard" },
      ...config,
    }),
    status: "active",
  }
}

function makeUser(): User {
  const caps = buildDefaultVerificationCapabilities()
  return {
    user_id: "usr_test",
    verification_state: "verified",
    verification_capabilities: {
      ...caps,
      unique_human: {
        ...caps.unique_human,
        state: "verified",
        provider: "very",
      },
    },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
}

const walletAttachments: WalletAttachmentSummary[] = [
  {
    wallet_attachment_id: "wal_eth",
    chain_namespace: "eip155:1",
    wallet_address: "0x2222222222222222222222222222222222222222",
    is_primary: true,
  },
  {
    wallet_attachment_id: "wal_polygon",
    chain_namespace: "eip155:137",
    wallet_address: "0x3333333333333333333333333333333333333333",
    is_primary: false,
  },
]

afterEach(() => {
  setErc721OwnershipCheckerForTests(null)
  setErc721InventoryMatcherForTests(null)
})

describe("erc721 gate evaluation", () => {
  test("builds erc721 summary with contract metadata", () => {
    const summary = buildMembershipGateSummary(makeErc721Rule("0x1111111111111111111111111111111111111111"))
    expect(summary.gate_type).toBe("erc721_holding")
    expect(summary.chain_namespace).toBe("eip155:1")
    expect(summary.contract_address).toBe("0x1111111111111111111111111111111111111111")
  })

  test("returns erc721_holding_required when no attached wallet holds the collection", async () => {
    setErc721OwnershipCheckerForTests(async () => false)

    const result = await evaluateMembershipGateRules({
      env: { ETHEREUM_RPC_URL: "https://example.invalid" },
      rules: [makeErc721Rule("0x1111111111111111111111111111111111111111")],
      user: makeUser(),
      walletAttachments,
    })

    expect(result.satisfied).toBe(false)
    expect(result.mismatchReasons).toContain("erc721_holding_required")
  })

  test("returns satisfied when an attached wallet holds the collection", async () => {
    setErc721OwnershipCheckerForTests(async ({ walletAddress }) => (
      walletAddress === "0x2222222222222222222222222222222222222222"
    ))

    const result = await evaluateMembershipGateRules({
      env: { ETHEREUM_RPC_URL: "https://example.invalid" },
      rules: [makeErc721Rule("0x1111111111111111111111111111111111111111")],
      user: makeUser(),
      walletAttachments,
    })

    expect(result.satisfied).toBe(true)
    expect(result.mismatchReasons).toEqual([])
  })

  test("builds erc721 inventory match summary with public metadata", () => {
    const summary = buildMembershipGateSummary(makeCourtyardInventoryRule())
    expect(summary.gate_type).toBe("erc721_inventory_match")
    expect(summary.chain_namespace).toBe("eip155:137")
    expect(summary.contract_address).toBe("0x251BE3A17Af4892035C37ebf5890F4a4D889dcAD")
    expect(summary.inventory_provider).toBe("courtyard")
    expect(summary.min_quantity).toBe(3)
    expect(summary.asset_category).toBe("trading_card")
    expect(summary.asset_filter_label).toBe("pokemon charizard")
  })

  test("returns erc721_inventory_match_required when attached wallets do not hold enough matching assets", async () => {
    setErc721InventoryMatcherForTests(async ({ walletAddresses }) => {
      expect(walletAddresses).toEqual([
        "0x2222222222222222222222222222222222222222",
        "0x3333333333333333333333333333333333333333",
      ])
      return { matchedQuantity: 2 }
    })

    const result = await evaluateMembershipGateRules({
      env: {},
      rules: [makeCourtyardInventoryRule()],
      user: makeUser(),
      walletAttachments,
    })

    expect(result.satisfied).toBe(false)
    expect(result.missingCapabilities).toEqual([])
    expect(result.mismatchReasons).toContain("erc721_inventory_match_required")
  })

  test("returns satisfied when attached wallets aggregate enough matching inventory", async () => {
    setErc721InventoryMatcherForTests(async () => ({ matchedQuantity: 3 }))

    const result = await evaluateMembershipGateRules({
      env: {},
      rules: [makeCourtyardInventoryRule()],
      user: makeUser(),
      walletAttachments,
    })

    expect(result.satisfied).toBe(true)
    expect(result.mismatchReasons).toEqual([])
  })

  test("fails closed when the inventory provider is unavailable", async () => {
    setErc721InventoryMatcherForTests(async () => ({ matchedQuantity: 0, unavailable: true }))

    const result = await evaluateMembershipGateRules({
      env: {},
      rules: [makeCourtyardInventoryRule()],
      user: makeUser(),
      walletAttachments,
    })

    expect(result.satisfied).toBe(false)
    expect(result.mismatchReasons).toContain("token_inventory_unavailable")
  })
})
