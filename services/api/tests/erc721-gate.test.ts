import { afterEach, describe, expect, test } from "bun:test"
import { buildMembershipGateSummary, evaluateMembershipGateRules } from "../src/lib/communities/membership/gates"
import { setErc721OwnershipCheckerForTests } from "../src/lib/communities/community-token-gates"
import {
  clearErc721InventoryMatchCacheForTests,
  evaluateErc721InventoryMatch,
  listCourtyardWalletInventoryGroups,
  normalizeInventoryMetadata,
  setErc721InventoryMatcherForTests,
} from "../src/lib/communities/community-token-inventory-gates"
import { buildDefaultVerificationCapabilities } from "../src/lib/verification/verification-capabilities"
import type { User, WalletAttachmentSummary } from "../src/types"
import { withMockedFetch } from "./helpers"

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

function makeCourtyardInventoryRule(config: Record<string, unknown> = {}, chainNamespace = "eip155:137"): CommunityGateRuleRow {
  const contractAddress = chainNamespace === "eip155:1"
    ? "0xd4ac3CE8e1E14CD60666D49AC34Ff2d2937cF6FA"
    : "0x251BE3A17Af4892035C37ebf5890F4a4D889dcAD"
  return {
    gate_rule_id: "gr_inventory",
    scope: "membership",
    gate_family: "token_holding",
    gate_type: "erc721_inventory_match",
    proof_requirements_json: null,
    chain_namespace: chainNamespace,
    gate_config_json: JSON.stringify({
      contract_address: contractAddress,
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
    wallet_attachment: "wal_eth",
    chain_namespace: "eip155:1",
    wallet_address: "0x2222222222222222222222222222222222222222",
    is_primary: true,
  },
  {
    wallet_attachment: "wal_polygon",
    chain_namespace: "eip155:137",
    wallet_address: "0x3333333333333333333333333333333333333333",
    is_primary: false,
  },
]

const originalConsoleWarn = console.warn
const originalConsoleError = console.error

afterEach(() => {
  setErc721OwnershipCheckerForTests(null)
  setErc721InventoryMatcherForTests(null)
  clearErc721InventoryMatchCacheForTests()
  console.warn = originalConsoleWarn
  console.error = originalConsoleError
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

  test("distinguishes missing Ethereum RPC configuration from provider outages", async () => {
    const operatorErrors: unknown[][] = []
    console.error = (...args: unknown[]) => operatorErrors.push(args)
    const result = await evaluateMembershipGateRules({
      env: {},
      rules: [makeErc721Rule("0x1111111111111111111111111111111111111111")],
      user: makeUser(),
      walletAttachments,
    })

    expect(result.satisfied).toBe(false)
    expect(result.mismatchReasons).toContain("ethereum_rpc_not_configured")
    expect(result.mismatchReasons).not.toContain("erc721_holding_required")
    expect(operatorErrors).toHaveLength(1)
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

  test("builds erc721 inventory match summary from canonical match config", () => {
    const summary = buildMembershipGateSummary(makeCourtyardInventoryRule({
      asset_filter: undefined,
      match: {
        category: "watch",
        brand: "Rolex",
        model: "Submariner",
        reference: "124060",
      },
    }))
    expect(summary.gate_type).toBe("erc721_inventory_match")
    expect(summary.inventory_provider).toBe("courtyard")
    expect(summary.min_quantity).toBe(3)
    expect(summary.asset_category).toBe("watch")
    expect(summary.asset_filter_label).toBe("rolex submariner 124060")
  })

  test("normalizes Alchemy/OpenSea-style metadata into Courtyard inventory facts", () => {
    const facts = normalizeInventoryMetadata({
      collection: "Courtyard Watches",
      name: "Rolex Submariner No Date",
      attributes: [
        { trait_type: "Brand", value: "Rolex" },
        { trait_type: "Model", value: "Submariner" },
        { trait_type: "Reference", value: "124060" },
        { trait_type: "Condition", value: "Unworn" },
      ],
    })

    expect(facts).toEqual({
      category: "watch",
      franchise: null,
      subject: null,
      brand: "rolex",
      model: "submariner",
      reference: "124060",
      set: null,
      year: null,
      grader: null,
      grade: null,
      condition: "unworn",
    })
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

  test("evaluates Ethereum Courtyard inventory gates against Ethereum wallets", async () => {
    setErc721InventoryMatcherForTests(async ({ walletAddresses, config }) => {
      expect(config.chainNamespace).toBe("eip155:1")
      expect(config.contractAddress.toLowerCase()).toBe("0xd4ac3ce8e1e14cd60666d49ac34ff2d2937cf6fa")
      expect(walletAddresses).toEqual([
        "0x2222222222222222222222222222222222222222",
        "0x3333333333333333333333333333333333333333",
      ])
      return { matchedQuantity: 1 }
    })

    const result = await evaluateMembershipGateRules({
      env: {},
      rules: [makeCourtyardInventoryRule({
        min_quantity: 1,
        match: { category: "watch", brand: "Rolex" },
      }, "eip155:1")],
      user: makeUser(),
      walletAttachments,
    })

    expect(result.satisfied).toBe(true)
    expect(result.mismatchReasons).toEqual([])
  })

  test("evaluates Polygon Courtyard inventory gates against attached EVM wallets", async () => {
    setErc721InventoryMatcherForTests(async ({ walletAddresses, config }) => {
      expect(config.chainNamespace).toBe("eip155:137")
      expect(config.contractAddress.toLowerCase()).toBe("0x251be3a17af4892035c37ebf5890f4a4d889dcad")
      expect(walletAddresses).toEqual([
        "0x2222222222222222222222222222222222222222",
        "0x3333333333333333333333333333333333333333",
      ])
      return { matchedQuantity: 1 }
    })

    const result = await evaluateMembershipGateRules({
      env: {},
      rules: [makeCourtyardInventoryRule({
        contract_address: "0x251BE3A17Af4892035C37ebf5890F4a4D889dcAD",
        min_quantity: 1,
        match: { category: "watch", brand: "Rolex" },
      }, "eip155:137")],
      user: makeUser(),
      walletAttachments,
    })

    expect(result.satisfied).toBe(true)
    expect(result.mismatchReasons).toEqual([])
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

  test("matches Courtyard inventory when a facet value is in an allowlist", async () => {
    await withMockedFetch(() => async () => new Response(JSON.stringify({
      total: 1,
      assets: [{
        chain: "polygon",
        collection: "Graded Cards",
        contract: "0x251BE3A17Af4892035C37ebf5890F4a4D889dcAD",
        owner: { address: "0x3333333333333333333333333333333333333333" },
        title: "Charizard V",
        token_id: "charizard-token",
        attributes: [
          { name: "Category", value: "Pokemon" },
          { name: "Title/Subject", value: "Charizard V" },
        ],
      }],
    })) as Response, async () => {
      const result = await evaluateMembershipGateRules({
        env: { COURTYARD_INVENTORY_CACHE_TTL_MS: "0" },
        rules: [makeCourtyardInventoryRule({
          min_quantity: 1,
          asset_filter: undefined,
          match: {
            category: "trading_card",
            subject: ["Gengar", "Charizard"],
          },
        })],
        user: makeUser(),
        walletAttachments,
      })

      expect(result.satisfied).toBe(true)
      expect(result.mismatchReasons).toEqual([])
    })
  })

  test("does not match Courtyard inventory when no allowlist value matches", async () => {
    await withMockedFetch(() => async () => new Response(JSON.stringify({
      total: 1,
      assets: [{
        chain: "polygon",
        collection: "Graded Cards",
        contract: "0x251BE3A17Af4892035C37ebf5890F4a4D889dcAD",
        owner: { address: "0x3333333333333333333333333333333333333333" },
        title: "Charizard V",
        token_id: "charizard-token",
        attributes: [
          { name: "Category", value: "Pokemon" },
          { name: "Title/Subject", value: "Charizard V" },
        ],
      }],
    })) as Response, async () => {
      const result = await evaluateMembershipGateRules({
        env: { COURTYARD_INVENTORY_CACHE_TTL_MS: "0" },
        rules: [makeCourtyardInventoryRule({
          min_quantity: 1,
          asset_filter: undefined,
          match: {
            category: "trading_card",
            subject: ["Gengar", "Pikachu"],
          },
        })],
        user: makeUser(),
        walletAttachments,
      })

      expect(result.satisfied).toBe(false)
      expect(result.mismatchReasons).toContain("erc721_inventory_match_required")
    })
  })

  test("counts any matching allowlist value toward min_quantity", async () => {
    await withMockedFetch(() => async () => new Response(JSON.stringify({
      total: 2,
      assets: [
        {
          chain: "polygon",
          collection: "Graded Cards",
          contract: "0x251BE3A17Af4892035C37ebf5890F4a4D889dcAD",
          owner: { address: "0x3333333333333333333333333333333333333333" },
          title: "Charizard V",
          token_id: "charizard-token",
          attributes: [
            { name: "Category", value: "Pokemon" },
            { name: "Title/Subject", value: "Charizard V" },
          ],
        },
        {
          chain: "polygon",
          collection: "Graded Cards",
          contract: "0x251BE3A17Af4892035C37ebf5890F4a4D889dcAD",
          owner: { address: "0x3333333333333333333333333333333333333333" },
          title: "Gengar V",
          token_id: "gengar-token",
          attributes: [
            { name: "Category", value: "Pokemon" },
            { name: "Title/Subject", value: "Gengar V" },
          ],
        },
      ],
    })) as Response, async () => {
      const result = await evaluateMembershipGateRules({
        env: { COURTYARD_INVENTORY_CACHE_TTL_MS: "0" },
        rules: [makeCourtyardInventoryRule({
          min_quantity: 2,
          asset_filter: undefined,
          match: {
            category: "trading_card",
            subject: ["Gengar", "Charizard"],
          },
        })],
        user: makeUser(),
        walletAttachments,
      })

      expect(result.satisfied).toBe(true)
      expect(result.mismatchReasons).toEqual([])
    })
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

  test("fails closed and logs when the inventory provider throws", async () => {
    const warnCalls: unknown[][] = []
    console.warn = (...args: unknown[]) => {
      warnCalls.push(args)
    }
    setErc721InventoryMatcherForTests(async () => {
      throw new Error("courtyard down")
    })

    const result = await evaluateMembershipGateRules({
      env: {},
      rules: [makeCourtyardInventoryRule()],
      user: makeUser(),
      walletAttachments,
    })

    expect(result.satisfied).toBe(false)
    expect(result.mismatchReasons).toContain("token_inventory_unavailable")
    expect(warnCalls.length).toBe(1)
    expect(String(warnCalls[0]?.[0])).toContain("courtyard-inventory-gate")
    expect(warnCalls[0]?.[1]).toEqual({
      error_name: "Error",
      error_message: "courtyard down",
      wallet_count: 2,
      contract_address: "0x251BE3A17Af4892035C37ebf5890F4a4D889dcAD",
    })
  })

  test("fails closed when the Courtyard ownership fetch times out", async () => {
    const warnCalls: unknown[][] = []
    let fetchSawAbortSignal = false
    console.warn = (...args: unknown[]) => {
      warnCalls.push(args)
    }

    await withMockedFetch(() => async (_requestInput: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const signal = init?.signal
      fetchSawAbortSignal = signal != null
      return await new Promise<Response>((_resolve, reject) => {
        const fallbackTimeout = setTimeout(() => reject(new Error("fetch did not abort")), 200)
        signal?.addEventListener("abort", () => {
          clearTimeout(fallbackTimeout)
          reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"))
        }, { once: true })
      })
    }, async () => {
      const result = await evaluateMembershipGateRules({
        env: {
          COURTYARD_INVENTORY_CACHE_TTL_MS: "0",
          COURTYARD_OWNERSHIP_FETCH_TIMEOUT_MS: "1",
        },
        rules: [makeCourtyardInventoryRule()],
        user: makeUser(),
        walletAttachments,
      })

      expect(result.satisfied).toBe(false)
      expect(result.mismatchReasons).toContain("token_inventory_unavailable")
    })

    expect(fetchSawAbortSignal).toBe(true)
    expect(warnCalls.length).toBe(1)
    expect(String(warnCalls[0]?.[0])).toContain("courtyard-inventory-gate")
    expect(warnCalls[0]?.[1]).toMatchObject({
      error_message: "Courtyard ownership lookup timed out",
      wallet_count: 2,
      contract_address: "0x251BE3A17Af4892035C37ebf5890F4a4D889dcAD",
    })
  })

  test("normalizes TCG metadata without relying on the collection name containing card", async () => {
    await withMockedFetch(() => async () => new Response(JSON.stringify({
      total: 1,
      assets: [{
        chain: "polygon",
        collection: "Pokemon TCG",
        contract: "0x251BE3A17Af4892035C37ebf5890F4a4D889dcAD",
        owner: { address: "0x3333333333333333333333333333333333333333" },
        title: "Charizard V",
        token_id: "1",
        attributes: [
          { name: "Category", value: "Pokemon" },
          { name: "Title/Subject", value: "Charizard V" },
        ],
      }],
    })) as Response, async () => {
      const result = await evaluateMembershipGateRules({
        env: { COURTYARD_INVENTORY_CACHE_TTL_MS: "0" },
        rules: [makeCourtyardInventoryRule({ min_quantity: 1 })],
        user: makeUser(),
        walletAttachments,
      })

      expect(result.satisfied).toBe(true)
      expect(result.mismatchReasons).toEqual([])
    })
  })

  test("evaluates canonical match config against normalized watch metadata", async () => {
    await withMockedFetch(() => async () => new Response(JSON.stringify({
      total: 1,
      assets: [{
        chain: "polygon",
        collection: "Watches",
        contract: "0x251BE3A17Af4892035C37ebf5890F4a4D889dcAD",
        owner: { address: "0x3333333333333333333333333333333333333333" },
        title: "Rolex Submariner No Date",
        token_id: "watch-token",
        attributes: [
          { name: "Brand", value: "Rolex" },
          { name: "Model", value: "Submariner" },
          { name: "Reference", value: "124060" },
          { name: "Condition", value: "Unworn" },
        ],
      }],
    })) as Response, async () => {
      const result = await evaluateMembershipGateRules({
        env: { COURTYARD_INVENTORY_CACHE_TTL_MS: "0" },
        rules: [makeCourtyardInventoryRule({
          min_quantity: 1,
          asset_filter: undefined,
          match: {
            category: "watch",
            brand: "Rolex",
            model: "Submariner",
            reference: "124060",
          },
        })],
        user: makeUser(),
        walletAttachments,
      })

      expect(result.satisfied).toBe(true)
      expect(result.mismatchReasons).toEqual([])
    })
  })

  test("deduplicates the same Courtyard token across Polygon wallets", async () => {
    let fetchCount = 0
    await withMockedFetch(() => async () => {
      fetchCount += 1
      return new Response(JSON.stringify({
        total: 1,
        assets: [{
          chain: "polygon",
          collection: "Graded Cards",
          contract: "0x251BE3A17Af4892035C37ebf5890F4a4D889dcAD",
          owner: { address: "0x3333333333333333333333333333333333333333" },
          title: "Charizard V",
          token_id: "shared-token",
          attributes: [
            { name: "Category", value: "Pokemon" },
            { name: "Title/Subject", value: "Charizard V" },
          ],
        }],
      })) as Response
    }, async () => {
      const result = await evaluateMembershipGateRules({
        env: { COURTYARD_INVENTORY_CACHE_TTL_MS: "0" },
        rules: [makeCourtyardInventoryRule({ min_quantity: 2 })],
        user: makeUser(),
        walletAttachments: [
          ...walletAttachments,
          {
            wallet_attachment: "wal_polygon_2",
            chain_namespace: "eip155:137",
            wallet_address: "0x4444444444444444444444444444444444444444",
            is_primary: false,
          },
        ],
      })

      expect(result.satisfied).toBe(false)
      expect(result.mismatchReasons).toContain("erc721_inventory_match_required")
    })
    expect(fetchCount).toBe(3)
  })

  test("caches successful Courtyard inventory matches briefly", async () => {
    let fetchCount = 0
    const config = {
      chainNamespace: "eip155:137" as const,
      contractAddress: "0x251BE3A17Af4892035C37ebf5890F4a4D889dcAD",
      inventoryProvider: "courtyard" as const,
      minQuantity: 1,
      assetFilter: { category: "trading_card" as const, franchise: "pokemon", subject: "charizard" },
    }
    await withMockedFetch(() => async () => {
      fetchCount += 1
      return new Response(JSON.stringify({
        total: 1,
        assets: [{
          chain: "polygon",
          collection: "Graded Cards",
          contract: "0x251BE3A17Af4892035C37ebf5890F4a4D889dcAD",
          owner: { address: "0x3333333333333333333333333333333333333333" },
          title: "Charizard V",
          token_id: "cached-token",
          attributes: [
            { name: "Category", value: "Pokemon" },
            { name: "Title/Subject", value: "Charizard V" },
          ],
        }],
      })) as Response
    }, async () => {
      const first = await evaluateErc721InventoryMatch({ env: {}, walletAttachments, config })
      const second = await evaluateErc721InventoryMatch({ env: {}, walletAttachments, config })

      expect(first).toEqual({ matchedQuantity: 1, unavailable: false })
      expect(second).toEqual({ matchedQuantity: 1, unavailable: false })
    })
    expect(fetchCount).toBe(1)
  })

  test("groups Courtyard wallet inventory into authorable gate facets", async () => {
    await withMockedFetch(() => async () => new Response(JSON.stringify({
      total: 2,
      assets: [
        {
          chain: "polygon",
          collection: "Graded Cards",
          contract: "0x251BE3A17Af4892035C37ebf5890F4a4D889dcAD",
          owner: { address: "0x3333333333333333333333333333333333333333" },
          title: "Charizard V",
          token_id: "charizard-1",
          attributes: [
            { name: "Category", value: "Pokemon" },
            { name: "Title/Subject", value: "Charizard V" },
            { name: "Set", value: "Champion's Path" },
            { name: "Grader", value: "PSA" },
          ],
        },
        {
          chain: "polygon",
          collection: "Graded Cards",
          contract: "0x251BE3A17Af4892035C37ebf5890F4a4D889dcAD",
          owner: { address: "0x3333333333333333333333333333333333333333" },
          title: "Charizard V",
          token_id: "charizard-2",
          attributes: [
            { name: "Category", value: "Pokemon" },
            { name: "Title/Subject", value: "Charizard V" },
            { name: "Set", value: "Champion's Path" },
            { name: "Grader", value: "PSA" },
          ],
        },
      ],
    })) as Response, async () => {
      const result = await listCourtyardWalletInventoryGroups({
        env: {},
        walletAttachments,
      })

      expect(result.unavailable).toBe(false)
      expect(result.groups).toEqual([{
        category: "trading_card",
        chain_namespace: "eip155:137",
        contract_address: "0x251BE3A17Af4892035C37ebf5890F4a4D889dcAD",
        franchise: "pokemon",
        subject: "charizard v",
        set: "champion's path",
        grader: "psa",
        display_label: "Pokemon Charizard V Champion's Path",
        display_detail: "2 in wallet",
        count: 2,
      }])
    })
  })

  test("caches successful Courtyard wallet inventory groups briefly", async () => {
    let fetchCount = 0
    await withMockedFetch(() => async () => {
      fetchCount += 1
      return new Response(JSON.stringify({
        total: 1,
        assets: [{
          chain: "polygon",
          collection: "Watches",
          contract: "0x251BE3A17Af4892035C37ebf5890F4a4D889dcAD",
          owner: { address: "0x3333333333333333333333333333333333333333" },
          title: "Rolex Submariner",
          token_id: "rolex-cache",
          attributes: [
            { name: "Brand", value: "Rolex" },
            { name: "Model", value: "Submariner" },
          ],
        }],
      })) as Response
    }, async () => {
      const first = await listCourtyardWalletInventoryGroups({
        env: {},
        walletAttachments,
      })
      const second = await listCourtyardWalletInventoryGroups({
        env: {},
        walletAttachments,
      })

      expect(first).toEqual(second)
      expect(first.unavailable).toBe(false)
      expect(first.groups).toHaveLength(1)
    })
    expect(fetchCount).toBe(2)
  })

  test("caps Courtyard wallet inventory pagination per wallet", async () => {
    const seenUrls: string[] = []
    await withMockedFetch(() => async (input) => {
      seenUrls.push(String(input))
      return new Response(JSON.stringify({
        total: 3,
        assets: [
          {
            chain: "polygon",
            collection: "Watches",
            contract: "0x251BE3A17Af4892035C37ebf5890F4a4D889dcAD",
            owner: { address: "0x3333333333333333333333333333333333333333" },
            title: "Rolex Submariner",
            token_id: "rolex-capped-1",
            attributes: [
              { name: "Brand", value: "Rolex" },
              { name: "Model", value: "Submariner" },
            ],
          },
          {
            chain: "polygon",
            collection: "Watches",
            contract: "0x251BE3A17Af4892035C37ebf5890F4a4D889dcAD",
            owner: { address: "0x3333333333333333333333333333333333333333" },
            title: "Rolex Daytona",
            token_id: "rolex-capped-2",
            attributes: [
              { name: "Brand", value: "Rolex" },
              { name: "Model", value: "Daytona" },
            ],
          },
        ],
      })) as Response
    }, async () => {
      const result = await listCourtyardWalletInventoryGroups({
        env: { COURTYARD_OWNERSHIP_MAX_ASSETS_PER_WALLET: "2" },
        walletAttachments,
      })

      expect(result.unavailable).toBe(false)
      expect(result.groups).toHaveLength(2)
    })

    expect(seenUrls).toHaveLength(2)
    for (const seenUrl of seenUrls) {
      const url = new URL(seenUrl)
      expect(url.searchParams.get("limit")).toBe("2")
      expect(url.searchParams.get("offset")).toBe("0")
    }
  })

  test("caps Courtyard gate evaluation pagination per wallet", async () => {
    const rule = makeCourtyardInventoryRule({ min_quantity: 1 })
    const seenUrls: string[] = []
    await withMockedFetch(() => async (input) => {
      seenUrls.push(String(input))
      return new Response(JSON.stringify({
        total: 2,
        assets: [{
          chain: "polygon",
          collection: "Graded Cards",
          contract: "0x251BE3A17Af4892035C37ebf5890F4a4D889dcAD",
          owner: { address: "0x3333333333333333333333333333333333333333" },
          title: "Pikachu",
          token_id: "non-match-before-cap",
          attributes: [
            { name: "Category", value: "Pokemon" },
            { name: "Title/Subject", value: "Pikachu" },
          ],
        }],
      })) as Response
    }, async () => {
      const evaluation = await evaluateMembershipGateRules({
        env: { COURTYARD_OWNERSHIP_MAX_ASSETS_PER_WALLET: "1" },
        user: makeUser(),
        walletAttachments,
        rules: [rule],
      })

      expect(evaluation.satisfied).toBe(false)
      expect(evaluation.mismatchReasons).toContain("erc721_inventory_match_required")
    })

    expect(seenUrls).toHaveLength(2)
    for (const seenUrl of seenUrls) {
      const url = new URL(seenUrl)
      expect(url.searchParams.get("limit")).toBe("1")
      expect(url.searchParams.get("offset")).toBe("0")
    }
  })

  test("bounds the Courtyard inventory match cache", async () => {
    let matcherCalls = 0
    setErc721InventoryMatcherForTests(async () => {
      matcherCalls += 1
      return { matchedQuantity: 1 }
    })
    const config = {
      chainNamespace: "eip155:137" as const,
      contractAddress: "0x251BE3A17Af4892035C37ebf5890F4a4D889dcAD",
      inventoryProvider: "courtyard" as const,
      minQuantity: 1,
      assetFilter: { category: "watch" as const, brand: "rolex" },
    }

    for (let index = 0; index < 1_001; index += 1) {
      const suffix = index.toString(16).padStart(40, "0")
      await evaluateErc721InventoryMatch({
        env: {},
        walletAttachments: [{
          wallet_attachment: `wal_${index}`,
          chain_namespace: "eip155:137",
          wallet_address: `0x${suffix}`,
          is_primary: false,
        }],
        config,
      })
    }

    await evaluateErc721InventoryMatch({
      env: {},
      walletAttachments: [{
        wallet_attachment: "wal_0",
        chain_namespace: "eip155:137",
        wallet_address: "0x0000000000000000000000000000000000000000",
        is_primary: false,
      }],
      config,
    })

    expect(matcherCalls).toBe(1_002)
  })
})
