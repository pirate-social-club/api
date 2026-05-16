import { executeFirst } from "../db-helpers"
import type { DbExecutor } from "../db-helpers"
import { requiredNumber, rowValue, stringOrNull } from "../sql-row"
import type { Post } from "../../types"

export type CommunityPostPolicy = {
  allow_anonymous_identity: boolean
  anonymous_identity_scope: Post["anonymous_scope"]
}

export async function getCommunityPostPolicy(
  executor: DbExecutor,
  communityId: string,
): Promise<CommunityPostPolicy | null> {
  const row = await executeFirst(executor, {
    sql: `
      SELECT allow_anonymous_identity, anonymous_identity_scope
      FROM communities
      WHERE community_id = ?1
      LIMIT 1
    `,
    args: [communityId],
  })

  if (!row) {
    return null
  }

  return {
    allow_anonymous_identity: requiredNumber(row, "allow_anonymous_identity") === 1,
    anonymous_identity_scope: stringOrNull(rowValue(row, "anonymous_identity_scope")) as Post["anonymous_scope"],
  }
}
