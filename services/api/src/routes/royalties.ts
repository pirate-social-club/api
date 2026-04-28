import { Hono } from "hono"
import { badRequestError } from "../lib/errors"
import { authenticate, type AuthenticatedEnv } from "../lib/auth-middleware"
import { getCommunityRepository } from "../lib/communities/db-community-repository"
import { listRoyaltyClaims, recordRoyaltyClaim } from "../lib/royalties/royalty-claim-history"
import { getClaimableRoyaltiesForUser, getRoyaltyActivityForUser } from "../lib/royalties/royalty-service"
import type { RoyaltyClaimRecordRequest } from "../types"

const royalties = new Hono<AuthenticatedEnv>()

royalties.use("*", authenticate)

royalties.get("/claimable", async (c) => {
  const actor = c.get("actor")
  const communityRepository = getCommunityRepository(c.env)
  try {
    const result = await getClaimableRoyaltiesForUser({
      env: c.env,
      userId: actor.userId,
      communityRepository,
    })
    return c.json(result)
  } finally {
    communityRepository.close?.()
  }
})

royalties.get("/activity", async (c) => {
  const actor = c.get("actor")
  const limitRaw = c.req.query("limit")
  const limit = limitRaw ? Number(limitRaw) : undefined
  const result = await getRoyaltyActivityForUser({
    env: c.env,
    userId: actor.userId,
    cursor: c.req.query("cursor") ?? null,
    limit: Number.isFinite(limit) ? limit : undefined,
  })
  return c.json(result)
})

royalties.get("/claims", async (c) => {
  const actor = c.get("actor")
  const limitRaw = c.req.query("limit")
  const limit = limitRaw ? Number(limitRaw) : undefined
  const result = await listRoyaltyClaims({
    env: c.env,
    userId: actor.userId,
    limit: Number.isFinite(limit) ? limit : undefined,
  })
  return c.json(result)
})

royalties.post("/claims", async (c) => {
  const actor = c.get("actor")
  let body: RoyaltyClaimRecordRequest
  try {
    body = await c.req.json<RoyaltyClaimRecordRequest>()
  } catch {
    throw badRequestError("Invalid royalty claim payload")
  }
  const result = await recordRoyaltyClaim({
    env: c.env,
    userId: actor.userId,
    body,
  })
  return c.json(result, 201)
})

export default royalties
