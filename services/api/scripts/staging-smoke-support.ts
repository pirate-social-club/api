import { SignJWT } from "jose"
import { allocationAttributionHeaders } from "./_lib/allocation-attribution"

export type Json = Record<string, unknown>

export function fail(prefix: string, message: string): never {
  console.error(`[${prefix}] FAIL: ${message}`)
  process.exit(1)
}

export function asObject(value: unknown, label: string, prefix: string): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(prefix, `${label} was not an object`)
  }
  return value as Json
}

export function asString(value: unknown, label: string, prefix: string): string {
  if (typeof value !== "string" || !value) {
    fail(prefix, `${label} was not a non-empty string`)
  }
  return value
}

export async function requestJson(input: {
  method?: string
  url: string
  token?: string
  body?: Json
  headers?: Record<string, string>
  okStatuses?: number[]
  prefix: string
}): Promise<Json> {
  const res = await fetch(input.url, {
    method: input.method ?? "POST",
    headers: {
      ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
      "content-type": "application/json",
      ...input.headers,
    },
    body: input.body ? JSON.stringify(input.body) : undefined,
  })
  const text = await res.text()
  let parsed: Json
  try {
    parsed = text ? JSON.parse(text) as Json : {}
  } catch {
    parsed = { raw: text }
  }
  const ok = input.okStatuses ?? [200, 201]
  if (!ok.includes(res.status)) {
    fail(input.prefix, `${input.method ?? "POST"} ${new URL(input.url).pathname} -> ${res.status}: ${JSON.stringify(parsed).slice(0, 1000)}`)
  }
  return parsed
}

export async function mintSmokeAccessToken(input: {
  apiBase: string
  subject: string
  prefix: string
}): Promise<string> {
  const secret = process.env.AUTH_UPSTREAM_JWT_SHARED_SECRET
  if (!secret) {
    fail(input.prefix, "AUTH_UPSTREAM_JWT_SHARED_SECRET is not configured")
  }
  const isStaging = new URL(input.apiBase).hostname.includes("staging")
  const issuer = process.env.AUTH_UPSTREAM_JWT_ISSUER || (isStaging ? "pirate-staging-upstream" : "pirate-production-upstream")
  const audience = process.env.AUTH_UPSTREAM_JWT_AUDIENCE || (isStaging ? "pirate-api-staging" : "api-core")
  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(input.subject)
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(new TextEncoder().encode(secret))
  const exchanged = await requestJson({
    url: `${input.apiBase}/auth/session/exchange`,
    body: { proof: { type: "jwt_based_auth", jwt } },
    prefix: input.prefix,
  })
  return asString(exchanged.access_token, "session_exchange.access_token", input.prefix)
}

export async function createSmokeCommunity(input: {
  apiBase: string
  token: string
  displayName: string
  description: string
  prefix: string
}): Promise<{
  created: Json
  community: Json
  publicCommunityId: string
  communityId: string
  job: Json
  jobId: string
}> {
  const created = await requestJson({
    url: `${input.apiBase}/communities`,
    token: input.token,
    headers: allocationAttributionHeaders("api-script:smoke-staging-community-create"),
    okStatuses: [202],
    prefix: input.prefix,
    body: {
      display_name: input.displayName,
      description: input.description,
      governance_mode: "centralized",
      membership_mode: "request",
      default_age_gate_policy: "none",
      allow_anonymous_identity: false,
      handle_policy: { policy_template: "standard" },
    },
  })
  const community = asObject(created.community, "create.community", input.prefix)
  const publicCommunityId = asString(community.id, "community.id", input.prefix)
  const job = asObject(created.job, "create.job", input.prefix)
  const jobId = asString(job.id, "job.id", input.prefix)

  return {
    created,
    community,
    publicCommunityId,
    communityId: publicCommunityId.replace(/^com_/, ""),
    job,
    jobId,
  }
}
