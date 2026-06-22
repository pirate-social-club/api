import { Hono } from "hono"
import type { Env } from "../env"
import { isAllowedKaraokeWebSocketOrigin } from "../lib/http/allowed-origins"
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
