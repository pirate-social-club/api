import type { Client } from "../sql-client"
import { upsertCommunityMembershipProjectionRow } from "../auth/auth-db-queries"
import type { CommunityMembershipProjectionRow } from "../auth/auth-db-rows"

export async function upsertCommunityMembershipProjection(
  client: Client,
  input: {
    communityId: string
    userId: string
    membershipState: CommunityMembershipProjectionRow["membership_state"]
    sourceUpdatedAt: string
    createdAt: string
  },
): Promise<void> {
  await upsertCommunityMembershipProjectionRow({
    executor: client,
    communityId: input.communityId,
    userId: input.userId,
    membershipState: input.membershipState,
    sourceUpdatedAt: input.sourceUpdatedAt,
    createdAt: input.createdAt,
  })
}
