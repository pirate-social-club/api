import { Hono } from "hono"

import {
  authenticate,
  type AuthenticatedEnv,
} from "../lib/auth-middleware"
import {
  parseDanceAttemptTerminalFacts,
} from "../lib/dance/attempt-contract"
import { finalizeDanceAttempt } from "../lib/dance/attempt-finalize-service"
import {
  getDanceAttemptForUser,
  serializeDanceAttempt,
} from "../lib/dance/dance-read-service"
import { verifyDanceGraderCallback } from "../lib/dance/grader-callback-auth"
import { badRequestError, notFoundError } from "../lib/errors"
import { getControlPlaneClient } from "../lib/runtime-deps"

const MAX_CALLBACK_BODY_BYTES = 64 * 1024

type RouteServices = {
  finalizeDanceAttempt: typeof finalizeDanceAttempt
  now: () => number
}

let routeServicesForTests: RouteServices | null = null
export function setDanceAttemptRouteServicesForTests(
  value: RouteServices | null,
): void {
  routeServicesForTests = value
}

function services(): RouteServices {
  return routeServicesForTests ?? {
    finalizeDanceAttempt,
    now: () => Date.now(),
  }
}

function parseBody(bytes: Uint8Array): Record<string, unknown> {
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes))
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error()
    return value as Record<string, unknown>
  } catch {
    throw badRequestError("Callback body is invalid")
  }
}

const danceAttempts = new Hono<AuthenticatedEnv>()

danceAttempts.get("/:attemptId", authenticate, async (c) => {
  const record = await getDanceAttemptForUser({
    env: c.env,
    attemptId: c.req.param("attemptId"),
    subjectUserId: c.get("actor").userId,
    controlClient: getControlPlaneClient(c.env),
  })
  if (!record) throw notFoundError("Dance attempt not found")
  c.header("Cache-Control", "private, no-store")
  return c.json(serializeDanceAttempt(record))
})

danceAttempts.post("/:sessionId/callback", async (c) => {
  const routeServices = services()
  const contentLength = Number(c.req.header("content-length"))
  if (Number.isFinite(contentLength) && contentLength > MAX_CALLBACK_BODY_BYTES) {
    throw badRequestError("Request body is too large")
  }
  const bodyBytes = new Uint8Array(await c.req.raw.arrayBuffer())
  if (bodyBytes.byteLength > MAX_CALLBACK_BODY_BYTES) {
    throw badRequestError("Request body is too large")
  }
  const body = parseBody(bodyBytes)
  const sessionId = c.req.param("sessionId")
  if (body.subject !== sessionId) {
    throw badRequestError("subject does not match session")
  }
  verifyDanceGraderCallback({
    env: c.env,
    method: c.req.method,
    path: new URL(c.req.url).pathname,
    timestampHeader: c.req.header("x-dance-grader-timestamp"),
    keyVersionHeader: c.req.header("x-dance-grader-key-version"),
    signatureHeader: c.req.header("x-dance-grader-signature"),
    subject: sessionId,
    body: bodyBytes,
    nowSeconds: Math.floor(routeServices.now() / 1000),
  })
  const facts = parseDanceAttemptTerminalFacts(body)
  const result = await routeServices.finalizeDanceAttempt({
    env: c.env,
    sessionId,
    facts,
    now: new Date(routeServices.now()).toISOString(),
  })
  return c.json({
    id: sessionId,
    object: "dance_attempt",
    status: result.status,
    idempotent: result.kind === "idempotent",
  })
})

export default danceAttempts
