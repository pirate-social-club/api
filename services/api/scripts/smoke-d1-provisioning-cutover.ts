import { SQL } from "bun"
import { SignJWT } from "jose"

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
    namespace_verification?: string | null
  }
  job?: {
    status?: string
  }
}

function env(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
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
  const parsed = new URL(env("CONTROL_PLANE_MIGRATOR_DATABASE_URL"))
  parsed.searchParams.delete("sslrootcert")
  return parsed.toString()
}

async function requestJson<T>(input: {
  apiBase: string
  method: "GET" | "POST"
  path: string
  token?: string
  body?: unknown
  ok?: number[]
}): Promise<T> {
  const response = await fetch(new URL(input.path, input.apiBase), {
    method: input.method,
    headers: {
      accept: "application/json",
      ...(input.body == null ? {} : { "content-type": "application/json" }),
      ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
    },
    body: input.body == null ? undefined : JSON.stringify(input.body),
  })
  const text = await response.text()
  const ok = input.ok ?? [200]
  if (!ok.includes(response.status)) {
    throw new Error(`${input.method} ${input.path} returned ${response.status}: ${text.slice(0, 500)}`)
  }
  return text ? JSON.parse(text) as T : {} as T
}

async function mintJwt(subject: string): Promise<string> {
  const issuer = optionalEnv("AUTH_UPSTREAM_JWT_ISSUER", optionalEnv("JWT_BASED_AUTH_ISSUERS", "pirate-production-upstream").split(",")[0]!)
  const audience = optionalEnv("AUTH_UPSTREAM_JWT_AUDIENCE", optionalEnv("JWT_BASED_AUTH_AUDIENCE", "api-core"))
  const secret = process.env.AUTH_UPSTREAM_JWT_SHARED_SECRET?.trim() || process.env.JWT_BASED_AUTH_SHARED_SECRET?.trim()
  if (!secret) throw new Error("AUTH_UPSTREAM_JWT_SHARED_SECRET or JWT_BASED_AUTH_SHARED_SECRET is required")

  return await new SignJWT({})
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(new TextEncoder().encode(secret))
}

async function exchangeSession(apiBase: string, subject: string): Promise<{ accessToken: string; userId: string }> {
  const jwt = await mintJwt(subject)
  const body = await requestJson<SessionExchange>({
    apiBase,
    method: "POST",
    path: "/auth/session/exchange",
    body: { proof: { type: "jwt_based_auth", jwt } },
  })
  const accessToken = body.access_token?.trim()
  const userId = body.user?.user_id?.trim() || (body.user?.id ? bareId(body.user.id, "usr") : "")
  if (!accessToken || !userId) throw new Error("session exchange did not return access_token and user id")
  return { accessToken, userId }
}

async function seedVerifiedNamespace(sql: SQL, input: {
  userId: string
  namespaceVerificationId: string
  namespaceVerificationSessionId: string
  rootLabel: string
  now: string
}): Promise<void> {
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()
  const challengePayload = JSON.stringify({
    smoke: "d1-provisioning-cutover",
    root_label: input.rootLabel,
  })

  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO namespace_verification_sessions (
        namespace_verification_session_id, namespace_verification_id, user_id, family, submitted_root_label,
        normalized_root_label, status, challenge_kind, challenge_payload_json, challenge_host, challenge_txt_value,
        setup_nameservers_json, challenge_expires_at, root_exists, root_control_verified, expiry_horizon_sufficient,
        routing_enabled, pirate_dns_authority_verified, club_attach_allowed, pirate_web_routing_allowed,
        pirate_subdomain_issuance_allowed, control_class, operation_class, observation_provider, evidence_bundle_ref,
        accepted_at, expires_at, failure_reason, created_at, updated_at
      ) VALUES (
        ${input.namespaceVerificationSessionId}, ${input.namespaceVerificationId}, ${input.userId}, 'hns', ${input.rootLabel},
        ${input.rootLabel}, 'verified', 'dns_txt', ${challengePayload}, '_pirate-smoke', 'd1-cutover-smoke',
        NULL, ${expiresAt}, 1, 1, 1,
        1, 1, 1, 1,
        1, 'single_holder_root', 'owner_managed_namespace', 'd1_cutover_smoke_seed', 'd1_cutover_smoke_seed',
        ${input.now}, ${expiresAt}, NULL, ${input.now}, ${input.now}
      )
    `
    await tx`
      INSERT INTO namespace_verifications (
        namespace_verification_id, source_namespace_verification_session_id, user_id, family, normalized_root_label,
        status, root_exists, root_control_verified, expiry_horizon_sufficient, routing_enabled,
        pirate_dns_authority_verified, club_attach_allowed, pirate_web_routing_allowed, pirate_subdomain_issuance_allowed,
        control_class, operation_class, observation_provider, evidence_bundle_ref, accepted_at, expires_at, created_at, updated_at
      ) VALUES (
        ${input.namespaceVerificationId}, ${input.namespaceVerificationSessionId}, ${input.userId}, 'hns', ${input.rootLabel},
        'verified', 1, 1, 1, 1,
        1, 1, 1, 1,
        'single_holder_root', 'owner_managed_namespace', 'd1_cutover_smoke_seed', 'd1_cutover_smoke_seed', ${input.now}, ${expiresAt}, ${input.now}, ${input.now}
      )
    `
  })
}

async function createCommunity(input: {
  apiBase: string
  token: string
  displayName: string
  namespaceVerificationId?: string
}): Promise<{ publicCommunityId: string; communityId: string }> {
  const body = await requestJson<CreateCommunityResponse>({
    apiBase: input.apiBase,
    method: "POST",
    path: "/communities",
    token: input.token,
    ok: [202],
    body: {
      display_name: input.displayName,
      description: "Temporary D1 provisioning cutover smoke.",
      membership_mode: "request",
      default_age_gate_policy: "none",
      ...(input.namespaceVerificationId
        ? { namespace: { namespace_verification: publicId(input.namespaceVerificationId, "nv") } }
        : {}),
    },
  })
  const publicCommunityId = body.community?.id ?? (body.community?.community_id ? publicId(body.community.community_id, "com") : "")
  const communityId = bareId(publicCommunityId || body.community?.community_id || "", "com")
  if (!communityId || body.job?.status !== "succeeded" || body.community?.provisioning_state !== "active") {
    throw new Error(`community create did not finish active/succeeded: ${JSON.stringify(body)}`)
  }
  return { publicCommunityId: publicId(communityId, "com"), communityId }
}

async function assertD1Routing(sql: SQL, communityId: string): Promise<Record<string, unknown>> {
  const rows = await sql`
    SELECT r.provisioning_state, r.shard_worker_id, r.binding_name, r.region,
           b.database_url, b.database_name, b.requires_credentials
    FROM community_database_routing r
    JOIN community_database_bindings b ON b.community_id = r.community_id AND b.binding_role = 'primary'
    WHERE r.community_id = ${communityId}
    LIMIT 1
  `
  const row = rows[0] as Record<string, unknown> | undefined
  if (!row) throw new Error(`missing routing row for ${communityId}`)
  if (row.provisioning_state !== "ready") {
    throw new Error(`routing row is not ready for ${communityId}: ${JSON.stringify(row)}`)
  }
  if (typeof row.database_url !== "string" || !row.database_url.startsWith("d1://shard/")) {
    throw new Error(`binding URL is not d1://shard for ${communityId}: ${JSON.stringify(row)}`)
  }
  if (Number(row.requires_credentials) !== 0) {
    throw new Error(`D1 binding unexpectedly requires credentials for ${communityId}: ${JSON.stringify(row)}`)
  }
  return row
}

async function main(): Promise<void> {
  const apiBase = optionalEnv("PIRATE_API_BASE_URL", "https://api.pirate.sc")
  const runId = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)
  const subject = `d1-cutover-smoke-${runId}`
  const now = new Date().toISOString()
  const sql = new SQL(sqlUrl())

  try {
    const session = await exchangeSession(apiBase, subject)
    const namespaceless = await createCommunity({
      apiBase,
      token: session.accessToken,
      displayName: `D1 Cutover Namespaceless Smoke ${runId}`,
    })

    const namespaceVerificationId = `nv_d1_cutover_smoke_${runId}`
    const namespaceVerificationSessionId = `nvs_d1_cutover_smoke_${runId}`
    await seedVerifiedNamespace(sql, {
      userId: session.userId,
      namespaceVerificationId,
      namespaceVerificationSessionId,
      rootLabel: `d1-cutover-smoke-${runId}`,
      now,
    })
    const namespaced = await createCommunity({
      apiBase,
      token: session.accessToken,
      displayName: `D1 Cutover Namespaced Smoke ${runId}`,
      namespaceVerificationId,
    })

    const namespacelessRouting = await assertD1Routing(sql, namespaceless.communityId)
    const namespacedRouting = await assertD1Routing(sql, namespaced.communityId)

    console.log(JSON.stringify({
      ok: true,
      apiBase,
      runId,
      namespaceless: {
        community: namespaceless.publicCommunityId,
        routing: namespacelessRouting,
      },
      namespaced: {
        community: namespaced.publicCommunityId,
        namespace_verification: publicId(namespaceVerificationId, "nv"),
        routing: namespacedRouting,
      },
    }, null, 2))
  } finally {
    await sql.close()
  }
}

await main()
