import { providerUnavailable } from "../errors"
import type { MegapotChainReader, MegapotPurchaseSnapshot } from "./megapot-chain-reader"
import type { MegapotRuntimeConfig } from "./megapot-config"

export type MegapotPurchaseBlockReason =
  | "drawing_mismatch"
  | "purchasing_disabled"
  | "jackpot_locked"
  | "ticket_price_above_ceiling"
  | "cutoff_safety_margin"
  | "referrer_limit_changed"

export type MegapotPurchasePreflight =
  | Readonly<{
      disposition: "ready"
      drawingId: bigint
      ticketPriceAtomic: bigint
      totalCostAtomic: bigint
      drawingTimeSeconds: bigint
      observedBlockNumber: number
      observedBlockHash: string
    }>
  | Readonly<{
      disposition: "blocked"
      reason: MegapotPurchaseBlockReason
      intendedDrawingId: bigint
      observedDrawingId: bigint
      observedBlockNumber: number
      observedBlockHash: string
    }>

function invalidSnapshot(reason: string): never {
  throw providerUnavailable("Megapot purchase preflight is internally inconsistent", { reason }, false)
}

export function decideMegapotPurchasePreflight(input: {
  config: MegapotRuntimeConfig
  snapshot: MegapotPurchaseSnapshot
  intendedDrawingId: bigint
  ticketCount: number
  maxTicketPriceAtomic: bigint
  referrerCount: number
}): MegapotPurchasePreflight {
  const { snapshot } = input
  if (!Number.isSafeInteger(input.ticketCount) || input.ticketCount < 1 || input.ticketCount > 10) {
    invalidSnapshot("ticket_count_out_of_range")
  }
  if (!Number.isSafeInteger(input.referrerCount) || input.referrerCount < 0) {
    invalidSnapshot("referrer_count_invalid")
  }
  if (input.intendedDrawingId < 0n || input.maxTicketPriceAtomic <= 0n) {
    invalidSnapshot("purchase_terms_invalid")
  }
  if (
    snapshot.ticketPriceAtomic <= 0n
    || snapshot.drawingTicketPriceAtomic <= 0n
    || snapshot.ticketPriceAtomic !== snapshot.drawingTicketPriceAtomic
  ) {
    invalidSnapshot("ticket_price_sources_disagree")
  }
  if (snapshot.drawingDurationSeconds <= 0n || snapshot.drawingTimeSeconds <= 0n) {
    invalidSnapshot("drawing_schedule_invalid")
  }

  const blocked = (reason: MegapotPurchaseBlockReason): MegapotPurchasePreflight => ({
    disposition: "blocked",
    reason,
    intendedDrawingId: input.intendedDrawingId,
    observedDrawingId: snapshot.activeDrawingId,
    observedBlockNumber: snapshot.block.number,
    observedBlockHash: snapshot.block.hash,
  })

  if (snapshot.activeDrawingId !== input.intendedDrawingId) return blocked("drawing_mismatch")
  if (!snapshot.purchasingAllowed) return blocked("purchasing_disabled")
  if (snapshot.jackpotLocked) return blocked("jackpot_locked")
  if (snapshot.ticketPriceAtomic > input.maxTicketPriceAtomic) {
    return blocked("ticket_price_above_ceiling")
  }
  if (BigInt(input.referrerCount) > snapshot.maxReferrers) return blocked("referrer_limit_changed")

  const latestSafeSubmissionSecond = snapshot.drawingTimeSeconds
    - BigInt(input.config.purchaseSafetyMarginSeconds)
  if (snapshot.block.timestampSeconds >= latestSafeSubmissionSecond) {
    return blocked("cutoff_safety_margin")
  }

  return {
    disposition: "ready",
    drawingId: snapshot.activeDrawingId,
    ticketPriceAtomic: snapshot.ticketPriceAtomic,
    totalCostAtomic: snapshot.ticketPriceAtomic * BigInt(input.ticketCount),
    drawingTimeSeconds: snapshot.drawingTimeSeconds,
    observedBlockNumber: snapshot.block.number,
    observedBlockHash: snapshot.block.hash,
  }
}

export async function revalidateMegapotPurchase(input: {
  config: MegapotRuntimeConfig
  reader: MegapotChainReader
  intendedDrawingId: bigint
  ticketCount: number
  maxTicketPriceAtomic: bigint
  referrerCount: number
}): Promise<MegapotPurchasePreflight> {
  let snapshot: MegapotPurchaseSnapshot
  try {
    snapshot = await input.reader.readPurchaseSnapshot()
  } catch {
    throw providerUnavailable("Megapot purchase preflight could not read chain state", null, true)
  }
  return decideMegapotPurchasePreflight({ ...input, snapshot })
}
