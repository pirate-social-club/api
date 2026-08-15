import { Contract, JsonRpcProvider, keccak256 } from "ethers"

import {
  MEGAPOT_JACKPOT_READ_ABI,
  MEGAPOT_RANDOM_BUYER_ABI,
  MEGAPOT_TICKET_NFT_ABI,
} from "./megapot-abi"
import type { MegapotRuntimeConfig } from "./megapot-config"

export type MegapotBlockSnapshot = Readonly<{
  number: number
  hash: string
  timestampSeconds: bigint
}>

export type MegapotStartupSnapshot = Readonly<{
  block: MegapotBlockSnapshot
  chainId: number
  codeHashes: Readonly<{
    usdc: string
    usdcImplementation: string
    jackpot: string
    randomTicketBuyer: string
    ticketNft: string
    purchaseEscrow: string
    commitmentRegistry: string
    claimModule: string
  }>
  links: Readonly<{
    randomBuyerJackpot: string
    randomBuyerUsdc: string
    jackpotUsdc: string
    jackpotTicketNft: string
    ticketNftJackpot: string
    usdcImplementation: string
  }>
}>

export type MegapotPurchaseSnapshot = Readonly<{
  block: MegapotBlockSnapshot
  activeDrawingId: bigint
  ticketPriceAtomic: bigint
  drawingTicketPriceAtomic: bigint
  drawingTimeSeconds: bigint
  drawingDurationSeconds: bigint
  maxReferrers: bigint
  purchasingAllowed: boolean
  jackpotLocked: boolean
}>

export type MegapotTicketSnapshot = Readonly<{
  owner: string
  drawingId: bigint
}>

export type MegapotReceiptChainReader = {
  getHeadBlockNumber(): Promise<number>
  getCanonicalBlockHash(blockNumber: number): Promise<string | null>
  getTicketSnapshot(ticketId: bigint, blockNumber: number): Promise<MegapotTicketSnapshot>
}

export type MegapotChainReader = MegapotReceiptChainReader & {
  readStartupSnapshot(): Promise<MegapotStartupSnapshot>
  readPurchaseSnapshot(): Promise<MegapotPurchaseSnapshot>
}

function requiredBlock(block: Awaited<ReturnType<JsonRpcProvider["getBlock"]>>): MegapotBlockSnapshot {
  if (!block || !block.hash || !Number.isSafeInteger(block.number) || block.number < 0) {
    throw new Error("Megapot block snapshot is unavailable")
  }
  if (!Number.isSafeInteger(block.timestamp) || block.timestamp < 0) {
    throw new Error("Megapot block timestamp is invalid")
  }
  return {
    number: block.number,
    hash: block.hash.toLowerCase(),
    timestampSeconds: BigInt(block.timestamp),
  }
}

function parseRpcChainId(value: unknown): number {
  const parsed = Number(BigInt(String(value)))
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("Megapot RPC returned an invalid chain ID")
  }
  return parsed
}

function codeHash(code: string): string {
  if (!/^0x[0-9a-fA-F]+$/u.test(code) || code === "0x") {
    throw new Error("Megapot pinned contract has no runtime bytecode")
  }
  return keccak256(code).toLowerCase()
}

export function createMegapotChainReader(config: MegapotRuntimeConfig): MegapotChainReader {
  const provider = new JsonRpcProvider(config.rpcUrl)
  const jackpot = new Contract(config.deployment.jackpot.address, MEGAPOT_JACKPOT_READ_ABI, provider)
  const randomBuyer = new Contract(
    config.deployment.randomTicketBuyer.address,
    MEGAPOT_RANDOM_BUYER_ABI,
    provider,
  )
  const ticketNft = new Contract(config.deployment.ticketNft.address, MEGAPOT_TICKET_NFT_ABI, provider)
  const usdcProxy = new Contract(
    config.deployment.usdc.address,
    ["function implementation() view returns (address)"],
    provider,
  )

  return {
    async readStartupSnapshot(): Promise<MegapotStartupSnapshot> {
      const block = requiredBlock(await provider.getBlock("latest"))
      const blockTag = block.number
      const [
        rawChainId,
        usdcCode,
        usdcImplementationCode,
        jackpotCode,
        randomBuyerCode,
        ticketNftCode,
        purchaseEscrowCode,
        commitmentRegistryCode,
        claimModuleCode,
        randomBuyerJackpot,
        randomBuyerUsdc,
        jackpotUsdc,
        jackpotTicketNft,
        ticketNftJackpot,
        usdcImplementation,
      ] = await Promise.all([
        provider.send("eth_chainId", []),
        provider.getCode(config.deployment.usdc.address, blockTag),
        provider.getCode(config.deployment.usdc.implementation.address, blockTag),
        provider.getCode(config.deployment.jackpot.address, blockTag),
        provider.getCode(config.deployment.randomTicketBuyer.address, blockTag),
        provider.getCode(config.deployment.ticketNft.address, blockTag),
        provider.getCode(config.purchaseEscrowAddress, blockTag),
        provider.getCode(config.commitmentRegistryAddress, blockTag),
        provider.getCode(config.claimModuleAddress, blockTag),
        randomBuyer.jackpot({ blockTag }),
        randomBuyer.usdc({ blockTag }),
        jackpot.usdc({ blockTag }),
        jackpot.jackpotNFT({ blockTag }),
        ticketNft.jackpot({ blockTag }),
        usdcProxy.implementation({ blockTag }),
      ])
      return {
        block,
        chainId: parseRpcChainId(rawChainId),
        codeHashes: {
          usdc: codeHash(usdcCode),
          usdcImplementation: codeHash(usdcImplementationCode),
          jackpot: codeHash(jackpotCode),
          randomTicketBuyer: codeHash(randomBuyerCode),
          ticketNft: codeHash(ticketNftCode),
          purchaseEscrow: codeHash(purchaseEscrowCode),
          commitmentRegistry: codeHash(commitmentRegistryCode),
          claimModule: codeHash(claimModuleCode),
        },
        links: {
          randomBuyerJackpot: String(randomBuyerJackpot),
          randomBuyerUsdc: String(randomBuyerUsdc),
          jackpotUsdc: String(jackpotUsdc),
          jackpotTicketNft: String(jackpotTicketNft),
          ticketNftJackpot: String(ticketNftJackpot),
          usdcImplementation: String(usdcImplementation),
        },
      }
    },

    async readPurchaseSnapshot(): Promise<MegapotPurchaseSnapshot> {
      const block = requiredBlock(await provider.getBlock("latest"))
      const blockTag = block.number
      const [activeDrawingId, ticketPriceAtomic, purchasingAllowed, drawingDurationSeconds, maxReferrers] =
        await Promise.all([
          jackpot.currentDrawingId({ blockTag }),
          jackpot.ticketPrice({ blockTag }),
          jackpot.allowTicketPurchases({ blockTag }),
          jackpot.drawingDurationInSeconds({ blockTag }),
          jackpot.maxReferrers({ blockTag }),
        ])
      const drawingState = await jackpot.getDrawingState(activeDrawingId, { blockTag }) as {
        ticketPrice: bigint
        drawingTime: bigint
        jackpotLock: boolean
      }
      return {
        block,
        activeDrawingId: BigInt(activeDrawingId),
        ticketPriceAtomic: BigInt(ticketPriceAtomic),
        drawingTicketPriceAtomic: BigInt(drawingState.ticketPrice),
        drawingTimeSeconds: BigInt(drawingState.drawingTime),
        drawingDurationSeconds: BigInt(drawingDurationSeconds),
        maxReferrers: BigInt(maxReferrers),
        purchasingAllowed: Boolean(purchasingAllowed),
        jackpotLocked: Boolean(drawingState.jackpotLock),
      }
    },

    async getHeadBlockNumber(): Promise<number> {
      return await provider.getBlockNumber()
    },

    async getCanonicalBlockHash(blockNumber: number): Promise<string | null> {
      return (await provider.getBlock(blockNumber))?.hash?.toLowerCase() ?? null
    },

    async getTicketSnapshot(ticketId: bigint, blockNumber: number): Promise<MegapotTicketSnapshot> {
      const [owner, ticketInfo] = await Promise.all([
        ticketNft.ownerOf(ticketId, { blockTag: blockNumber }),
        ticketNft.getTicketInfo(ticketId, { blockTag: blockNumber }),
      ])
      return {
        owner: String(owner),
        drawingId: BigInt((ticketInfo as { drawingId: bigint }).drawingId),
      }
    },
  }
}
