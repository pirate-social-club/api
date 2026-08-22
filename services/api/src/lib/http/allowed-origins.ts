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

const HNS_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u
const HNS_HOSTNAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/u
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
  return HNS_LABEL_PATTERN.test(labels[1] ?? "") ? labels[1]! : null
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
  return HNS_LABEL_PATTERN.test(hostname) ? hostname : null
}

function isTrustedHnsHostname(hostname: string, importedOriginAllowed: boolean): boolean {
  if (!HNS_HOSTNAME_PATTERN.test(hostname)) {
    return false
  }

  if (!hostname.includes(".")) {
    return importedOriginAllowed && HNS_LABEL_PATTERN.test(hostname)
  }

  if (hostname.endsWith(".pirate") || hostname.endsWith(".clawitzer")) {
    return true
  }

  // Imported HNS roots use the dashboard-compatible app.<root> origin. The
  // activation decision is supplied by the request path; it must never be
  // inferred from an attacker-controlled Origin header alone.
  const labels = hostname.split(".")
  return importedOriginAllowed
    && labels.length === 2
    && labels[0] === "app"
    && HNS_LABEL_PATTERN.test(labels[1] ?? "")
}

function isTrustedHnsWebOrigin(origin: string, importedOriginAllowed = false): boolean {
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
  return isTrustedHnsHostname(hostname, importedOriginAllowed)
}

export function isAllowedHnsHttpReadOrigin(origin: string, importedOriginAllowed = false): boolean {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return false
  }

  if (url.protocol !== "http:" || url.username || url.password || url.port) {
    return false
  }

  return isTrustedHnsHostname(url.hostname.toLowerCase(), importedOriginAllowed)
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
