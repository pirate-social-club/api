import { describe, expect, it } from "bun:test"
import { id, keccak256 } from "ethers"

import {
  runRehearsalPreflight,
  SELECTORS,
  BALANCE_OF_SELECTOR,
  VAULT_VIEW_SIGNATURES,
  BALANCE_OF_SIGNATURE,
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
    host: "sepolia.base.org",
    confirmationPolicy: { kind: "finalized-tag", depth: null },
    readsWereHashPinned: true,
    assertSnapshotIntact: async () => {},
    chainId: async () => 84532,
    latestConfirmedBlock: async () => BLOCK,
    getCode: async (_a, block) => {
      seenBlocks.push(block.number)
      return CODE
    },
    call: async (to, data, block) => {
      seenBlocks.push(block.number)
      if (to === USDC) return word("186a0") // 100_000
      const selector = data.slice(0, 10)
      const value = { ...RESPONSES, ...patch }[selector]
      if (value === undefined) throw new Error(`unexpected selector ${selector}`)
      return value
    },
    getBalance: async (_a, block) => {
      seenBlocks.push(block.number)
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
  emitEvidence?: (e: unknown) => void
} = {}) => {
  const { reader: chainReader, seenBlocks } = reader(options.overrides, options.patch)
  return {
    seenBlocks,
    promise: runRehearsalPreflight({
      manifest,
      reader: chainReader,
      expectedPauseState: options.expectedPauseState ?? { payoutsPaused: false, refundsPaused: false },
      emitEvidence: options.emitEvidence as never,
    }),
  }
}

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

})

describe("selectors are derived, never transcribed", () => {
  it.each(Object.entries(VAULT_VIEW_SIGNATURES))(
    "%s matches keccak of its Solidity signature",
    (name, signature) => {
      expect(SELECTORS[name as keyof typeof SELECTORS]).toBe(id(signature).slice(0, 10))
    },
  )

  it("derives the ERC-20 balanceOf selector", () => {
    expect(BALANCE_OF_SELECTOR).toBe(id(BALANCE_OF_SIGNATURE).slice(0, 10))
  })
})

describe("evidence is emitted on failure, not only on success", () => {
  it("emits sanitized failure evidence before throwing", async () => {
    const emitted: unknown[] = []
    await expect(
      run({
        patch: { "0x58355ead": word("2") },
        emitEvidence: (evidence) => emitted.push(evidence),
      }).promise,
    ).rejects.toThrow(RehearsalPreflightError)

    expect(emitted).toHaveLength(1)
    const evidence = emitted[0] as {
      passed: boolean
      failureSummary: string | null
      checks: { field: string }[]
      blockHash: string
    }
    expect(evidence.passed).toBe(false)
    expect(evidence.failureSummary).toContain("vault.policyVersion")
    expect(evidence.blockHash).toBe(BLOCK.hash)
    // Full check list survives, not just the mismatch.
    expect(evidence.checks.length).toBeGreaterThan(10)
  })

  it("records the confirmation policy and whether reads were hash-pinned", async () => {
    const evidence = await run().promise
    expect(evidence.confirmationPolicy).toEqual({ kind: "finalized-tag", depth: null })
    expect(evidence.readsWereHashPinned).toBe(true)
  })
})

describe("snapshot integrity", () => {
  it("fails when the snapshot was reorganised during the reads", async () => {
    await expect(
      run({
        overrides: {
          readsWereHashPinned: false,
          assertSnapshotIntact: async () => {
            throw new RehearsalPreflightError("snapshot was reorganised during the preflight")
          },
        },
      }).promise,
    ).rejects.toThrow(/reorganised/u)
  })
})
