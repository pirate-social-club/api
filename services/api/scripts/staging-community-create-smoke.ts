import { SignJWT } from "jose"
import { resolve } from "node:path"
import { readModeEnv } from "./_lib/dev-vars"

function requireEnv(values: Record<string, string>, key: string): string {
  const value = values[key]?.trim()
  if (!value) {
    throw new Error(`${key} is not configured in .env.staging`)
  }
  return value
}

function readArg(name: string): string | null {
  const args = process.argv.slice(2)
  const index = args.indexOf(name)
  if (index === -1) return null
  return args[index + 1] || null
}

async function mintJwt(input: {
  secret: string
  issuer: string
  audience: string
  subject: string
}): Promise<string> {
  return await new SignJWT()
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(input.issuer)
    .setAudience(input.audience)
    .setSubject(input.subject)
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(new TextEncoder().encode(input.secret))
}

async function requestJson(input: {
  baseUrl: string
  path: string
  method?: string
  bearerToken?: string | null
  body?: unknown
}): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${input.baseUrl}${input.path}`, {
    method: input.method ?? "POST",
    headers: {
      ...(input.body === undefined ? {} : { "content-type": "application/json" }),
      ...(input.bearerToken ? { authorization: `Bearer ${input.bearerToken}` } : {}),
    },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  })

  const raw = await response.text()
  let body: unknown = null
  try {
    body = raw ? JSON.parse(raw) : null
  } catch {
    body = raw
  }

  return { status: response.status, body }
}

function expectStatus(actual: number, expected: number, label: string, body: unknown): void {
  if (actual !== expected) {
    throw new Error(`${label} returned ${actual}: ${JSON.stringify(body)}`)
  }
}

async function main(): Promise<void> {
  const serviceRoot = resolve(import.meta.dirname, "..")
  const env = readModeEnv(serviceRoot, "staging")
  const baseUrl = requireEnv(env, "PIRATE_API_PUBLIC_ORIGIN").replace(/\/+$/, "")
  const secret = requireEnv(env, "AUTH_UPSTREAM_JWT_SHARED_SECRET")
  const issuer = requireEnv(env, "AUTH_UPSTREAM_JWT_ISSUER")
  const audience = requireEnv(env, "AUTH_UPSTREAM_JWT_AUDIENCE")

  const suffix = Date.now().toString(36)
  const rootLabel = (readArg("--root-label") || `stageop${suffix}`).toLowerCase()
  const displayName = readArg("--display-name") || `Stage Operator ${suffix}`
  const subject = readArg("--subject") || `stage-operator-${suffix}`

  const upstreamJwt = await mintJwt({
    secret,
    issuer,
    audience,
    subject,
  })

  const exchange = await requestJson({
    baseUrl,
    path: "/auth/session/exchange",
    body: {
      proof: {
        type: "jwt_based_auth",
        jwt: upstreamJwt,
      },
    },
  })
  expectStatus(exchange.status, 200, "session exchange", exchange.body)
  const accessToken = String((exchange.body as { access_token?: string }).access_token || "").trim()
  if (!accessToken) {
    throw new Error(`session exchange did not return access_token: ${JSON.stringify(exchange.body)}`)
  }

  const verification = await requestJson({
    baseUrl,
    path: "/verification-sessions",
    bearerToken: accessToken,
    body: {
      provider: "self",
    },
  })
  expectStatus(verification.status, 201, "verification session create", verification.body)
  const verificationSessionId = String(
    (verification.body as { verification_session_id?: string }).verification_session_id || "",
  ).trim()

  const verificationComplete = await requestJson({
    baseUrl,
    path: `/verification-sessions/${verificationSessionId}/complete`,
    bearerToken: accessToken,
    body: {},
  })
  expectStatus(verificationComplete.status, 200, "verification session complete", verificationComplete.body)

  const namespaceSession = await requestJson({
    baseUrl,
    path: "/namespace-verification-sessions",
    bearerToken: accessToken,
    body: {
      family: "hns",
      root_label: rootLabel,
    },
  })
  expectStatus(namespaceSession.status, 201, "namespace session create", namespaceSession.body)
  const namespaceVerificationSessionId = String(
    (namespaceSession.body as { namespace_verification_session_id?: string }).namespace_verification_session_id || "",
  ).trim()

  const namespaceComplete = await requestJson({
    baseUrl,
    path: `/namespace-verification-sessions/${namespaceVerificationSessionId}/complete`,
    bearerToken: accessToken,
    body: {},
  })
  expectStatus(namespaceComplete.status, 200, "namespace session complete", namespaceComplete.body)
  const namespaceVerificationId = String(
    (namespaceComplete.body as { namespace_verification_id?: string }).namespace_verification_id || "",
  ).trim()

  const communityCreate = await requestJson({
    baseUrl,
    path: "/communities",
    bearerToken: accessToken,
    body: {
      display_name: displayName,
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    },
  })
  expectStatus(communityCreate.status, 202, "community create", communityCreate.body)
  const communityId = String(
    (communityCreate.body as { community?: { community_id?: string } }).community?.community_id || "",
  ).trim()
  if (!communityId) {
    throw new Error(`community create did not return community_id: ${JSON.stringify(communityCreate.body)}`)
  }

  const posts = await requestJson({
    baseUrl,
    path: `/communities/${communityId}/posts`,
    method: "GET",
  })
  expectStatus(posts.status, 200, "community posts read", posts.body)

  process.stdout.write([
    "staging community create smoke passed",
    `base_url=${baseUrl}`,
    `subject=${subject}`,
    `root_label=${rootLabel}`,
    `namespace_verification_id=${namespaceVerificationId}`,
    `community_id=${communityId}`,
  ].join("\n") + "\n")
}

await main()
