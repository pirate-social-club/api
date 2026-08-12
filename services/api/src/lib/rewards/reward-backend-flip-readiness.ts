import type { Client } from "../sql-client"
import { rowValue } from "../sql-row"

export type RewardBackendFlipReadiness = {
  ready: boolean
  non_terminal_cashouts: number
  non_terminal_refunds: number
  reconciliation_required: number
}

function count(value: unknown): number {
  const parsed = Number(value ?? 0)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("rewards backend-flip readiness count is invalid")
  }
  return parsed
}

export async function getRewardBackendFlipReadiness(
  client: Client,
): Promise<RewardBackendFlipReadiness> {
  const result = await client.execute(`
    SELECT
      (SELECT COUNT(*) FROM reward_payout_effects
        WHERE status = 'submitted') AS non_terminal_cashouts,
      (SELECT COUNT(*) FROM reward_campaign_funding_effects
        WHERE status = 'refund_pending') AS non_terminal_refunds,
      (
        (SELECT COUNT(*) FROM reward_payout_effects
          WHERE coordinator_state = 'reconciliation_required')
        +
        (SELECT COUNT(*) FROM reward_campaign_funding_effects
          WHERE refund_coordinator_state = 'reconciliation_required')
      ) AS reconciliation_required
  `)
  const row = result.rows[0]
  const nonTerminalCashouts = count(rowValue(row, "non_terminal_cashouts"))
  const nonTerminalRefunds = count(rowValue(row, "non_terminal_refunds"))
  const reconciliationRequired = count(rowValue(row, "reconciliation_required"))
  return {
    ready: nonTerminalCashouts === 0 && nonTerminalRefunds === 0 && reconciliationRequired === 0,
    non_terminal_cashouts: nonTerminalCashouts,
    non_terminal_refunds: nonTerminalRefunds,
    reconciliation_required: reconciliationRequired,
  }
}
