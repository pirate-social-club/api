import { Hono } from "hono"

import type { Env } from "../env"
import { enforceRateLimit } from "../lib/rate-limit"
import {
  getPublicActiveRewardCampaign,
  getPublicActiveRewardCampaignForSong,
} from "../lib/rewards/reward-campaign-service"
import { getControlPlaneClient } from "../lib/runtime-deps"
import { decodePublicCommunityId, decodePublicPostId } from "../lib/public-ids"
import { setPublicReadCacheHeaders } from "./cache-headers"

const publicRewards = new Hono<{ Bindings: Env }>()

function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip")?.trim()
    || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || "unknown"
}

async function enforceOfferReadRateLimit(env: Env, request: Request): Promise<void> {
  await enforceRateLimit(
    env.REWARD_OFFER_RATE_LIMITER,
    `reward-offer:${clientIp(request)}`,
    "Too many reward offer requests. Please try again shortly.",
    { scope: "reward_offer" },
  )
}

function setOfferCacheHeaders(c: Parameters<typeof setPublicReadCacheHeaders>[0]): void {
  setPublicReadCacheHeaders(c, {
    freshSeconds: 15,
    staleSeconds: 15,
    cacheTags: ["reward-offers"],
  })
}

publicRewards.get("/public/reward_campaigns/:campaignId", async (c) => {
  await enforceOfferReadRateLimit(c.env, c.req.raw)
  const result = await getPublicActiveRewardCampaign({
    env: c.env,
    client: getControlPlaneClient(c.env),
    campaignId: c.req.param("campaignId"),
  })
  setOfferCacheHeaders(c)
  return c.json(result, 200)
})

publicRewards.get("/public/reward_campaigns", async (c) => {
  await enforceOfferReadRateLimit(c.env, c.req.raw)
  const result = await getPublicActiveRewardCampaignForSong({
    env: c.env,
    client: getControlPlaneClient(c.env),
    communityId: decodePublicCommunityId(c.req.query("community_id") ?? ""),
    postId: decodePublicPostId(c.req.query("post_id") ?? ""),
  })
  setOfferCacheHeaders(c)
  return c.json(result, 200)
})

export default publicRewards
