import type { InStatement, QueryResult } from "../sql-client"
import { rowValue } from "../sql-row"

type Executor = { execute(statement: InStatement | string): Promise<QueryResult> }

export const REWARD_NATIONALITY_RETENTION_BATCH_SIZE = 500
export const REWARD_NATIONALITY_RETENTION_OWNER = "rewards-operations"

export type RewardNationalityRetentionSummary = {
  owner: typeof REWARD_NATIONALITY_RETENTION_OWNER
  deleted: number
  overdue: number
  checkedAt: string
}

function count(result: QueryResult): number {
  const value = Number(rowValue(result.rows[0], "count") ?? 0)
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("reward nationality retention verification returned an invalid count")
  }
  return value
}

/**
 * Deletes only records whose policy-calculated expiry has elapsed, then runs
 * the policy verification query in the same scheduled job. The caller owns
 * alerting on throws and on a non-zero overdue count.
 */
export async function enforceRewardNationalityDecisionRetention(input: {
  client: Executor
  now: string
  limit?: number
}): Promise<RewardNationalityRetentionSummary> {
  const limit = input.limit ?? REWARD_NATIONALITY_RETENTION_BATCH_SIZE
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > REWARD_NATIONALITY_RETENTION_BATCH_SIZE) {
    throw new Error(`reward nationality retention limit must be 1-${REWARD_NATIONALITY_RETENTION_BATCH_SIZE}`)
  }
  if (!Number.isFinite(Date.parse(input.now))) {
    throw new Error("reward nationality retention timestamp is invalid")
  }

  const deleted = await input.client.execute({
    sql: `
      DELETE FROM reward_nationality_decisions
      WHERE reward_nationality_decision_id IN (
        SELECT reward_nationality_decision_id
        FROM reward_nationality_decisions
        WHERE expires_at <= ?1
        ORDER BY expires_at ASC, reward_nationality_decision_id ASC
        LIMIT ?2
      )
      RETURNING reward_nationality_decision_id
    `,
    args: [input.now, limit],
  })
  const verification = await input.client.execute({
    sql: `
      SELECT COUNT(*) AS count
      FROM reward_nationality_decisions
      WHERE expires_at <= ?1
    `,
    args: [input.now],
  })
  return {
    owner: REWARD_NATIONALITY_RETENTION_OWNER,
    deleted: deleted.rows.length,
    overdue: count(verification),
    checkedAt: input.now,
  }
}
