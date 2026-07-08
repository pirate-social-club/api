import { Hono } from "hono"
import type { Context } from "hono"
import type { Env } from "../env"
import { isAllowedKaraokeWebSocketOrigin } from "../lib/http/allowed-origins"
import {
  finalizeKaraokeAttempt,
  parseFinalizeKaraokeAttemptPayload,
} from "../lib/karaoke/karaoke-attempt-finalize-service"
import { verifyKaraokeGatewayToken } from "../lib/karaoke/gateway-token"

const karaokeSessions = new Hono<{ Bindings: Env }>()

function responseHeaders(requestId: string): HeadersInit {
  return {
    "cache-control": "no-store",
    "x-request-id": requestId,
  }
}

function errorResponse(requestId: string, status: number, code: string, message: string): Response {
  return Response.json({ code, message }, {
    headers: responseHeaders(requestId),
    status,
  })
}

function requireFinalizeSecret(c: Context<{ Bindings: Env }>): Response | null {
  const expected = c.env.KARAOKE_GATEWAY_SIGNING_KEY?.trim()
  const provided = c.req.header("x-karaoke-finalize-secret")?.trim()
  if (!expected || expected.length < 32 || !provided || provided !== expected) {
    return errorResponse(
      c.req.header("x-request-id")?.trim() || crypto.randomUUID(),
      401,
      "karaoke_finalize_unauthorized",
      "Karaoke finalization is unauthorized",
    )
  }
  return null
}

karaokeSessions.post("/:sessionId/finalize", async (c) => {
  const requestId = c.req.header("x-request-id")?.trim() || crypto.randomUUID()
  const unauthorized = requireFinalizeSecret(c)
  if (unauthorized) return unauthorized
  const payload = parseFinalizeKaraokeAttemptPayload(await c.req.json().catch(() => null))
  if (payload.sessionId !== c.req.param("sessionId")) {
    return errorResponse(requestId, 400, "karaoke_finalize_session_mismatch", "Karaoke finalization session does not match")
  }
  const result = await finalizeKaraokeAttempt({
    env: c.env,
    payload,
  })
  return Response.json(result, {
    headers: responseHeaders(requestId),
    status: 200,
  })
})

karaokeSessions.get("/:sessionId/websocket", async (c) => {
  const requestId = c.req.header("x-request-id")?.trim() || crypto.randomUUID()
  const sessionId = c.req.param("sessionId")
  const namespace = c.env.KARAOKE_SESSION_RUNTIME
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
    return errorResponse(requestId, 426, "websocket_upgrade_required", "WebSocket upgrade is required")
  }
  const origin = c.req.header("origin")
  if (!origin || !isAllowedKaraokeWebSocketOrigin(origin, c.env)) {
    return errorResponse(requestId, 403, "karaoke_origin_not_allowed", "WebSocket origin is not allowed")
  }
  const token = c.req.query("token")?.trim()
  const signingKey = c.env.KARAOKE_GATEWAY_SIGNING_KEY?.trim()
  if (!token || !signingKey || signingKey.length < 32) {
    return errorResponse(requestId, 401, "karaoke_gateway_invalid_token", "Karaoke gateway token is invalid")
  }
  const verified = await verifyKaraokeGatewayToken({
    nowSeconds: Math.floor(Date.now() / 1000),
    secret: signingKey,
    token,
  })
  if (verified.error) {
    return errorResponse(requestId, 401, `karaoke_gateway_${verified.error}`, "Karaoke gateway token is invalid")
  }
  if (verified.claims.sessionId !== sessionId) {
    return errorResponse(requestId, 403, "karaoke_gateway_session_mismatch", "Karaoke gateway session does not match")
  }
  if (!namespace) {
    return errorResponse(requestId, 503, "karaoke_runtime_unavailable", "Karaoke runtime is unavailable")
  }
  const stub = namespace.get(namespace.idFromName(sessionId))
  return await stub.fetch("https://karaoke-runtime.internal/websocket", {
    headers: {
      "upgrade": "websocket",
      "x-karaoke-attempt-id": verified.claims.attemptId,
      "x-karaoke-nonce": verified.claims.nonce,
      "x-karaoke-request-id": requestId,
      "x-karaoke-session-id": verified.claims.sessionId,
      "x-karaoke-subject": verified.claims.subject,
    },
  })
})

export default karaokeSessions
