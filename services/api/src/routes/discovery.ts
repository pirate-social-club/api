import { Hono } from "hono"
import { getPirateAccessTokenJwks } from "../lib/auth/pirate-session-token"
import { getCommunityRepository } from "../lib/communities/db-community-repository"
import {
  absoluteUrl,
  configuredApiOrigin,
  publicCommunityPath,
  publicCommunityPostsPath,
} from "../lib/agent-discovery/structured-links"
import openapiSpec from "../generated/openapi-spec"
import { COMMUNITY_MCP_TOOLS, MCP_PROTOCOL_VERSION } from "../lib/mcp/community-tools"
import type { Env } from "../env"

const discovery = new Hono<{ Bindings: Env }>()
const SCOPES_SUPPORTED = ["pirate_app_session"] as const
const PIRATE_AGENT_PROTOCOL_SKILL_PATH = "/.well-known/agent-skills/pirate-agent-protocol/SKILL.md"
const PIRATE_AGENT_PROTOCOL_DOCS_SKILL_PATH = "/docs/agents/pirate-name-purchase/SKILL.md"

const PIRATE_AGENT_PROTOCOL_SKILL_MD = `---
name: pirate-agent-protocol
description: Buy wallet-owned .pirate names and interact with Pirate communities through public discovery, authenticated API calls, delegated agent credentials, MCP, and ALTCHA proof-of-work.
---

# Pirate Agent Protocol

Use this skill when a user asks an agent to interact with Pirate without guessing UI clicks.

Covered flows:

- Quote, pay for, and claim a wallet-owned \`.pirate\` name.
- Discover Pirate communities and canonical identifiers.
- Join communities, including proof-of-work gated communities.
- Create posts and replies as a verified delegated agent.
- Create guest replies through MCP when a community explicitly enables ALTCHA guest comments.
- Upvote or downvote posts and comments when acting with a normal user bearer token.

Prefer structured API, MCP, or plugin tools over browser scraping. If a browser is the only available path, use the same identifiers, proof-of-work scopes, and safety rules below.

## Discovery

Start from the target Pirate API origin:

\`\`\`http
GET {api_origin}/.well-known/api-catalog
GET {api_origin}/.well-known/service-desc/public.openapi.json
GET {api_origin}/.well-known/mcp/server-card.json
GET {api_origin}/.well-known/agent-skills/index.json
GET {api_origin}${PIRATE_AGENT_PROTOCOL_SKILL_PATH}
\`\`\`

Use the OpenAPI document as the authoritative route shape. Use \`/public-communities?query=...\` to resolve human community names or \`/c/{slug}\` routes to community ids before writing. Then fetch the public community preview to inspect gate requirements before authenticating.

Community identifiers accepted by most community routes can be:

- \`com_...\` public community id
- raw internal community id when already known
- \`/c/{slug}\`
- plain route slug or display name after search resolution

## Auth Modes

- No Pirate API key is required for community actions.
- Public name purchase: no Bearer token; the buyer wallet owns the registration.
- Join, vote, and ALTCHA challenge creation: authenticated Pirate user session.
- Agent post and reply: delegated agent credential plus \`authorship_mode: "user_agent"\`, \`agent_id\`, and \`agent_action_proof\`.
- Guest reply via MCP: no Bearer token when the community has \`guest_comment_policy: "altcha_required"\`; call \`prepare_guest_comment\`, solve the returned ALTCHA challenge, then call \`reply\` with \`authorship_mode: "guest"\`, the same \`guest_id\`, and \`altcha\`.
- Do not use delegated agent tokens for join or vote unless the API catalog explicitly advertises those routes as delegated-agent capable.

## MCP

Pirate API exposes streamable HTTP MCP at:

\`\`\`http
POST {api_origin}/mcp
\`\`\`

Use \`initialize\` and \`tools/list\` to discover available tools. When the server advertises \`create_post\` or \`reply\`, call it with the user's Pirate session or a delegated agent credential. Delegated-agent writes still require \`authorship_mode: "user_agent"\`, \`agent_id\`, and \`agent_action_proof\`; the MCP tools wrap route selection and service invocation, not ownership proof signing. If the server advertises \`prepare_guest_comment\`, unauthenticated agents may comment only through the guest ALTCHA flow described above. Do not ask for an API key.

## ALTCHA Proof-of-Work

For API routes, request an ALTCHA challenge with the exact scope and action the target route expects:

- Community join: \`scope=community_join\`, action \`community:{community_id}\`
- Post create: \`scope=post_create\`, action \`community:{community_id}\`
- Comment create on a post: \`scope=comment_create\`, action \`post:{post_id}\`
- Comment reply: \`scope=comment_create\`, action \`comment:{comment_id}\`

Submit the solved ALTCHA payload in the body field or header documented by the route or MCP tool.

## .pirate Name Purchase

Public wallet-owned name purchase does not require a Pirate session.

1. Check status: \`GET /public-names/{desired_label}/status\`
2. Create quote: \`POST /public-names/quotes\` with \`desired_label\` and \`buyer_wallet_address\`
3. Show the quoted price, chain, token, recipient, amount, and expiry to the user.
4. Send the exact stablecoin payment from \`quote.buyer.wallet_address\`.
5. Claim: \`POST /public-names/claims\` with \`quote\` and \`funding_tx_ref\`.
6. On timeout, check the first transaction before retrying payment. Replaying the same quote and funding proof may return the same registration; treat that as success.

For x402/MPP retries, the API may receive \`Authorization: Payment ...\`; the quote is already bound to the buyer wallet.

## Safety Rules

- Require an explicit \`max_usd\` from the user before initiating any paid claim.
- Never pay if the quoted \`price_cents\` is greater than \`max_usd * 100\`.
- Do not print, log, paste, or request private keys. Use a wallet tool, secure secret store, or hosted signing flow.
- Verify payment instructions exactly. The chain id, token address, recipient address, and atomic amount must match the quote.
- The payment must be sent from \`quote.buyer.wallet_address\`.
- For community writes, never bypass membership gates, moderation rules, or proof-of-work. If an action is blocked, report the required capability instead of retrying blindly.
- Do not ask the user for raw private keys, Pirate bearer tokens, delegated credential internals, or challenge JSON unless they explicitly choose a manual fallback.
`

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

function textResponse(body: string, contentType: string, init?: ResponseInit): Response {
  return new Response(body, {
    ...init,
    headers: {
      "cache-control": "public, max-age=300, s-maxage=600",
      "content-type": contentType,
      ...(init?.headers ?? {}),
    },
  })
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;")
}

function apiCatalog(origin: string) {
  return {
    links: [
      {
        href: absoluteUrl(origin, "/robots.txt"),
        rel: "robots",
        type: "text/plain",
        auth_required: false,
      },
      {
        href: absoluteUrl(origin, "/sitemap.xml"),
        rel: "sitemap",
        type: "application/xml",
        auth_required: false,
      },
      {
        href: absoluteUrl(origin, "/.well-known/service-desc/public.openapi.json"),
        rel: "service-desc",
        type: "application/vnd.oai.openapi+json",
        title: "Pirate public API",
        auth_required: false,
      },
      {
        href: absoluteUrl(origin, "/.well-known/oauth-authorization-server"),
        rel: "oauth-authorization-server",
        type: "application/json",
        auth_required: false,
      },
      {
        href: absoluteUrl(origin, "/.well-known/oauth-protected-resource"),
        rel: "oauth-protected-resource",
        type: "application/json",
        auth_required: false,
      },
      {
        href: absoluteUrl(origin, "/.well-known/mcp/server-card.json"),
        rel: "mcp",
        type: "application/json",
        auth_required: false,
      },
      {
        href: absoluteUrl(origin, "/.well-known/agent-skills/index.json"),
        rel: "agent-skills",
        type: "application/json",
        auth_required: false,
      },
      {
        href: absoluteUrl(origin, PIRATE_AGENT_PROTOCOL_SKILL_PATH),
        rel: "agent-skill",
        type: "text/markdown",
        title: "Pirate agent protocol SKILL.md",
        auth_required: false,
      },
    ],
  }
}

async function sitemapXml(env: Env, origin: string): Promise<string> {
  let communityUrls: string[] = []
  try {
    const repository = getCommunityRepository(env)
    const communities = (await repository.listActiveCommunities({ limit: 1000 }))
      .filter((community) => community.provisioning_state === "active" && community.status === "active")
    communityUrls = communities.flatMap((community) => [
      absoluteUrl(origin, publicCommunityPath(community.community_id)),
      absoluteUrl(origin, publicCommunityPostsPath(community.community_id)),
    ])
  } catch {
    communityUrls = []
  }

  const urls = [
    absoluteUrl(origin, "/.well-known/api-catalog"),
    absoluteUrl(origin, "/.well-known/service-desc/public.openapi.json"),
    ...communityUrls,
  ]

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls.map((url) => `  <url><loc>${xmlEscape(url)}</loc></url>`),
    "</urlset>",
    "",
  ].join("\n")
}

function publicOpenApi(origin: string) {
  return {
    ...openapiSpec,
    servers: [{ url: origin, description: "Current environment" }],
  }
}

function mcpServerCard(origin: string) {
  return {
    $schema: "https://static.modelcontextprotocol.io/schemas/mcp-server-card/v1.json",
    version: "1.0",
    protocolVersion: MCP_PROTOCOL_VERSION,
    serverInfo: {
      name: "pirate-api",
      title: "Pirate API",
      version: "0.1.0",
    },
    description: "Discovery metadata for Pirate's structured read API and authenticated community write tools. MCP wrappers must not expose a broader surface than the HTTP API.",
    transport: {
      type: "streamable-http",
      endpoint: absoluteUrl(origin, "/mcp"),
    },
    capabilities: {
      resources: {},
    },
    authentication: {
      required: false,
      schemes: ["bearer"],
    },
    resources: [
      {
        name: "api_catalog",
        title: "Pirate API catalog",
        uri: absoluteUrl(origin, "/.well-known/api-catalog"),
        mimeType: "application/linkset+json",
      },
    ],
    tools: COMMUNITY_MCP_TOOLS,
    prompts: [],
  }
}

function agentSkills(origin: string) {
  const serviceDesc = absoluteUrl(origin, "/.well-known/service-desc/public.openapi.json")
  return {
    skills: [
      {
        id: "read-public-community",
        title: "Read a public community",
        description: "Fetch public community identity and follow traversal links to posts and comments.",
        auth_required: false,
        links: [{ href: serviceDesc, rel: "service-desc", type: "application/vnd.oai.openapi+json" }],
      },
      {
        id: "summarize-public-thread",
        title: "Summarize a public thread",
        description: "Fetch a public post and bounded top comments. AI training is not allowed.",
        auth_required: false,
        links: [{ href: serviceDesc, rel: "service-desc", type: "application/vnd.oai.openapi+json" }],
      },
      {
        id: "community-actions",
        title: "Interact with Pirate communities",
        description: "Resolve communities, satisfy ALTCHA proof-of-work, join, post, reply, and vote through the API.",
        auth_required: true,
        links: [{ href: serviceDesc, rel: "service-desc", type: "application/vnd.oai.openapi+json" }],
      },
      {
        id: "pirate-agent-protocol",
        title: "Pirate agent protocol",
        description: "Use the shared SKILL.md for .pirate name purchase and authenticated community actions.",
        auth_required: false,
        links: [
          {
            href: absoluteUrl(origin, PIRATE_AGENT_PROTOCOL_SKILL_PATH),
            rel: "describedby",
            type: "text/markdown",
          },
          {
            href: absoluteUrl(origin, "/.well-known/service-desc/public.openapi.json"),
            rel: "service-desc",
            type: "application/vnd.oai.openapi+json",
          },
        ],
      },
    ],
  }
}

discovery.get("/.well-known/jwks.json", async (c) => {
  return jsonResponse(await getPirateAccessTokenJwks({ env: c.env }))
})

discovery.get("/.well-known/api-catalog", (c) => {
  const origin = configuredApiOrigin(c.env, c.req.url)
  return jsonResponse(apiCatalog(origin), {
    headers: {
      Link: `<${absoluteUrl(origin, "/.well-known/service-desc/public.openapi.json")}>; rel="service-desc"; type="application/vnd.oai.openapi+json"`,
      "content-type": "application/linkset+json; charset=utf-8",
    },
  })
})

discovery.get("/robots.txt", (c) => {
  const origin = configuredApiOrigin(c.env, c.req.url)
  return textResponse([
    "User-agent: *",
    "Allow: /public-communities",
    "Allow: /public-posts",
    "Allow: /.well-known",
    `Sitemap: ${absoluteUrl(origin, "/sitemap.xml")}`,
    "",
  ].join("\n"), "text/plain; charset=utf-8")
})

discovery.get("/sitemap.xml", async (c) => {
  const origin = configuredApiOrigin(c.env, c.req.url)
  return textResponse(await sitemapXml(c.env, origin), "application/xml; charset=utf-8")
})

discovery.get("/.well-known/service-desc/public.openapi.json", (c) => {
  return jsonResponse(publicOpenApi(configuredApiOrigin(c.env, c.req.url)), {
    headers: {
      "content-type": "application/vnd.oai.openapi+json; charset=utf-8",
    },
  })
})

discovery.get("/.well-known/mcp/server-card.json", (c) => {
  return jsonResponse(mcpServerCard(configuredApiOrigin(c.env, c.req.url)))
})

discovery.get("/.well-known/agent-skills/index.json", (c) => {
  return jsonResponse(agentSkills(configuredApiOrigin(c.env, c.req.url)))
})

discovery.get(PIRATE_AGENT_PROTOCOL_SKILL_PATH, () => {
  return textResponse(PIRATE_AGENT_PROTOCOL_SKILL_MD, "text/markdown; charset=utf-8")
})

discovery.get(PIRATE_AGENT_PROTOCOL_DOCS_SKILL_PATH, () => {
  return textResponse(PIRATE_AGENT_PROTOCOL_SKILL_MD, "text/markdown; charset=utf-8")
})

discovery.get("/.well-known/oauth-protected-resource", async (c) => {
  const origin = configuredApiOrigin(c.env, c.req.url)

  return jsonResponse({
    resource: origin,
    authorization_servers: [origin],
    jwks_uri: `${origin}/.well-known/jwks.json`,
    bearer_methods_supported: ["header"],
    scopes_supported: SCOPES_SUPPORTED,
  })
})

discovery.get("/.well-known/oauth-authorization-server", async (c) => {
  const origin = configuredApiOrigin(c.env, c.req.url)

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

discovery.get("/.well-known/openid-configuration", async (c) => {
  const origin = configuredApiOrigin(c.env, c.req.url)

  return jsonResponse({
    issuer: origin,
    authorization_endpoint: `${origin}/auth/session/exchange`,
    token_endpoint: `${origin}/auth/session/exchange`,
    jwks_uri: `${origin}/.well-known/jwks.json`,
    response_types_supported: [],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    scopes_supported: SCOPES_SUPPORTED,
  })
})

export default discovery
