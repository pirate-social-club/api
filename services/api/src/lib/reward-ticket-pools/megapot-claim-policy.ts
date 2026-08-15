import { Interface, id } from "ethers"

import { MEGAPOT_CLAIM_ERRORS_ABI } from "./megapot-abi"

const CLAIM_ERRORS = new Interface(MEGAPOT_CLAIM_ERRORS_ABI)
const NO_TICKETS_TO_CLAIM_SELECTOR = id("NoTicketsToClaim()").slice(0, 10).toLowerCase()
const NOT_TICKET_OWNER_SELECTOR = id("NotTicketOwner()").slice(0, 10).toLowerCase()

export function isPayingMegapotTier(tierId: bigint | number): boolean {
  const tier = BigInt(tierId)
  return tier > 0n && tier !== 2n
}

export function payingMegapotTicketIds(
  tickets: readonly Readonly<{ ticketId: bigint; tierId: bigint | number }>[],
): bigint[] {
  return tickets.filter((ticket) => isPayingMegapotTier(ticket.tierId)).map((ticket) => ticket.ticketId)
}

function nestedValues(value: unknown, depth: number, seen: Set<object>): unknown[] {
  if (depth > 4 || typeof value !== "object" || value === null || seen.has(value)) return []
  seen.add(value)
  return Object.values(value as Record<string, unknown>).flatMap((nested) => [
    nested,
    ...nestedValues(nested, depth + 1, seen),
  ])
}

export function isMegapotNoTicketsToClaim(error: unknown): boolean {
  const values = [error, ...nestedValues(error, 0, new Set())]
  for (const value of values) {
    if (typeof value !== "string" || !value.startsWith("0x")) continue
    if (value.slice(0, 10).toLowerCase() !== NO_TICKETS_TO_CLAIM_SELECTOR) continue
    try {
      return CLAIM_ERRORS.parseError(value)?.name === "NoTicketsToClaim"
    } catch {
      continue
    }
  }
  return values.some((value) =>
    typeof value === "object"
    && value !== null
    && "errorName" in value
    && (value as { errorName?: unknown }).errorName === "NoTicketsToClaim"
  )
}

export function isMegapotNotTicketOwner(error: unknown): boolean {
  const values = [error, ...nestedValues(error, 0, new Set())]
  return values.some((value) => {
    if (typeof value === "object" && value !== null && "errorName" in value) {
      return (value as { errorName?: unknown }).errorName === "NotTicketOwner"
    }
    if (typeof value !== "string" || value.slice(0, 10).toLowerCase() !== NOT_TICKET_OWNER_SELECTOR) {
      return false
    }
    try { return CLAIM_ERRORS.parseError(value)?.name === "NotTicketOwner" } catch { return false }
  })
}
