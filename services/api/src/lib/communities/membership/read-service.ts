import type { CommunityRepository } from "../db-community-repository"
import { openCommunityDb } from "../community-db-factory"
import {
  buildLocalizedCommunity,
  enqueueCommunityTextTranslationOnReadIfNeeded,
} from "../../localization/community-localization-service"
import { notFoundError } from "../../errors"
import { nowIso } from "../../helpers"
import { loadCommunityProjection, requireOwnedCommunity } from "../create/repository"
import { serializeJob } from "../community-serialization"
import type {
  Community,
  Env,
  Job,
} from "../../../types"

export async function setPendingNamespaceVerificationSession(input: {
  env: Env
  userId: string
  communityId: string
  sessionId: string | null
  communityRepository: CommunityRepository
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
  repository: CommunityRepository
}): Promise<Community> {
  const community = await requireOwnedCommunity(input.repository, input.communityId, input.userId)
  const canonical = await loadCommunityProjection(input.env, input.repository, community)
  if (input.locale == null) {
    return canonical
  }

  const db = await openCommunityDb(input.env, input.repository, input.communityId)
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

export async function getJob(input: {
  env: Env
  userId: string
  jobId: string
  repository: CommunityRepository
}): Promise<Job> {
  const job = await input.repository.getJobById(input.jobId)
  if (!job) {
    throw notFoundError("Job not found")
  }
  if (!job.community_id) {
    throw notFoundError("Job not found")
  }
  await requireOwnedCommunity(input.repository, job.community_id, input.userId)
  return serializeJob(job)
}
