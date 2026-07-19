import type { ReadClient } from "../../sql-client"
import type { CommunityMembershipProjectionRepository } from "../db-community-repository"
import { nowIso } from "../../helpers"
import { getMembershipGatePolicy } from "./gate-policy-store"
import { getCommunityFollowStatus, setCommunityFollowActive } from "./follow-store"
import { syncCommunityFollowProjection } from "./projection-service"
import type { GateExpression, GatePolicy } from "./gate-types"
import type { CommunityMembershipRow } from "./membership-state-store"

/**
 * True when a proof-of-work proof ALONE satisfies the expression: an `or`
 * passes if any branch does, an `and` only if every branch does.
 */
function isSatisfiedByPowAlone(expression: GateExpression): boolean {
  if (expression.op === "gate") {
    return expression.gate.type === "altcha_pow"
  }
  if (expression.children.length === 0) {
    return false
  }
  return expression.op === "or"
    ? expression.children.some(isSatisfiedByPowAlone)
    : expression.children.every(isSatisfiedByPowAlone)
}

/**
 * Membership is ceremony wherever proof-of-work alone already satisfies the
 * membership gate: every gated write carries its own single-use, action-scoped
 * ALTCHA proof, so a joined and a non-joined actor prove exactly the same
 * thing. That covers `or(altcha_pow, wallet_score, unique_human)` as much as a
 * bare `altcha_pow` — a gate anyone can clear with a browser check is already
 * open, and forcing a join in front of it adds friction, not safety.
 *
 * Identity remains the way to become a CITIZEN: satisfying the gate through
 * wallet score or a document/human check still joins, with members-only
 * visibility and roles intact. Clearing it with proof-of-work instead only
 * earns a follow (see followCommunityAfterParticipation).
 */
export function isPowSatisfiableGatePolicy(policy: GatePolicy | null): boolean {
  return policy != null && isSatisfiedByPowAlone(policy.expression)
}

export async function isPowSatisfiableGatedCommunity(client: ReadClient, communityId: string): Promise<boolean> {
  return isPowSatisfiableGatePolicy(await getMembershipGatePolicy(client, communityId))
}

export async function allowsNonMemberPowParticipation(input: {
  client: ReadClient
  communityId: string
  membership: CommunityMembershipRow
}): Promise<boolean> {
  if (input.membership.membership_status === "banned") {
    return false
  }
  return isPowSatisfiableGatedCommunity(input.client, input.communityId)
}

export type ParticipationFollowRepository = Pick<
  CommunityMembershipProjectionRepository,
  "upsertCommunityFollowProjection" | "incrementCommunityFollowerCount"
>

/**
 * Interacting without joining subscribes the actor to the community
 * (Reddit-style): activate the follow after a successful non-member write.
 *
 * An explicit unfollow is honoured permanently. `status='inactive'` is only
 * ever written by unfollowCommunity — the user's own unfollow route — so it
 * is an unambiguous opt-out, and re-following on the next vote would make
 * subscription a recurring condition of participating rather than a one-time
 * consequence of it. Only a never-followed actor gets auto-followed.
 *
 * Follow failures must never fail the interaction that triggered them.
 */
export async function followCommunityAfterParticipation(input: {
  client: ReadClient
  communityRepository: ParticipationFollowRepository
  communityId: string
  userId: string
}): Promise<void> {
  if (input.userId.startsWith("usr_guest_")) {
    return
  }
  try {
    const previousStatus = await getCommunityFollowStatus(input.client, input.communityId, input.userId)
    if (previousStatus != null) {
      return
    }
    const now = nowIso()
    const result = await setCommunityFollowActive({
      client: input.client,
      communityId: input.communityId,
      userId: input.userId,
      now,
    })
    await syncCommunityFollowProjection({
      communityRepository: input.communityRepository,
      communityId: input.communityId,
      userId: input.userId,
      followState: "active",
      changed: result.changed,
      now,
    })
  } catch (error) {
    console.error("[membership] auto-follow after non-member participation failed", JSON.stringify({
      community_id: input.communityId,
      user_id: input.userId,
      error: String(error),
    }))
  }
}
