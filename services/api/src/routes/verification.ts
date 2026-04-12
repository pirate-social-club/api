import { Hono } from "hono"
import { authError, badRequestError, errorResponse, notFoundError } from "../lib/errors"
import { getControlPlaneVerificationRepository } from "../lib/verification/control-plane-verification-repository"
import { requireBearerToken } from "../lib/helpers"
import { verifyPirateAccessToken } from "../lib/auth/pirate-session-token"
import { handleRoute, requireRouteParam } from "./route-helpers"
import type { Env, StartVerificationSessionRequest } from "../types"

const verification = new Hono<{ Bindings: Env }>()
const VALID_VERIFICATION_INTENTS = new Set<string>([
  "profile_verification",
  "community_creation",
  "ucommunity_join",
  "post_access_18_plus",
  "commerce_pricing",
  "qualifier_disclosure",
] as const)

verification.post("/verification-sessions", handleRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const session = await verifyPirateAccessToken({ env: c.env, token })
  const body = await c.req.json<Partial<StartVerificationSessionRequest>>().catch(() => null)
  if (!body?.provider || (body.provider !== "self" && body.provider !== "very")) {
    throw badRequestError("Invalid verification session payload")
  }

  const requestedCapabilitiesInput = body.requested_capabilities
  const requestedCapabilities = Array.isArray(requestedCapabilitiesInput)
    ? requestedCapabilitiesInput.filter((value): value is "unique_human" | "age_over_18" | "nationality" | "gender" => (
      value === "unique_human"
      || value === "age_over_18"
      || value === "nationality"
      || value === "gender"
    ))
    : null
  if (
    requestedCapabilities != null
    && Array.isArray(requestedCapabilitiesInput)
    && requestedCapabilities.length !== requestedCapabilitiesInput.length
  ) {
    throw badRequestError("Invalid requested_capabilities")
  }
  const verificationIntent = typeof body.verification_intent === "string"
    ? body.verification_intent
    : body.verification_intent == null
      ? null
      : (() => {
          throw badRequestError("Invalid verification_intent")
        })()
  if (verificationIntent != null && !VALID_VERIFICATION_INTENTS.has(verificationIntent)) {
    throw badRequestError("Invalid verification_intent")
  }
  const policyId = typeof body.policy_id === "string"
    ? body.policy_id
    : body.policy_id == null
      ? null
      : (() => {
          throw badRequestError("Invalid policy_id")
        })()

  const repo = getControlPlaneVerificationRepository(c.env)
  const created = await repo.startVerificationSession({
    userId: session.userId,
    provider: body.provider,
    walletAttachmentId: body.wallet_attachment_id ?? null,
    requestedCapabilities,
    verificationIntent,
    policyId,
  })
  return c.json(created, 201)
}))

verification.get("/verification-sessions/:verificationSessionId", handleRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const session = await verifyPirateAccessToken({ env: c.env, token })
  const repo = getControlPlaneVerificationRepository(c.env)
  const verificationSessionId = requireRouteParam(c.req.param("verificationSessionId"), "verification_session_id")
  const result = await repo.getVerificationSession(verificationSessionId, session.userId)
  if (!result) {
    throw notFoundError("Verification session not found")
  }
  return c.json(result, 200)
}))

verification.post("/verification-sessions/:verificationSessionId/callback", handleRoute(async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null)
  const repo = getControlPlaneVerificationRepository(c.env)
  const verificationSessionId = requireRouteParam(c.req.param("verificationSessionId"), "verification_session_id")
  const result = await repo.completeVerificationSessionByCallback({
    verificationSessionId,
    requestBody: body ?? {},
  })
  if (!result) {
    throw notFoundError("Verification session not found")
  }
  return c.json(result, 200)
}))

verification.post("/verification-sessions/:verificationSessionId/complete", handleRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const session = await verifyPirateAccessToken({ env: c.env, token })
  const body =
    (await c.req
      .json<{ attestation_id?: string | null; proof_hash?: string | null; proof?: string | null }>()
      .catch(() => null)) ?? null
  const repo = getControlPlaneVerificationRepository(c.env)
  const verificationSessionId = requireRouteParam(c.req.param("verificationSessionId"), "verification_session_id")
  const result = await repo.completeVerificationSession({
    verificationSessionId,
    userId: session.userId,
    attestationId: body?.attestation_id ?? null,
    proofHash: body?.proof_hash ?? null,
    proof: body?.proof ?? null,
  })
  if (!result) {
    throw notFoundError("Verification session not found")
  }
  return c.json(result, 200)
}))

verification.post("/namespace-verification-sessions", handleRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const session = await verifyPirateAccessToken({ env: c.env, token })
  const body = await c.req.json<{ family?: "hns" | "spaces"; root_label?: string }>().catch(() => null)
  if (!body?.family || (body.family !== "hns" && body.family !== "spaces") || !body.root_label?.trim()) {
    throw badRequestError("Invalid namespace verification session payload")
  }

  const repo = getControlPlaneVerificationRepository(c.env)
  const created = await repo.startNamespaceVerificationSession({
    userId: session.userId,
    family: body.family,
    rootLabel: body.root_label,
  })
  return c.json(created, 201)
}))

verification.get("/namespace-verification-sessions/:namespaceVerificationSessionId", handleRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const session = await verifyPirateAccessToken({ env: c.env, token })
  const repo = getControlPlaneVerificationRepository(c.env)
  const namespaceVerificationSessionId = requireRouteParam(
    c.req.param("namespaceVerificationSessionId"),
    "namespace_verification_session_id",
  )
  const result = await repo.getNamespaceVerificationSession(namespaceVerificationSessionId, session.userId)
  if (!result) {
    throw notFoundError("Namespace verification session not found")
  }
  return c.json(result, 200)
}))

verification.post("/namespace-verification-sessions/:namespaceVerificationSessionId/complete", handleRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const session = await verifyPirateAccessToken({ env: c.env, token })
  const body = (
    await c.req.json<{
      restart_challenge?: boolean | null
      signature_payload?: {
        signature?: string | null
        algorithm?: string | null
        signer_pubkey?: string | null
        digest?: string | null
      } | null
    }>().catch(() => null)
  ) ?? null
  const repo = getControlPlaneVerificationRepository(c.env)
  const namespaceVerificationSessionId = requireRouteParam(
    c.req.param("namespaceVerificationSessionId"),
    "namespace_verification_session_id",
  )
  const result = await repo.completeNamespaceVerificationSession({
    namespaceVerificationSessionId,
    userId: session.userId,
    restartChallenge: body?.restart_challenge ?? null,
    signaturePayload: body?.signature_payload ?? null,
  })
  if (!result) {
    throw notFoundError("Namespace verification session not found")
  }
  return c.json(result, 200)
}))

verification.get("/namespace-verifications/:namespaceVerificationId", handleRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const session = await verifyPirateAccessToken({ env: c.env, token })
  const repo = getControlPlaneVerificationRepository(c.env)
  const namespaceVerificationId = requireRouteParam(c.req.param("namespaceVerificationId"), "namespace_verification_id")
  const result = await repo.getNamespaceVerification(namespaceVerificationId, session.userId)
  if (!result) {
    throw notFoundError("Namespace verification not found")
  }
  return c.json(result, 200)
}))

export default verification
