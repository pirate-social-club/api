import { Hono } from "hono"
import { authenticate, type AuthenticatedEnv } from "../lib/auth-middleware"
import { badRequestError } from "../lib/errors"
import { verifyPrivyAccessProof } from "../lib/auth/privy-auth"
import { cashOutRewards, getRewardCashoutForUser } from "../lib/rewards/reward-cashout-service"
import { getRewardsSummaryForUser } from "../lib/rewards/reward-read-service"
import type { RewardCashoutRequest } from "../types"

const rewards = new Hono<AuthenticatedEnv>()

rewards.use("/me/rewards", authenticate)
rewards.use("/me/rewards/*", authenticate)

rewards.get("/me/rewards", async (c) => {
  const actor = c.get("actor")
  const result = await getRewardsSummaryForUser({
    env: c.env,
    userId: actor.userId,
  })
  return c.json(result, 200, {
    "cache-control": "no-store",
  })
})

rewards.post("/me/rewards/cashouts", async (c) => {
  const actor = c.get("actor")
  const body = await c.req.json<RewardCashoutRequest>().catch(() => null)
  if (!body || typeof body !== "object") {
    throw badRequestError("Invalid rewards cashout payload")
  }
  if (body.wallet_proof && body.wallet_proof.type !== "privy_access_token") {
    throw badRequestError("Unsupported rewards cashout wallet proof")
  }
  const walletIdentity = body.wallet_proof?.type === "privy_access_token"
    ? await verifyPrivyAccessProof({
        env: c.env,
        accessToken: body.wallet_proof.privy_access_token,
        walletAddress: body.wallet_proof.wallet_address ?? null,
      })
    : null
  const result = await cashOutRewards({
    env: c.env,
    userId: actor.userId,
    amountCents: body.amount_cents,
    idempotencyKey: body.idempotency_key,
    walletIdentity,
  })
  return c.json(result, 202, {
    "cache-control": "no-store",
  })
})

rewards.get("/me/rewards/cashouts/:cashoutId", async (c) => {
  const actor = c.get("actor")
  const result = await getRewardCashoutForUser({
    env: c.env,
    userId: actor.userId,
    cashoutId: c.req.param("cashoutId"),
  })
  return c.json(result, 200, {
    "cache-control": "no-store",
  })
})

export default rewards
