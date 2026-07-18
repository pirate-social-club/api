import type { ReadClient } from "../../sql-client"
import type { CommunityMembershipProjectionRepository } from "../db-community-repository"
import { nowIso } from "../../helpers"
import { getMembershipGatePolicy } from "./gate-policy-store"
import { flattenGatePolicyAtoms } from "./gate-summary"
import { setCommunityFollowActive } from "./follow-store"
import { syncCommunityFollowProjection } from "./projection-service"
import type { CommunityMembershipRow } from "./membership-state-store"

/**
 * A community whose entire membership gate is proof-of-work admits non-member
 * interactions: every gated write already carries its own single-use,
 * action-scoped ALTCHA proof, so joining first would prove nothing more.
 * Communities with identity/asset atoms anywhere in the policy (including
 * OR-trees that PoW alone could satisfy) still require membership — their
 * owners chose a verification gate, and reinterpreting it is out of scope.
 */
export async function isPowOnlyGatedCommunity(client: ReadClient, communityId: string): Promise<boolean> {
  const atoms = flattenGatePolicyAtoms(await getMembershipGatePolicy(client, communityId))
  return atoms.length > 0 && atoms.every((atom) => atom.type === "altcha_pow")
}

export async function allowsNonMemberPowParticipation(input: {
  client: ReadClient
  communityId: string
  membership: CommunityMembershipRow
}): Promise<boolean> {
  if (input.membership.membership_status === "banned") {
    return false
  }
  return isPowOnlyGatedCommunity(input.client, input.communityId)
}

export type ParticipationFollowRepository = Pick<
  CommunityMembershipProjectionRepository,
  "upsertCommunityFollowProjection" | "incrementCommunityFollowerCount"
>

/**
 * Interacting without joining still subscribes the actor to the community
 * (Reddit-style): activate the follow after a successful non-member write.
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
