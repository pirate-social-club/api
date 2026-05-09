import { Hono } from "hono"
import { authenticate } from "../lib/auth-middleware"
import {
  authorizeDeviceCode,
  createDeviceAuthorization,
  pollDeviceToken,
  refreshDeviceToken,
} from "../lib/oauth/device-authorization-service"
import { badRequestError } from "../lib/errors"
import type { Env } from "../env"

const oauth = new Hono<{ Bindings: Env; Variables: { actor: { userId: string } } }>()

oauth.post("/device_authorize", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  return c.json(await createDeviceAuthorization(c.env, body), 200, {
    "cache-control": "no-store",
  })
})

oauth.post("/device/verify", authenticate, async (c) => {
  const body = await c.req.json<{ user_code?: unknown }>().catch(() => null)
  if (!body) {
    throw badRequestError("Invalid device verification payload")
  }
  return c.json(await authorizeDeviceCode(c.env, {
    userCode: body.user_code,
    userId: c.get("actor").userId,
  }), 200)
})

oauth.get("/device/verify", authenticate, async (c) => {
  return c.json(await authorizeDeviceCode(c.env, {
    userCode: c.req.query("user_code"),
    userId: c.get("actor").userId,
  }), 200)
})

oauth.post("/device/token", async (c) => {
  const body = await c.req.json<{ grant_type?: unknown }>().catch(() => null)
  if (!body || typeof body !== "object") {
    throw badRequestError("Invalid device token payload")
  }
  const grantType = typeof body.grant_type === "string" ? body.grant_type.trim() : "urn:ietf:params:oauth:grant-type:device_code"
  const result = grantType === "refresh_token"
    ? await refreshDeviceToken(c.env, body)
    : grantType === "urn:ietf:params:oauth:grant-type:device_code"
      ? await pollDeviceToken(c.env, body)
      : (() => {
          throw badRequestError("Unsupported grant_type")
        })()

  if ("error" in result) {
    return c.json(result, 400, {
      "cache-control": "no-store",
    })
  }

  return c.json(result, 200, {
    "cache-control": "no-store",
  })
})

export default oauth
