import type { UserRepository } from "../../auth/repositories"
import { internalError, notFoundError } from "../../errors"
import type { Env } from "../../../env"
import type { Community, JoinEligibility, User } from "../../../types"
import { openCommunityDb } from "../community-db-factory"
import {
  buildMembershipGateSummariesFromPolicy,
  flattenGatePolicyAtoms,
  evaluateMembershipGatePolicy,
} from "./gates"
import {
  canAccessCommunity,
  getCommunityMembershipState,
} from "./membership-state-store"
import { getPendingMembershipRequestByApplicant } from "./membership-request-store"
import { getMembershipGatePolicy } from "./gate-policy-store"
import type { GatePolicy, GatePolicyEvaluation, RequiredActionNode, RequiredActionSet } from "./gate-types"
import type { CommunityMembershipRepository } from "./types"
import { gateFailureReasonFromPolicyEvaluation } from "./gate-failure-service"
import { publicCommunityId } from "../../public-ids"

export function satisfiesBaselineJoinGate(user: User): boolean {
  if (user.verification_capabilities.unique_human.state === "verified") {
    return true
  }

  return user.verification_capabilities.wallet_score.state === "verified"
    && user.verification_capabilities.wallet_score.provider === "passport"
    && user.verification_capabilities.wallet_score.passing_score === true
}

function getRequiredWalletScore(policy: GatePolicy | null): number | null {
  let requiredScore: number | null = null
  for (const atom of flattenGatePolicyAtoms(policy)) {
    if (atom.type !== "wallet_score") {
      continue
    }
    requiredScore = requiredScore == null ? atom.minimum_score : Math.max(requiredScore, atom.minimum_score)
  }
  return requiredScore
}

function flattenRequiredActions(actionSet: RequiredActionSet | null): RequiredActionNode[] {
  if (!actionSet) {
    return []
  }
  return actionSet.items.flatMap((item) => item.kind === "set" ? flattenRequiredActions(item) : [item])
}

function missingCapabilitiesFromRequiredActionSet(
  actionSet: RequiredActionSet | null,
): NonNullable<JoinEligibility["missing_capabilities"]> {
  const capabilities = new Set<NonNullable<JoinEligibility["missing_capabilities"]>[number]>()
  for (const item of flattenRequiredActions(actionSet)) {
    if (item.kind !== "action") {
      continue
    }
    if (
      item.capability === "minimum_age"
      || item.capability === "nationality"
      || item.capability === "gender"
      || item.capability === "unique_human"
      || item.capability === "wallet_score"
    ) {
      capabilities.add(item.capability)
    }
  }
  return [...capabilities]
}

function suggestedProviderFromRequiredActionSet(
  actionSet: RequiredActionSet | null,
): JoinEligibility["suggested_verification_provider"] {
  const action = flattenRequiredActions(actionSet).find((item) => (
    item.kind === "action"
    && (item.provider === "self" || item.provider === "very" || item.provider === "passport")
  ))
  return action?.kind === "action" && (action.provider === "self" || action.provider === "very" || action.provider === "passport")
    ? action.provider
    : null
}

export function buildWalletScoreStatus(
  user: User,
  policy: GatePolicy | null,
): JoinEligibility["wallet_score_status"] {
  const requiredScore = getRequiredWalletScore(policy)
  if (requiredScore == null) {
    return null
  }
  const capability = user.verification_capabilities.wallet_score
  return {
    current_score_decimal: capability.score_decimal ?? null,
    required_score_decimal: String(requiredScore),
    passing_score: typeof capability.passing_score === "boolean" ? capability.passing_score : null,
    last_scored_at: capability.last_scored_at ?? null,
  }
}

export async function evaluateGatedMembership(input: {
  env: Env
  user: User
  userRepository: Pick<UserRepository, "getWalletAttachmentsByUserId">
  communityId: string
  policy: GatePolicy | null
}): Promise<{
  gateSummaries: ReturnType<typeof buildMembershipGateSummariesFromPolicy>
  walletScoreStatus: JoinEligibility["wallet_score_status"]
  evaluation: GatePolicyEvaluation
}> {
  const gateSummaries = buildMembershipGateSummariesFromPolicy(input.policy)
  const walletScoreStatus = buildWalletScoreStatus(input.user, input.policy)
  const walletAttachments = await input.userRepository.getWalletAttachmentsByUserId(input.user.user_id)
  const evaluation = await evaluateMembershipGatePolicy({
    env: input.env,
    policy: input.policy,
    user: input.user,
    walletAttachments,
  })
  return { gateSummaries, walletScoreStatus, evaluation }
}

export async function getJoinEligibility(input: {
  env: Env
  userId: string
  communityId: string
  userRepository: UserRepository
  communityRepository: CommunityMembershipRepository
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
      localResult.rows[0]?.membership_mode === "request" || localResult.rows[0]?.membership_mode === "gated"
        ? (localResult.rows[0].membership_mode as Community["membership_mode"])
        : "request"

    const membership = await getCommunityMembershipState(db.client, input.communityId, input.userId)
    if (canAccessCommunity(membership)) {
      return {
        community: publicCommunityId(input.communityId),
        membership_mode: membershipMode,
        human_verification_lane: "self",
        joinable_now: false,
        status: "already_joined",
        membership_gate_summaries: [],
        gate_evaluation: null,
      }
    }

    if (membership.membership_status === "banned") {
      return {
        community: publicCommunityId(input.communityId),
        membership_mode: membershipMode,
        human_verification_lane: "self",
        joinable_now: false,
        status: "banned",
        membership_gate_summaries: [],
        gate_evaluation: null,
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
         community: publicCommunityId(input.communityId),
          membership_mode: "request",
          human_verification_lane: "self",
          joinable_now: false,
          status: "pending_request",
          membership_gate_summaries: [],
          gate_evaluation: null,
        }
      }
      return {
        community: publicCommunityId(input.communityId),
        membership_mode: "request",
        human_verification_lane: "self",
        joinable_now: false,
        status: "requestable",
        membership_gate_summaries: [],
        gate_evaluation: null,
      }
    }

    const policy = await getMembershipGatePolicy(db.client, input.communityId)
    const { gateSummaries, walletScoreStatus, evaluation } = await evaluateGatedMembership({
      env: input.env,
      user,
      userRepository: input.userRepository,
      communityId: input.communityId,
      policy,
    })
    const gateEvaluation: NonNullable<JoinEligibility["gate_evaluation"]> = {
      passed: evaluation.satisfied,
      trace: evaluation.trace,
      required_action_set: evaluation.requiredActionSet,
    }
    if (evaluation.satisfied) {
      return {
        community: publicCommunityId(input.communityId),
        membership_mode: membershipMode,
        human_verification_lane: "self",
        joinable_now: true,
        status: "joinable",
        membership_gate_summaries: gateSummaries,
        gate_evaluation: gateEvaluation,
      }
    }

    if (evaluation.requiredActionSet && evaluation.requiredActionSet.items.length > 0) {
      const missingCapabilities = missingCapabilitiesFromRequiredActionSet(evaluation.requiredActionSet)
      return {
        community: publicCommunityId(input.communityId),
        membership_mode: membershipMode,
        human_verification_lane: "self",
        joinable_now: false,
        status: "verification_required",
        membership_gate_summaries: gateSummaries,
        gate_evaluation: gateEvaluation,
        missing_capabilities: missingCapabilities,
        suggested_verification_provider: suggestedProviderFromRequiredActionSet(evaluation.requiredActionSet),
        ...(walletScoreStatus ? { wallet_score_status: walletScoreStatus } : {}),
        suggested_verification_intent: "community_join",
      }
    }

    return {
        community: publicCommunityId(input.communityId),
      membership_mode: membershipMode,
      human_verification_lane: "self",
      joinable_now: false,
      status: "gate_failed",
      membership_gate_summaries: gateSummaries,
      gate_evaluation: gateEvaluation,
      failure_reason: gateFailureReasonFromPolicyEvaluation(evaluation),
      ...(walletScoreStatus ? { wallet_score_status: walletScoreStatus } : {}),
    }
  } finally {
    db.close()
  }
}
