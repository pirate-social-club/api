import { isPayingMegapotTier } from "./megapot-claim-policy"

export type RewardTicketSweepTicket = Readonly<{
  inventoryId: string
  ticketId: bigint
  status: "held" | "no_win" | "winning" | "claim_pending" | "claimed" | "needs_review"
}>

export async function planRewardTicketSweep(input: Readonly<{
  nowSeconds: bigint
  drawingResolvesAtSeconds: bigint
  expectedTicketCount: number
  confirmedEventTicketCount: number
  tickets: readonly RewardTicketSweepTicket[]
  readTierIds: (ticketIds: readonly bigint[]) => Promise<readonly number[]>
}>): Promise<Readonly<{
  inventoryComplete: boolean
  sweepComplete: boolean
  updates: readonly Readonly<{ inventoryId: string; tierId: number; status: "no_win" | "winning" }>[]
}>> {
  if (input.nowSeconds < input.drawingResolvesAtSeconds) throw new Error("reward_ticket_drawing_not_resolved")
  const inventoryComplete = input.tickets.length === input.expectedTicketCount
    && input.tickets.length === input.confirmedEventTicketCount
  if (!inventoryComplete) throw new Error("reward_ticket_inventory_incomplete")
  const held = input.tickets.filter((ticket) => ticket.status === "held")
  const tiers = held.length === 0 ? [] : await input.readTierIds(held.map((ticket) => ticket.ticketId))
  if (tiers.length !== held.length || tiers.some((tier) => !Number.isSafeInteger(tier) || tier < 0)) {
    throw new Error("reward_ticket_sweep_response_invalid")
  }
  const updates = held.map((ticket, index) => ({
    inventoryId: ticket.inventoryId,
    tierId: tiers[index] as number,
    status: isPayingMegapotTier(tiers[index] as number) ? "winning" as const : "no_win" as const,
  }))
  const projected = new Map(updates.map((update) => [update.inventoryId, update.status]))
  const sweepComplete = input.tickets.every((ticket) => {
    const status = projected.get(ticket.inventoryId) ?? ticket.status
    return status === "no_win" || status === "winning" || status === "claimed"
  })
  return { inventoryComplete, sweepComplete, updates }
}
