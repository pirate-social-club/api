import {
  buildLocalizedCommunity,
  enqueueCommunityTextTranslationOnReadIfNeeded,
} from "../../localization/community-localization-service"
import { notFoundError } from "../../errors"
import { nowIso } from "../../helpers"
import { loadCommunityProjection, requireOwnedCommunity } from "../create/service"
import { openCommunityWriteClient } from "../community-read-access"
import type { Env } from "../../../env"
import type { Community } from "../../../types"
import type { CommunityMembershipRepository } from "./types"

export async function setPendingNamespaceVerificationSession(input: {
  env: Env
  userId: string
  communityId: string
  sessionId: string | null
  communityRepository: CommunityMembershipRepository
}): Promise<Community> {
  await requireOwnedCommunity(input.communityRepository, input.communityId, input.userId)
  await input.communityRepository.setPendingNamespaceVerificationSession({
    communityId: input.communityId,
    sessionId: input.sessionId,
    updatedAt: nowIso(),
  })

  const updated = await input.communityRepository.getCommunityById(input.communityId)
  if (!updated) {
    throw notFoundError("Community not found")
  }
  return loadCommunityProjection(input.env, input.communityRepository, updated)
}

export async function getCommunity(input: {
  env: Env
  userId: string
  communityId: string
  locale?: string | null
  repository: CommunityMembershipRepository
}): Promise<Community> {
  const community = await requireOwnedCommunity(input.repository, input.communityId, input.userId)
  const canonical = await loadCommunityProjection(input.env, input.repository, community)
  if (input.locale == null) {
    return canonical
  }

  const db = await openCommunityWriteClient(input.env, input.repository, input.communityId)
  try {
    const localized = await buildLocalizedCommunity({
      executor: db.client,
      community: canonical,
      locale: input.locale ?? null,
    })
    await enqueueCommunityTextTranslationOnReadIfNeeded({
      executor: db.client,
      communityId: input.communityId,
      localization: localized.localized_text,
    })
    return localized
  } finally {
    db.close()
  }
}
