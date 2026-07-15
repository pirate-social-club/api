import type { Context, MiddlewareHandler } from "hono"
import type { Env } from "../env"
import type { ActorContext, AdminActorContext } from "./auth-middleware"
import { isAnalyticsEnabled, trackServerEvent } from "./analytics"
import { withStandaloneControlPlaneClient } from "./runtime-deps"

export const REQUEST_ID_HEADER = "x-request-id"

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"])
const MAX_ERROR_BODY_BYTES = 16 * 1024

type RequestCorrelationVariables = {
  requestId: string
  actor?: ActorContext | AdminActorContext
}

export type RequestCorrelationEnv = {
  Bindings: Env
  Variables: RequestCorrelationVariables
}

type RequestCorrelationContext = Context<RequestCorrelationEnv>

export function resolveRequestId(request: Request): string {
  return request.headers.get("cf-ray")?.trim() || crypto.randomUUID()
}

export function requestIdForContext(c: Context): string {
  return c.get("requestId") || resolveRequestId(c.req.raw)
}

function executionWaitUntil(c: RequestCorrelationContext): ((promise: Promise<unknown>) => void) | null {
  try {
    const executionCtx = c.executionCtx
    return (promise) => executionCtx.waitUntil(promise)
  } catch {
    return null
  }
}

export function isAuthenticatedWriteFailure(input: {
  actor: ActorContext | AdminActorContext | undefined
  method: string
  status: number
}): boolean {
  return Boolean(
    input.actor
    && WRITE_METHODS.has(input.method.toUpperCase())
    && input.status >= 400
    && input.status < 500,
  )
}

async function readBoundedBody(response: Response): Promise<string | null> {
  const body = response.clone().body
  if (!body) {
    return null
  }

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) {
        break
      }
      totalBytes += result.value.byteLength
      if (totalBytes > MAX_ERROR_BODY_BYTES) {
        await reader.cancel()
        return null
      }
      chunks.push(result.value)
    }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

export async function errorCodeForResponse(response: Response): Promise<string> {
  const fallback = `http_${response.status}`
  if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    return fallback
  }

  try {
    const text = await readBoundedBody(response)
    if (!text) {
      return fallback
    }
    const body = JSON.parse(text) as Record<string, unknown>
    const code = typeof body.code === "string"
      ? body.code
      : typeof body.error_code === "string"
        ? body.error_code
        : null
    return code?.trim() || fallback
  } catch {
    return fallback
  }
}

async function trackAuthenticatedWriteFailure(
  c: RequestCorrelationContext,
  actor: ActorContext | AdminActorContext,
  requestId: string,
  response: Response,
): Promise<void> {
  const errorCode = await errorCodeForResponse(response)
  await withStandaloneControlPlaneClient(c.env, async (db) => {
    await trackServerEvent(c.env, db, {
      eventName: "api_write_failed",
      source: "api",
      appSurface: "api",
      userId: actor.userId,
      requestId,
      sessionId: c.req.header("x-pirate-session-id"),
      anonymousId: c.req.header("x-pirate-anonymous-id"),
      properties: {
        error_code: errorCode,
        method: c.req.method.toUpperCase(),
        route: c.req.routePath || c.req.path,
        status: response.status,
      },
    })
  })
}

export const requestCorrelationMiddleware: MiddlewareHandler<RequestCorrelationEnv> = async (c, next) => {
  const requestId = c.get("requestId") || resolveRequestId(c.req.raw)
  c.set("requestId", requestId)
  c.header(REQUEST_ID_HEADER, requestId)

  await next()

  // Raw Response objects do not consume Hono's prepared headers. Add the header
  // after routing as well; WebSocket responses already carry the same ID from
  // the karaoke runtime, so their 101 response is never reconstructed here.
  if (c.res.headers.get(REQUEST_ID_HEADER) !== requestId) {
    c.header(REQUEST_ID_HEADER, requestId)
  }

  const actor = c.get("actor")
  if (!isAuthenticatedWriteFailure({
    actor,
    method: c.req.method,
    status: c.res.status,
  }) || !isAnalyticsEnabled(c.env)) {
    return
  }

  const waitUntil = executionWaitUntil(c)
  if (!waitUntil) {
    return
  }

  const response = c.res
  waitUntil(
    trackAuthenticatedWriteFailure(c, actor!, requestId, response).catch((error) => {
      console.error("[analytics] authenticated write failure tracking failed", {
        request_id: requestId,
        error,
      })
    }),
  )
}
