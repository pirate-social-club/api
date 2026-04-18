import {
  canAccessCommunity,
  buildMembershipGateSummary,
  evaluateMembershipGateRules,
  getCommunityJoinMode,
  getCommunityMembershipState,
  listActiveMembershipGateRules,
  upsertCommunityMembership,
  upsertMembershipRequest,
} from "./community-membership-store"
import { openCommunityDb } from "./community-db-factory"
import {
  resolveCommunityAvatarRef,
  resolveCommunityBannerRef,
} from "./community-identity-media"
import type { UserRepository } from "../auth/repositories"
import type { CommunityRepository } from "./db-community-repository"
import { gateFailedWithDetails, internalError, notFoundError } from "../errors"
import { nowIso } from "../helpers"
import { loadCommunityProjection, requireOwnedCommunity } from "./community-create-service"
import { serializeJob } from "./community-serialization"
import type {
  Community,
  CommunityPreview,
  Env,
  JoinEligibility,
  Job,
  User,
} from "../../types"

type MembershipResult = {
  community_id: string
  status: "joined" | "requested" | "left"
}

export function satisfiesBaselineJoinGate(user: User): boolean {
  if (user.verification_capabilities.unique_human.state === "verified") {
    return true
  }

  return user.verification_capabilities.wallet_score.state === "verified"
    && user.verification_capabilities.wallet_score.provider === "passport"
    && user.verification_capabilities.wallet_score.passing_score === true
}

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
  repository: CommunityRepository
}): Promise<Community> {
  const community = await requireOwnedCommunity(input.repository, input.communityId, input.userId)
  return loadCommunityProjection(input.env, input.repository, community)
}

export async function getCommunityPreview(input: {
  env: Env
  userId: string
  communityId: string
  communityRepository: CommunityRepository
}): Promise<CommunityPreview> {
  const community = await input.communityRepository.getCommunityById(input.communityId)
  if (!community || community.provisioning_state !== "active" || community.status !== "active") {
    throw notFoundError("Community not found")
  }

  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    const rules = await listActiveMembershipGateRules(db.client, input.communityId)
    const membership = await getCommunityMembershipState(db.client, input.communityId, input.userId)
    return await buildCommunityPreview({
      client: db.client,
      communityId: input.communityId,
      communityDisplayName: community.display_name,
      communityCreatedAt: community.created_at,
      rules,
      viewerMembershipStatus:
        membership.membership_status === "banned"
          ? "banned"
          : canAccessCommunity(membership)
            ? "member"
            : "not_member",
    })
  } finally {
    db.close()
  }
}

export async function getPublicCommunityPreview(input: {
  env: Env
  communityId: string
  communityRepository: CommunityRepository
}): Promise<CommunityPreview> {
  const community = await input.communityRepository.getCommunityById(input.communityId)
  if (!community || community.provisioning_state !== "active" || community.status !== "active") {
    throw notFoundError("Community not found")
  }

  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    const rules = await listActiveMembershipGateRules(db.client, input.communityId)
    return await buildCommunityPreview({
      client: db.client,
      communityId: input.communityId,
      communityDisplayName: community.display_name,
      communityCreatedAt: community.created_at,
      rules,
      viewerMembershipStatus: "not_member",
    })
  } finally {
    db.close()
  }
}

async function buildCommunityPreview(input: {
  client: Awaited<ReturnType<typeof openCommunityDb>>["client"]
  communityId: string
  communityDisplayName: string
  communityCreatedAt: string
  rules: Awaited<ReturnType<typeof listActiveMembershipGateRules>>
  viewerMembershipStatus: CommunityPreview["viewer_membership_status"]
}): Promise<CommunityPreview> {
  const localResult = await input.client.execute({
    sql: `SELECT display_name, description, avatar_ref, banner_ref, membership_mode FROM communities WHERE community_id = ?1 LIMIT 1`,
    args: [input.communityId],
  })
  const localRow = localResult.rows[0]
  const membershipMode: CommunityPreview["membership_mode"] =
    localRow?.membership_mode === "open" || localRow?.membership_mode === "request" || localRow?.membership_mode === "gated"
      ? (localRow.membership_mode as CommunityPreview["membership_mode"])
      : "open"
  const displayName = localRow?.display_name ? String(localRow.display_name) : input.communityDisplayName

  return {
    community_id: input.communityId,
    display_name: displayName,
    description: localRow?.description != null ? String(localRow.description) : null,
    avatar_ref: resolveCommunityAvatarRef({
      communityId: input.communityId,
      displayName,
      avatarRef: localRow?.avatar_ref == null ? null : String(localRow.avatar_ref),
    }),
    banner_ref: resolveCommunityBannerRef({
      communityId: input.communityId,
      displayName,
      bannerRef: localRow?.banner_ref == null ? null : String(localRow.banner_ref),
    }),
    membership_mode: membershipMode,
    human_verification_lane: "self",
    member_count: null,
    membership_gate_summaries: input.rules.map(buildMembershipGateSummary),
    viewer_membership_status: input.viewerMembershipStatus,
    created_at: input.communityCreatedAt,
  }
}

export async function getJoinEligibility(input: {
  env: Env
  userId: string
  communityId: string
  userRepository: UserRepository
  communityRepository: CommunityRepository
}): Promise<JoinEligibility> {
  const user = await input.userRepository.getUserById(input.userId)
  if (!user) {
    throw internalError("Resolved user row is missing for join eligibility")
  }

  const community = await input.communityRepository.getCommunityById(input.communityId)
  if (!community || community.provisioning_state !== "active" || community.status !== "active") {
    throw notFoundError("Community not found")
  }

  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    const localResult = await db.client.execute({
      sql: `SELECT membership_mode FROM communities WHERE community_id = ?1 LIMIT 1`,
      args: [input.communityId],
    })
    const membershipMode: Community["membership_mode"] =
      localResult.rows[0]?.membership_mode === "open" || localResult.rows[0]?.membership_mode === "request" || localResult.rows[0]?.membership_mode === "gated"
        ? (localResult.rows[0].membership_mode as Community["membership_mode"])
        : "open"

    const membership = await getCommunityMembershipState(db.client, input.communityId, input.userId)
    if (canAccessCommunity(membership)) {
      return {
        community_id: input.communityId,
        membership_mode: membershipMode,
        human_verification_lane: "self",
        joinable_now: false,
        status: "already_joined",
        membership_gate_summaries: [],
        missing_capabilities: [],
      }
    }

    if (membership.membership_status === "banned") {
      return {
        community_id: input.communityId,
        membership_mode: membershipMode,
        human_verification_lane: "self",
        joinable_now: false,
        status: "banned",
        membership_gate_summaries: [],
        missing_capabilities: [],
      }
    }

    if (!satisfiesBaselineJoinGate(user)) {
      return {
        community_id: input.communityId,
        membership_mode: membershipMode,
        human_verification_lane: "self",
        joinable_now: false,
        status: "verification_required",
        membership_gate_summaries: [],
        missing_capabilities: ["unique_human"],
        suggested_verification_provider: "self",
        suggested_verification_intent: "community_join",
      }
    }

    if (membershipMode === "open") {
      return {
        community_id: input.communityId,
        membership_mode: "open",
        human_verification_lane: "self",
        joinable_now: true,
        status: "joinable",
        membership_gate_summaries: [],
        missing_capabilities: [],
      }
    }

    if (membershipMode === "request") {
      return {
        community_id: input.communityId,
        membership_mode: "request",
        human_verification_lane: "self",
        joinable_now: false,
        status: "requestable",
        membership_gate_summaries: [],
        missing_capabilities: [],
      }
    }

    const rules = await listActiveMembershipGateRules(db.client, input.communityId)
    const gateSummaries = rules.map(buildMembershipGateSummary)
    const evaluation = evaluateMembershipGateRules(rules, user)
    if (evaluation.satisfied) {
      return {
        community_id: input.communityId,
        membership_mode: membershipMode,
        human_verification_lane: "self",
        joinable_now: true,
        status: "joinable",
        membership_gate_summaries: gateSummaries,
        missing_capabilities: [],
      }
    }

    if (evaluation.missingCapabilities.length > 0) {
      return {
        community_id: input.communityId,
        membership_mode: membershipMode,
        human_verification_lane: "self",
        joinable_now: false,
        status: "verification_required",
        membership_gate_summaries: gateSummaries,
        missing_capabilities: evaluation.missingCapabilities,
        suggested_verification_provider: evaluation.suggestedVerificationProvider,
        suggested_verification_intent: evaluation.suggestedVerificationProvider === "self"
          ? "community_join"
          : null,
      }
    }

    return {
      community_id: input.communityId,
      membership_mode: membershipMode,
      human_verification_lane: "self",
      joinable_now: false,
      status: "gate_failed",
      membership_gate_summaries: gateSummaries,
      missing_capabilities: [],
    }
  } finally {
    db.close()
  }
}

export async function joinCommunity(input: {
  env: Env
  userId: string
  communityId: string
  userRepository: UserRepository
  communityRepository: CommunityRepository
}): Promise<MembershipResult> {
  const user = await input.userRepository.getUserById(input.userId)
  if (!user) {
    throw internalError("Resolved user row is missing for community join")
  }
  if (!satisfiesBaselineJoinGate(user)) {
    throw gateFailedWithDetails("A platform trust credential is required to join this community", {
      missing_capabilities: ["unique_human"],
      suggested_verification_provider: "self",
      suggested_verification_intent: "community_join",
      failure_reason: "missing_verification",
    })
  }

  const community = await input.communityRepository.getCommunityById(input.communityId)
  if (!community || community.provisioning_state !== "active" || community.status !== "active") {
    throw notFoundError("Community not found")
  }

  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    const membership = await getCommunityMembershipState(db.client, input.communityId, input.userId)
    if (canAccessCommunity(membership)) {
      return {
        community_id: input.communityId,
        status: "joined",
      }
    }
    if (membership.membership_status === "banned") {
      throw gateFailedWithDetails("Community membership is not available for this account", {
        failure_reason: "banned",
      })
    }

    const membershipMode = await getCommunityJoinMode(db.client, input.communityId)
    if (!membershipMode) {
      throw notFoundError("Community not found")
    }

    const now = nowIso()
    if (membershipMode === "open") {
      await upsertCommunityMembership({
        client: db.client,
        communityId: input.communityId,
        userId: input.userId,
        now,
      })
      await input.communityRepository.upsertCommunityMembershipProjection({
        communityId: input.communityId,
        userId: input.userId,
        membershipState: "member",
        sourceUpdatedAt: now,
        createdAt: now,
      })
      return {
        community_id: input.communityId,
        status: "joined",
      }
    }

    if (membershipMode === "request") {
      await upsertMembershipRequest({
        client: db.client,
        communityId: input.communityId,
        userId: input.userId,
        now,
      })
      await input.communityRepository.upsertCommunityMembershipProjection({
        communityId: input.communityId,
        userId: input.userId,
        membershipState: "pending_request",
        sourceUpdatedAt: now,
        createdAt: now,
      })
      return {
        community_id: input.communityId,
        status: "requested",
      }
    }

    const rules = await listActiveMembershipGateRules(db.client, input.communityId)
    const gateSummaries = rules.map(buildMembershipGateSummary)
    const evaluation = evaluateMembershipGateRules(rules, user)
    if (!evaluation.satisfied) {
      if (evaluation.missingCapabilities.length > 0) {
        throw gateFailedWithDetails("Verification is required to join this community", {
          membership_gate_summaries: gateSummaries,
          missing_capabilities: evaluation.missingCapabilities,
          suggested_verification_provider: evaluation.suggestedVerificationProvider,
          suggested_verification_intent: evaluation.suggestedVerificationProvider === "self"
            ? "community_join"
            : null,
          failure_reason: "missing_verification",
        })
      }
      if (evaluation.mismatchReasons.includes("nationality_mismatch")) {
        throw gateFailedWithDetails("Your verified nationality does not satisfy this community requirement", {
          membership_gate_summaries: gateSummaries,
          failure_reason: "nationality_mismatch",
        })
      }
      if (evaluation.mismatchReasons.includes("gender_mismatch")) {
        throw gateFailedWithDetails("Your verified gender does not satisfy this community requirement", {
          membership_gate_summaries: gateSummaries,
          failure_reason: "gender_mismatch",
        })
      }
      throw gateFailedWithDetails("Community membership requirements are not satisfied", {
        membership_gate_summaries: gateSummaries,
        failure_reason: "unsupported",
      })
    }
    await upsertCommunityMembership({
      client: db.client,
      communityId: input.communityId,
      userId: input.userId,
      now,
    })
    await input.communityRepository.upsertCommunityMembershipProjection({
      communityId: input.communityId,
      userId: input.userId,
      membershipState: "member",
      sourceUpdatedAt: now,
      createdAt: now,
    })
    return {
      community_id: input.communityId,
      status: "joined",
    }
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
