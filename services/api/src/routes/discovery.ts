import { Hono } from "hono"
import { getPirateAccessTokenJwks } from "../lib/auth/pirate-session-token"
import type { Env } from "../types"

const discovery = new Hono<{ Bindings: Env }>()

function requestOrigin(url: string): string {
  const parsed = new URL(url)
  return parsed.origin
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body, null, 2), {
    ...init,
    headers: {
      "cache-control": "public, max-age=300, s-maxage=600",
      "content-type": "application/json; charset=utf-8",
      ...(init?.headers ?? {}),
    },
  })
}

discovery.get("/.well-known/jwks.json", async (c) => {
  return jsonResponse(await getPirateAccessTokenJwks({ env: c.env }))
})

discovery.get("/.well-known/oauth-protected-resource", async (c) => {
  const origin = requestOrigin(c.req.url)

  return jsonResponse({
    resource: origin,
    jwks_uri: `${origin}/.well-known/jwks.json`,
    bearer_methods_supported: ["header"],
    scopes_supported: ["pirate_app_session"],
  })
})

export default discovery
