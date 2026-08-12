import { requiredString, rowValue } from "../sql-row"
import type { QueryResultRow } from "../sql-client"

function column(alias: string, name: string): string {
  return alias ? `${alias}.${name}` : name
}

export function learnerVisibleRewardCampaignSql(input: {
  alias?: string
  nowParameter: string
}): string {
  const alias = input.alias ?? ""
  return `
    ${column(alias, "status")} = 'active'
    AND ${column(alias, "starts_at")} <= ${input.nowParameter}
    AND ${column(alias, "ends_at")} > ${input.nowParameter}
    AND ${column(alias, "eligible_activity")} IN ('study', 'karaoke', 'either')
    AND ${column(alias, "daily_reward_cents")} > 0
    AND ${column(alias, "funded_cents")} > ${column(alias, "reserved_cents")} + ${column(alias, "credited_cents")} + ${column(alias, "refunded_cents")}
  `
}

export function isLearnerVisibleRewardCampaign(row: QueryResultRow, nowMs: number): boolean {
  const integer = (name: string) => Number(rowValue(row, name))
  return requiredString(row, "status") === "active"
    && Date.parse(requiredString(row, "starts_at")) <= nowMs
    && Date.parse(requiredString(row, "ends_at")) > nowMs
    && ["study", "karaoke", "either"].includes(requiredString(row, "eligible_activity"))
    && integer("daily_reward_cents") > 0
    && integer("funded_cents") > integer("reserved_cents") + integer("credited_cents") + integer("refunded_cents")
}
