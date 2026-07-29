import { Hono, type Context } from "hono"
import type { Env } from "../env"
import {
  authenticateOperatorCredential,
  requireOperatorScope,
  REWARD_CAMPAIGN_INCIDENT_RESOLVE_SCOPE,
  REWARD_REHEARSAL_EXECUTE_SCOPE,
  REWARD_SETTLEMENT_READ_SCOPE,
  REWARD_SETTLEMENT_RESOLVE_SCOPE,
} from "../lib/operator-credential-auth"
import { getRewardCampaignCapabilities } from "../lib/rewards/reward-campaign-capabilities"
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
import { decodePublicCommunityId, decodePublicPostId } from "../lib/public-ids"
import type { RewardCashoutRequest } from "../types"
import { inspectKaraokeRewardEligibility } from "../lib/posts/post-karaoke-service"
import { resolveRewardSettlementManually } from "../lib/rewards/reward-settlement-manual-resolution"
import { getRewardPoolRefundPolicyReadiness } from "../lib/rewards/reward-pool-refund-readiness"
import { getRewardBackendFlipReadiness } from "../lib/rewards/reward-backend-flip-readiness"
import { getRewardSolvencyGateStatus } from "../lib/rewards/reward-solvency-gate"
import {
  enqueueRewardRehearsalScenario,
  isRewardRehearsalScenario,
} from "../lib/rewards/reward-rehearsal"

const rewards = new Hono<AuthenticatedEnv>()

const operatorRouteDefaults = {
  authenticate: authenticateOperatorCredential,
  recover: recoverRewardCampaignIncident,
  getClient: getControlPlaneClient,
  getBackendFlipReadiness: getRewardBackendFlipReadiness,
  getRefundPolicyReadiness: getRewardPoolRefundPolicyReadiness,
  getSolvencyReadiness: getRewardSolvencyGateStatus,
  resolveSettlement: resolveRewardSettlementManually,
  alertRecovery: async (env: Env, campaignId: string, incidentId: string) => captureScheduledWarning(
    env,
    "Reward campaign operational hold recovered",
    `reward_campaign_recovery:${campaignId}:${incidentId}`,
    { campaign_id: campaignId, incident_id: incidentId },
    { urgency: "low" },
  ),
}
type RewardOperatorRouteServices = typeof operatorRouteDefaults
type RewardRecoveryRouteServices = Pick<
  RewardOperatorRouteServices,
  "authenticate" | "recover" | "getClient" | "alertRecovery"
>
type RewardSettlementResolutionRouteServices = Pick<
  RewardOperatorRouteServices,
  "authenticate" | "resolveSettlement" | "getClient"
>
type RewardReadinessRouteServices = Pick<
  RewardOperatorRouteServices,
  "authenticate" | "getBackendFlipReadiness" | "getClient" | "getRefundPolicyReadiness" | "getSolvencyReadiness"
>
type RewardRehearsalRouteServices = Pick<RewardOperatorRouteServices, "authenticate"> & {
  enqueue: typeof enqueueRewardRehearsalScenario
}

rewards.use("/me/rewards", authenticate)
rewards.use("/me/rewards/*", authenticate)
// Distinct path prefix from /reward_campaigns, so it needs its own guard.
rewards.use("/reward_campaign_capabilities", authenticate)
rewards.use("/reward_campaigns", authenticate)
rewards.use("/reward_campaigns/*", authenticate)
rewards.use("/reward_song_policies/*", authenticate)

async function resolveCampaignTarget(
  env: AuthenticatedEnv["Bindings"],
  communityId: string,
  postId: string,
  options?: { inspectKaraoke: boolean },
): Promise<RewardCampaignTarget> {
  // Policy paths receive public IDs from the web client, whereas the routing
  // table and shard rows use raw IDs. Campaign creation normalizes earlier,
  // but normalize here too so every reward target entry point is consistent.
  const resolvedCommunityId = decodePublicCommunityId(communityId)
  const resolvedPostId = decodePublicPostId(postId)
  const communityRepository = getCommunityRepository(env)
  const handle = await openCommunityReadClient(env, communityRepository, resolvedCommunityId)
  let target: RewardCampaignTarget
  let karaokeEnabled = false
  let lyrics: string | null = null
  try {
    const result = await handle.client.execute({
      sql: `
        SELECT community_id, post_id, author_user_id, post_type, status, song_artifact_bundle_id,
          lyrics, (
            SELECT karaoke_enabled FROM communities
            WHERE communities.community_id = posts.community_id LIMIT 1
          ) AS karaoke_enabled
        FROM posts
        WHERE community_id = ?1 AND post_id = ?2
        LIMIT 1
      `,
      args: [resolvedCommunityId, resolvedPostId],
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
    target = { communityId: resolvedCommunityId, postId: resolvedPostId, songArtifactBundleId, songOwnerUserId }
    karaokeEnabled = Number(rowValue(row, "karaoke_enabled") ?? 0) === 1
    lyrics = stringOrNull(rowValue(row, "lyrics"))
  } finally {
    await handle.close()
  }
  if (!options?.inspectKaraoke) return target
  const eligibility = await inspectKaraokeRewardEligibility({
    communityId: resolvedCommunityId,
    env,
    karaokeEnabled,
    lyrics,
    songArtifactBundleId: target.songArtifactBundleId,
  })
  return { ...target, karaokeLineCount: eligibility.lyricLineCount }
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

rewards.get("/reward_campaign_capabilities", (c) => {
  // Never throws: when the surface is dark or misconfigured this reports
  // enabled=false so the client hides the entry point instead of offering an
  // action the API would refuse.
  const postId = c.req.query("post_id")?.trim()
  if (!postId) throw badRequestError("post_id is required")
  return c.json(getRewardCampaignCapabilities(c.env, postId), 200, { "cache-control": "no-store" })
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
    resolveTarget: (communityId, postId) => resolveCampaignTarget(c.env, communityId, postId, {
      inspectKaraoke: body.eligible_activity !== "study",
    }),
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

export function createRewardCampaignRecoveryHandler(services: RewardRecoveryRouteServices = operatorRouteDefaults) {
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

export function createRewardSettlementResolutionHandler(
  services: RewardSettlementResolutionRouteServices = operatorRouteDefaults,
) {
  return async (c: Context<AuthenticatedEnv>) => {
    const operator = await services.authenticate({
      env: c.env,
      authorization: c.req.header("authorization"),
    })
    requireOperatorScope(operator, REWARD_SETTLEMENT_RESOLVE_SCOPE)
    const body = await c.req.json<{
      effect_kind?: unknown
      expected_tx_hash?: unknown
      resolution?: unknown
      reason?: unknown
    }>().catch(() => null)
    const effectKind = body?.effect_kind
    const resolution = body?.resolution
    if (effectKind !== "cashout" && effectKind !== "funding_refund") {
      throw badRequestError("Invalid rewards settlement effect kind")
    }
    if (resolution !== "confirmed" && resolution !== "failed_onchain") {
      throw badRequestError("Invalid rewards settlement resolution")
    }
    const result = await services.resolveSettlement({
      env: c.env,
      client: services.getClient(c.env),
      effectKind,
      effectId: c.req.param("effectId") ?? "",
      expectedTxHash: typeof body?.expected_tx_hash === "string" ? body.expected_tx_hash : "",
      resolution,
      reason: typeof body?.reason === "string" ? body.reason : "",
      operatorActorId: operator.operatorActorId,
    })
    return c.json(result, 200)
  }
}

export function createRewardRefundPolicyReadinessHandler(
  services: RewardReadinessRouteServices = operatorRouteDefaults,
) {
  return async (c: Context<AuthenticatedEnv>) => {
    const operator = await services.authenticate({
      env: c.env,
      authorization: c.req.header("authorization"),
    })
    requireOperatorScope(operator, REWARD_SETTLEMENT_READ_SCOPE)
    const rawProposed = c.req.query("proposed_max_refund_atomic")
    if (rawProposed !== undefined && !/^(0|[1-9][0-9]*)$/u.test(rawProposed)) {
      throw badRequestError("Invalid proposed max refund")
    }
    const readiness = await services.getRefundPolicyReadiness({
      client: services.getClient(c.env),
      proposedMaxRefundAtomic: rawProposed === undefined ? undefined : BigInt(rawProposed),
    })
    return c.json(readiness, 200)
  }
}

export function createRewardBackendFlipReadinessHandler(
  services: RewardReadinessRouteServices = operatorRouteDefaults,
) {
  return async (c: Context<AuthenticatedEnv>) => {
    const operator = await services.authenticate({
      env: c.env,
      authorization: c.req.header("authorization"),
    })
    requireOperatorScope(operator, REWARD_SETTLEMENT_READ_SCOPE)
    return c.json(await services.getBackendFlipReadiness(services.getClient(c.env)), 200)
  }
}

export function createRewardSolvencyReadinessHandler(
  services: RewardReadinessRouteServices = operatorRouteDefaults,
) {
  return async (c: Context<AuthenticatedEnv>) => {
    const operator = await services.authenticate({
      env: c.env,
      authorization: c.req.header("authorization"),
    })
    requireOperatorScope(operator, REWARD_SETTLEMENT_READ_SCOPE)
    return c.json(await services.getSolvencyReadiness({
      env: c.env,
      client: services.getClient(c.env),
    }), 200)
  }
}

export function createRewardRehearsalHandler(
  services: RewardRehearsalRouteServices = {
    authenticate: operatorRouteDefaults.authenticate,
    enqueue: enqueueRewardRehearsalScenario,
  },
) {
  return async (c: Context<AuthenticatedEnv>) => {
    if (c.env.ENVIRONMENT !== "staging") return c.json({ error: "not_found" }, 404)
    const operator = await services.authenticate({
      env: c.env,
      authorization: c.req.header("authorization"),
    })
    requireOperatorScope(operator, REWARD_REHEARSAL_EXECUTE_SCOPE)
    const body = await c.req.json<{ scenario?: unknown }>().catch(() => null)
    if (!body || Object.keys(body).length !== 1 || !isRewardRehearsalScenario(body.scenario)) {
      throw badRequestError("Rewards rehearsal requires exactly one supported scenario enum")
    }
    const result = await services.enqueue({ env: c.env, scenario: body.scenario })
    console.warn(JSON.stringify({
      message: "rewards rehearsal scenario invoked",
      scenario: body.scenario,
      operator_actor_id: operator.operatorActorId,
      coordinator_ref: result.idempotencyKey,
      state: result.state,
    }))
    return c.json({
      scenario: body.scenario,
      coordinator_ref: result.idempotencyKey,
      state: result.state,
    }, 202, {
      "cache-control": "private, no-store",
    })
  }
}

rewards.post(
  "/operator/reward_campaigns/:campaignId/incidents/:incidentId/recover",
  createRewardCampaignRecoveryHandler(),
)
rewards.post(
  "/operator/reward_settlements/:effectId/resolve",
  createRewardSettlementResolutionHandler(),
)
rewards.get("/operator/reward_pools/refund_policy_readiness", createRewardRefundPolicyReadinessHandler())
rewards.get("/operator/reward_settlements/backend_flip_readiness", createRewardBackendFlipReadinessHandler())
rewards.get("/operator/reward_settlements/solvency_readiness", createRewardSolvencyReadinessHandler())
rewards.post("/operator/reward_settlements/rehearsal", createRewardRehearsalHandler())

export default rewards
