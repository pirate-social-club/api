import { openCommunityReadClient, openCommunityWriteClient } from "../communities/community-read-access"
import type { CommunityDatabaseBindingRepository } from "../communities/db-community-repository"
import type { Env } from "../../env"
import { badRequestError, internalError, notFoundError } from "../errors"
import { makeId, nowIso } from "../helpers"
import { getPostById } from "../posts/community-post-query-store"
import { requireAnyCommunityRole } from "../moderation/moderation-access"
import {
  getMediaAnalysisResultById,
  getRightsReviewCaseById,
  listRightsReviewCases,
  updateRightsReviewCaseAction,
} from "./rights-review-store"
import type {
  CreateRightsReviewActionRequest,
  RightsReviewActionType,
  RightsReviewCase,
  RightsReviewCaseDetail,
  RightsReviewCaseListResponse,
  RightsReviewCaseStatus,
  RightsReviewResolution,
} from "./rights-review-types"

const DEFAULT_RIGHTS_REVIEW_LIMIT = 50
const MAX_RIGHTS_REVIEW_LIMIT = 100

function parseLimit(value: string | null | undefined): number {
  if (!value) return DEFAULT_RIGHTS_REVIEW_LIMIT
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_RIGHTS_REVIEW_LIMIT) {
    throw badRequestError("Invalid limit")
  }
  return parsed
}

function parseStatuses(value: string | null | undefined): RightsReviewCaseStatus[] {
  if (!value || value === "active") {
    return ["open", "under_review"]
  }
  if (value === "all") {
    return ["open", "under_review", "resolved", "blocked"]
  }
  const statuses = value.split(",").map((item) => item.trim()).filter(Boolean)
  if (!statuses.length) {
    throw badRequestError("Invalid status")
  }
  for (const status of statuses) {
    if (status !== "open" && status !== "under_review" && status !== "resolved" && status !== "blocked") {
      throw badRequestError("Invalid status")
    }
  }
  return statuses as RightsReviewCaseStatus[]
}

function assertRightsReviewAction(body: CreateRightsReviewActionRequest): RightsReviewActionType {
  const actionType = body.action_type
  if (
    actionType !== "start_review"
    && actionType !== "clear"
    && actionType !== "clear_with_upstream_refs"
    && actionType !== "needs_more_evidence"
    && actionType !== "block"
  ) {
    throw badRequestError("Unsupported rights review action")
  }
  return actionType
}

function normalizeEvidenceRefs(value: string[] | null | undefined): string[] | null {
  if (value == null) return null
  if (!Array.isArray(value)) {
    throw badRequestError("evidence_refs must be an array")
  }
  const refs = value.map((item) => String(item).trim()).filter(Boolean)
  return refs.length ? refs : null
}

function normalizeUpstreamAssetEvidenceRef(ref: string): { upstreamRef: string; localAssetId: string | null } | null {
  const trimmed = ref.trim()
  if (!trimmed) return null
  if (trimmed.startsWith("story:asset:")) {
    const localAssetId = trimmed.slice("story:asset:".length).trim()
    return localAssetId ? { upstreamRef: `story:asset:${localAssetId}`, localAssetId } : null
  }
  if (trimmed.startsWith("asset:")) {
    const localAssetId = trimmed.slice("asset:".length).trim()
    return localAssetId ? { upstreamRef: `story:asset:${localAssetId}`, localAssetId } : null
  }
  if (trimmed.startsWith("ast_")) {
    return { upstreamRef: `story:asset:${trimmed}`, localAssetId: trimmed }
  }
  return { upstreamRef: trimmed, localAssetId: null }
}

function normalizeUpstreamAssetEvidenceRefs(refs: string[] | null): Array<{ upstreamRef: string; localAssetId: string | null }> {
  if (!refs?.length) return []
  const seen = new Set<string>()
  const normalized: Array<{ upstreamRef: string; localAssetId: string | null }> = []
  for (const ref of refs) {
    const item = normalizeUpstreamAssetEvidenceRef(ref)
    if (!item || seen.has(item.upstreamRef)) continue
    seen.add(item.upstreamRef)
    normalized.push(item)
  }
  return normalized
}

function actionPlan(actionType: RightsReviewActionType): {
  status: RightsReviewCaseStatus
  resolution: RightsReviewResolution | null
  terminal: boolean
} {
  switch (actionType) {
    case "start_review":
      return { status: "under_review", resolution: null, terminal: false }
    case "needs_more_evidence":
      return { status: "under_review", resolution: "needs_more_evidence", terminal: false }
    case "block":
      return { status: "blocked", resolution: "block", terminal: true }
    case "clear":
    case "clear_with_upstream_refs":
      return { status: "resolved", resolution: actionType, terminal: true }
  }
}

async function attachUpstreamRefsForRightsReviewResolution(input: {
  dbClient: Parameters<typeof getPostById>[0]
  caseRow: RightsReviewCase
  evidenceRefs: string[] | null
  now: string
}): Promise<void> {
  const refs = normalizeUpstreamAssetEvidenceRefs(input.evidenceRefs)
  if (!refs.length) return

  const analysis = input.caseRow.analysis_result_ref
    ? await getMediaAnalysisResultById({
        executor: input.dbClient,
        mediaAnalysisResultId: input.caseRow.analysis_result_ref,
      })
    : null
  const postId = input.caseRow.subject_type === "post" ? input.caseRow.subject_id : analysis?.source_post_id
  if (!postId) return

  const post = await getPostById(input.dbClient, postId)
  if (!post) return

  const upstreamRefs = Array.from(new Set([
    ...(post.upstream_asset_refs ?? []),
    ...refs.map((ref) => ref.upstreamRef),
  ]))
  await input.dbClient.execute({
    sql: `
      UPDATE posts
      SET upstream_asset_refs_json = ?2,
          updated_at = ?3
      WHERE post_id = ?1
    `,
    args: [postId, JSON.stringify(upstreamRefs), input.now],
  })

  const subjectAssetId = input.caseRow.subject_type === "asset" ? input.caseRow.subject_id : post.asset_id
  if (!subjectAssetId) return
  const localAssetIds = refs
    .map((ref) => ref.localAssetId)
    .filter((assetId): assetId is string => Boolean(assetId))
  for (const upstreamAssetId of localAssetIds) {
    await input.dbClient.execute({
      sql: `
        INSERT INTO asset_derivative_links (
          asset_derivative_link_id, asset_id, upstream_asset_id, relationship_type, created_at
        )
        SELECT ?1, ?2, ?3, 'references_song', ?4
        WHERE NOT EXISTS (
          SELECT 1 FROM asset_derivative_links
          WHERE asset_id = ?2 AND upstream_asset_id = ?3 AND relationship_type = 'references_song'
        )
      `,
      args: [makeId("adl"), subjectAssetId, upstreamAssetId, input.now],
    })
  }
}

async function buildRightsReviewCaseDetail(input: {
  dbClient: Parameters<typeof getPostById>[0]
  caseRow: RightsReviewCase
}): Promise<RightsReviewCaseDetail> {
  const analysis = input.caseRow.analysis_result_ref
    ? await getMediaAnalysisResultById({
        executor: input.dbClient,
        mediaAnalysisResultId: input.caseRow.analysis_result_ref,
      })
    : null
  const postId = input.caseRow.subject_type === "post" ? input.caseRow.subject_id : analysis?.source_post_id
  const post = postId ? await getPostById(input.dbClient, postId) : null
  return {
    case: input.caseRow,
    analysis,
    post,
  }
}

export async function listCommunityRightsReviewCases(input: {
  env: Env
  userId: string
  communityId: string
  status?: string | null
  limit?: string | null
  communityRepository: CommunityDatabaseBindingRepository
}): Promise<RightsReviewCaseListResponse> {
  const db = await openCommunityReadClient(input.env, input.communityRepository, input.communityId)
  try {
    await requireAnyCommunityRole({
      client: db.client,
      communityId: input.communityId,
      userId: input.userId,
    })
    return {
      items: await listRightsReviewCases({
        executor: db.client,
        communityId: input.communityId,
        statuses: parseStatuses(input.status),
        limit: parseLimit(input.limit),
      }),
      next_cursor: null,
    }
  } finally {
    db.close()
  }
}

export async function getRightsReviewCaseDetail(input: {
  env: Env
  userId: string
  communityId: string
  rightsReviewCaseId: string
  communityRepository: CommunityDatabaseBindingRepository
}): Promise<RightsReviewCaseDetail> {
  const db = await openCommunityReadClient(input.env, input.communityRepository, input.communityId)
  try {
    await requireAnyCommunityRole({
      client: db.client,
      communityId: input.communityId,
      userId: input.userId,
    })
    const caseRow = await getRightsReviewCaseById({
      executor: db.client,
      rightsReviewCaseId: input.rightsReviewCaseId,
    })
    if (!caseRow || caseRow.community_id !== input.communityId) {
      throw notFoundError("Rights review case not found")
    }
    return await buildRightsReviewCaseDetail({
      dbClient: db.client,
      caseRow,
    })
  } finally {
    db.close()
  }
}

export async function applyRightsReviewCaseAction(input: {
  env: Env
  userId: string
  communityId: string
  rightsReviewCaseId: string
  body: CreateRightsReviewActionRequest
  communityRepository: CommunityDatabaseBindingRepository
}): Promise<RightsReviewCaseDetail> {
  const actionType = assertRightsReviewAction(input.body)
  const evidenceRefs = normalizeEvidenceRefs(input.body.evidence_refs)
  const plan = actionPlan(actionType)
  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.communityId)
  try {
    await requireAnyCommunityRole({
      client: db.client,
      communityId: input.communityId,
      userId: input.userId,
    })
    const caseRow = await getRightsReviewCaseById({
      executor: db.client,
      rightsReviewCaseId: input.rightsReviewCaseId,
    })
    if (!caseRow || caseRow.community_id !== input.communityId) {
      throw notFoundError("Rights review case not found")
    }
    if (caseRow.status === "resolved" || caseRow.status === "blocked") {
      throw badRequestError("Rights review case is already closed")
    }

    const now = nowIso()
    if (actionType === "clear_with_upstream_refs") {
      await attachUpstreamRefsForRightsReviewResolution({
        dbClient: db.client,
        caseRow,
        evidenceRefs,
        now,
      })
    }

    await updateRightsReviewCaseAction({
      executor: db.client,
      rightsReviewCaseId: input.rightsReviewCaseId,
      status: plan.status,
      resolution: plan.resolution,
      resolverUserId: input.userId,
      evidenceRefs,
      resolvedAt: plan.terminal ? now : null,
      now,
    })

    if (plan.terminal && caseRow.analysis_result_ref) {
      await db.client.execute({
        sql: `
          UPDATE media_analysis_results
          SET resolved_at = ?2,
              updated_at = ?2
          WHERE media_analysis_result_id = ?1
        `,
        args: [caseRow.analysis_result_ref, now],
      })
    }

    const updatedCase = await getRightsReviewCaseById({
      executor: db.client,
      rightsReviewCaseId: input.rightsReviewCaseId,
    })
    if (!updatedCase) {
      throw internalError("Rights review case is missing after action")
    }
    return await buildRightsReviewCaseDetail({
      dbClient: db.client,
      caseRow: updatedCase,
    })
  } finally {
    db.close()
  }
}
