import type { ActorContext, AdminActorContext } from "../../auth-middleware"
import type { CommunityRow } from "../../auth/auth-db-rows"
import { eligibilityFailed, notFoundError } from "../../errors"
import type {
  CommunityDatabaseBindingRepository,
  CommunityReadRepository,
} from "../db-community-repository"
import { openCommunityDb } from "../community-db-factory"
import { isCommunityLive } from "../community-status"
import {
  ANY_COMMUNITY_ROLE,
  OWNER_OR_ADMIN_ROLE,
  canAccessCommunity,
  getCommunityMembershipState,
  hasCommunityRole,
  type CommunityMembershipRow,
} from "../membership/membership-state-store"
import type { Env } from "../../../env"

export type CommunityAssistantRepository = CommunityReadRepository & CommunityDatabaseBindingRepository
export type CommunityAssistantActor = ActorContext | AdminActorContext

export type CommunityAssistantAccess = {
  community: CommunityRow
  membership: CommunityMembershipRow | null
}

export async function requireLiveAssistantCommunity(input: {
  communityRepository: Pick<CommunityReadRepository, "getCommunityById">
  communityId: string
}): Promise<CommunityRow> {
  const community = await input.communityRepository.getCommunityById(input.communityId)
  if (!isCommunityLive(community)) {
    throw notFoundError("Community not found")
  }
  return community
}

async function readMembership(input: {
  env: Env
  communityRepository: CommunityAssistantRepository
  communityId: string
  userId: string
}): Promise<CommunityMembershipRow> {
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    return await getCommunityMembershipState(db.client, input.communityId, input.userId)
  } finally {
    db.close()
  }
}

export async function requireAssistantCommunityAccess(input: {
  env: Env
  communityRepository: CommunityAssistantRepository
  communityId: string
  actor: CommunityAssistantActor
}): Promise<CommunityAssistantAccess> {
  const community = await requireLiveAssistantCommunity(input)
  if ("adminOverride" in input.actor) {
    return { community, membership: null }
  }

  const membership = await readMembership({
    env: input.env,
    communityRepository: input.communityRepository,
    communityId: community.community_id,
    userId: input.actor.userId,
  })
  if (!canAccessCommunity(membership)) {
    throw notFoundError("Community not found")
  }

  return { community, membership }
}

export async function requireAssistantModeratorAccess(input: {
  env: Env
  communityRepository: CommunityAssistantRepository
  communityId: string
  actor: CommunityAssistantActor
}): Promise<CommunityAssistantAccess> {
  const access = await requireAssistantCommunityAccess(input)
  if ("adminOverride" in input.actor) {
    return access
  }
  if (!access.membership || !hasCommunityRole(access.membership, ANY_COMMUNITY_ROLE)) {
    throw eligibilityFailed("Moderator access is required")
  }
  return access
}

export async function requireAssistantOwnerOrAdminAccess(input: {
  env: Env
  communityRepository: CommunityAssistantRepository
  communityId: string
  actor: CommunityAssistantActor
}): Promise<CommunityAssistantAccess> {
  const access = await requireAssistantCommunityAccess(input)
  if ("adminOverride" in input.actor || access.community.creator_user_id === input.actor.userId) {
    return access
  }
  if (!access.membership || !hasCommunityRole(access.membership, OWNER_OR_ADMIN_ROLE)) {
    throw eligibilityFailed("Owner or admin access is required")
  }
  return access
}

export function canManageAssistantPolicy(input: {
  actor: CommunityAssistantActor
  access: CommunityAssistantAccess
}): boolean {
  if ("adminOverride" in input.actor) {
    return true
  }
  return Boolean(input.access.membership && hasCommunityRole(input.access.membership, ANY_COMMUNITY_ROLE))
}
