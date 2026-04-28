import type { UserRepository } from "../auth/repositories"
import type { CommunityRepository } from "../communities/db-community-repository"
import { canAccessCommunity, getCommunityMembershipState } from "../communities/membership/membership-state-store"
import { badRequestError, eligibilityFailed, notFoundError, verificationRequired } from "../errors"
import type { Client } from "../sql-client"
import { requireSongArtifactUpload } from "./song-artifact-upload-repository"
import type { SongArtifactUpload } from "../../types"

type CommunityMembershipRow = Awaited<ReturnType<typeof getCommunityMembershipState>>

export async function requireSongArtifactMemberAccess(
  client: Client,
  communityId: string,
  userId: string,
): Promise<CommunityMembershipRow> {
  const membership = await getCommunityMembershipState(client, communityId, userId)
  if (!canAccessCommunity(membership)) {
    throw notFoundError("Community not found")
  }
  return membership
}

export async function requireVerifiedHuman(userRepository: UserRepository, userId: string): Promise<void> {
  const user = await userRepository.getUserById(userId)
  if (!user) {
    throw notFoundError("User not found")
  }
  if (user.verification_capabilities.unique_human.state !== "verified") {
    throw verificationRequired("unique_human verification is required")
  }
}

export async function requireActiveCommunity(
  communityRepository: CommunityRepository,
  communityId: string,
): Promise<void> {
  const community = await communityRepository.getCommunityById(communityId)
  if (!community || community.provisioning_state !== "active" || community.status !== "active") {
    throw eligibilityFailed("Community is not available for posting")
  }
}

export async function requireResolvedUpload(input: {
  client: Client
  communityId: string
  userId: string
  ref: { song_artifact_upload_id: string }
  expectedKind: SongArtifactUpload["artifact_kind"]
}): Promise<SongArtifactUpload> {
  const upload = await requireSongArtifactUpload(input.client, input.communityId, input.ref.song_artifact_upload_id)
  if (upload.uploader_user_id !== input.userId) {
    throw notFoundError("Song artifact upload not found")
  }
  if (upload.status !== "uploaded") {
    throw badRequestError(`Song artifact upload ${upload.song_artifact_upload_id} is not uploaded yet`)
  }
  if (upload.artifact_kind !== input.expectedKind) {
    throw badRequestError(`Song artifact upload ${upload.song_artifact_upload_id} is not a ${input.expectedKind} upload`)
  }
  return upload
}
