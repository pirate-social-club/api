import {
  canAccessCommunity,
  buildMembershipGateSummary,
  evaluateMembershipGateRules,
  getCommunityJoinMode,
  getCommunityMembershipState,
  listActiveMembershipGateRules,
  upsertCommunityMembership,
  upsertMembershipRequest,
} from "./store"
import { openCommunityDb } from "../community-db-factory"
import {
  buildLocalizedCommunity,
  enqueueCommunityTextTranslationOnReadIfNeeded,
} from "../../localization/community-localization-service"
import type { UserRepository } from "../../auth/repositories"
import type { CommunityRepository } from "../db-community-repository"
import { gateFailedWithDetails, internalError, notFoundError } from "../../errors"
import { nowIso } from "../../helpers"
import { loadCommunityProjection, requireOwnedCommunity } from "../create/service"

import { serializeJob } from "../community-serialization"
import type {
  Community,
  Env,
  JoinEligibility,
  Job,
  User,
} from "../../../types"

type MembershipResult = {
  community_id: string
  status: "joined" | "requested" | "left"
}

export { getCommunityPreview, getPublicCommunityPreview } from "../community-preview-service"

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
    const walletAttachments = await input.userRepository.getWalletAttachmentsByUserId(input.userId)
    const evaluation = await evaluateMembershipGateRules({
      env: input.env,
      rules,
      user,
      walletAttachments,
    })
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

    const failureReason = evaluation.mismatchReasons.includes("token_inventory_unavailable")
      ? "token_inventory_unavailable"
      : evaluation.mismatchReasons.includes("erc721_inventory_match_required")
        ? "erc721_inventory_match_required"
        : evaluation.mismatchReasons.includes("erc721_holding_required")
          ? "erc721_holding_required"
          : evaluation.mismatchReasons.includes("minimum_age_mismatch")
            ? "minimum_age_mismatch"
            : null
    return {
      community_id: input.communityId,
      membership_mode: membershipMode,
      human_verification_lane: "self",
      joinable_now: false,
      status: "gate_failed",
      membership_gate_summaries: gateSummaries,
      missing_capabilities: [],
      failure_reason: failureReason,
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
    const walletAttachments = await input.userRepository.getWalletAttachmentsByUserId(input.userId)
    const evaluation = await evaluateMembershipGateRules({
      env: input.env,
      rules,
      user,
      walletAttachments,
    })
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
      if (evaluation.mismatchReasons.includes("minimum_age_mismatch")) {
        throw gateFailedWithDetails("Your verified age does not satisfy this community requirement", {
          membership_gate_summaries: gateSummaries,
          failure_reason: "minimum_age_mismatch",
        })
      }
      if (evaluation.mismatchReasons.includes("erc721_holding_required")) {
        throw gateFailedWithDetails("A linked Ethereum wallet holding this NFT collection is required to join", {
          membership_gate_summaries: gateSummaries,
          failure_reason: "erc721_holding_required",
        })
      }
      if (evaluation.mismatchReasons.includes("token_inventory_unavailable")) {
        throw gateFailedWithDetails("Collectible inventory could not be checked right now", {
          membership_gate_summaries: gateSummaries,
          failure_reason: "token_inventory_unavailable",
        })
      }
      if (evaluation.mismatchReasons.includes("erc721_inventory_match_required")) {
        throw gateFailedWithDetails("A linked wallet holding the required collectible inventory is required to join", {
          membership_gate_summaries: gateSummaries,
          failure_reason: "erc721_inventory_match_required",
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
