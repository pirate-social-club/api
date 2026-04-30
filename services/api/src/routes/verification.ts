import { Hono } from "hono"
import { badRequestError, HttpError, notFoundError } from "../lib/errors"
import { getControlPlaneVerificationRepository } from "../lib/verification/verification-repository"
import { proxyVeryBridgeRequest } from "../lib/verification/very-provider"
import { refreshPassportWalletScore } from "../lib/verification/passport-wallet-score-service"
import { authenticate, authenticateAdminOrUser, type AuthenticatedEnv } from "../lib/auth-middleware"
import { trackApiEvent } from "../lib/analytics/track"
import { logVerificationDebug } from "../lib/verification/verification-logging"
import { getUserRepository } from "../lib/auth/repositories"
import { getCommunityRepository } from "../lib/communities/db-community-repository"
import { resolveCommunityIdentifier } from "../lib/communities/community-identifier"
import { getJoinEligibility } from "../lib/communities/membership/eligibility-service"
import {
  decodePublicNamespaceVerificationId,
  decodePublicNamespaceVerificationSessionId,
  decodePublicVerificationSessionId,
} from "../lib/public-ids"
import type { Env, RequestedVerificationCapability, VerificationIntent, VerificationRequirement } from "../types"

const verification = new Hono<{ Bindings: Env }>()
const authenticatedVerification = new Hono<AuthenticatedEnv>()
const authenticatedNamespaceVerification = new Hono<AuthenticatedEnv>()
type VeryBridgePollStatus = "initialized" | "received" | "completed"
const veryBridgeLastStatusBySession = new Map<string, VeryBridgePollStatus>()

function isVeryBridgePollStatus(value: unknown): value is VeryBridgePollStatus {
  return value === "initialized" || value === "received" || value === "completed"
}

function namespaceVerificationErrorProperties(input: {
  endpoint: string
  error: unknown
  tld?: string | null
}): Record<string, unknown> {
  return {
    endpoint: input.endpoint,
    tld: input.tld ?? null,
    error_code: input.error instanceof HttpError ? input.error.code : "internal_error",
    error_status: input.error instanceof HttpError ? input.error.status : 500,
    retryable: input.error instanceof HttpError ? input.error.retryable : false,
    message: input.error instanceof Error ? input.error.message : String(input.error),
  }
}

verification.post("/verification-sessions/:verificationSessionId/self-callback", async (c) => {
  const payload = (await c.req.json<Record<string, unknown>>().catch(() => null)) ?? null
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw badRequestError("Invalid Self verification callback payload")
  }
  const repo = getControlPlaneVerificationRepository(c.env)
  const result = await repo.completeSelfVerificationCallback({
    verificationSessionId: decodePublicVerificationSessionId(c.req.param("verificationSessionId")),
    payload,
  })
  if (!result) {
    throw notFoundError("Verification session not found")
  }
  await trackApiEvent(c.env, c.req, {
    eventName: result.status === "verified" ? "unique_human_verification_succeeded" : "unique_human_verification_failed",
    userId: result.user.replace(/^usr_/, ""),
    verificationSessionId: result.id.replace(/^vs_/, ""),
    properties: {
      provider: "self",
      intent: result.verification_intent ?? null,
      failure_code: result.status === "verified" ? null : result.failure_reason ?? result.status,
    },
  })
  return c.json({
    result: result.status === "verified",
    status: result.status,
    verification_session_id: result.id,
  }, 200)
})

verification.post("/verification-sessions/very-widget-verify", async (c) => {
  const payload = (await c.req.json<{ proof?: unknown }>().catch(() => null)) ?? null
  const proof = typeof payload?.proof === "string" ? payload.proof.trim() : ""
  if (!proof) {
    return c.json({ status: "invalid", error: "missing_proof" }, 200)
  }

  logVerificationDebug(c.env, "[very-provider] widget verify callback received", {
    proofLength: proof.length,
  })
  return c.json({ status: "valid" }, 200)
})

authenticatedVerification.use("/verification-sessions", authenticate)
authenticatedVerification.use("/verification-sessions/*", authenticate)
authenticatedVerification.use("/verification/passport-wallet-score", authenticate)
authenticatedNamespaceVerification.use("/namespace-verification-sessions", authenticateAdminOrUser)
authenticatedNamespaceVerification.use("/namespace-verification-sessions/*", authenticateAdminOrUser)
authenticatedNamespaceVerification.use("/namespace-verifications/*", authenticateAdminOrUser)

authenticatedVerification.post("/verification-sessions/:verificationSessionId/very-bridge/sessions", async (c) => {
  const actor = c.get("actor")
  const verificationSessionId = decodePublicVerificationSessionId(c.req.param("verificationSessionId"))
  const body = await c.req.text()
  const result = await proxyVeryBridgeRequest({
    body,
    env: c.env,
    method: "POST",
    path: "sessions",
  })
  const providerSessionId = typeof result.body.sessionId === "string" ? result.body.sessionId.trim() : ""
  if (providerSessionId) {
    logVerificationDebug(c.env, "[very-provider] bridge session created", {
      verificationSessionId,
      providerSessionId,
    })
    const repo = getControlPlaneVerificationRepository(c.env)
    const recorded = await repo.recordVeryBridgeSession({
      verificationSessionId,
      userId: actor.userId,
      providerSessionId,
    })
    if (!recorded) {
      throw notFoundError("Verification session not found")
    }
  } else {
    console.warn("[very-provider] bridge session creation did not return a session id", {
      verificationSessionId,
      responseStatus: result.status,
      bodyStatus: typeof result.body.status === "string" ? result.body.status : null,
      userMessage: typeof result.body.userMessage === "string" ? result.body.userMessage : null,
      message: typeof result.body.message === "string" ? result.body.message : null,
      bodyKeys: Object.keys(result.body).sort(),
    })
  }
  return c.json(result.body, result.status as 200)
})

authenticatedVerification.get("/verification-sessions/:verificationSessionId/very-bridge/session/:providerSessionId", async (c) => {
  const actor = c.get("actor")
  const repo = getControlPlaneVerificationRepository(c.env)
  const verificationSessionId = decodePublicVerificationSessionId(c.req.param("verificationSessionId"))
  const session = await repo.getVerificationSession(verificationSessionId, actor.userId)
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
  const status = typeof result.body.status === "string" ? result.body.status : null
  if (isVeryBridgePollStatus(status)) {
    veryBridgeLastStatusBySession.set(providerSessionId, status)
  }
  if (result.status === 504 && result.body.userMessage === "Very bridge request timed out") {
    const fallbackStatus = veryBridgeLastStatusBySession.get(providerSessionId) ?? "initialized"
    console.warn("[very-provider] bridge session status timed out; returning last known status", {
      verificationSessionId,
      providerSessionId,
      fallbackStatus,
    })
    return c.json({ status: fallbackStatus }, 200)
  }
  logVerificationDebug(c.env, "[very-provider] bridge session status", {
    verificationSessionId,
    providerSessionId,
    status,
    responseStatus: result.status,
    hasResponse: Boolean(result.body.response),
    userMessage: typeof result.body.userMessage === "string" ? result.body.userMessage : null,
    message: typeof result.body.message === "string" ? result.body.message : null,
    error: typeof result.body.error === "string" ? result.body.error : null,
    code: typeof result.body.code === "string" || typeof result.body.code === "number" ? result.body.code : null,
    bodyKeys: Object.keys(result.body).sort(),
  })
  if (status === "error" || result.status >= 400) {
    console.warn("[very-provider] bridge session status error", {
      verificationSessionId,
      providerSessionId,
      status,
      responseStatus: result.status,
      userMessage: typeof result.body.userMessage === "string" ? result.body.userMessage : null,
    })
  } else if (status === "completed") {
    logVerificationDebug(c.env, "[very-provider] bridge session completed", {
      verificationSessionId,
      providerSessionId,
    })
  }
  return c.json(result.body, result.status as 200)
})

authenticatedVerification.post("/verification/passport-wallet-score", async (c) => {
  const actor = c.get("actor")
  const body = (await c.req.json<{
    wallet_attachment_id?: string | null
    community_id?: string | null
  }>().catch(() => null)) ?? {}
  const refreshed = await refreshPassportWalletScore({
    env: c.env,
    userId: actor.userId,
    walletAttachmentId: body.wallet_attachment_id ?? null,
  })

  const communityRef = typeof body.community_id === "string" ? body.community_id.trim() : ""
  if (!communityRef) {
    return c.json({
      wallet_score: refreshed.walletScore,
      wallet_score_status: refreshed.walletScoreStatus,
    }, 200)
  }

  const communityRepository = getCommunityRepository(c.env)
  const communityId = await resolveCommunityIdentifier(communityRepository, communityRef) ?? communityRef
  const joinEligibility = await getJoinEligibility({
    env: c.env,
    userId: actor.userId,
    communityId,
    userRepository: getUserRepository(c.env),
    communityRepository,
  })
  return c.json({
    wallet_score: refreshed.walletScore,
    wallet_score_status: joinEligibility.wallet_score_status ?? refreshed.walletScoreStatus,
    join_eligibility: joinEligibility,
  }, 200)
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
  logVerificationDebug(c.env, "[verification-sessions] start request", {
    userId: actor.userId,
    provider: body.provider,
    requestedCapabilities: body.requested_capabilities ?? null,
    verificationRequirements: body.verification_requirements ?? null,
    verificationIntent: body.verification_intent ?? null,
    policyId: body.policy_id ?? null,
    publicOrigin,
  })
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
  logVerificationDebug(c.env, "[verification-sessions] start response", {
    userId: actor.userId,
    verificationSessionId: created.id.replace(/^vs_/, ""),
    provider: created.provider,
    requestedCapabilities: created.requested_capabilities,
    verificationRequirements: created.verification_requirements,
    status: created.status,
    launchMode: created.launch?.mode ?? null,
    selfDisclosures: created.launch?.self_app?.disclosures ?? null,
    selfEndpointType: created.launch?.self_app?.endpoint_type ?? null,
    selfScope: created.launch?.self_app?.scope ?? null,
    veryContext: created.launch?.very_widget?.context ?? null,
    veryTypeId: created.launch?.very_widget?.type_id ?? null,
    veryQuery: created.launch?.very_widget?.query ?? null,
    veryVerifyUrl: created.launch?.very_widget?.verify_url ?? null,
  })
  await trackApiEvent(c.env, c.req, {
    eventName: "unique_human_verification_started",
    userId: actor.userId,
    verificationSessionId: created.id.replace(/^vs_/, ""),
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
  const result = await repo.getVerificationSession(decodePublicVerificationSessionId(c.req.param("verificationSessionId")), actor.userId)
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
    verificationSessionId: decodePublicVerificationSessionId(c.req.param("verificationSessionId")),
    userId: actor.userId,
    attestationId: body?.attestation_id ?? null,
    proof: body?.proof ?? null,
    proofHash: body?.proof_hash ?? null,
    providerPayloadRef: body?.provider_payload_ref ?? null,
  })
  if (!result) {
    throw notFoundError("Verification session not found")
  }
  if (result.status === "verified" || result.status === "failed" || result.status === "expired") {
    await trackApiEvent(c.env, c.req, {
      eventName: result.status === "verified" ? "unique_human_verification_succeeded" : "unique_human_verification_failed",
      userId: actor.userId,
      verificationSessionId: result.id.replace(/^vs_/, ""),
      properties: {
        provider: result.provider,
        intent: result.verification_intent ?? null,
        failure_code: result.status === "verified" ? null : result.failure_reason ?? result.status,
      },
    })
  }
  return c.json(result, 200)
})

authenticatedNamespaceVerification.post("/namespace-verification-sessions", async (c) => {
  const actor = c.get("actor")
  const body = await c.req.json<{ family?: "hns" | "spaces"; root_label?: string }>().catch(() => null)
  if (!body?.family || (body.family !== "hns" && body.family !== "spaces") || !body.root_label?.trim()) {
    throw badRequestError("Invalid namespace verification session payload")
  }

  const repo = getControlPlaneVerificationRepository(c.env)
  try {
    const created = await repo.startNamespaceVerificationSession({
      userId: actor.userId,
      family: body.family,
      rootLabel: body.root_label,
    })
    await trackApiEvent(c.env, c.req, {
      eventName: "namespace_verification_started",
      userId: actor.userId,
      verificationSessionId: created.id.replace(/^nvs_/, ""),
      properties: { tld: body.family },
    })
    return c.json(created, 201)
  } catch (error) {
    await trackApiEvent(c.env, c.req, {
      eventName: "namespace_verification_failed",
      userId: actor.userId,
      properties: namespaceVerificationErrorProperties({
        endpoint: "start",
        error,
        tld: body.family,
      }),
    })
    throw error
  }
})

authenticatedNamespaceVerification.get("/namespace-verification-sessions/:namespaceVerificationSessionId", async (c) => {
  const actor = c.get("actor")
  const repo = getControlPlaneVerificationRepository(c.env)
  const result = await repo.getNamespaceVerificationSession(decodePublicNamespaceVerificationSessionId(c.req.param("namespaceVerificationSessionId")), actor.userId)
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

authenticatedNamespaceVerification.post("/namespace-verification-sessions/:namespaceVerificationSessionId/complete", async (c) => {
  const actor = c.get("actor")
  const body = (await c.req.json<{
    restart_challenge?: boolean | null
  }>().catch(() => null)) ?? null
  const repo = getControlPlaneVerificationRepository(c.env)
  const namespaceVerificationSessionId = decodePublicNamespaceVerificationSessionId(c.req.param("namespaceVerificationSessionId"))
  try {
    const result = await repo.completeNamespaceVerificationSession({
      namespaceVerificationSessionId,
      userId: actor.userId,
      restartChallenge: body?.restart_challenge ?? null,
    })
    if (!result) {
      throw notFoundError("Namespace verification session not found")
    }
    return c.json(result, 200)
  } catch (error) {
    await trackApiEvent(c.env, c.req, {
      eventName: "namespace_verification_failed",
      userId: actor.userId,
      verificationSessionId: namespaceVerificationSessionId,
      properties: namespaceVerificationErrorProperties({
        endpoint: "complete",
        error,
      }),
    })
    throw error
  }
})

authenticatedNamespaceVerification.get("/namespace-verifications/:namespaceVerificationId", async (c) => {
  const actor = c.get("actor")
  const repo = getControlPlaneVerificationRepository(c.env)
  const result = await repo.getNamespaceVerification(decodePublicNamespaceVerificationId(c.req.param("namespaceVerificationId")), actor.userId)
  if (!result) {
    throw notFoundError("Namespace verification not found")
  }
  return c.json(result, 200)
})

verification.route("/", authenticatedVerification)
verification.route("/", authenticatedNamespaceVerification)

export default verification
