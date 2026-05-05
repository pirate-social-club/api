import type { Client } from "@libsql/client"

export async function ensureRemoteCommunityMembershipStateIndexes(client: Client): Promise<void> {
  await client.batch([
    {
      sql: `
        CREATE INDEX IF NOT EXISTS idx_community_memberships_state_lookup
          ON community_memberships(community_id, user_id, created_at DESC)
      `,
      args: [],
    },
    {
      sql: `
        CREATE INDEX IF NOT EXISTS idx_community_roles_state_lookup
          ON community_roles(community_id, user_id, created_at DESC)
      `,
      args: [],
    },
  ], "write")
}
