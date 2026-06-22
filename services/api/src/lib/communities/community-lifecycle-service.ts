import { nowIso } from "../helpers"
import { writeAuditEventForEnv } from "../audit"
import type { CommunityRow } from "../auth/auth-db-rows"
import type { CommunityMutationRepository, CommunityReadRepository } from "./community-repository-types"
import {
  requireAdminOverrideOrOwnedCommunity,
  type CommunityMutationActor,
} from "./create/shared"
import type { Env } from "../../env"

type CommunityLifecycleRepository = Pick<CommunityReadRepository, "getCommunityById"> &
  Pick<CommunityMutationRepository, "setCommunityLifecycleStatus">

export type CommunityLifecycleResult = {
  community_id: string
  status: CommunityRow["status"]
}

/**
 * Archive a community: active -> archived (idempotent on archived). Owner or admin-override
 * only. The canonical status lives on the control-plane communities row; isCommunityLive then
 * blocks new content/membership/commerce/live-room writes for archived communities.
 */
export async function archiveCommunity(input: {
  env: Env
  communityRepository: CommunityLifecycleRepository
  communityId: string
  actor: CommunityMutationActor
}): Promise<CommunityLifecycleResult> {
  const { actor } = input
  const community = await requireAdminOverrideOrOwnedCommunity({
    env: input.env,
    repo: input.communityRepository,
    communityId: input.communityId,
    actor,
    action: "community.archive",
  })

  const now = nowIso()
  const updated = await input.communityRepository.setCommunityLifecycleStatus({
    communityId: input.communityId,
    targetStatus: "archived",
    allowedFromStatuses: ["active", "archived"],
    updatedAt: now,
  })

  await writeAuditEventForEnv(input.env, {
    action: "community.archive",
    actorId: "adminOverride" in actor ? actor.adminOverride.adminActorId : actor.userId,
    actorType: "adminOverride" in actor ? "operator" : "user",
    communityId: input.communityId,
    createdAt: now,
    targetId: input.communityId,
    targetType: "community",
    metadata: {
      status: updated.status,
      owner_user_id: community.creator_user_id,
      ...("adminOverride" in actor
        ? { acting_user_id: actor.userId, scope: actor.adminOverride.scope }
        : {}),
    },
  })

  return { community_id: updated.community_id, status: updated.status }
}

/**
 * Unarchive a community: archived -> active (idempotent on active). Owner or admin-override
 * only. Other lifecycle states (draft/frozen/suspended/deleted) are not self-serve restorable.
 */
export async function unarchiveCommunity(input: {
  env: Env
  communityRepository: CommunityLifecycleRepository
  communityId: string
  actor: CommunityMutationActor
}): Promise<CommunityLifecycleResult> {
  const { actor } = input
  const community = await requireAdminOverrideOrOwnedCommunity({
    env: input.env,
    repo: input.communityRepository,
    communityId: input.communityId,
    actor,
    action: "community.unarchive",
  })

  const now = nowIso()
  const updated = await input.communityRepository.setCommunityLifecycleStatus({
    communityId: input.communityId,
    targetStatus: "active",
    allowedFromStatuses: ["archived", "active"],
    updatedAt: now,
  })

  await writeAuditEventForEnv(input.env, {
    action: "community.unarchive",
    actorId: "adminOverride" in actor ? actor.adminOverride.adminActorId : actor.userId,
    actorType: "adminOverride" in actor ? "operator" : "user",
    communityId: input.communityId,
    createdAt: now,
    targetId: input.communityId,
    targetType: "community",
    metadata: {
      status: updated.status,
      owner_user_id: community.creator_user_id,
      ...("adminOverride" in actor
        ? { acting_user_id: actor.userId, scope: actor.adminOverride.scope }
        : {}),
    },
  })

  return { community_id: updated.community_id, status: updated.status }
}
