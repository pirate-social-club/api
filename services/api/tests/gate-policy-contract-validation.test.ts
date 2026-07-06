import { afterEach, describe, expect, test } from "bun:test"
import { HttpError } from "../src/lib/errors"
import { setErc721ContractSupportCheckerForTests } from "../src/lib/communities/community-token-gates"
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

afterEach(() => {
  setErc721ContractSupportCheckerForTests(null)
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
      message: "erc721_holding contract validation is unavailable",
      status: 403,
    } satisfies Partial<HttpError>)
  })
})
