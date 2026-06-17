/**
 * Operator/dev tooling — mint a short-lived STAGING-ONLY test JWT for the dedicated
 * staging test issuer (see src/lib/auth/staging-test-auth.ts). NOT a request path.
 *
 * The minted token is accepted by POST /session/exchange ONLY when the staging worker
 * has ENVIRONMENT=staging + STAGING_TEST_AUTH_ENABLED=true + STAGING_TEST_JWT_SHARED_SECRET
 * set. It is signed with STAGING_TEST_JWT_SHARED_SECRET — never the real upstream secret.
 *
 * Usage (secret injected via Infisical staging path):
 *   infisical run --project-config-dir ../../core --env staging --path /services/api -- \
 *     bun scripts/mint-staging-test-token.ts --sub usr_pilot_owner [--wallet 0x..] \
 *       [--ttl 900] [--exchange] [--api-base https://api-staging.pirate.sc]
 *
 * With --exchange it also calls /session/exchange and prints the pirate access_token.
 */
import { SignJWT } from "jose"
import { STAGING_TEST_JWT_AUDIENCE, STAGING_TEST_JWT_ISSUER } from "../src/lib/auth/staging-test-auth"

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}
function args(name: string): string[] {
  const out: string[] = []
  process.argv.forEach((a, i) => {
    if (a === `--${name}` && process.argv[i + 1]) out.push(process.argv[i + 1])
  })
  return out
}

const sub = arg("sub")?.trim()
if (!sub) {
  console.error("missing --sub <user subject> (e.g. usr_pilot_owner)")
  process.exit(1)
}

const env = String(process.env.ENVIRONMENT || "").trim().toLowerCase()
if (env && env !== "staging") {
  console.error(`refusing to mint: ENVIRONMENT=${env} (this token is for staging only)`)
  process.exit(1)
}

const secret = String(process.env.STAGING_TEST_JWT_SHARED_SECRET || "").trim()
if (!secret) {
  console.error("STAGING_TEST_JWT_SHARED_SECRET is not set (inject via Infisical staging /services/api)")
  process.exit(1)
}

const ttl = Math.max(60, Math.min(Number(arg("ttl") ?? 900), 3600))
const wallets = args("wallet").map((w) => w.trim()).filter(Boolean)

const now = Math.floor(Date.now() / 1000)
const payload: Record<string, unknown> = {}
if (wallets.length > 0) {
  payload.wallet_addresses = wallets
  payload.selected_wallet_address = wallets[0]
}

const jwt = await new SignJWT(payload)
  .setProtectedHeader({ alg: "HS256", typ: "JWT" })
  .setIssuer(STAGING_TEST_JWT_ISSUER)
  .setAudience(STAGING_TEST_JWT_AUDIENCE)
  .setSubject(sub)
  .setIssuedAt(now)
  .setExpirationTime(now + ttl)
  .sign(new TextEncoder().encode(secret))

console.error(`minted staging test JWT (issuer=${STAGING_TEST_JWT_ISSUER}, sub=${sub}, ttl=${ttl}s)`)
console.log(jwt)

if (flag("exchange")) {
  const base = (arg("api-base") ?? "https://api-staging.pirate.sc").replace(/\/$/, "")
  const res = await fetch(`${base}/auth/session/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ proof: { type: "staging_test_jwt", jwt } }),
  })
  const text = await res.text()
  console.error(`\n/session/exchange -> ${res.status}`)
  try {
    const parsed = JSON.parse(text) as { access_token?: string }
    if (parsed.access_token) {
      console.error("pirate access_token:")
      console.log(parsed.access_token)
    } else {
      console.error(text.slice(0, 800))
    }
  } catch {
    console.error(text.slice(0, 800))
  }
}
