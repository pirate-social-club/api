export type RewardTicketBackingDomainStatus = "active" | "operational_hold" | "retired"

export function assertRewardTicketBackingDomainActive(status: RewardTicketBackingDomainStatus): void {
  if (status !== "active") {
    throw new Error(`reward_ticket_backing_domain_not_active:${status}`)
  }
}

function sqlState(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null
  const record = error as Record<string, unknown>
  for (const key of ["code", "errno", "sqlState", "sqlstate"]) {
    const value = record[key]
    if (typeof value === "string" && /^[0-9A-Z]{5}$/u.test(value)) return value
  }
  return null
}

export function classifyRewardTicketLedgerWriteError(error: unknown): Readonly<{
  disposition: "fail_closed" | "reconcile_as_applied" | "retry_later"
  retryable: boolean
  sqlState: string | null
}> {
  const state = sqlState(error)
  if (state === "23505") {
    return { disposition: "reconcile_as_applied", retryable: false, sqlState: state }
  }
  if (
    state === "40001"
    || state === "40P01"
    || state?.startsWith("08")
    || state === "57P01"
  ) {
    return { disposition: "retry_later", retryable: true, sqlState: state }
  }
  if (state !== null) {
    return { disposition: "fail_closed", retryable: false, sqlState: state }
  }
  return { disposition: "retry_later", retryable: true, sqlState: state }
}
