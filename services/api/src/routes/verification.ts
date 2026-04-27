import { Hono } from "hono"
import { badRequestError, notFoundError } from "../lib/errors"
import { getControlPlaneVerificationRepository } from "../lib/verification/verification-repository"
import { proxyVeryBridgeRequest } from "../lib/verification/very-provider"
import { authenticateAdminOrUser, type AuthenticatedEnv } from "../lib/auth-middleware"
import { trackApiEvent } from "../lib/analytics/track"
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
  await trackApiEvent(c.env, c.req, {
    eventName: result.status === "verified" ? "unique_human_verification_succeeded" : "unique_human_verification_failed",
    userId: result.user_id,
    verificationSessionId: result.verification_session_id,
    properties: {
      provider: "self",
      intent: result.verification_intent ?? null,
      failure_code: result.status === "verified" ? null : result.failure_reason ?? result.status,
    },
  })
  return c.json({ status: result.status, verification_session_id: result.verification_session_id }, 200)
})

verification.post("/verification-sessions/very-widget-verify", async (c) => {
  const payload = (await c.req.json<{ proof?: unknown }>().catch(() => null)) ?? null
  const proof = typeof payload?.proof === "string" ? payload.proof.trim() : ""
  if (!proof) {
    return c.json({ status: "invalid", error: "missing_proof" }, 200)
  }

  return c.json({ status: "valid" }, 200)
})

authenticatedVerification.use("*", authenticateAdminOrUser)

authenticatedVerification.post("/verification-sessions/:verificationSessionId/very-bridge/sessions", async (c) => {
  const actor = c.get("actor")
  const body = await c.req.text()
  const result = await proxyVeryBridgeRequest({
    body,
    env: c.env,
    method: "POST",
    path: "sessions",
  })
  const providerSessionId = typeof result.body.sessionId === "string" ? result.body.sessionId.trim() : ""
  if (providerSessionId) {
    const repo = getControlPlaneVerificationRepository(c.env)
    const recorded = await repo.recordVeryBridgeSession({
      verificationSessionId: c.req.param("verificationSessionId"),
      userId: actor.userId,
      providerSessionId,
    })
    if (!recorded) {
      throw notFoundError("Verification session not found")
    }
  }
  return c.json(result.body, result.status as 200)
})

authenticatedVerification.get("/verification-sessions/:verificationSessionId/very-bridge/session/:providerSessionId", async (c) => {
  const actor = c.get("actor")
  const repo = getControlPlaneVerificationRepository(c.env)
  const session = await repo.getVerificationSession(c.req.param("verificationSessionId"), actor.userId)
  if (!session) {
    throw notFoundError("Verification session not found")
  }
  const providerSessionId = c.req.param("providerSessionId").trim()
  if (!providerSessionId || providerSessionId.includes("/")) {
    throw badRequestError("Invalid Very bridge session id")
  }
  const result = await proxyVeryBridgeRequest({
    env: c.env,
    method: "GET",
    path: `session/${encodeURIComponent(providerSessionId)}`,
  })
  return c.json(result.body, result.status as 200)
})

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
  await trackApiEvent(c.env, c.req, {
    eventName: "unique_human_verification_started",
    userId: actor.userId,
    verificationSessionId: created.verification_session_id,
    properties: {
      provider: body.provider,
      intent: body.verification_intent ?? null,
    },
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
  if (result.status === "verified" || result.status === "failed" || result.status === "expired") {
    await trackApiEvent(c.env, c.req, {
      eventName: result.status === "verified" ? "unique_human_verification_succeeded" : "unique_human_verification_failed",
      userId: actor.userId,
      verificationSessionId: result.verification_session_id,
      properties: {
        provider: result.provider,
        intent: result.verification_intent ?? null,
        failure_code: result.status === "verified" ? null : result.failure_reason ?? result.status,
      },
    })
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
  await trackApiEvent(c.env, c.req, {
    eventName: "namespace_verification_started",
    userId: actor.userId,
    properties: { tld: body.family },
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
  if (result.status === "verified" || result.status === "failed" || result.status === "expired") {
    await trackApiEvent(c.env, c.req, {
      eventName: result.status === "verified" ? "namespace_verification_succeeded" : "namespace_verification_failed",
      userId: actor.userId,
      properties: {
        tld: result.family,
        failure_code: result.status === "verified" ? null : result.failure_reason ?? result.status,
      },
    })
  }
  return c.json(result, 200)
})

authenticatedVerification.post("/namespace-verification-sessions/:namespaceVerificationSessionId/complete", async (c) => {
  const actor = c.get("actor")
  const body = (await c.req.json<{
    restart_challenge?: boolean | null
  }>().catch(() => null)) ?? null
  const repo = getControlPlaneVerificationRepository(c.env)
  const result = await repo.completeNamespaceVerificationSession({
    namespaceVerificationSessionId: c.req.param("namespaceVerificationSessionId"),
    userId: actor.userId,
    restartChallenge: body?.restart_challenge ?? null,
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
