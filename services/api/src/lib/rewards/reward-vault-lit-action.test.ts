import { describe, expect, test } from "bun:test"
import { Interface, Wallet, getAddress } from "ethers"

import { rewardVaultActionRequest, verifySignedRewardVaultTransaction } from "./reward-vault-transaction"
import { buildRewardVaultLitAction, type RewardVaultLitActionPolicy } from "./reward-vault-lit-action"

const PRIVATE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
const SIGNER = new Wallet(PRIVATE_KEY)
const VAULT = "0x1000000000000000000000000000000000000001"
const RECIPIENT = "0x3000000000000000000000000000000000000003"
const NOW_SECONDS = 2_000_000_000
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<unknown>

const POLICY: RewardVaultLitActionPolicy = {
  vaultAddress: VAULT,
  signerAddress: SIGNER.address,
  chainId: 8453,
  policyVersion: 7n,
  maxDeadlineSeconds: 600,
  maxFeePerGasWei: 3_000_000_000n,
  maxPriorityFeePerGasWei: 2_000_000_000n,
  maxGasLimit: 150_000n,
}

function transactionInput() {
  return {
    effectKind: "reward_cashout" as const,
    effectId: "rpe_0123456789abcdef0123456789abcdef",
    recipient: RECIPIENT,
    amount: 12_340_000n,
    deadline: BigInt(NOW_SECONDS + 300),
    policyVersion: 7n,
    vaultAddress: VAULT,
    signerAddress: SIGNER.address,
    chainId: 8453,
    nonce: 11,
    gas: {
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      gasLimit: 140_000n,
    },
  }
}

async function runAction(
  source: string,
  jsParams: Record<string, unknown>,
  onGetPrivateKey: () => void = () => {},
): Promise<unknown> {
  const ethersV5Compat = {
    Wallet,
    utils: { Interface, getAddress },
  }
  const Lit = {
    Actions: {
      getPrivateKey: async ({ pkpId }: { pkpId: string }) => {
        onGetPrivateKey()
        expect(pkpId).toBe(SIGNER.address)
        return PRIVATE_KEY
      },
    },
  }
  const execute = new AsyncFunction(
    "ethers",
    "Lit",
    "jsParams",
    "Date",
    `${source}; return await main(jsParams);`,
  )
  const fixedDate = { now: () => NOW_SECONDS * 1000 }
  return execute(ethersV5Compat, Lit, jsParams, fixedDate)
}

describe("buildRewardVaultLitAction", () => {
  test("signs an exact request that passes the independent Worker verifier", async () => {
    const input = transactionInput()
    const request = rewardVaultActionRequest(input)
    const result = await runAction(
      buildRewardVaultLitAction(POLICY),
      request as unknown as Record<string, unknown>,
    ) as { signedTx: string }

    expect(verifySignedRewardVaultTransaction(result.signedTx, input).txHash)
      .toMatch(/^0x[0-9a-f]{64}$/)
  })

  test.each([
    ["vault", { vaultAddress: "0x2000000000000000000000000000000000000002" }],
    ["signer", { signerAddress: "0x2000000000000000000000000000000000000002" }],
    ["chain", { chainId: 84532 }],
    ["policy version", { policyVersion: "8" }],
  ])("rejects caller-selected %s configuration before accessing the PKP", async (_field, override) => {
    let privateKeyReads = 0
    const request = {
      ...rewardVaultActionRequest(transactionInput()),
      ...override,
    }
    await expect(runAction(
      buildRewardVaultLitAction(POLICY),
      request,
      () => { privateKeyReads += 1 },
    )).rejects.toThrow("pinned policy")
    expect(privateKeyReads).toBe(0)
  })

  test("rejects gas above the source-pinned ceiling before accessing the PKP", async () => {
    let privateKeyReads = 0
    const request = rewardVaultActionRequest(transactionInput())
    request.gas.maxFeePerGas = "3000000001"
    await expect(runAction(
      buildRewardVaultLitAction(POLICY),
      request as unknown as Record<string, unknown>,
      () => { privateKeyReads += 1 },
    )).rejects.toThrow("gas fields exceed pinned policy")
    expect(privateKeyReads).toBe(0)
  })

  test("changing a security constant changes the action source and therefore its CID input", () => {
    const source = buildRewardVaultLitAction(POLICY)
    expect(buildRewardVaultLitAction({ ...POLICY, chainId: 84532 })).not.toBe(source)
    expect(buildRewardVaultLitAction({ ...POLICY, policyVersion: 8n })).not.toBe(source)
    expect(buildRewardVaultLitAction({
      ...POLICY,
      vaultAddress: "0x2000000000000000000000000000000000000002",
    })).not.toBe(source)
  })
})
