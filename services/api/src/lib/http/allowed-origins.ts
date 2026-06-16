import type { Env } from "../../env"

function configuredOriginValues(env: Pick<Env, "CORS_ALLOWED_ORIGINS" | "PIRATE_WEB_PUBLIC_ORIGIN">): string[] {
  const values = String(env.CORS_ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
  const webOrigin = env.PIRATE_WEB_PUBLIC_ORIGIN?.trim()
  if (webOrigin) {
    values.push(webOrigin)
  }
  return [...new Set(values)]
}

function normalizeExactOrigin(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
      return null
    }
    return url.origin
  } catch {
    return null
  }
}

export function isTrustedHnsWebOrigin(origin: string): boolean {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return false
  }

  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    return false
  }

  const hostname = url.hostname.toLowerCase()
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/u.test(hostname)) {
    return false
  }

  if (!hostname.includes(".")) {
    return true
  }

  return hostname.endsWith(".pirate") || hostname.endsWith(".clawitzer")
}

export function configuredCorsOrigin(origin: string, env: Pick<Env, "CORS_ALLOWED_ORIGINS">): string | null {
  if (isTrustedHnsWebOrigin(origin)) {
    return origin
  }

  const allowedOrigins = String(env.CORS_ALLOWED_ORIGINS || "")
    .split(",")
    .map((allowedOrigin) => allowedOrigin.trim())
    .filter(Boolean)
  if (allowedOrigins.includes("*")) {
    return "*"
  }
  return allowedOrigins.includes(origin) ? origin : null
}

export function isAllowedKaraokeWebSocketOrigin(
  origin: string | null | undefined,
  env: Pick<Env, "CORS_ALLOWED_ORIGINS" | "ENVIRONMENT" | "PIRATE_WEB_PUBLIC_ORIGIN">,
): boolean {
  if (!origin) return false
  const normalized = normalizeExactOrigin(origin)
  if (!normalized) return false

  const candidate = new URL(normalized)
  const isLocalhost = candidate.hostname === "localhost" || candidate.hostname === "127.0.0.1"
  if (isLocalhost && env.ENVIRONMENT !== "development" && env.ENVIRONMENT !== "test") {
    return false
  }

  return configuredOriginValues(env)
    .filter((value) => value !== "*")
    .map(normalizeExactOrigin)
    .some((allowed) => allowed === normalized)
}
