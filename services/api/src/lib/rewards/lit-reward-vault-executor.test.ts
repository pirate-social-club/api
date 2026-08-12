import { describe, expect, test } from "bun:test"

import { LitChipotleError, type LitActionExecution } from "./lit-chipotle-client"
import {
  createLitRewardVaultExecutor,
  createProductionLitRewardVaultExecutor,
} from "./lit-reward-vault-executor"
import type { RewardVaultActionRequest } from "./reward-vault-transaction"

const REQUEST: RewardVaultActionRequest = {
  method: "pay",
  operationId: "0x566277c126ff70156eceee8d4f46b24e0c251d46600efbabedf2caae037eef7e",
  recipient: "0x3000000000000000000000000000000000000003",
  amount: "12340000",
  deadline: "2000000000",
  policyVersion: "7",
  vaultAddress: "0x1000000000000000000000000000000000000001",
  signerAddress: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  chainId: 8453,
  nonce: 11,
  gas: {
    maxFeePerGas: "2000000000",
    maxPriorityFeePerGas: "1000000000",
    gasLimit: "140000",
  },
}

describe("createLitRewardVaultExecutor", () => {
  const PINNED_POLICY = { policyVersion: 7n, maxDeadlineSeconds: 300 }
  test.each([
    ["object", { signedTx: "0x1234" }],
    ["JSON string", JSON.stringify({ signedTx: "0xabcd" })],
  ])("accepts a signed transaction in a %s response", async (_label, response) => {
    const executions: LitActionExecution[] = []
    const executor = createLitRewardVaultExecutor({
      execute: async (execution) => {
        executions.push(execution)
        return response
      },
    }, { ipfsId: "QmPinnedRewardsVaultAction" })

    const result = await executor(REQUEST)
    expect(result.signedTx).toMatch(/^0x/)
    expect(executions).toEqual([{
      ipfsId: "QmPinnedRewardsVaultAction",
      jsParams: { ...REQUEST },
    }])
  })

  test.each([
    ["not json"],
    [null],
    [[]],
    [{}],
    [{ signedTx: "private-key-material" }],
    [{ signedTx: "0x123" }],
  ])("rejects malformed action output without echoing it", async (response) => {
    const executor = createLitRewardVaultExecutor({
      execute: async () => response,
    }, { code: "async function main() {}" })

    let thrown: unknown
    try {
      await executor(REQUEST)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(LitChipotleError)
    expect((thrown as LitChipotleError).code).toBe("invalid_response")
    expect([
      "LitChipotleError: Lit rewards vault action response was invalid",
      "LitChipotleError: Lit rewards vault action did not return a signed transaction",
    ]).toContain(String(thrown))
  })

  test("production construction permits only a pinned CID", async () => {
    const executions: LitActionExecution[] = []
    const client = {
      execute: async (execution: LitActionExecution) => {
        executions.push(execution)
        return { signedTx: "0x1234" }
      },
    }
    expect(() => createProductionLitRewardVaultExecutor(client, "", PINNED_POLICY)).toThrow(
      "Pinned Lit rewards vault action CID is required",
    )
    expect(() => createProductionLitRewardVaultExecutor(client, " QmPinned ", PINNED_POLICY)).toThrow(
      "Pinned Lit rewards vault action CID is required",
    )

    const originalNow = Date.now
    Date.now = () => 1_999_999_800_000
    try {
      await createProductionLitRewardVaultExecutor(client, "QmPinned", PINNED_POLICY)(REQUEST)
    } finally {
      Date.now = originalNow
    }
    expect(executions[0]).toMatchObject({ ipfsId: "QmPinned" })
    expect(executions[0]).not.toHaveProperty("code")
  })

  test("rejects stale policy and deadline before calling Lit", async () => {
    let executions = 0
    const executor = createProductionLitRewardVaultExecutor({
      execute: async () => {
        executions += 1
        return { signedTx: "0x1234" }
      },
    }, "QmPinned", PINNED_POLICY)
    const originalNow = Date.now
    Date.now = () => 2_000_000_100_000
    try {
      await expect(executor({ ...REQUEST, policyVersion: "8", deadline: "2000000200" }))
        .rejects.toMatchObject({ litErrorToken: "policy_version_mismatch" })
      await expect(executor({ ...REQUEST, deadline: "2000000099" }))
        .rejects.toMatchObject({ litErrorToken: "deadline_out_of_policy" })
      await expect(executor({ ...REQUEST, deadline: "2000000401" }))
        .rejects.toMatchObject({ litErrorToken: "deadline_out_of_policy" })
    } finally {
      Date.now = originalNow
    }
    expect(executions).toBe(0)
  })
})
