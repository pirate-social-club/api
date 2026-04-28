import { Hono } from "hono"
import { authenticate, type AuthenticatedEnv } from "../lib/auth-middleware"
import { listNotificationFeed } from "../lib/notifications/notification-store"
import { getControlPlaneClient } from "../lib/runtime-deps"
import type { NotificationFeedItem } from "../types"

const royalties = new Hono<AuthenticatedEnv>()

royalties.use("*", authenticate)

function payloadString(payload: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = payload?.[key]
  return typeof value === "string" && value.trim() ? value : null
}

function royaltyActivityFromFeedItem(item: NotificationFeedItem) {
  const payload = item.event.payload
  const amountWipWei = payloadString(payload, "amount_wip_wei")
  const storyIpId = payloadString(payload, "story_ip_id")
  const communityId = payloadString(payload, "community_id")
  const assetId = payloadString(payload, "asset_id") ?? item.event.subject_id
  if (!amountWipWei || !storyIpId || !communityId || !assetId) {
    return null
  }
  return {
    event_id: item.event.event_id,
    community_id: communityId,
    asset_id: assetId,
    title: payloadString(payload, "title"),
    story_ip_id: storyIpId,
    amount_wip_wei: amountWipWei,
    buyer_wallet_address: payloadString(payload, "buyer_wallet_address"),
    tx_hash: payloadString(payload, "tx_hash"),
    purchase_id: item.event.object_type === "purchase" ? item.event.object_id ?? null : null,
    created_at: item.event.created_at,
    read_at: item.receipt.read_at ?? null,
  }
}

royalties.get("/activity", async (c) => {
  const actor = c.get("actor")
  const limitRaw = c.req.query("limit")
  const limit = limitRaw ? Number(limitRaw) : undefined
  const client = getControlPlaneClient(c.env)
  try {
    const feed = await listNotificationFeed({
      executor: client,
      userId: actor.userId,
      cursor: c.req.query("cursor") ?? null,
      limit: Number.isFinite(limit) ? limit : undefined,
      type: "royalty_earned",
    })
    return c.json({
      items: feed.items.map(royaltyActivityFromFeedItem).filter((item) => Boolean(item)),
      next_cursor: feed.next_cursor,
    })
  } finally {
    client.close?.()
  }
})

export default royalties
