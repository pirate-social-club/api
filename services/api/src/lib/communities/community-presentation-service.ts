import type { CommunityMutationActor } from "./create/shared"
import { requireAdminOverrideOrOwnedCommunity } from "./create/shared"
import type {
  CommunityDatabaseBindingRepository,
  CommunityMutationRepository,
  CommunityReadRepository,
} from "./db-community-repository"
import {
  assertCommunityPresentationPatch,
  communityPresentationFromRow,
  type CommunityPresentation,
  type CommunityPresentationPatch,
} from "./community-presentation"
import { nowIso } from "../helpers"
import { writeAuditEventForEnv } from "../audit"
import { publicCommunityId } from "../public-ids"
import type { Env } from "../../env"

export type { CommunityPresentationPatch } from "./community-presentation"

type CommunityPresentationRepository = CommunityReadRepository
  & CommunityDatabaseBindingRepository
  & Pick<CommunityMutationRepository, "updateCommunityPresentation">

export type CommunityPresentationResource = CommunityPresentation & {
  community: string
  id: string
  object: "community_presentation"
}

export async function updateCommunityPresentation(input: {
  actor: CommunityMutationActor
  body: CommunityPresentationPatch | null
  communityId: string
  communityRepository: CommunityPresentationRepository
  env: Env
}): Promise<CommunityPresentationResource> {
  const community = await requireAdminOverrideOrOwnedCommunity({
    action: "community.presentation.update",
    actor: input.actor,
    communityId: input.communityId,
    env: input.env,
    repo: input.communityRepository,
  })
  const current = communityPresentationFromRow(community)
  const next = assertCommunityPresentationPatch(input.body, current)
  const updatedAt = nowIso()
  await input.communityRepository.updateCommunityPresentation({
    brandingJson: JSON.stringify(next.branding),
    communityId: input.communityId,
    defaultSurface: next.default_surface,
    videoFeedEnabled: next.video_feed_enabled,
    updatedAt,
  })
  await writeAuditEventForEnv(input.env, {
    action: "community.presentation.update",
    actorId: "adminOverride" in input.actor
      ? input.actor.adminOverride.adminActorId
      : input.actor.userId,
    actorType: "adminOverride" in input.actor ? "operator" : "user",
    communityId: input.communityId,
    createdAt: updatedAt,
    metadata: {
      default_surface: next.default_surface,
      branding: next.branding,
      video_feed_enabled: next.video_feed_enabled,
    },
    targetId: input.communityId,
    targetType: "community",
  })

  const id = publicCommunityId(input.communityId)
  return {
    ...next,
    community: id,
    id,
    object: "community_presentation",
  }
}
