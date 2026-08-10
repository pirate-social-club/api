import type { Env } from "../../env"
import { internalError } from "../errors"
import { envFlag } from "../helpers"
import { getControlPlaneClient } from "../runtime-deps"
import { rowValue, stringOrNull } from "../sql-row"

const MAX_ALIAS_DEPTH = 8

/**
 * Resolve an authenticated principal through an irreversible account-merge
 * fence. `finalizing` is entered only after every blocking preflight succeeds,
 * before the first shard write; `completed` keeps old tokens canonical after
 * the permanent alias is installed.
 */
export async function resolveCanonicalUserId(input: {
  env: Env
  userId: string
}): Promise<string> {
  if (envFlag(input.env.DEV_MEMORY_STORE_ENABLED, false)) return input.userId

  const client = getControlPlaneClient(input.env)
  const visited = new Set<string>()
  let current = input.userId
  for (let depth = 0; depth < MAX_ALIAS_DEPTH; depth += 1) {
    if (visited.has(current)) throw internalError("Account alias cycle detected")
    visited.add(current)
    const resolution = await client.execute({
      sql: `
        SELECT canonical_user_id FROM (
          SELECT canonical_user_id, 0 AS priority
          FROM user_account_aliases
          WHERE source_user_id = ?1 AND status = 'active'
          UNION ALL
          SELECT canonical_user_id, 1 AS priority
          FROM user_account_merges
          WHERE source_user_id = ?1 AND status IN ('finalizing', 'completed')
        ) resolutions
        ORDER BY priority
        LIMIT 1
      `,
      args: [current],
    })
    const canonicalUserId = stringOrNull(rowValue(resolution.rows[0], "canonical_user_id"))
    if (!canonicalUserId) return current
    current = canonicalUserId
  }
  throw internalError("Account alias chain is too deep")
}
