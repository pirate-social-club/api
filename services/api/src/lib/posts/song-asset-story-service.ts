import type { UserRepository } from "../auth/repositories"
import type { CommunityRepository } from "../communities/control-plane-community-repository"
import { openCommunityDb } from "../communities/community-db-factory"
import { nowIso } from "../helpers"
import type { Asset, Env } from "../../types"
import {
  claimAssetForStoryPublish,
  completeAssetStoryPublish,
  failAssetStoryPublish,
  listAssetsPendingStoryPublish,
} from "./community-asset-store"
import {
  hasStoryPublishDirectKeyConfigured,
  publishSongAssetVersionViaDirectKey,
  publishSongAssetVersionViaLit,
} from "./story-operator-runtime"

function summarizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.trim().slice(0, 500) || "unknown_error"
}

function shouldFallbackToDirectPublish(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return (
    message.startsWith("lit_api_http_error:")
    || message.startsWith("lit_action_fetch_failed:")
    || message.startsWith("lit_action_signer_mismatch:")
    || message === "lit_action_missing_serialized_tx"
    || message === "story_publish_tx_hash_invalid"
    || message.startsWith("story_publish_receipt_timeout:")
    || message.startsWith("story_publish_tx_reverted:")
  )
}

function parsePositiveInt(value: string | null | undefined, fallback: number): number {
  const parsed = Number(String(value ?? "").trim())
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback
  }
  return Math.max(1, Math.trunc(parsed))
}

function buildStubStoryIpId(assetId: string): string {
  return `pirate-story-${assetId}`
}

function isoBeforeSeconds(seconds: number): string | null {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return null
  }
  return new Date(Date.now() - (seconds * 1000)).toISOString()
}

async function publishAssetToStory(input: {
  env: Env
  asset: Asset
  userRepository: UserRepository
}): Promise<{
  storyIpId: string
  storyIpNftContract: string | null
  storyIpNftTokenId: string | null
  storyPublishTxRef: string | null
  storyPublishModel: "pirate_v1" | "story_ip_v1"
}> {
  if (String(input.env.STORY_PUBLISH_FORCE_FAIL || "").trim().toLowerCase() === "true") {
    throw new Error("story_publish_forced_failure")
  }
  const hasLitUsageKey = Boolean(String(input.env.LIT_CHIPOTLE_OPERATOR_API_KEY || "").trim())
  const hasDirectKey = hasStoryPublishDirectKeyConfigured(input.env)

  if (!hasLitUsageKey && !hasDirectKey) {
    return {
      storyIpId: buildStubStoryIpId(input.asset.asset_id),
      storyIpNftContract: null,
      storyIpNftTokenId: null,
      storyPublishTxRef: null,
      storyPublishModel: "pirate_v1",
    }
  }

  const walletAttachments = await input.userRepository.getWalletAttachmentsByUserId(input.asset.creator_user_id)
  const publisherWallet = walletAttachments.find((attachment) => attachment.is_primary && attachment.chain_namespace.startsWith("eip155:"))
    ?? walletAttachments.find((attachment) => attachment.chain_namespace.startsWith("eip155:"))
  if (!publisherWallet) {
    throw new Error("story_publisher_wallet_missing")
  }

  if (hasLitUsageKey) {
    try {
      return {
        ...(await publishSongAssetVersionViaLit({
          env: input.env,
          asset: input.asset,
          publisherAddress: publisherWallet.wallet_address,
        })),
      }
    } catch (error) {
      if (!hasDirectKey || !shouldFallbackToDirectPublish(error)) {
        throw error
      }
    }
  }

  if (hasDirectKey) {
    return {
      ...(await publishSongAssetVersionViaDirectKey({
        env: input.env,
        asset: input.asset,
        publisherAddress: publisherWallet.wallet_address,
      })),
    }
  }

  throw new Error("story_publish_operator_unavailable")
}

export function parseSongAssetStoryDrainLimit(value: string | null | undefined, env: Env): number {
  return parsePositiveInt(value ?? env.SONG_ASSET_STORY_DRAIN_LIMIT, 10)
}

function parseSongAssetStoryStaleAfterSeconds(env: Env): number {
  return parsePositiveInt(env.SONG_ASSET_STORY_STALE_AFTER_SECONDS, 900)
}

export async function drainPendingSongAssetStoryPublishes(input: {
  env: Env
  limit: number
  communityRepository: CommunityRepository
  userRepository: UserRepository
}): Promise<{
  scanned_count: number
  claimed_count: number
  processed_count: number
  published_count: number
  failed_count: number
}> {
  const communities = await input.communityRepository.listActiveCommunities()
  const staleBefore = isoBeforeSeconds(parseSongAssetStoryStaleAfterSeconds(input.env))
  const counts = {
    scanned_count: 0,
    claimed_count: 0,
    processed_count: 0,
    published_count: 0,
    failed_count: 0,
  }

  let remaining = Math.max(1, Math.trunc(input.limit))
  for (const community of communities) {
    if (remaining <= 0) {
      break
    }
    const db = await openCommunityDb(input.communityRepository, community.community_id)
    try {
      const candidates = await listAssetsPendingStoryPublish({
        client: db.client,
        limit: remaining,
        staleBefore,
      })
      counts.scanned_count += candidates.length

      for (const candidate of candidates) {
        if (remaining <= 0) {
          break
        }
        const claimed = await claimAssetForStoryPublish({
          client: db.client,
          assetId: candidate.asset_id,
          staleBefore,
          updatedAt: nowIso(),
        })
        if (!claimed) {
          continue
        }
        counts.claimed_count += 1

        try {
          const published = await publishAssetToStory({
            env: input.env,
            asset: claimed,
            userRepository: input.userRepository,
          })
          await completeAssetStoryPublish({
          client: db.client,
          assetId: claimed.asset_id,
          storyIpId: published.storyIpId,
          storyIpNftContract: published.storyIpNftContract,
          storyIpNftTokenId: published.storyIpNftTokenId,
          storyPublishTxRef: published.storyPublishTxRef,
          storyPublishModel: published.storyPublishModel,
          updatedAt: nowIso(),
        })
          counts.published_count += 1
        } catch (error) {
          await failAssetStoryPublish({
            client: db.client,
            assetId: claimed.asset_id,
            error: summarizeError(error),
            updatedAt: nowIso(),
          })
          counts.failed_count += 1
        }

        counts.processed_count += 1
        remaining -= 1
      }
    } finally {
      db.close()
    }
  }

  return counts
}
