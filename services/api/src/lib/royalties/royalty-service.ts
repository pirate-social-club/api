import { StoryClient, WIP_TOKEN_ADDRESS } from "@story-protocol/core-sdk"
import { http } from "viem"
import type { Env } from "../../env"
import { openCommunityReadClient } from "../communities/community-read-access"
import type { CommunityDatabaseBindingRepository } from "../communities/db-community-repository"
import { listCommunityMembershipProjectionRowsByUserId } from "../auth/auth-db-community-queries"
import { getControlPlaneClient } from "../runtime-deps"
import { resolveStoryChainId, resolveStoryRpcUrl } from "../story/story-runtime-config"
import { listNotificationFeed } from "../notifications/notification-read-store"
import { listUserStoryAssets } from "./royalty-queries"
import type {
  ClaimableRoyaltiesResponse,
  ClaimableRoyaltyItem,
  NotificationFeedItem,
  RoyaltyActivityItem,
  RoyaltyActivityResponse,
} from "@pirate/api-contracts"
import { unixSeconds } from "../../serializers/time"

function resolveStoryChainName(env: Pick<Env, "STORY_CHAIN_ID">): "aeneid" | "mainnet" {
  return resolveStoryChainId(env) === 1514 ? "mainnet" : "aeneid"
}

function createReadOnlyStoryClient(env: Pick<Env, "STORY_CHAIN_ID" | "STORY_RPC_URL">) {
  return StoryClient.newClient({
    account: "0x0000000000000000000000000000000000000000",
    transport: http(resolveStoryRpcUrl(env)),
    chainId: resolveStoryChainName(env),
  })
}

export async function getClaimableRoyaltiesForUser(input: {
  env: Env
  userId: string
  communityRepository: CommunityDatabaseBindingRepository
}): Promise<ClaimableRoyaltiesResponse> {
  const controlPlane = getControlPlaneClient(input.env)
  try {
    const memberships = await listCommunityMembershipProjectionRowsByUserId(controlPlane, input.userId)
    const memberCommunityIds = new Set(
      memberships
        .filter((m) => m.membership_state === "member")
        .map((m) => m.community_id),
    )

    if (memberCommunityIds.size === 0) {
      return {
        items: [],
        total_claimable_wip_wei: "0",
        checked_at: unixSeconds(new Date()),
      }
    }

    const storyClient = createReadOnlyStoryClient(input.env)
    const items: ClaimableRoyaltyItem[] = []

    for (const communityId of memberCommunityIds) {
      let db: Awaited<ReturnType<typeof openCommunityReadClient>> | null = null
      try {
        db = await openCommunityReadClient(input.env, input.communityRepository, communityId)
        const assets = await listUserStoryAssets(db.client, input.userId)

        for (const asset of assets) {
          if (!asset.story_ip_id) continue

          try {
            const claimableWei = await storyClient.royalty.claimableRevenue({
              ipId: asset.story_ip_id as `0x${string}`,
              claimer: asset.story_ip_id as `0x${string}`,
              token: WIP_TOKEN_ADDRESS,
            })

            if (claimableWei > 0n) {
              items.push({
                ip: asset.story_ip_id,
                claimable_wip_wei: claimableWei.toString(),
                asset: `asset_${asset.asset_id}`,
                community: `com_${asset.community_id}`,
                title: asset.display_title,
              })
            }
          } catch (error) {
            console.warn("[royalty-service] claimableRevenue check failed", {
              userId: input.userId,
              communityId,
              assetId: asset.asset_id,
              ipId: asset.story_ip_id,
              error: error instanceof Error ? error.message : String(error),
            })
          }
        }
      } catch (error) {
        console.warn("[royalty-service] community scan failed", {
          userId: input.userId,
          communityId,
          error: error instanceof Error ? error.message : String(error),
        })
      } finally {
        db?.close()
      }
    }

    const total = items.reduce((sum, item) => sum + BigInt(item.claimable_wip_wei), 0n)

    return {
      items,
      total_claimable_wip_wei: total.toString(),
      checked_at: unixSeconds(new Date()),
    }
  } finally {
    controlPlane.close?.()
  }
}

function payloadString(payload: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = payload?.[key]
  return typeof value === "string" && value.trim() ? value : null
}

function royaltyActivityFromFeedItem(item: NotificationFeedItem): RoyaltyActivityItem | null {
  const payload = item.event.payload
  const amountWipWei = payloadString(payload, "amount_wip_wei")
  const storyIpId = payloadString(payload, "story_ip_id")
  const communityId = payloadString(payload, "community_id")
  const assetId = payloadString(payload, "asset_id") ?? item.event.subject
  const purchaseId = payloadString(payload, "purchase")
  if (!amountWipWei || !storyIpId || !communityId || !assetId) {
    return null
  }
  return {
    id: `rai_${item.event.id.replace(/^ne_/, "")}`,
    object: "royalty_activity_item",
    community: `com_${communityId.replace(/^com_/, "")}`,
    asset: `asset_${assetId.replace(/^asset_/, "")}`,
    title: payloadString(payload, "title"),
    story_ip: storyIpId,
    amount_wip_wei: amountWipWei,
    buyer_wallet_address: payloadString(payload, "buyer_wallet_address"),
    tx_hash: payloadString(payload, "tx_hash"),
    purchase: purchaseId,
    created: item.event.created,
    read_at: item.receipt.read_at ?? null,
  }
}

export async function getRoyaltyActivityForUser(input: {
  env: Env
  userId: string
  cursor?: string | null
  limit?: number
}): Promise<RoyaltyActivityResponse> {
  const client = getControlPlaneClient(input.env)
  try {
    const feed = await listNotificationFeed({
      executor: client,
      userId: input.userId,
      cursor: input.cursor,
      limit: input.limit,
      type: "royalty_earned",
    })
    return {
      items: feed.items.map(royaltyActivityFromFeedItem).filter((item): item is RoyaltyActivityItem => Boolean(item)),
      next_cursor: feed.next_cursor,
    }
  } finally {
    client.close?.()
  }
}
