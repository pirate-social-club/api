/**
 * Manual staging smoke for the D1 community provisioning seam:
 * upstream-JWT auth -> POST /communities -> public readback through routing.
 *
 * This creates a REAL loaded community and intentionally does not reclaim its D1
 * binding. Run manually after staging API/shard deploys; each successful run
 * consumes one pool binding. Use --archive-success to hide the smoke community
 * from public surfaces after readback, but note that archive does not release
 * the D1 binding.
 *
 * Default mode is API-only and credential-light. Use --deep only when you also
 * want direct control-plane routing confirmation via CONTROL_PLANE_MIGRATOR_DATABASE_URL.
 *
 * Typical staging run:
 *   infisical run --project-config-dir ../../core --env staging --path /services/api -- \
 *     bun scripts/smoke-d1-provisioning-cutover.ts --archive-success
 */

import { SQL } from "bun"
import { SignJWT } from "jose"
import { allocationAttributionHeaders } from "./_lib/allocation-attribution"

type JsonObject = Record<string, unknown>

type SessionExchange = {
  access_token?: string
  user?: {
    id?: string
    user_id?: string
  }
}

type CreateCommunityResponse = {
  community?: {
    id?: string
    community_id?: string
    provisioning_state?: string
  }
  job?: {
    id?: string
    status?: string
  }
}

type SmokeContext = {
  phase: string
  apiBase: string
  runId: string
  subject: string
  communityId?: string
  publicCommunityId?: string
  jobId?: string
}

class ApiRequestError extends Error {
  readonly status: number
  readonly body: unknown

  constructor(message: string, status: number, body: unknown) {
    super(message)
    this.name = "ApiRequestError"
    this.status = status
    this.body = body
  }
}

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  if (index === -1) return undefined
  return process.argv[index + 1]
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name)
}

function optionalEnv(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback
}

function bareId(id: string, prefix: string): string {
  return id.startsWith(`${prefix}_`) ? id.slice(prefix.length + 1) : id
}

function publicId(id: string, prefix: string): string {
  return id.startsWith(`${prefix}_`) ? id : `${prefix}_${id}`
}

function sqlUrl(): string {
  const value = process.env.CONTROL_PLANE_MIGRATOR_DATABASE_URL?.trim()
  if (!value) throw new Error("CONTROL_PLANE_MIGRATOR_DATABASE_URL is required for --deep")
  const parsed = new URL(value)
  parsed.searchParams.delete("sslrootcert")
  return parsed.toString()
}

function assertStagingOrAllowed(apiBase: string): void {
  const host = new URL(apiBase).hostname
  if (host.includes("staging") || hasFlag("--allow-prod")) return
  throw new Error(`refusing to run against non-staging host ${host}; pass --allow-prod explicitly`)
}

function result(context: SmokeContext, extra: JsonObject = {}): JsonObject {
  return {
    ...extra,
    apiBase: context.apiBase,
    runId: context.runId,
    subject: context.subject,
    communityId: context.communityId ?? null,
    publicCommunityId: context.publicCommunityId ?? null,
    jobId: context.jobId ?? null,
    consumedBinding: Boolean(context.communityId),
  }
}

function fail(context: SmokeContext, error: unknown): never {
  if (error instanceof ApiRequestError && error.body && typeof error.body === "object") {
    const details = (error.body as { details?: unknown }).details
    const source = details && typeof details === "object" ? details as Record<string, unknown> : error.body as Record<string, unknown>
    if (!context.communityId && typeof source.community_id === "string") {
      context.communityId = bareId(source.community_id, "cmt")
      context.publicCommunityId = publicId(context.communityId, "com")
    }
    if (!context.jobId && typeof source.job_id === "string") {
      context.jobId = source.job_id
    }
  }

  console.error(JSON.stringify(result(context, {
    ok: false,
    phase: context.phase,
    error: error instanceof Error ? error.message : String(error),
    responseStatus: error instanceof ApiRequestError ? error.status : null,
    responseBody: error instanceof ApiRequestError ? error.body : null,
  }), null, 2))
  process.exit(1)
}

async function requestJson<T>(input: {
  apiBase: string
  method?: "GET" | "POST"
  path: string
  token?: string
  body?: unknown
  headers?: Record<string, string>
  ok?: number[]
}): Promise<T> {
  const method = input.method ?? "POST"
  const response = await fetch(new URL(input.path, input.apiBase), {
    method,
    headers: {
      accept: "application/json",
      ...(input.body == null ? {} : { "content-type": "application/json" }),
      ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
      ...input.headers,
    },
    body: input.body == null ? undefined : JSON.stringify(input.body),
  })
  const text = await response.text()
  let parsed: unknown = {}
  try {
    parsed = text ? JSON.parse(text) : {}
  } catch {
    parsed = { raw: text }
  }
  const ok = input.ok ?? [200]
  if (!ok.includes(response.status)) {
    throw new ApiRequestError(
      `${method} ${input.path} returned ${response.status}: ${text.slice(0, 500)}`,
      response.status,
      parsed,
    )
  }
  return parsed as T
}

async function mintJwt(input: { apiBase: string; subject: string }): Promise<string> {
  const isStaging = new URL(input.apiBase).hostname.includes("staging")
  const issuer = optionalEnv(
    "AUTH_UPSTREAM_JWT_ISSUER",
    isStaging
      ? "pirate-staging-upstream"
      : optionalEnv("JWT_BASED_AUTH_ISSUERS", "pirate-production-upstream").split(",")[0]!,
  )
  const audience = optionalEnv(
    "AUTH_UPSTREAM_JWT_AUDIENCE",
    isStaging ? "pirate-api-staging" : optionalEnv("JWT_BASED_AUTH_AUDIENCE", "api-core"),
  )
  const secret = process.env.AUTH_UPSTREAM_JWT_SHARED_SECRET?.trim() || process.env.JWT_BASED_AUTH_SHARED_SECRET?.trim()
  if (!secret) throw new Error("AUTH_UPSTREAM_JWT_SHARED_SECRET or JWT_BASED_AUTH_SHARED_SECRET is required")

  return await new SignJWT({})
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(input.subject)
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(new TextEncoder().encode(secret))
}

async function exchangeSession(apiBase: string, subject: string): Promise<{ accessToken: string; userId: string }> {
  const jwt = await mintJwt({ apiBase, subject })
  const body = await requestJson<SessionExchange>({
    apiBase,
    path: "/auth/session/exchange",
    body: { proof: { type: "jwt_based_auth", jwt } },
  })
  const accessToken = body.access_token?.trim()
  const userId = body.user?.user_id?.trim() || (body.user?.id ? bareId(body.user.id, "usr") : "")
  if (!accessToken || !userId) throw new Error("session exchange did not return access_token and user id")
  return { accessToken, userId }
}

async function createCommunity(input: {
  apiBase: string
  token: string
  displayName: string
}): Promise<{ publicCommunityId: string; communityId: string; jobId: string | null }> {
  const body = await requestJson<CreateCommunityResponse>({
    apiBase: input.apiBase,
    path: "/communities",
    token: input.token,
    headers: allocationAttributionHeaders("api-script:smoke-d1-provisioning-cutover"),
    ok: [200, 201, 202],
    body: {
      display_name: input.displayName,
      description: "Manual staging smoke community for the D1 provisioning seam.",
      governance_mode: "centralized",
      membership_mode: "request",
      default_age_gate_policy: "none",
      allow_anonymous_identity: false,
      handle_policy: { policy_template: "standard" },
    },
  })
  const publicCommunityId = body.community?.id ?? (body.community?.community_id ? publicId(body.community.community_id, "com") : "")
  const communityId = bareId(publicCommunityId || body.community?.community_id || "", "com")
  if (!communityId) throw new Error(`community create response did not include a community id: ${JSON.stringify(body)}`)
  if (body.job?.status && body.job.status !== "succeeded") {
    throw new Error(`community create job did not succeed: ${JSON.stringify(body)}`)
  }
  if (body.community?.provisioning_state && body.community.provisioning_state !== "active") {
    throw new Error(`community did not become active: ${JSON.stringify(body)}`)
  }
  return { publicCommunityId: publicId(communityId, "com"), communityId, jobId: body.job?.id ?? null }
}

async function assertPublicReadback(input: { apiBase: string; publicCommunityId: string }): Promise<JsonObject> {
  return await requestJson<JsonObject>({
    apiBase: input.apiBase,
    method: "GET",
    path: `/public-communities/${encodeURIComponent(input.publicCommunityId)}`,
    ok: [200],
  })
}

async function archiveCommunity(input: { apiBase: string; token: string; publicCommunityId: string }): Promise<JsonObject> {
  return await requestJson<JsonObject>({
    apiBase: input.apiBase,
    path: `/communities/${encodeURIComponent(input.publicCommunityId)}/archive`,
    token: input.token,
    body: {},
    ok: [200],
  })
}

async function assertD1Routing(communityId: string): Promise<Record<string, unknown>> {
  const sql = new SQL(sqlUrl())
  try {
    const rows = await sql`
      SELECT r.provisioning_state, r.shard_worker_id, r.binding_name, r.region
      FROM community_database_routing r
      WHERE r.community_id = ${communityId}
      LIMIT 1
    `
    const row = rows[0] as Record<string, unknown> | undefined
    if (!row) throw new Error(`missing routing row for ${communityId}`)
    if (row.provisioning_state !== "ready") {
      throw new Error(`routing row is not ready for ${communityId}: ${JSON.stringify(row)}`)
    }
    if (typeof row.binding_name !== "string" || !row.binding_name.startsWith("DB_CMTY_")) {
      throw new Error(`routing row does not carry a D1 binding for ${communityId}: ${JSON.stringify(row)}`)
    }
    return row
  } finally {
    await sql.close()
  }
}

async function main(): Promise<void> {
  const apiBase = (
    readArg("--api-base")
    ?? process.env.PIRATE_SMOKE_API_BASE_URL
    ?? process.env.PIRATE_API_BASE_URL
    ?? "https://api-staging.pirate.sc"
  ).replace(/\/$/u, "")
  const runId = new Date().toISOString().replace(/[-:.TZ]/gu, "").slice(0, 14)
  const subject = readArg("--subject") ?? process.env.PIRATE_SMOKE_SUBJECT ?? `d1-provisioning-smoke-${runId}`
  const context: SmokeContext = { phase: "init", apiBase, runId, subject }

  try {
    context.phase = "preflight"
    assertStagingOrAllowed(apiBase)

    context.phase = "auth"
    const session = await exchangeSession(apiBase, subject)

    context.phase = "create"
    const created = await createCommunity({
      apiBase,
      token: session.accessToken,
      displayName: `D1 Provisioning Smoke ${runId}`,
    })
    context.communityId = created.communityId
    context.publicCommunityId = created.publicCommunityId
    context.jobId = created.jobId ?? undefined

    context.phase = "readback"
    const preview = await assertPublicReadback({ apiBase, publicCommunityId: created.publicCommunityId })

    let routing: Record<string, unknown> | null = null
    if (hasFlag("--deep")) {
      context.phase = "deep_routing"
      routing = await assertD1Routing(created.communityId)
    }

    let archive: JsonObject | null = null
    if (hasFlag("--archive-success")) {
      context.phase = "archive"
      archive = await archiveCommunity({ apiBase, token: session.accessToken, publicCommunityId: created.publicCommunityId })
    }

    context.phase = "done"
    console.log(JSON.stringify(result(context, {
      ok: true,
      phase: context.phase,
      deep: hasFlag("--deep"),
      archived: Boolean(archive),
      displayName: typeof preview.display_name === "string" ? preview.display_name : null,
      canonicalHref: preview.links && typeof preview.links === "object"
        ? ((preview.links as { canonical?: { href?: unknown } }).canonical?.href ?? null)
        : null,
      routing,
    }), null, 2))
  } catch (error) {
    fail(context, error)
  }
}

await main()
