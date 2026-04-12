import { resolve } from "node:path"
import { SignJWT } from "jose"
import { readModeEnv } from "./_lib/dev-vars"

const fileEnv = readModeEnv(resolve(import.meta.dirname, ".."), "local-sqlite")

function resolveEnv(name: string, fallback = ""): string {
  return process.env[name] || fileEnv[name] || fallback
}

function readArg(name: string): string | null {
  const args = process.argv.slice(2)
  const index = args.indexOf(name)
  if (index === -1) return null
  return args[index + 1] || null
}

async function main(): Promise<void> {
  const sub = readArg("--sub") || "dev-user"
  const wallet = readArg("--wallet")
  const issuer = (resolveEnv("AUTH_UPSTREAM_JWT_ISSUER") || resolveEnv("JWT_BASED_AUTH_ISSUERS", "pirate-dev")).split(",")[0].trim()
  const audience = resolveEnv("AUTH_UPSTREAM_JWT_AUDIENCE") || resolveEnv("JWT_BASED_AUTH_AUDIENCE", "pirate-api")
  const secret = resolveEnv("AUTH_UPSTREAM_JWT_SHARED_SECRET") || resolveEnv("JWT_BASED_AUTH_SHARED_SECRET")
  if (!secret) {
    throw new Error("AUTH_UPSTREAM_JWT_SHARED_SECRET is not configured")
  }

  const jwt = await new SignJWT(wallet ? { wallet_address: wallet } : {})
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(new TextEncoder().encode(secret))

  process.stdout.write(`${jwt}\n`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
