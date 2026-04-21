import type { Client } from "../../sql-client"
import { badRequestError, notFoundError, verificationRequired } from "../../errors"
import { getCommunityMembershipState } from "../community-membership-store"
import type { CommunityRepository } from "../db-community-repository"
import type { UserRepository } from "../../auth/repositories"
import { getPrimaryWalletSnapshot } from "../community-serialization"
import {
  resolveStoryCdrWriterDirectSigner,
  resolveStoryOperatorDirectSigner,
} from "../../story/story-direct-signer"
import type { Env } from "../../../types"

export async function requireCommunityMember(
  client: Client,
  communityId: string,
  userId: string,
): Promise<void> {
  const membership = await getCommunityMembershipState(client, communityId, userId)
  if (membership.membership_status !== "member" && membership.role_status !== "active") {
    throw notFoundError("Community not found")
  }
}

export async function requireCommunityOwner(input: {
  communityId: string
  userId: string
  communityRepository: CommunityRepository
}): Promise<void> {
  const community = await input.communityRepository.getCommunityById(input.communityId)
  if (!community || community.creator_user_id !== input.userId) {
    throw notFoundError("Community not found")
  }
}

export async function requireVerifiedHuman(
  userRepository: UserRepository,
  userId: string,
): Promise<void> {
  const user = await userRepository.getUserById(userId)
  if (!user) {
    throw notFoundError("User not found")
  }
  if (user.verification_capabilities.unique_human.state !== "verified") {
    throw verificationRequired("unique_human verification is required")
  }
}

export function buildAssetContentPath(communityId: string, assetId: string): string {
  return `/communities/${encodeURIComponent(communityId)}/assets/${encodeURIComponent(assetId)}/content`
}

export async function resolvePrimaryWalletAddress(input: {
  env: Env
  userRepository: UserRepository
  userId: string
  fallbackToRuntimeSigner?: boolean
}): Promise<string> {
  const user = await input.userRepository.getUserById(input.userId)
  if (!user) {
    throw notFoundError("User not found")
  }
  const attachments = await input.userRepository.getWalletAttachmentsByUserId(input.userId)
  const address = getPrimaryWalletSnapshot(user, attachments)
  if (!address?.trim()) {
    if (input.fallbackToRuntimeSigner !== false) {
      const operator = resolveStoryOperatorDirectSigner(input.env)
      if (operator.ok && operator.value) {
        return operator.value.address
      }
      const writer = resolveStoryCdrWriterDirectSigner(input.env)
      if (writer.ok && writer.value) {
        return writer.value.address
      }
    }
    throw badRequestError("Primary wallet is required")
  }
  return address
}

export async function resolveWalletAttachmentAddress(input: {
  userRepository: UserRepository
  userId: string
  walletAttachmentId: string
}): Promise<string> {
  const attachments = await input.userRepository.getWalletAttachmentsByUserId(input.userId)
  const attachment = attachments.find((candidate) => candidate.wallet_attachment_id === input.walletAttachmentId)
  if (!attachment?.wallet_address?.trim()) {
    throw badRequestError("Settlement wallet attachment is invalid")
  }
  return attachment.wallet_address
}
