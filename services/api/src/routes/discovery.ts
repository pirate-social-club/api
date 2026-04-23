import { Hono } from "hono"
import { getPirateAccessTokenJwks } from "../lib/auth/pirate-session-token"
import type { Env } from "../types"

const discovery = new Hono<{ Bindings: Env }>()
const SCOPES_SUPPORTED = ["pirate_app_session"] as const

function requestOrigin(url: string): string {
  const parsed = new URL(url)
  return parsed.origin
}

function configuredPublicOrigin(env: Env, requestUrl: string): string {
  const configured = env.PIRATE_API_PUBLIC_ORIGIN?.trim()
  if (configured) {
    return new URL(configured).origin
  }
  return requestOrigin(requestUrl)
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
  const origin = configuredPublicOrigin(c.env, c.req.url)

  return jsonResponse({
    resource: origin,
    authorization_servers: [origin],
    jwks_uri: `${origin}/.well-known/jwks.json`,
    bearer_methods_supported: ["header"],
    scopes_supported: SCOPES_SUPPORTED,
  })
})

discovery.get("/.well-known/oauth-authorization-server", async (c) => {
  const origin = configuredPublicOrigin(c.env, c.req.url)

  return jsonResponse({
    issuer: origin,
    authorization_endpoint: `${origin}/auth/session/exchange`,
    token_endpoint: `${origin}/auth/session/exchange`,
    jwks_uri: `${origin}/.well-known/jwks.json`,
    grant_types_supported: ["urn:pirate:params:oauth:grant-type:session-exchange"],
    response_types_supported: [],
    scopes_supported: SCOPES_SUPPORTED,
    token_endpoint_auth_methods_supported: ["none"],
    bearer_methods_supported: ["header"],
    protected_resources: [origin],
  })
})

export default discovery
