import { executeFirst } from "../db-helpers"
import type { InStatement, QueryResult } from "../sql-client"

export async function hasActiveUniqueHumanNullifier(client: { execute(statement: InStatement | string): Promise<QueryResult> }, userId: string): Promise<boolean> {
  const row = await executeFirst(client, {
    sql: `
      SELECT identity_nullifier_id
      FROM identity_nullifiers
      WHERE user_id = ?1
        AND status = 'active'
      LIMIT 1
    `,
    args: [userId],
  })
  return Boolean(row)
}
