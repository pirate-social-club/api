import { mkdir, rm, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { SignJWT } from "jose"
import { readModeEnv } from "./_lib/dev-vars"

function requireEnv(values: Record<string, string>, key: string): string {
  const value = values[key]?.trim()
  if (!value) {
    throw new Error(`${key} is not configured in .env.local-sqlite`)
  }
  return value
}

function requireLocalFilePath(url: string, key: string): string {
  if (!url.startsWith("file:")) {
    throw new Error(`${key} must use a local file: URL for Bruno local prep`)
  }

  const parsed = new URL(url)
  if (!parsed.pathname) {
    throw new Error(`${key} must resolve to a writable local file path`)
  }

  return parsed.pathname
}

async function mintJwt(input: {
  secret: string
  issuer: string
  audience: string
  subject: string
  issuedAt: number
  expiresAt: number
}): Promise<string> {
  return await new SignJWT()
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(input.issuer)
    .setAudience(input.audience)
    .setSubject(input.subject)
    .setIssuedAt(input.issuedAt)
    .setExpirationTime(input.expiresAt)
    .sign(new TextEncoder().encode(input.secret))
}

async function main(): Promise<void> {
  const serviceRoot = resolve(import.meta.dirname, "..")
  const repoRoot = resolve(serviceRoot, "../..")
  const brunoEnvPath = resolve(serviceRoot, "bruno/environments/local.bru")
  const port = Number(process.env.PORT || "8787")
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`PORT must be a positive integer, received: ${process.env.PORT ?? ""}`)
  }
  const baseUrl = `http://127.0.0.1:${port}`
  const devVars = readModeEnv(serviceRoot, "local-sqlite")

  const controlPlaneDbPath = requireLocalFilePath(
    requireEnv(devVars, "CONTROL_PLANE_DATABASE_URL"),
    "CONTROL_PLANE_DATABASE_URL",
  )
  const communityDbRoot = requireEnv(devVars, "LOCAL_COMMUNITY_DB_ROOT")

  await rm(controlPlaneDbPath, { force: true })
  await rm(`${controlPlaneDbPath}-shm`, { force: true })
  await rm(`${controlPlaneDbPath}-wal`, { force: true })
  await rm(communityDbRoot, { recursive: true, force: true })
  await mkdir(communityDbRoot, { recursive: true })

  const migrate = spawnSync(
    "./scripts/apply-sqlite-migrations.sh",
    ["--db", controlPlaneDbPath, "--migrations", "db/control-plane/migrations", "--label", "control-plane"],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  )
  if (migrate.status !== 0) {
    throw new Error(`migration bootstrap failed:\n${migrate.stderr}`)
  }

  const secret = requireEnv(devVars, "AUTH_UPSTREAM_JWT_SHARED_SECRET")
  const issuer = requireEnv(devVars, "AUTH_UPSTREAM_JWT_ISSUER")
  const audience = requireEnv(devVars, "AUTH_UPSTREAM_JWT_AUDIENCE")

  const nowSeconds = Math.floor(Date.now() / 1000)
  const subject = `bruno-${nowSeconds}`
  const upstreamJwt = await mintJwt({
    secret,
    issuer,
    audience,
    subject,
    issuedAt: nowSeconds,
    expiresAt: nowSeconds + 15 * 60,
  })
  const upstreamJwtSecondary = await mintJwt({
    secret,
    issuer,
    audience,
    subject: `${subject}-secondary`,
    issuedAt: nowSeconds,
    expiresAt: nowSeconds + 15 * 60,
  })
  const upstreamJwtExpired = await mintJwt({
    secret,
    issuer,
    audience,
    subject,
    issuedAt: nowSeconds - 7200,
    expiresAt: nowSeconds - 3600,
  })
  const upstreamJwtWrongIssuer = await mintJwt({
    secret,
    issuer: "pirate-wrong-issuer",
    audience,
    subject,
    issuedAt: nowSeconds,
    expiresAt: nowSeconds + 15 * 60,
  })
  const upstreamJwtWrongAudience = await mintJwt({
    secret,
    issuer,
    audience: "pirate-wrong-audience",
    subject,
    issuedAt: nowSeconds,
    expiresAt: nowSeconds + 15 * 60,
  })

  const envContents = `vars {
  base_url: ${baseUrl}
  upstream_jwt: ${upstreamJwt}
  upstream_jwt_secondary: ${upstreamJwtSecondary}
  pirate_access_token:
  pirate_user_id:
  verification_session_id:
  namespace_root_label: demo-bruno
  namespace_verification_session_id:
  namespace_verification_id:
  community_display_name: Bruno Demo Club
  community_description: CLI-first Bruno community
  community_id:
  community_provisioning_job_id:
  post_id:
  song_artifact_upload_id:
  song_artifact_upload_url:
  song_artifact_bundle_id:
  song_post_id:
  review_post_id:
  post_idempotency_key: bruno-post-01
  post_title: Hello From Bruno
  post_body: First post created through the API collection.
  song_primary_audio_storage_ref:
  song_primary_audio_size_bytes:
  song_primary_audio_content_hash:
  song_primary_audio_gateway_url:
  song_lyrics:
  post_locale: en
  upstream_jwt_expired: ${upstreamJwtExpired}
  upstream_jwt_malformed: not-a-jwt
  upstream_jwt_wrong_issuer: ${upstreamJwtWrongIssuer}
  upstream_jwt_wrong_audience: ${upstreamJwtWrongAudience}
  jwt_issuer: ${issuer}
  jwt_subject: ${subject}
}
`

  await writeFile(brunoEnvPath, envContents, "utf8")

  process.stdout.write([
    "prepared bruno local state",
    `base_url=${baseUrl}`,
    `db=${controlPlaneDbPath}`,
    `community_root=${communityDbRoot}`,
    `jwt_subject=${subject}`,
  ].join("\n") + "\n")
}

await main()
