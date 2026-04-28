import type { UserRepository } from "../../auth/repositories"
import type { CommunityRepository } from "../db-community-repository"
import { gateFailedWithDetails, internalError, notFoundError } from "../../errors"
import { openCommunityDb } from "../community-db-factory"
import {
  canAccessCommunity,
  getCommunityMembershipState,
} from "./membership-state-store"
import { getPendingMembershipRequestByApplicant } from "./membership-request-store"
import { listActiveMembershipGateRules } from "./gate-rule-store"
import {
  buildMembershipGateSummary,
  evaluateMembershipGateRules,
} from "./gates"
import type { CommunityGateRuleRow } from "./gates"
import type {
  Community,
  Env,
  JoinEligibility,
  User,
} from "../../../types"

export function satisfiesBaselineJoinGate(user: User): boolean {
  if (user.verification_capabilities.unique_human.state === "verified") {
    return true
  }

  return user.verification_capabilities.wallet_score.state === "verified"
    && user.verification_capabilities.wallet_score.provider === "passport"
    && user.verification_capabilities.wallet_score.passing_score === true
}

function getRequiredWalletScore(rules: CommunityGateRuleRow[]): number | null {
  let requiredScore: number | null = null
  for (const summary of rules.map(buildMembershipGateSummary)) {
    if (summary.gate_type !== "wallet_score" || typeof summary.minimum_score !== "number") {
      continue
    }
    requiredScore = requiredScore == null ? summary.minimum_score : Math.max(requiredScore, summary.minimum_score)
  }
  return requiredScore
}

export function buildWalletScoreStatus(user: User, rules: CommunityGateRuleRow[]): JoinEligibility["wallet_score_status"] {
  const requiredScore = getRequiredWalletScore(rules)
  if (requiredScore == null) {
    return null
  }
  const capability = user.verification_capabilities.wallet_score
  return {
    current_score: typeof capability.score === "number" ? capability.score : null,
    required_score: requiredScore,
    passing_score: typeof capability.passing_score === "boolean" ? capability.passing_score : null,
    last_score_timestamp: capability.last_score_timestamp ?? null,
  }
}

export function assertBaselineJoinGate(user: User): void {
  if (satisfiesBaselineJoinGate(user)) {
    return
  }
  throw gateFailedWithDetails("A platform trust credential is required to join this community", {
    missing_capabilities: ["unique_human"],
    suggested_verification_provider: "self",
    suggested_verification_intent: "community_join",
    failure_reason: "missing_verification",
  })
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
      const pendingRequest = await getPendingMembershipRequestByApplicant({
        client: db.client,
        communityId: input.communityId,
        userId: input.userId,
      })
      if (pendingRequest) {
        return {
          community_id: input.communityId,
          membership_mode: "request",
          human_verification_lane: "self",
          joinable_now: false,
          status: "pending_request",
          membership_gate_summaries: [],
          missing_capabilities: [],
        }
      }
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
    const walletScoreStatus = buildWalletScoreStatus(user, rules)
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
        ...(walletScoreStatus ? { wallet_score_status: walletScoreStatus } : {}),
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
            : evaluation.mismatchReasons.includes("wallet_score_too_low")
              ? "wallet_score_too_low"
              : evaluation.mismatchReasons.includes("mechanism_not_accepted")
                ? "provider_not_accepted"
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
      ...(walletScoreStatus ? { wallet_score_status: walletScoreStatus } : {}),
    }
  } finally {
    db.close()
  }
}
