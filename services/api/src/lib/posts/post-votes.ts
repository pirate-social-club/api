import { openCommunityWriteClient } from "../communities/community-read-access"
import type {
  CommunityDatabaseBindingRepository,
  CommunityPostProjectionRepository,
  CommunityReadRepository,
} from "../communities/db-community-repository"
import { enforceCommunityActionGate } from "../communities/membership/eligibility-service"
import { canAccessCommunity, getCommunityMembershipState } from "../communities/membership/membership-state-store"
import {
  allowsNonMemberPowParticipation,
  followCommunityAfterParticipation,
  type ParticipationFollowRepository,
} from "../communities/membership/open-participation"
import { badRequestError, membershipRequired, notFoundError } from "../errors"
import { nowIso } from "../helpers"
import type { Env } from "../../env"
import type { UserRepository } from "../auth/repositories"
import { publicPostId } from "../public-ids"
import type { AltchaProofInput } from "../verification/altcha-provider"
import { getPostById } from "./community-post-query-store"
import { deletePostVote, upsertPostVote } from "./community-post-vote-store"
import { syncPostProjectionMetrics } from "./post-projection-sync"

type PostVoteCommunityRepository =
  & CommunityReadRepository
  & CommunityDatabaseBindingRepository
  & ParticipationFollowRepository
  & Pick<
    CommunityPostProjectionRepository,
    "getCommunityPostProjectionByPostId" | "updateCommunityPostProjectionMetrics"
  >

type MutatePostVoteInput = {
  env: Env
  userId: string
  postId: string
  value: -1 | 1 | null
  bypassVoterAccessChecks?: boolean
  altchaProof?: AltchaProofInput
  userRepository: UserRepository
  communityRepository: PostVoteCommunityRepository
}

async function mutatePostVote<const Value extends -1 | 1 | null>(
  input: Omit<MutatePostVoteInput, "value"> & { value: Value },
): Promise<{ post: string; value: Value }> {
  const projection = await input.communityRepository.getCommunityPostProjectionByPostId(input.postId)
  if (!projection) {
    throw notFoundError("Post not found")
  }

  const db = await openCommunityWriteClient(input.env, input.communityRepository, projection.community_id)
  try {
    let nonMemberPowVoter = false
    if (!input.bypassVoterAccessChecks) {
      const membership = await getCommunityMembershipState(
        db.client,
        projection.community_id,
        input.userId,
      )
      if (!canAccessCommunity(membership)) {
        // PoW-only communities admit non-member votes: the action gate below
        // demands a vote-scoped ALTCHA proof, which is all joining would prove.
        nonMemberPowVoter = await allowsNonMemberPowParticipation({
          client: db.client,
          communityId: projection.community_id,
          membership,
        })
        if (!nonMemberPowVoter) {
          throw membershipRequired("Join this community to vote", {
            reason: "membership_required",
          })
        }
      }
      await enforceCommunityActionGate({
        env: input.env,
        client: db.client,
        userId: input.userId,
        userRepository: input.userRepository,
        communityId: projection.community_id,
        altchaScope: "vote",
        altchaProof: input.altchaProof,
      })
    }
    const post = await getPostById(db.client, input.postId)
    if (!post) {
      throw notFoundError("Post not found")
    }
    if (post.status !== "published") {
      throw badRequestError("Cannot vote on a post that is not published")
    }

    const now = nowIso()
    if (input.value === null) {
      await deletePostVote({
        client: db.client,
        postId: input.postId,
        userId: input.userId,
      })
    } else {
      await upsertPostVote({
        client: db.client,
        postId: input.postId,
        communityId: projection.community_id,
        userId: input.userId,
        value: input.value,
        now,
      })
    }
    await syncPostProjectionMetrics({
      executor: db.client,
      communityRepository: input.communityRepository,
      postId: input.postId,
      updatedAt: now,
    })
    if (nonMemberPowVoter && input.value !== null) {
      await followCommunityAfterParticipation({
        client: db.client,
        communityRepository: input.communityRepository,
        communityId: projection.community_id,
        userId: input.userId,
      })
    }
    return {
      post: publicPostId(input.postId),
      value: input.value,
    }
  } finally {
    db.close()
  }
}

export function castPostVote(
  input: Omit<MutatePostVoteInput, "value"> & { value: -1 | 1 },
): Promise<{ post: string; value: -1 | 1 }> {
  return mutatePostVote(input)
}

export function clearPostVote(
  input: Omit<MutatePostVoteInput, "value">,
): Promise<{ post: string; value: null }> {
  return mutatePostVote({ ...input, value: null })
}
