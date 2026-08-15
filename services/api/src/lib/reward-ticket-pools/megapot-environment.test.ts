import { describe, expect, test } from "bun:test"

import type {
  MegapotChainReader,
  MegapotPurchaseSnapshot,
  MegapotStartupSnapshot,
} from "./megapot-chain-reader"
import { MEGAPOT_DEPLOYMENTS, type MegapotRuntimeConfig } from "./megapot-config"
import { verifyMegapotEnvironmentAtStartup } from "./megapot-environment"
import { decideMegapotPurchasePreflight } from "./megapot-purchase-preflight"

const config: MegapotRuntimeConfig = {
  deployment: MEGAPOT_DEPLOYMENTS.testnet,
  rpcUrl: "https://rpc.example.test",
  purchaseSafetyMarginSeconds: 120,
  minimumConfirmations: 30,
  custodyAddress: "0x1000000000000000000000000000000000000001",
  purchaseOperatorAddress: "0x2000000000000000000000000000000000000002",
  platformRevenueAddress: "0x3000000000000000000000000000000000000003",
  purchaseEscrowAddress: "0x4000000000000000000000000000000000000004",
  commitmentRegistryAddress: "0x5000000000000000000000000000000000000005",
  claimModuleAddress: "0x6000000000000000000000000000000000000006",
  purchaseEscrowCodeHash: `0x${"4".repeat(64)}`,
  commitmentRegistryCodeHash: `0x${"5".repeat(64)}`,
  claimModuleCodeHash: `0x${"6".repeat(64)}`,
}

const startupSnapshot: MegapotStartupSnapshot = {
  block: { number: 100, hash: `0x${"a".repeat(64)}`, timestampSeconds: 1_000n },
  chainId: 84532,
  codeHashes: {
    usdc: config.deployment.usdc.codeHash,
    usdcImplementation: config.deployment.usdc.implementation.codeHash,
    jackpot: config.deployment.jackpot.codeHash,
    randomTicketBuyer: config.deployment.randomTicketBuyer.codeHash,
    ticketNft: config.deployment.ticketNft.codeHash,
    purchaseEscrow: config.purchaseEscrowCodeHash,
    commitmentRegistry: config.commitmentRegistryCodeHash,
    claimModule: config.claimModuleCodeHash,
  },
  links: {
    randomBuyerJackpot: config.deployment.jackpot.address,
    randomBuyerUsdc: config.deployment.usdc.address,
    jackpotUsdc: config.deployment.usdc.address,
    jackpotTicketNft: config.deployment.ticketNft.address,
    ticketNftJackpot: config.deployment.jackpot.address,
    usdcImplementation: config.deployment.usdc.implementation.address,
  },
}

function reader(snapshot: MegapotStartupSnapshot): MegapotChainReader {
  return {
    readStartupSnapshot: async () => snapshot,
    readPurchaseSnapshot: async () => { throw new Error("unused") },
    getHeadBlockNumber: async () => 0,
    getCanonicalBlockHash: async () => null,
    getTicketSnapshot: async () => { throw new Error("unused") },
  }
}

function purchaseSnapshot(overrides: Partial<MegapotPurchaseSnapshot> = {}): MegapotPurchaseSnapshot {
  return {
    block: { number: 101, hash: `0x${"b".repeat(64)}`, timestampSeconds: 1_000n },
    activeDrawingId: 7n,
    ticketPriceAtomic: 10_000n,
    drawingTicketPriceAtomic: 10_000n,
    drawingTimeSeconds: 1_500n,
    drawingDurationSeconds: 1_800n,
    maxReferrers: 3n,
    purchasingAllowed: true,
    jackpotLocked: false,
    ...overrides,
  }
}

describe("Megapot environment verification", () => {
  test("verifies code hashes and every linked contract at one observed block", async () => {
    const result = await verifyMegapotEnvironmentAtStartup({ config, reader: reader(startupSnapshot) })
    expect(result.observedBlockNumber).toBe(100)
    expect(result.observedBlockHash).toBe(startupSnapshot.block.hash)
  })

  test("fails closed when pinned bytecode changes", async () => {
    await expect(verifyMegapotEnvironmentAtStartup({
      config,
      reader: reader({
        ...startupSnapshot,
        codeHashes: { ...startupSnapshot.codeHashes, jackpot: `0x${"f".repeat(64)}` },
      }),
    })).rejects.toThrow("Megapot deployment verification failed")
  })
})

describe("Megapot per-purchase preflight", () => {
  test("revalidates the mutable drawing, price, availability, schedule, and referrer cap", () => {
    expect(decideMegapotPurchasePreflight({
      config,
      snapshot: purchaseSnapshot(),
      intendedDrawingId: 7n,
      ticketCount: 3,
      maxTicketPriceAtomic: 12_000n,
      referrerCount: 1,
    })).toEqual({
      disposition: "ready",
      drawingId: 7n,
      ticketPriceAtomic: 10_000n,
      totalCostAtomic: 30_000n,
      drawingTimeSeconds: 1_500n,
      observedBlockNumber: 101,
      observedBlockHash: `0x${"b".repeat(64)}`,
    })
  })

  test("blocks a boundary straddle and a purchase inside the safety margin", () => {
    const common = {
      config,
      ticketCount: 1,
      maxTicketPriceAtomic: 10_000n,
      referrerCount: 1,
    }
    expect(decideMegapotPurchasePreflight({
      ...common,
      snapshot: purchaseSnapshot(),
      intendedDrawingId: 6n,
    })).toMatchObject({ disposition: "blocked", reason: "drawing_mismatch" })
    expect(decideMegapotPurchasePreflight({
      ...common,
      snapshot: purchaseSnapshot({ drawingTimeSeconds: 1_120n }),
      intendedDrawingId: 7n,
    })).toMatchObject({ disposition: "blocked", reason: "cutoff_safety_margin" })
  })
})
