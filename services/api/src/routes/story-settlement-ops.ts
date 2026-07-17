import { Hono, type Context } from "hono"
import { isHex, size, type Hex } from "viem"

import type { Env } from "../env"
import { badRequestError, notFoundError } from "../lib/errors"
import {
  authenticateOperatorCredential,
  requireOperatorScope,
  STORY_SETTLEMENT_REPAIR_SCOPE,
} from "../lib/operator-credential-auth"
import type { OperatorActorContext } from "../lib/operator-credential-auth"
import { captureScheduledWarning } from "../lib/ops-alerts/scheduled"
import { getCommunityRepository } from "../lib/communities/db-community-repository"
import { reconcileCommunityPurchaseSettlement } from "../lib/communities/commerce/settlement-service"
import { resolveStoryCoordinatorDirectSigner } from "../lib/story/story-direct-signer"
import { resolveStoryChainId } from "../lib/story/story-runtime-config"
import { storySettlementCoordinatorName } from "../lib/story/story-settlement-wallet-coordinator-do"
import { recoverOperatorBlockedPostPublish } from "../lib/posts/operator-blocked-publish-recovery"
import { openCommunityWriteClient } from "../lib/communities/community-read-access"
import { decodePublicAssetId, decodePublicCommunityId } from "../lib/public-ids"
import { operatorAttestStoryRegistrationNotBroadcast } from "../lib/story/story-registration-effect-ops"

type StorySettlementOpsEnv = { Bindings: Env }
const storySettlementOps = new Hono<StorySettlementOpsEnv>()
const REASONS = new Set(["operator_cancelled", "terminal_configuration", "rights_hold"])
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/

type OperatorAuthenticator = (input: { env: Env; authorization: string | undefined }) => Promise<OperatorActorContext>
type AlertCapture = typeof captureScheduledWarning
let testAuthenticator: OperatorAuthenticator | null = null
let testAlertCapture: AlertCapture | null = null
let testPurchaseReconciler: typeof reconcileCommunityPurchaseSettlement | null = null
let testOperatorBlockedPublishRecovery: typeof recoverOperatorBlockedPostPublish | null = null
type ConfirmRegistrationNoBroadcast = (input: {
  env: Env
  communityId: string
  assetId: string
  operationId: string
  actorId: string
  reason: string
}) => Promise<{ operationId: string; status: string; errorCode: string | null }>
let testConfirmRegistrationNoBroadcast: ConfirmRegistrationNoBroadcast | null = null

export function setStorySettlementOpsDependenciesForTests(input: {
  authenticate?: OperatorAuthenticator | null
  captureAlert?: AlertCapture | null
  reconcilePurchase?: typeof reconcileCommunityPurchaseSettlement | null
  recoverOperatorBlockedPublish?: typeof recoverOperatorBlockedPostPublish | null
  confirmRegistrationNoBroadcast?: ConfirmRegistrationNoBroadcast | null
}): void {
  testAuthenticator = input.authenticate ?? null
  testAlertCapture = input.captureAlert ?? null
  testPurchaseReconciler = input.reconcilePurchase ?? null
  testOperatorBlockedPublishRecovery = input.recoverOperatorBlockedPublish ?? null
  testConfirmRegistrationNoBroadcast = input.confirmRegistrationNoBroadcast ?? null
}

function bytes32(name: string, value: unknown): Hex {
  if (typeof value !== "string" || !isHex(value, { strict: true }) || size(value) !== 32) {
    throw badRequestError(`${name}_must_be_bytes32`)
  }
  return value
}

function positiveVersion(value: unknown): number {
  const version = Number(value)
  if (!Number.isSafeInteger(version) || version < 1) throw badRequestError("expected_version_must_be_positive")
  return version
}

function reference(value: unknown): string {
  if (typeof value !== "string" || !REFERENCE.test(value)) throw badRequestError("authorization_ref_invalid")
  return value
}

async function operator(c: Context<StorySettlementOpsEnv>) {
  const actor = await (testAuthenticator ?? authenticateOperatorCredential)({
    env: c.env,
    authorization: c.req.header("authorization"),
  })
  requireOperatorScope(actor, STORY_SETTLEMENT_REPAIR_SCOPE)
  return actor
}

function coordinator(c: Context<StorySettlementOpsEnv>) {
  const binding = c.env.STORY_SETTLEMENT_WALLET_COORDINATOR
  if (!binding) throw badRequestError("story_settlement_coordinator_binding_missing")
  const signer = resolveStoryCoordinatorDirectSigner(c.env)
  if (!signer.ok) throw badRequestError(signer.error)
  if (!signer.value) throw badRequestError("story_settlement_coordinator_signer_missing")
  return binding.getByName(storySettlementCoordinatorName(resolveStoryChainId(c.env), signer.value.address))
}

storySettlementOps.post("/plan-inspections", async (c) => {
  const actor = await operator(c)
  let body: Record<string, unknown>
  try { body = await c.req.json<Record<string, unknown>>() } catch { throw badRequestError("invalid_json_body") }
  const planRef = bytes32("plan_ref", body.plan_ref)
  const authorizationRef = reference(body.authorization_ref)
  const plan = await coordinator(c).lookup(planRef)
  if (!plan) throw notFoundError("Story settlement plan not found")
  console.info(JSON.stringify({
    message: "story settlement plan inspected",
    operatorCredentialId: actor.operatorCredentialId,
    operatorActorId: actor.operatorActorId,
    authorizationRef,
    planRef,
  }))
  const serializablePlan = JSON.parse(JSON.stringify(plan, (_key, value) => (
    typeof value === "bigint" ? value.toString() : value
  )))
  return c.json({ plan: serializablePlan }, 200)
})

storySettlementOps.post("/nonce-repairs", async (c) => {
  const actor = await operator(c)
  let body: Record<string, unknown>
  try { body = await c.req.json<Record<string, unknown>>() } catch { throw badRequestError("invalid_json_body") }
  const reason = typeof body.reason_code === "string" ? body.reason_code : ""
  if (!REASONS.has(reason)) throw badRequestError("reason_code_invalid")
  const clientReference = reference(body.authorization_ref)
  const plan = await coordinator(c).requestAbandonedNonceRepair({
    planRef: bytes32("plan_ref", body.plan_ref),
    stepRef: bytes32("step_ref", body.step_ref),
    expectedVersion: positiveVersion(body.expected_version),
    reasonCode: reason as "operator_cancelled" | "terminal_configuration" | "rights_hold",
    authorizationRef: `operator:${actor.operatorCredentialId}:${clientReference}`,
  })
  console.info(JSON.stringify({
    message: "story settlement abandoned nonce repair requested",
    operatorCredentialId: actor.operatorCredentialId,
    operatorActorId: actor.operatorActorId,
    authorizationRef: clientReference,
    planRef: plan.planRef,
  }))
  return c.json({ plan }, 202)
})

storySettlementOps.post("/purchase-reconciliations", async (c) => {
  const actor = await operator(c)
  let body: Record<string, unknown>
  try { body = await c.req.json<Record<string, unknown>>() } catch { throw badRequestError("invalid_json_body") }
  const communityId = reference(body.community_id)
  const quoteId = reference(body.quote_id)
  const authorizationRef = reference(body.authorization_ref)
  const communityRepository = testPurchaseReconciler
    ? {} as Parameters<typeof reconcileCommunityPurchaseSettlement>[0]["communityRepository"]
    : getCommunityRepository(c.env)
  const outcome = await (testPurchaseReconciler ?? reconcileCommunityPurchaseSettlement)({
    env: c.env,
    communityRepository,
    communityId,
    quoteId,
  })
  console.info(JSON.stringify({
    message: "story purchase settlement reconciliation requested",
    operatorCredentialId: actor.operatorCredentialId,
    operatorActorId: actor.operatorActorId,
    authorizationRef,
    communityId,
    quoteId,
    outcome,
  }))
  return c.json({ outcome }, outcome === "finalized" ? 200 : 202)
})

storySettlementOps.post("/operator-blocked-publish-recoveries", async (c) => {
  const actor = await operator(c)
  let body: Record<string, unknown>
  try { body = await c.req.json<Record<string, unknown>>() } catch { throw badRequestError("invalid_json_body") }
  const communityId = reference(body.community_id)
  const postId = reference(body.post_id)
  const authorizationRef = reference(body.authorization_ref)
  const communityRepository = testOperatorBlockedPublishRecovery
    ? {} as Parameters<typeof recoverOperatorBlockedPostPublish>[0]["communityRepository"]
    : getCommunityRepository(c.env)
  const result = await (testOperatorBlockedPublishRecovery ?? recoverOperatorBlockedPostPublish)({
    env: c.env,
    communityRepository,
    communityId,
    postId,
  })
  console.info(JSON.stringify({
    message: "operator-blocked Story publish recovery requested",
    operatorCredentialId: actor.operatorCredentialId,
    operatorActorId: actor.operatorActorId,
    authorizationRef,
    communityId,
    postId,
    jobId: result.jobId,
  }))
  return c.json({ result }, 202)
})

storySettlementOps.post("/registration-effect-no-broadcast-confirmations", async (c) => {
  const actor = await operator(c)
  let body: Record<string, unknown>
  try { body = await c.req.json<Record<string, unknown>>() } catch { throw badRequestError("invalid_json_body") }
  const communityId = decodePublicCommunityId(reference(body.community_id))
  const assetId = decodePublicAssetId(reference(body.asset_id))
  const operationId = reference(body.operation_id)
  const authorizationRef = reference(body.authorization_ref)
  const reason = typeof body.reason === "string" ? body.reason.trim() : ""
  if (reason.length < 10 || reason.length > 600) throw badRequestError("reason_must_be_10_to_600_characters")

  const confirm = testConfirmRegistrationNoBroadcast ?? (async (input) => {
    const communityRepository = getCommunityRepository(input.env)
    const db = await openCommunityWriteClient(input.env, communityRepository, input.communityId)
    try {
      const effect = await operatorAttestStoryRegistrationNotBroadcast({
        env: input.env,
        client: db.client,
        communityId: input.communityId,
        assetId: input.assetId,
        expectedOperationId: input.operationId,
        actorId: input.actorId,
        reason: input.reason,
        now: new Date().toISOString(),
      })
      return { operationId: effect.operationId, status: effect.status, errorCode: effect.errorCode }
    } finally {
      db.close()
    }
  })
  const effect = await confirm({
    env: c.env,
    communityId,
    assetId,
    operationId,
    actorId: actor.operatorActorId,
    reason,
  })
  console.info(JSON.stringify({
    message: "Story registration no-broadcast outcome confirmed",
    operatorCredentialId: actor.operatorCredentialId,
    operatorActorId: actor.operatorActorId,
    authorizationRef,
    communityId,
    assetId,
    operationId,
  }))
  return c.json({ effect, next_action: "recycle the owning finalize job" }, 200)
})

storySettlementOps.post("/alerts/synthetic", async (c) => {
  const actor = await operator(c)
  if (c.env.ENVIRONMENT !== "staging") return c.json({ error: "synthetic_alert_staging_only" }, 403)
  let body: Record<string, unknown>
  try { body = await c.req.json<Record<string, unknown>>() } catch { throw badRequestError("invalid_json_body") }
  const authorizationRef = reference(body.authorization_ref)
  const delivered = await (testAlertCapture ?? captureScheduledWarning)(
    c.env,
    "Synthetic Story settlement coordinator alert",
    `story_settlement_coordinator_synthetic:${authorizationRef}`,
    {
      operatorCredentialId: actor.operatorCredentialId,
      operatorActorId: actor.operatorActorId,
      authorizationRef,
      synthetic: true,
    },
    { urgency: "high" },
  )
  return c.json({ delivered }, delivered ? 202 : 503)
})

export default storySettlementOps
