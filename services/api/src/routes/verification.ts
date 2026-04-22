import { Hono } from "hono"
import { badRequestError, notFoundError } from "../lib/errors"
import { getControlPlaneVerificationRepository } from "../lib/verification/control-plane-verification-repository"
import { authenticate, type AuthenticatedEnv } from "../lib/auth-middleware"
import type { Env, RequestedVerificationCapability, VerificationIntent, VerificationRequirement } from "../types"

const verification = new Hono<{ Bindings: Env }>()
const authenticatedVerification = new Hono<AuthenticatedEnv>()

verification.post("/verification-sessions/:verificationSessionId/self-callback", async (c) => {
  const payload = (await c.req.json<Record<string, unknown>>().catch(() => null)) ?? null
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw badRequestError("Invalid Self verification callback payload")
  }
  const repo = getControlPlaneVerificationRepository(c.env)
  const result = await repo.completeSelfVerificationCallback({
    verificationSessionId: c.req.param("verificationSessionId"),
    payload,
  })
  if (!result) {
    throw notFoundError("Verification session not found")
  }
  return c.json({ status: result.status, verification_session_id: result.verification_session_id }, 200)
})

authenticatedVerification.use("*", authenticate)

authenticatedVerification.post("/verification-sessions", async (c) => {
  const actor = c.get("actor")
  const body = await c.req.json<{
    provider?: "self" | "very"
    provider_mode?: "qr_deeplink" | "widget" | null
    requested_capabilities?: RequestedVerificationCapability[] | null
    verification_requirements?: VerificationRequirement[] | null
    wallet_attachment_id?: string | null
    verification_intent?: string | null
    policy_id?: string | null
  }>().catch(() => null)
  if (!body?.provider || (body.provider !== "self" && body.provider !== "very")) {
    throw badRequestError("Invalid verification session payload")
  }

  const repo = getControlPlaneVerificationRepository(c.env)
  const publicOrigin = new URL(c.req.url).origin
  const created = await repo.startVerificationSession({
    userId: actor.userId,
    provider: body.provider,
    requestedCapabilities: body.requested_capabilities ?? null,
    verificationRequirements: body.verification_requirements ?? null,
    walletAttachmentId: body.wallet_attachment_id ?? null,
    verificationIntent: (body.verification_intent as VerificationIntent | undefined) ?? null,
    policyId: body.policy_id ?? null,
    publicOrigin,
  })
  return c.json(created, 201)
})

authenticatedVerification.get("/verification-sessions/:verificationSessionId", async (c) => {
  const actor = c.get("actor")
  const repo = getControlPlaneVerificationRepository(c.env)
  const result = await repo.getVerificationSession(c.req.param("verificationSessionId"), actor.userId)
  if (!result) {
    throw notFoundError("Verification session not found")
  }
  return c.json(result, 200)
})

authenticatedVerification.post("/verification-sessions/:verificationSessionId/complete", async (c) => {
  const actor = c.get("actor")
  const body =
    (await c.req
      .json<{ attestation_id?: string | null; proof?: unknown; proof_hash?: string | null; provider_payload_ref?: unknown }>()
      .catch(() => null)) ?? null
  const repo = getControlPlaneVerificationRepository(c.env)
  const result = await repo.completeVerificationSession({
    verificationSessionId: c.req.param("verificationSessionId"),
    userId: actor.userId,
    attestationId: body?.attestation_id ?? null,
    proof: body?.proof ?? null,
    proofHash: body?.proof_hash ?? null,
    providerPayloadRef: body?.provider_payload_ref ?? null,
  })
  if (!result) {
    throw notFoundError("Verification session not found")
  }
  return c.json(result, 200)
})

authenticatedVerification.post("/namespace-verification-sessions", async (c) => {
  const actor = c.get("actor")
  const body = await c.req.json<{ family?: "hns" | "spaces"; root_label?: string }>().catch(() => null)
  if (!body?.family || (body.family !== "hns" && body.family !== "spaces") || !body.root_label?.trim()) {
    throw badRequestError("Invalid namespace verification session payload")
  }

  const repo = getControlPlaneVerificationRepository(c.env)
  const created = await repo.startNamespaceVerificationSession({
    userId: actor.userId,
    family: body.family,
    rootLabel: body.root_label,
  })
  return c.json(created, 201)
})

authenticatedVerification.get("/namespace-verification-sessions/:namespaceVerificationSessionId", async (c) => {
  const actor = c.get("actor")
  const repo = getControlPlaneVerificationRepository(c.env)
  const result = await repo.getNamespaceVerificationSession(c.req.param("namespaceVerificationSessionId"), actor.userId)
  if (!result) {
    throw notFoundError("Namespace verification session not found")
  }
  return c.json(result, 200)
})

authenticatedVerification.post("/namespace-verification-sessions/:namespaceVerificationSessionId/complete", async (c) => {
  const actor = c.get("actor")
  const body = (await c.req.json<{
    restart_challenge?: boolean | null
    signature_payload?: Record<string, unknown> | null
  }>().catch(() => null)) ?? null
  const repo = getControlPlaneVerificationRepository(c.env)
  const result = await repo.completeNamespaceVerificationSession({
    namespaceVerificationSessionId: c.req.param("namespaceVerificationSessionId"),
    userId: actor.userId,
    restartChallenge: body?.restart_challenge ?? null,
    signaturePayload: body?.signature_payload ?? null,
  })
  if (!result) {
    throw notFoundError("Namespace verification session not found")
  }
  return c.json(result, 200)
})

authenticatedVerification.get("/namespace-verifications/:namespaceVerificationId", async (c) => {
  const actor = c.get("actor")
  const repo = getControlPlaneVerificationRepository(c.env)
  const result = await repo.getNamespaceVerification(c.req.param("namespaceVerificationId"), actor.userId)
  if (!result) {
    throw notFoundError("Namespace verification not found")
  }
  return c.json(result, 200)
})

verification.route("/", authenticatedVerification)

export default verification
