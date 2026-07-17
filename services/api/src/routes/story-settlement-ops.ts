import { Hono, type Context } from "hono"
import { isHex, size, type Hex } from "viem"

import type { Env } from "../env"
import { badRequestError } from "../lib/errors"
import {
  authenticateOperatorCredential,
  requireOperatorScope,
  STORY_SETTLEMENT_REPAIR_SCOPE,
} from "../lib/operator-credential-auth"
import type { OperatorActorContext } from "../lib/operator-credential-auth"
import { captureScheduledWarning } from "../lib/ops-alerts/scheduled"
import { resolveStoryCoordinatorDirectSigner } from "../lib/story/story-direct-signer"
import { resolveStoryChainId } from "../lib/story/story-runtime-config"
import { storySettlementCoordinatorName } from "../lib/story/story-settlement-wallet-coordinator-do"

type StorySettlementOpsEnv = { Bindings: Env }
const storySettlementOps = new Hono<StorySettlementOpsEnv>()
const REASONS = new Set(["operator_cancelled", "terminal_configuration", "rights_hold"])
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/

type OperatorAuthenticator = (input: { env: Env; authorization: string | undefined }) => Promise<OperatorActorContext>
type AlertCapture = typeof captureScheduledWarning
let testAuthenticator: OperatorAuthenticator | null = null
let testAlertCapture: AlertCapture | null = null

export function setStorySettlementOpsDependenciesForTests(input: {
  authenticate?: OperatorAuthenticator | null
  captureAlert?: AlertCapture | null
}): void {
  testAuthenticator = input.authenticate ?? null
  testAlertCapture = input.captureAlert ?? null
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

storySettlementOps.post("/nonce-repairs", async (c) => {
  const actor = await operator(c)
  let body: Record<string, unknown>
  try { body = await c.req.json<Record<string, unknown>>() } catch { throw badRequestError("invalid_json_body") }
  const reason = typeof body.reason_code === "string" ? body.reason_code : ""
  if (!REASONS.has(reason)) throw badRequestError("reason_code_invalid")
  const binding = c.env.STORY_SETTLEMENT_WALLET_COORDINATOR
  if (!binding) throw badRequestError("story_settlement_coordinator_binding_missing")
  const signer = resolveStoryCoordinatorDirectSigner(c.env)
  if (!signer.ok) throw badRequestError(signer.error)
  if (!signer.value) throw badRequestError("story_settlement_coordinator_signer_missing")
  const clientReference = reference(body.authorization_ref)
  const coordinator = binding.getByName(storySettlementCoordinatorName(resolveStoryChainId(c.env), signer.value.address))
  const plan = await coordinator.requestAbandonedNonceRepair({
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
