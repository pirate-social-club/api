import { openCommunityDb } from "../src/lib/communities/community-db-factory"
import { syncCommunityAuthProjection } from "../src/lib/communities/community-auth-projection-service"
import { getMembershipGatePolicy } from "../src/lib/communities/membership/gate-policy-store"
import { getCommunityRepository } from "../src/lib/communities/db-community-repository"
import { getControlPlaneClient } from "../src/lib/runtime-deps"
import { requiredString, rowValue, stringOrNull } from "../src/lib/sql-row"
import type { Env } from "../src/env"

const BACKFILL_CONCURRENCY = 5

type CommunityBackfillRow = {
  community_id: string
}

function toCommunityBackfillRow(row: unknown): CommunityBackfillRow {
  return {
    community_id: requiredString(row, "community_id"),
  }
}

async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let nextIndex = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = nextIndex
      nextIndex += 1
      if (index >= items.length) return
      await mapper(items[index] as T, index)
    }
  }))
}

async function readCommunityIdentity(input: {
  db: Awaited<ReturnType<typeof openCommunityDb>>
  communityId: string
}): Promise<{ displayName: string | null; avatarRef: string | null }> {
  const result = await input.db.client.execute({
    sql: `
      SELECT display_name, avatar_ref
      FROM communities
      WHERE community_id = ?1
      LIMIT 1
    `,
    args: [input.communityId],
  })
  const row = result.rows[0]
  return {
    displayName: stringOrNull(rowValue(row, "display_name")),
    avatarRef: stringOrNull(rowValue(row, "avatar_ref")),
  }
}

async function backfillCommunity(input: {
  env: Env
  communityId: string
}): Promise<boolean> {
  const repository = getCommunityRepository(input.env)
  let db: Awaited<ReturnType<typeof openCommunityDb>> | null = null
  try {
    db = await openCommunityDb(input.env, repository, input.communityId)
    const [identity, policy] = await Promise.all([
      readCommunityIdentity({
        db,
        communityId: input.communityId,
      }),
      getMembershipGatePolicy(db.client, input.communityId),
    ])
    await syncCommunityAuthProjection({
      env: input.env,
      communityId: input.communityId,
      ...(identity.displayName ? { displayName: identity.displayName } : {}),
      avatarRef: identity.avatarRef,
      membershipGatePolicy: policy,
      updatedAt: new Date().toISOString(),
    })
    return true
  } catch (error) {
    console.error("[postable-community-projection] backfill skipped", {
      communityId: input.communityId,
      message: error instanceof Error ? error.message : String(error),
    })
    return false
  } finally {
    db?.close()
  }
}

const env = process.env as unknown as Env
const result = await getControlPlaneClient(env).execute({
  sql: `
    SELECT community_id
    FROM communities
    WHERE status = 'active'
      AND provisioning_state = 'active'
    ORDER BY created_at DESC, community_id ASC
  `,
  args: [],
})
const rows = result.rows.map(toCommunityBackfillRow)
let updated = 0

await mapWithConcurrency(rows, BACKFILL_CONCURRENCY, async (row) => {
  if (await backfillCommunity({
    env,
    communityId: row.community_id,
  })) {
    updated += 1
  }
})

console.log(`postable community projection backfill complete: updated=${updated} total=${rows.length}`)
