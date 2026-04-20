import { afterEach, describe, expect, test } from "bun:test"
import { buildMembershipGateSummary, evaluateMembershipGateRules } from "../src/lib/communities/community-membership-store"
import { setErc721OwnershipCheckerForTests } from "../src/lib/communities/community-token-gates"
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
]

afterEach(() => {
  setErc721OwnershipCheckerForTests(null)
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
})
