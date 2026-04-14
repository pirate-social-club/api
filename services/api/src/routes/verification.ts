import { Hono } from "hono"
import { authError, badRequestError, errorResponse, notFoundError } from "../lib/errors"
import { getControlPlaneVerificationRepository } from "../lib/verification/control-plane-verification-repository"
import { requireBearerToken } from "../lib/helpers"
import { verifyPirateAccessToken } from "../lib/auth/pirate-session-token"
import type { Env, RequestedVerificationCapability, VerificationIntent } from "../types"

const verification = new Hono<{ Bindings: Env }>()

verification.post("/verification-sessions", async (c) => {
  try {
    const token = requireBearerToken(c.req.header("authorization"))
    const session = await verifyPirateAccessToken({ env: c.env, token })
    const body = await c.req.json<{
      provider?: "self" | "very"
      provider_mode?: "qr_deeplink" | "widget" | null
      requested_capabilities?: RequestedVerificationCapability[] | null
      wallet_attachment_id?: string | null
      verification_intent?: string | null
      policy_id?: string | null
    }>().catch(() => null)
    if (!body?.provider || (body.provider !== "self" && body.provider !== "very")) {
      throw badRequestError("Invalid verification session payload")
    }

    const repo = getControlPlaneVerificationRepository(c.env)
    const created = await repo.startVerificationSession({
      userId: session.userId,
      provider: body.provider,
      requestedCapabilities: body.requested_capabilities ?? null,
      walletAttachmentId: body.wallet_attachment_id ?? null,
      verificationIntent: (body.verification_intent as VerificationIntent | undefined) ?? null,
      policyId: body.policy_id ?? null,
    })
    return c.json(created, 201)
  } catch (error) {
    const response = errorResponse(error)
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { "content-type": "application/json" },
    })
  }
})

verification.get("/verification-sessions/:verificationSessionId", async (c) => {
  try {
    const token = requireBearerToken(c.req.header("authorization"))
    const session = await verifyPirateAccessToken({ env: c.env, token })
    const repo = getControlPlaneVerificationRepository(c.env)
    const result = await repo.getVerificationSession(c.req.param("verificationSessionId"), session.userId)
    if (!result) {
      throw notFoundError("Verification session not found")
    }
    return c.json(result, 200)
  } catch (error) {
    const response = errorResponse(error)
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { "content-type": "application/json" },
    })
  }
})

verification.post("/verification-sessions/:verificationSessionId/complete", async (c) => {
  try {
    const token = requireBearerToken(c.req.header("authorization"))
    const session = await verifyPirateAccessToken({ env: c.env, token })
    const body =
      (await c.req
        .json<{ attestation_id?: string | null; proof?: string | null; proof_hash?: string | null; provider_payload_ref?: string | null }>()
        .catch(() => null)) ?? null
    const repo = getControlPlaneVerificationRepository(c.env)
    const result = await repo.completeVerificationSession({
      verificationSessionId: c.req.param("verificationSessionId"),
      userId: session.userId,
      attestationId: body?.attestation_id ?? null,
      proof: body?.proof ?? null,
      proofHash: body?.proof_hash ?? null,
      providerPayloadRef: body?.provider_payload_ref ?? null,
    })
    if (!result) {
      throw notFoundError("Verification session not found")
    }
    return c.json(result, 200)
  } catch (error) {
    const response = errorResponse(error)
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { "content-type": "application/json" },
    })
  }
})

verification.post("/namespace-verification-sessions", async (c) => {
  try {
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
  } catch (error) {
    const response = errorResponse(error)
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { "content-type": "application/json" },
    })
  }
})

verification.get("/namespace-verification-sessions/:namespaceVerificationSessionId", async (c) => {
  try {
    const token = requireBearerToken(c.req.header("authorization"))
    const session = await verifyPirateAccessToken({ env: c.env, token })
    const repo = getControlPlaneVerificationRepository(c.env)
    const result = await repo.getNamespaceVerificationSession(c.req.param("namespaceVerificationSessionId"), session.userId)
    if (!result) {
      throw notFoundError("Namespace verification session not found")
    }
    return c.json(result, 200)
  } catch (error) {
    const response = errorResponse(error)
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { "content-type": "application/json" },
    })
  }
})

verification.post("/namespace-verification-sessions/:namespaceVerificationSessionId/complete", async (c) => {
  try {
    const token = requireBearerToken(c.req.header("authorization"))
    const session = await verifyPirateAccessToken({ env: c.env, token })
    const body = (await c.req.json<{
      restart_challenge?: boolean | null
      signature_payload?: Record<string, unknown> | null
    }>().catch(() => null)) ?? null
    const repo = getControlPlaneVerificationRepository(c.env)
    const result = await repo.completeNamespaceVerificationSession({
      namespaceVerificationSessionId: c.req.param("namespaceVerificationSessionId"),
      userId: session.userId,
      restartChallenge: body?.restart_challenge ?? null,
      signaturePayload: body?.signature_payload ?? null,
    })
    if (!result) {
      throw notFoundError("Namespace verification session not found")
    }
    return c.json(result, 200)
  } catch (error) {
    const response = errorResponse(error)
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { "content-type": "application/json" },
    })
  }
})

verification.get("/namespace-verifications/:namespaceVerificationId", async (c) => {
  try {
    const token = requireBearerToken(c.req.header("authorization"))
    const session = await verifyPirateAccessToken({ env: c.env, token })
    const repo = getControlPlaneVerificationRepository(c.env)
    const result = await repo.getNamespaceVerification(c.req.param("namespaceVerificationId"), session.userId)
    if (!result) {
      throw notFoundError("Namespace verification not found")
    }
    return c.json(result, 200)
  } catch (error) {
    const response = errorResponse(error)
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { "content-type": "application/json" },
    })
  }
})

export default verification
