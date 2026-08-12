import type { Env } from "../../env"

const DEFAULT_ANDROID_KARAOKE_ORIGIN = "https://android.pirate.sc"
function commaSeparatedValues(value: string | undefined): string[] {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

function configuredOriginValues(env: Pick<Env, "CORS_ALLOWED_ORIGINS" | "PIRATE_WEB_PUBLIC_ORIGIN">): string[] {
  const values = commaSeparatedValues(env.CORS_ALLOWED_ORIGINS)
  const webOrigin = env.PIRATE_WEB_PUBLIC_ORIGIN?.trim()
  if (webOrigin) {
    values.push(webOrigin)
  }
  return [...new Set(values)]
}

function configuredKaraokeOriginValues(
  env: Pick<Env, "CORS_ALLOWED_ORIGINS" | "PIRATE_ANDROID_KARAOKE_ORIGINS" | "PIRATE_WEB_PUBLIC_ORIGIN">,
): string[] {
  return [
    ...configuredOriginValues(env),
    DEFAULT_ANDROID_KARAOKE_ORIGIN,
    ...commaSeparatedValues(env.PIRATE_ANDROID_KARAOKE_ORIGINS),
  ]
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

export function importedHnsAppRoot(origin: string): string | null {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return null
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null
  const labels = url.hostname.toLowerCase().split(".")
  if (labels.length !== 2 || labels[0] !== "app") return null
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(labels[1] ?? "")
    ? labels[1]!
    : null
}

export function importedHnsRootLabel(origin: string): string | null {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return null
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null
  const hostname = url.hostname.toLowerCase()
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(hostname)
    ? hostname
    : null
}

function isTrustedHnsWebOrigin(origin: string, importedOriginAllowed: boolean): boolean {
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
    return importedOriginAllowed && importedHnsRootLabel(origin) !== null
  }

  if (hostname.endsWith(".pirate") || hostname.endsWith(".clawitzer")) {
    return true
  }

  // Imported HNS roots use the dashboard-compatible app.<root> origin. The
  // API remains the canonical HNS service, so these origins need the same
  // CORS treatment as app.pirate without requiring one config entry per root.
  return importedOriginAllowed && importedHnsAppRoot(origin) !== null
}

export function configuredCorsOrigin(
  origin: string,
  env: Pick<Env, "CORS_ALLOWED_ORIGINS"> | undefined,
  importedHnsOriginAllowed = false,
): string | null {
  if (isTrustedHnsWebOrigin(origin, importedHnsOriginAllowed)) {
    return origin
  }

  const allowedOrigins = String(env?.CORS_ALLOWED_ORIGINS || "")
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
  env: Pick<Env, "CORS_ALLOWED_ORIGINS" | "ENVIRONMENT" | "PIRATE_ANDROID_KARAOKE_ORIGINS" | "PIRATE_WEB_PUBLIC_ORIGIN">,
): boolean {
  if (!origin) return false
  const normalized = normalizeExactOrigin(origin)
  if (!normalized) return false

  const candidate = new URL(normalized)
  const isLocalhost = candidate.hostname === "localhost" || candidate.hostname === "127.0.0.1"
  if (isLocalhost && env.ENVIRONMENT !== "development" && env.ENVIRONMENT !== "test") {
    return false
  }

  return configuredKaraokeOriginValues(env)
    .filter((value) => value !== "*")
    .map(normalizeExactOrigin)
    .some((allowed) => allowed === normalized)
}
