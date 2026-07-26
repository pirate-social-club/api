import { describe, expect, it } from "bun:test"
import { keccak256 } from "ethers"

import {
  assertPinnedRpcUrl,
  runRehearsalPreflight,
  RehearsalPreflightError,
  type PreflightChainReader,
} from "./preflight"
import type { ExecutableRehearsalManifest } from "./manifest"

const VAULT = "0x000000000000000000000000000000000000beef"
const SAFE = "0x1cd289b6b232e1378d606ba550019e553685ad4c"
const OPERATOR = "0x6a1c1a6c780e9f2eb23e564c04b6316864468c46"
const USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e"
const CODE = "0x60806040523480156100"
const BLOCK = { number: 1_234_567, hash: `0x${"ab".repeat(32)}` }
const ALLOWED = ["sepolia.base.org"] as const
const RPC = "https://sepolia.base.org/v1"

const word = (hex: string) => `0x${hex.padStart(64, "0")}`
const addressWord = (address: string) => word(address.slice(2))

const manifest = {
  vault: {
    address: VAULT,
    bytecodeHash: keccak256(CODE).toLowerCase(),
    ownerSafeAddress: SAFE,
    usdcAddress: USDC,
    chainId: 84532,
    policyVersion: 1n,
    epochDurationSeconds: 86_400n,
    maxPayoutAtomic: 10_000n,
    payoutEpochCapAtomic: 50_000n,
    maxRefundAtomic: 10_000n,
    refundEpochCapAtomic: 50_000n,
  },
  balances: {
    settlementOperatorAddress: OPERATOR,
    vaultUsdcAtomic: 100_000n,
    signerEthWei: 1_000_000_000_000_000n,
  },
} as unknown as ExecutableRehearsalManifest

const RESPONSES: Record<string, string> = {
  "0x8da5cb5b": addressWord(SAFE),
  "0xe30c3978": word("0"),
  "0x1b6984e8": addressWord(OPERATOR),
  "0x301cf6e7": word("0"),
  "0xd90866d6": word("0"),
  "0x58355ead": word("1"),
  "0x4ff0876a": word("15180"),
  "0xe0176de8": word("2710"),
  "0x38b84cef": word("c350"),
  "0x2353464c": word("2710"),
  "0xa39b8f24": word("c350"),
  "0x3e413bee": addressWord(USDC),
}

const reader = (overrides: Partial<PreflightChainReader> = {}, patch: Record<string, string> = {}) => {
  const seenBlocks: number[] = []
  const base: PreflightChainReader = {
    chainId: async () => 84532,
    latestConfirmedBlock: async () => BLOCK,
    getCode: async (_a, blockNumber) => {
      seenBlocks.push(blockNumber)
      return CODE
    },
    call: async (to, data, blockNumber) => {
      seenBlocks.push(blockNumber)
      if (to === USDC) return word("186a0") // 100_000
      const selector = data.slice(0, 10)
      const value = { ...RESPONSES, ...patch }[selector]
      if (value === undefined) throw new Error(`unexpected selector ${selector}`)
      return value
    },
    getBalance: async (_a, blockNumber) => {
      seenBlocks.push(blockNumber)
      return 1_000_000_000_000_000n
    },
    ...overrides,
  }
  return { reader: base, seenBlocks }
}

const run = (options: {
  overrides?: Partial<PreflightChainReader>
  patch?: Record<string, string>
  expectedPauseState?: { payoutsPaused: boolean; refundsPaused: boolean }
  rpcUrl?: string
} = {}) => {
  const { reader: chainReader, seenBlocks } = reader(options.overrides, options.patch)
  return {
    seenBlocks,
    promise: runRehearsalPreflight({
      manifest,
      reader: chainReader,
      rpcUrl: options.rpcUrl ?? RPC,
      allowedRpcHosts: ALLOWED,
      expectedPauseState: options.expectedPauseState ?? { payoutsPaused: false, refundsPaused: false },
    }),
  }
}

describe("assertPinnedRpcUrl", () => {
  it("accepts a pinned HTTPS host", () => {
    expect(assertPinnedRpcUrl(RPC, ALLOWED)).toBe("sepolia.base.org")
  })

  it.each([
    "http://sepolia.base.org/v1",
    "ws://sepolia.base.org",
    "https://evil.example.com/v1",
    "not a url",
  ])("rejects %p", (url) => {
    expect(() => assertPinnedRpcUrl(url, ALLOWED)).toThrow(RehearsalPreflightError)
  })
})

describe("runRehearsalPreflight", () => {
  it("passes and records evidence when the chain matches the manifest", async () => {
    const evidence = await run().promise
    expect(evidence.passed).toBe(true)
    expect(evidence.blockNumber).toBe(BLOCK.number)
    expect(evidence.blockHash).toBe(BLOCK.hash)
    expect(evidence.rpcHost).toBe("sepolia.base.org")
    expect(evidence.checks.every((check) => check.matched)).toBe(true)
  })

  it("records every field as expected/observed, not just failures", async () => {
    const evidence = await run().promise
    const fields = evidence.checks.map((check) => check.field)
    for (const field of [
      "chainId",
      "vault.bytecodeHash",
      "vault.owner",
      "vault.pendingOwner",
      "vault.settlementOperator",
      "vault.usdc",
      "vault.policyVersion",
      "vault.epochDuration",
      "vault.maxPayout",
      "vault.payoutEpochCap",
      "vault.maxRefund",
      "vault.refundEpochCap",
      "vault.payoutsPaused",
      "vault.refundsPaused",
      "balances.vaultUsdcAtomic",
      "balances.signerEthWei",
    ]) {
      expect(fields).toContain(field)
    }
  })

  it("takes every read at one block, so the snapshot is consistent", async () => {
    const { promise, seenBlocks } = run()
    await promise
    expect(new Set(seenBlocks)).toEqual(new Set([BLOCK.number]))
  })

  it("fails on a pending ownership transfer", async () => {
    await expect(
      run({ patch: { "0xe30c3978": addressWord("0x00000000000000000000000000000000000000ff") } })
        .promise,
    ).rejects.toThrow(/pendingOwner/u)
  })

  it.each([
    ["vault.owner", "0x8da5cb5b", addressWord("0x00000000000000000000000000000000000000ee")],
    ["vault.settlementOperator", "0x1b6984e8", addressWord("0x00000000000000000000000000000000000000ee")],
    ["vault.usdc", "0x3e413bee", addressWord("0x00000000000000000000000000000000000000ee")],
    ["vault.policyVersion", "0x58355ead", word("2")],
    ["vault.epochDuration", "0x4ff0876a", word("2a30")],
    ["vault.payoutEpochCap", "0x38b84cef", word("1")],
  ])("fails when %s disagrees with the manifest", async (field, selector, value) => {
    await expect(run({ patch: { [selector]: value } }).promise).rejects.toThrow(
      new RegExp(field.replace(".", "\\."), "u"),
    )
  })

  it("fails when the deployed bytecode hash differs", async () => {
    await expect(
      run({ overrides: { getCode: async () => "0xdeadbeef" } }).promise,
    ).rejects.toThrow(/bytecodeHash/u)
  })

  it("fails when the vault address has no code at all", async () => {
    await expect(run({ overrides: { getCode: async () => "0x" } }).promise).rejects.toThrow(
      /no deployed bytecode/u,
    )
  })

  it("fails when the chain is not Base Sepolia", async () => {
    await expect(run({ overrides: { chainId: async () => 8453 } }).promise).rejects.toThrow(
      /chainId/u,
    )
  })

  it("requires the scenario's expected pause state, not whatever is there", async () => {
    // Vault is unpaused; a rejection scenario expecting paused must not proceed.
    await expect(
      run({ expectedPauseState: { payoutsPaused: true, refundsPaused: true } }).promise,
    ).rejects.toThrow(/payoutsPaused/u)
  })

  it("fails when the signer ETH balance disagrees", async () => {
    await expect(
      run({ overrides: { getBalance: async () => 1n } }).promise,
    ).rejects.toThrow(/signerEthWei/u)
  })

  it("refuses an unpinned RPC before touching the chain", async () => {
    let touched = false
    await expect(
      run({
        rpcUrl: "https://evil.example.com",
        overrides: {
          chainId: async () => {
            touched = true
            return 84532
          },
        },
      }).promise,
    ).rejects.toThrow(RehearsalPreflightError)
    expect(touched).toBe(false)
  })
})
