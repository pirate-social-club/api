import type {
  CommunityHandleListResponse,
  CommunityHandleMeResponse,
  CommunityHandlePolicy,
  CommunityHandleStatusResponse,
  Env,
} from "../../../types"
import { HttpError, badRequestError, eligibilityFailed, notFoundError } from "../../errors"
import { openCommunityReadClient } from "../community-read-access"
import { requireCommunityOwner } from "../commerce/access"
import { requireHandleClaimAccess } from "./handle-access"
import { listNamespaceLabelClaimRules } from "./handle-label-claim-rules"
import {
  HANDLE_PROTOCOL_ISSUANCE_JOIN,
  HANDLE_PROTOCOL_ISSUANCE_SELECT,
  getActiveHandleForUser,
  serializeHandle,
} from "./handle-row-store"
import {
  type HandleCommunityRepository,
  getNamespacePolicy,
  serializeHandlePolicy,
  withHandlePrefix,
} from "./handle-policy-service"

export async function getMyCommunityHandle(input: {
  env: Env
  userId: string
  communityId: string
  namespaceVerificationId?: string | null
  communityRepository: HandleCommunityRepository
}): Promise<CommunityHandleMeResponse> {
  const community = await input.communityRepository.getCommunityById(input.communityId)
  if (!community) {
    throw notFoundError("Community not found")
  }
  const db = await openCommunityReadClient(input.env, input.communityRepository, input.communityId)
  try {
    const policy = await getNamespacePolicy(db.client, input.communityId, {
      namespaceVerificationId: input.namespaceVerificationId,
    })
    if (!policy) {
      return { handle: null }
    }
    const handle = await getActiveHandleForUser(db.client, policy.namespace_id, input.userId)
    return { handle: handle ? serializeHandle(handle) : null }
  } finally {
    db.close()
  }
}

export async function getCommunityHandleStatus(input: {
  env: Env
  userId: string
  communityId: string
  namespaceVerificationId?: string | null
  communityRepository: HandleCommunityRepository
}): Promise<CommunityHandleStatusResponse> {
  const community = await input.communityRepository.getCommunityById(input.communityId)
  if (!community) {
    throw notFoundError("Community not found")
  }
  const db = await openCommunityReadClient(input.env, input.communityRepository, input.communityId)
  try {
    const policy = await getNamespacePolicy(db.client, input.communityId, {
      namespaceVerificationId: input.namespaceVerificationId,
    })
    if (!policy) {
      return {
        available: false,
        reason: "Community names are not available for this community",
        claims_enabled: null,
        namespace: null,
      }
    }
    if (!policy.claims_enabled) {
      return {
        available: false,
        reason: "Community name claims are currently disabled",
        claims_enabled: false,
        namespace: withHandlePrefix("ns", policy.namespace_id),
      }
    }
    const access = await requireHandleClaimAccess({
      client: db.client,
      communityId: input.communityId,
      userId: input.userId,
    }).catch((error: unknown) => {
      if (error instanceof HttpError && error.code === "eligibility_failed") {
        return { blockedReason: error.message }
      }
      throw error
    })
    if ("blockedReason" in access) {
      return {
        available: false,
        reason: access.blockedReason,
        claims_enabled: true,
        namespace: withHandlePrefix("ns", policy.namespace_id),
      }
    }
    return {
      available: true,
      reason: null,
      claims_enabled: true,
      namespace: withHandlePrefix("ns", policy.namespace_id),
    }
  } finally {
    db.close()
  }
}

export async function getCommunityHandlePolicy(input: {
  env: Env
  userId: string
  communityId: string
  namespaceVerificationId?: string | null
  communityRepository: HandleCommunityRepository
}): Promise<CommunityHandlePolicy> {
  await requireCommunityOwner({
    communityId: input.communityId,
    userId: input.userId,
    communityRepository: input.communityRepository,
  })
  const db = await openCommunityReadClient(input.env, input.communityRepository, input.communityId)
  try {
    const policy = await getNamespacePolicy(db.client, input.communityId, {
      namespaceVerificationId: input.namespaceVerificationId,
    })
    if (!policy) {
      throw eligibilityFailed("Community names are not available for this community")
    }
    const labelClaimRules = await listNamespaceLabelClaimRules(db.client, policy.namespace_handle_policy_id)
    return serializeHandlePolicy(policy, labelClaimRules)
  } finally {
    db.close()
  }
}

export async function listCommunityHandles(input: {
  env: Env
  userId: string
  communityId: string
  namespaceVerificationId?: string | null
  status?: string | null
  communityRepository: HandleCommunityRepository
}): Promise<CommunityHandleListResponse> {
  await requireCommunityOwner({
    communityId: input.communityId,
    userId: input.userId,
    communityRepository: input.communityRepository,
  })
  const db = await openCommunityReadClient(input.env, input.communityRepository, input.communityId)
  try {
    const policy = await getNamespacePolicy(db.client, input.communityId, {
      namespaceVerificationId: input.namespaceVerificationId,
    })
    if (!policy) {
      throw eligibilityFailed("Community names are not available for this community")
    }
    const status = input.status?.trim()
    const allowedStatuses = new Set(["active", "grace_period", "expired", "revoked", "reserved"])
    if (status && !allowedStatuses.has(status)) {
      throw badRequestError("Invalid handle status")
    }
    const result = await db.client.execute({
      sql: `
        SELECT ${HANDLE_PROTOCOL_ISSUANCE_SELECT}
        FROM community_handles ch
        ${HANDLE_PROTOCOL_ISSUANCE_JOIN}
        WHERE ch.community_id = ?1
          AND ch.namespace_id = ?2
          AND (?3 IS NULL OR ch.status = ?3)
        ORDER BY ch.created_at DESC
        LIMIT 200
      `,
      args: [input.communityId, policy.namespace_id, status || null],
    })
    return { handles: result.rows.map(serializeHandle) }
  } finally {
    db.close()
  }
}
