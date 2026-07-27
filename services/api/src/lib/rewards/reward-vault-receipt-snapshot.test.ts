import { describe, expect, it } from "bun:test"

import {
  fetchRewardVaultReceiptSnapshot,
  type RewardVaultReceiptProvider,
} from "./reward-vault-receipt-snapshot"

const TX = `0x${"ab".repeat(32)}`
const BLOCK_HASH = `0x${"cd".repeat(32)}`

const receipt = (overrides: Record<string, unknown> = {}) => ({
  status: 1,
  hash: TX,
  blockHash: BLOCK_HASH,
  logs: [{ address: "0x00", topics: [], data: "0x", transactionHash: TX }],
  ...overrides,
})

const provider = (
  overrides: Partial<RewardVaultReceiptProvider> = {},
  seen: string[] = [],
): { provider: RewardVaultReceiptProvider; seen: string[] } => ({
  seen,
  provider: {
    getTransactionReceipt: async () => receipt() as never,
    getBlock: async (blockHash: string) => {
      seen.push(blockHash)
      return { timestamp: 1_700_000_000 }
    },
    ...overrides,
  },
})

describe("fetchRewardVaultReceiptSnapshot", () => {
  it("returns one coherent snapshot", async () => {
    const { provider: p } = provider()
    const result = await fetchRewardVaultReceiptSnapshot(p, TX)
    expect(result.status).toBe("snapshot")
    if (result.status !== "snapshot") throw new Error("unreachable")
    expect(result.snapshot.transactionHash).toBe(TX)
    expect(result.snapshot.blockHash).toBe(BLOCK_HASH)
    expect(result.snapshot.blockTimestampSeconds).toBe(1_700_000_000n)
  })

  it("reads the timestamp from the RECEIPT'S OWN block hash", async () => {
    const seen: string[] = []
    const { provider: p } = provider({}, seen)
    await fetchRewardVaultReceiptSnapshot(p, TX)
    expect(seen).toEqual([BLOCK_HASH])
  })

  it.each(["latest", "finalized", "safe", "pending", "0x1"])(
    "never requests %p",
    async (tag) => {
      // A wrong timestamp does not fail loudly — it shifts the computed epoch
      // and either strands a correct deferral or passes while proving nothing.
      const seen: string[] = []
      const { provider: p } = provider({}, seen)
      await fetchRewardVaultReceiptSnapshot(p, TX)
      expect(seen).not.toContain(tag)
    },
  )

  it("asks for the block exactly once", async () => {
    const seen: string[] = []
    const { provider: p } = provider({}, seen)
    await fetchRewardVaultReceiptSnapshot(p, TX)
    expect(seen).toHaveLength(1)
  })

  it("reports an unavailable receipt rather than inventing one", async () => {
    const { provider: p } = provider({ getTransactionReceipt: async () => null })
    const result = await fetchRewardVaultReceiptSnapshot(p, TX)
    expect(result.status).toBe("unavailable")
    expect(result.status === "unavailable" && result.reason).toContain("receipt is unavailable")
  })

  it("reports a receipt with no status rather than defaulting it", async () => {
    const { provider: p } = provider({
      getTransactionReceipt: async () => receipt({ status: null }) as never,
    })
    const result = await fetchRewardVaultReceiptSnapshot(p, TX)
    expect(result.status).toBe("unavailable")
    expect(result.status === "unavailable" && result.reason).toContain("no status")
  })

  it.each([undefined, "0xnope", `0x${"ab".repeat(31)}`])(
    "rejects a non-canonical block hash (%p)",
    async (blockHash) => {
      const { provider: p } = provider({
        getTransactionReceipt: async () => receipt({ blockHash }) as never,
      })
      const result = await fetchRewardVaultReceiptSnapshot(p, TX)
      expect(result.status).toBe("unavailable")
    },
  )

  it("does not fetch a block when the receipt is unusable", async () => {
    const seen: string[] = []
    const { provider: p } = provider(
      { getTransactionReceipt: async () => receipt({ blockHash: "0xnope" }) as never },
      seen,
    )
    await fetchRewardVaultReceiptSnapshot(p, TX)
    expect(seen).toHaveLength(0)
  })

  it("reports a block that cannot be found by its own hash", async () => {
    const { provider: p } = provider({ getBlock: async () => null })
    const result = await fetchRewardVaultReceiptSnapshot(p, TX)
    expect(result.status).toBe("unavailable")
    expect(result.status === "unavailable" && result.reason).toContain("by its own hash")
  })

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 2])(
    "rejects an unusable block timestamp (%p)",
    async (timestamp) => {
      const { provider: p } = provider({ getBlock: async () => ({ timestamp }) })
      const result = await fetchRewardVaultReceiptSnapshot(p, TX)
      expect(result.status).toBe("unavailable")
    },
  )
})
