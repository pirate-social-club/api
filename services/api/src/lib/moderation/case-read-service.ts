import { openCommunityDb } from "../communities/community-db-factory"
import type { CommunityRepository } from "../communities/db-community-repository"
import { notFoundError } from "../errors"
import type { Env } from "../../env"
import {
  getModerationCaseById,
  listModerationCases,
} from "./community-moderation-store"
import type {
  ModerationCaseDetail,
  ModerationCaseListResponse,
} from "./moderation-types"
import { requireOwner } from "./moderation-access"
import { buildModerationCaseDetail } from "./case-detail-service"

export async function listCommunityModerationCases(input: {
  env: Env
  userId: string
  communityId: string
  communityRepository: CommunityRepository
}): Promise<ModerationCaseListResponse> {
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    await requireOwner({
      client: db.client,
      communityId: input.communityId,
      userId: input.userId,
    })
    return {
      items: await listModerationCases({
        executor: db.client,
        communityId: input.communityId,
      }),
      next_cursor: null,
    }
  } finally {
    db.close()
  }
}

export async function getModerationCaseDetail(input: {
  env: Env
  userId: string
  communityId: string
  moderationCaseId: string
  communityRepository: CommunityRepository
}): Promise<ModerationCaseDetail> {
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    await requireOwner({
      client: db.client,
      communityId: input.communityId,
      userId: input.userId,
    })
    const caseRow = await getModerationCaseById({
      executor: db.client,
      moderationCaseId: input.moderationCaseId,
    })
    if (!caseRow || caseRow.community_id !== input.communityId) {
      throw notFoundError("Moderation case not found")
    }
    return await buildModerationCaseDetail({
      caseRow,
      dbClient: db.client,
    })
  } finally {
    db.close()
  }
}
