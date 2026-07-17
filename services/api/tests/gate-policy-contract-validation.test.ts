import { afterEach, describe, expect, test } from "bun:test"
import { HttpError } from "../src/lib/errors"
import { setErc721ContractSupportCheckerForTests } from "../src/lib/communities/community-token-gates"
import { setAssetBalanceReaderForTests } from "../src/lib/communities/community-asset-balance"
import { assertGatePolicyContractsValid } from "../src/lib/communities/membership/gate-policy-contract-validation"
import type { GatePolicy } from "../src/lib/communities/membership/gate-types"
import type { Env } from "../src/env"

const erc721Policy: GatePolicy = {
  version: 1,
  expression: {
    op: "gate",
    gate: {
      type: "erc721_holding",
      chain_namespace: "eip155:1",
      contract_address: "0x1111111111111111111111111111111111111111",
    },
  },
}

function assetBalancePolicy(assetId: string): GatePolicy {
  return {
    version: 1,
    expression: {
      op: "gate",
      gate: { type: "asset_balance", asset_id: assetId, min_amount_atomic: "1000000" },
    },
  }
}

afterEach(() => {
  setErc721ContractSupportCheckerForTests(null)
  setAssetBalanceReaderForTests(null)
})

describe("gate policy contract validation", () => {
  test("accepts ERC-721 holding gates when the contract supports ERC-721", async () => {
    const checkedContracts: string[] = []
    setErc721ContractSupportCheckerForTests(async ({ contractAddress }) => {
      checkedContracts.push(contractAddress)
      return true
    })

    await expect(assertGatePolicyContractsValid({
      env: {} as Env,
      policy: erc721Policy,
    })).resolves.toBeUndefined()

    expect(checkedContracts).toEqual(["0x1111111111111111111111111111111111111111"])
  })

  test("rejects ERC-721 holding gates when the contract does not support ERC-721", async () => {
    setErc721ContractSupportCheckerForTests(async () => false)

    await expect(assertGatePolicyContractsValid({
      env: {} as Env,
      policy: erc721Policy,
    })).rejects.toMatchObject({
      code: "eligibility_failed",
      message: "erc721_holding gate contract must support ERC-721",
      status: 403,
    } satisfies Partial<HttpError>)
  })

  test("fails closed when ERC-721 contract validation is unavailable", async () => {
    await expect(assertGatePolicyContractsValid({
      env: {} as Env,
      policy: erc721Policy,
    })).rejects.toMatchObject({
      code: "eligibility_failed",
      message: "erc721_holding contract validation is temporarily unavailable. Check RPC availability and try again.",
      status: 403,
    } satisfies Partial<HttpError>)
  })

  test("accepts an asset balance gate when the asset's chain transport is configured", async () => {
    await expect(assertGatePolicyContractsValid({
      env: { BASE_MAINNET_RPC_URL: "https://base.example" } as Env,
      policy: assetBalancePolicy("eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"),
    })).resolves.toBeUndefined()
  })

  test("rejects an asset balance gate whose chain transport is not configured", async () => {
    // Without this the policy saves and then denies every member forever.
    await expect(assertGatePolicyContractsValid({
      env: { ETHEREUM_RPC_URL: "https://eth.example" } as Env,
      policy: assetBalancePolicy("eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"),
    })).rejects.toMatchObject({
      code: "eligibility_failed",
      message: "asset_balance gate for USDC on Base cannot be evaluated here. Choose an asset from the supported asset catalog.",
      status: 403,
    } satisfies Partial<HttpError>)
  })

  test("validates asset balance transport without making a balance request", async () => {
    // Authoring must not depend on provider liveness, or vendor downtime
    // becomes an authoring outage. A configured transport is enough because the
    // trusted registry already fixes the contract and standard.
    let balanceReaderCalls = 0
    setAssetBalanceReaderForTests(async () => {
      balanceReaderCalls += 1
      return 0n
    })

    await expect(assertGatePolicyContractsValid({
      env: { ETHEREUM_RPC_URL: "https://eth.example" } as Env,
      policy: assetBalancePolicy("eip155:1/slip44:60"),
    })).resolves.toBeUndefined()

    expect(balanceReaderCalls).toBe(0)
  })
})
