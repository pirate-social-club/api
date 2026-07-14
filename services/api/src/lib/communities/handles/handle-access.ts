import type { DbExecutor } from "../../db-helpers"
import { eligibilityFailed } from "../../errors"
import type { Client } from "../../sql-client"
import { canAccessCommunity, getCommunityMembershipState } from "../membership/membership-state-store"

export async function requireHandleClaimAccess(input: {
  client: DbExecutor
  communityId: string
  userId: string
}): Promise<{ isMember: boolean }> {
  const membership = await getCommunityMembershipState(input.client as Client, input.communityId, input.userId)
  const isMember = canAccessCommunity(membership)
  if (isMember) {
    return { isMember }
  }
  throw eligibilityFailed("Community membership is required to claim names")
}
