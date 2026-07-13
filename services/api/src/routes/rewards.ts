import { Hono, type Context } from "hono"
import type { Env } from "../env"
import { authenticateOperatorCredential, requireOperatorScope, REWARD_CAMPAIGN_INCIDENT_RESOLVE_SCOPE } from "../lib/operator-credential-auth"
import { recoverRewardCampaignIncident } from "../lib/rewards/reward-campaign-recovery"
import { authenticate, type AuthenticatedEnv } from "../lib/auth-middleware"
import { badRequestError } from "../lib/errors"
import { verifyPrivyAccessProof } from "../lib/auth/privy-auth"
import { cashOutRewards, getRewardCashoutForUser } from "../lib/rewards/reward-cashout-service"
import { getRewardsSummaryForUser } from "../lib/rewards/reward-read-service"
import {
  confirmRewardCampaignFunding,
  createRewardCampaign,
  createRewardCampaignFundingQuote,
  getRewardCampaign,
  getRewardSongOwnerPolicy,
  setRewardSongOwnerPolicy,
  type RewardCampaignCreateInput,
  type RewardCampaignTarget,
} from "../lib/rewards/reward-campaign-service"
import { getControlPlaneClient } from "../lib/runtime-deps"
import { captureScheduledWarning } from "../lib/ops-alerts/scheduled"
import { getCommunityRepository } from "../lib/communities/db-community-repository"
import { openCommunityReadClient } from "../lib/communities/community-read-access"
import { rowValue, stringOrNull } from "../lib/sql-row"
import type { RewardCashoutRequest } from "../types"

const rewards = new Hono<AuthenticatedEnv>()

const operatorRouteDefaults = {
  authenticate: authenticateOperatorCredential,
  recover: recoverRewardCampaignIncident,
  getClient: getControlPlaneClient,
  alertRecovery: async (env: Env, campaignId: string, incidentId: string) => captureScheduledWarning(
    env,
    "Reward campaign operational hold recovered",
    `reward_campaign_recovery:${campaignId}:${incidentId}`,
    { campaign_id: campaignId, incident_id: incidentId },
    { urgency: "low" },
  ),
}
type RewardOperatorRouteServices = typeof operatorRouteDefaults

rewards.use("/me/rewards", authenticate)
rewards.use("/me/rewards/*", authenticate)
rewards.use("/reward_campaigns", authenticate)
rewards.use("/reward_campaigns/*", authenticate)
rewards.use("/reward_song_policies/*", authenticate)

async function resolveCampaignTarget(env: AuthenticatedEnv["Bindings"], communityId: string, postId: string): Promise<RewardCampaignTarget> {
  const handle = await openCommunityReadClient(env, getCommunityRepository(env), communityId)
  try {
    const result = await handle.client.execute({
      sql: `
        SELECT community_id, post_id, author_user_id, post_type, status, song_artifact_bundle_id
        FROM posts
        WHERE community_id = ?1 AND post_id = ?2
        LIMIT 1
      `,
      args: [communityId, postId],
    })
    const row = result.rows[0]
    if (
      !row
      || stringOrNull(rowValue(row, "post_type")) !== "song"
      || stringOrNull(rowValue(row, "status")) !== "published"
    ) throw badRequestError("Reward campaigns require a published song post")
    const songArtifactBundleId = stringOrNull(rowValue(row, "song_artifact_bundle_id"))
    const songOwnerUserId = stringOrNull(rowValue(row, "author_user_id"))
    if (!songArtifactBundleId || !songOwnerUserId) {
      throw badRequestError("Reward campaign song target is incomplete")
    }
    return { communityId, postId, songArtifactBundleId, songOwnerUserId }
  } finally {
    await handle.close()
  }
}

async function canModerateCommunity(
  env: AuthenticatedEnv["Bindings"],
  communityId: string,
  userId: string,
): Promise<boolean> {
  const handle = await openCommunityReadClient(env, getCommunityRepository(env), communityId)
  try {
    const result = await handle.client.execute({
      sql: `
        SELECT 1 AS allowed
        FROM community_roles
        WHERE community_id = ?1 AND user_id = ?2 AND status = 'active'
          AND role IN ('owner', 'admin', 'moderator')
        LIMIT 1
      `,
      args: [communityId, userId],
    })
    return result.rows.length > 0
  } finally {
    await handle.close()
  }
}

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

rewards.post("/reward_campaigns", async (c) => {
  const actor = c.get("actor")
  const body = await c.req.json<RewardCampaignCreateInput>().catch(() => null)
  if (!body || typeof body !== "object") throw badRequestError("Invalid reward campaign payload")
  const result = await createRewardCampaign({
    env: c.env,
    client: getControlPlaneClient(c.env),
    userId: actor.userId,
    body,
    resolveTarget: (communityId, postId) => resolveCampaignTarget(c.env, communityId, postId),
  })
  return c.json(result, 201, { "cache-control": "no-store" })
})

rewards.get("/reward_campaigns/:campaignId", async (c) => {
  const actor = c.get("actor")
  const result = await getRewardCampaign({
    env: c.env,
    client: getControlPlaneClient(c.env),
    campaignId: c.req.param("campaignId"),
    userId: actor.userId,
    canModerateCommunity: (communityId) => canModerateCommunity(c.env, communityId, actor.userId),
  })
  return c.json(result, 200, { "cache-control": "no-store" })
})

rewards.get("/reward_song_policies/:communityId/:postId", async (c) => {
  const target = await resolveCampaignTarget(c.env, c.req.param("communityId"), c.req.param("postId"))
  const result = await getRewardSongOwnerPolicy({
    env: c.env,
    client: getControlPlaneClient(c.env),
    target,
  })
  return c.json(result, 200, { "cache-control": "no-store" })
})

rewards.put("/reward_song_policies/:communityId/:postId", async (c) => {
  const actor = c.get("actor")
  const body = await c.req.json<{ third_party_rewards?: unknown }>().catch(() => null)
  if (!body || (body.third_party_rewards !== "allowed" && body.third_party_rewards !== "blocked")) {
    throw badRequestError("Invalid reward song policy payload")
  }
  const target = await resolveCampaignTarget(c.env, c.req.param("communityId"), c.req.param("postId"))
  const result = await setRewardSongOwnerPolicy({
    env: c.env,
    client: getControlPlaneClient(c.env),
    userId: actor.userId,
    target,
    thirdPartyRewards: body.third_party_rewards,
  })
  return c.json(result, 200, { "cache-control": "no-store" })
})

rewards.post("/reward_campaigns/:campaignId/funding_quotes", async (c) => {
  const actor = c.get("actor")
  const body = await c.req.json<{ amount_cents?: unknown; idempotency_key?: unknown }>().catch(() => null)
  if (!body || typeof body !== "object") throw badRequestError("Invalid reward funding quote payload")
  const result = await createRewardCampaignFundingQuote({
    env: c.env,
    client: getControlPlaneClient(c.env),
    userId: actor.userId,
    campaignId: c.req.param("campaignId"),
    amountCents: Number(body.amount_cents),
    idempotencyKey: typeof body.idempotency_key === "string" ? body.idempotency_key : "",
  })
  return c.json(result, 201, { "cache-control": "no-store" })
})

rewards.post("/reward_campaigns/:campaignId/funding_quotes/:fundingQuoteId/confirm", async (c) => {
  const actor = c.get("actor")
  const body = await c.req.json<{ tx_hash?: unknown }>().catch(() => null)
  if (!body || typeof body.tx_hash !== "string") throw badRequestError("Invalid reward funding confirmation payload")
  const result = await confirmRewardCampaignFunding({
    env: c.env,
    client: getControlPlaneClient(c.env),
    userId: actor.userId,
    campaignId: c.req.param("campaignId"),
    fundingId: c.req.param("fundingQuoteId"),
    txHash: body.tx_hash,
  })
  return c.json(result, 200, { "cache-control": "no-store" })
})

export function createRewardCampaignRecoveryHandler(services: RewardOperatorRouteServices = operatorRouteDefaults) {
  return async (c: Context<AuthenticatedEnv>) => {
    const operator = await services.authenticate({
      env: c.env,
      authorization: c.req.header("authorization"),
    })
    requireOperatorScope(operator, REWARD_CAMPAIGN_INCIDENT_RESOLVE_SCOPE)
    const body = await c.req.json<{ incident_version?: unknown; resolution_note?: unknown }>().catch(() => null)
    const campaignId = c.req.param("campaignId") ?? ""
    const incidentId = c.req.param("incidentId") ?? ""
    const result = await services.recover({
      env: c.env,
      client: services.getClient(c.env),
      campaignId,
      incidentId,
      incidentVersion: Number(body?.incident_version),
      resolutionNote: typeof body?.resolution_note === "string" ? body.resolution_note : "",
      operatorActorId: operator.operatorActorId,
    })
    await services.alertRecovery(c.env, campaignId, incidentId).catch((error) => {
      console.error("[reward-campaigns] recovery alert failed", { campaign_id: campaignId, incident_id: incidentId, error })
    })
    return c.json(result, 200)
  }
}

rewards.post(
  "/operator/reward_campaigns/:campaignId/incidents/:incidentId/recover",
  createRewardCampaignRecoveryHandler(),
)

export default rewards
