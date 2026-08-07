import type { Env } from "../../env"

// The VPS HNS gateway forwards api.pirate traffic to this worker with the
// original public hostname in this header (the web worker trusts the same
// header for its own origin resolution). The plain Host header is accepted as
// a fallback for gateway configs that preserve it.
export const MIRROR_REQUEST_HOST_HEADER = "x-pirate-hns-host"

// Only these request hostnames may be mirrored into emitted URLs. Anything
// else — including arbitrary Host header values — must never be reflected
// into response bodies (host-header-injection / open-redirect guard).
const MIRRORABLE_REQUEST_HOSTNAMES: ReadonlySet<string> = new Set([
  "api.pirate",
])

// Stored media refs are baked with the request origin at write time, which in
// production is the canonical zone. The env origin covers other environments
// (staging, preview) whose stored refs point at their own public origin.
const DEFAULT_CANONICAL_API_HOSTNAME = "api.pirate.sc"

function normalizeRequestHostname(value: string | null): string | null {
  const candidate = value?.split(",")[0]?.trim().toLowerCase().replace(/\.+$/u, "") ?? ""
  if (!candidate) {
    return null
  }

  try {
    // Parsing as a URL drops any port and rejects userinfo/path noise; only
    // the resulting hostname is ever used, so the raw header value can never
    // leak into an emitted URL. The trailing-dot FQDN form compares equal to
    // its bare hostname.
    const hostname = new URL(`https://${candidate}`).hostname.replace(/\.+$/u, "")
    return hostname || null
  } catch {
    return null
  }
}

export function resolveRequestMirrorOrigin(request: Request): string | null {
  const hostname = normalizeRequestHostname(request.headers.get(MIRROR_REQUEST_HOST_HEADER))
    ?? normalizeRequestHostname(request.headers.get("host"))
  if (!hostname || !MIRRORABLE_REQUEST_HOSTNAMES.has(hostname)) {
    return null
  }

  return `https://${hostname}`
}

export function canonicalApiHostnames(
  env: Pick<Env, "PIRATE_API_PUBLIC_ORIGIN"> | undefined,
): ReadonlySet<string> {
  const hostnames = new Set<string>([DEFAULT_CANONICAL_API_HOSTNAME])
  const configured = env?.PIRATE_API_PUBLIC_ORIGIN?.trim()
  if (configured) {
    try {
      const hostname = new URL(configured).hostname.toLowerCase()
      if (hostname && !MIRRORABLE_REQUEST_HOSTNAMES.has(hostname)) {
        hostnames.add(hostname)
      }
    } catch {
      // Ignore a malformed configured origin; the default hostname still applies.
    }
  }
  return hostnames
}

function rehostCanonicalApiUrl(
  value: string,
  mirrorOrigin: string,
  canonicalHostnames: ReadonlySet<string>,
): string {
  const trimmed = value.trim()
  // Whole-string URLs only: ref fields carry a single URL as the entire
  // value. Free text (post bodies, descriptions) mentioning an API URL is
  // deliberately not rewritten.
  if (!/^https?:\/\//iu.test(trimmed)) {
    return value
  }

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return value
  }

  if (
    url.username
    || url.password
    || !canonicalHostnames.has(url.hostname.toLowerCase())
  ) {
    return value
  }

  const mirror = new URL(mirrorOrigin)
  url.protocol = mirror.protocol
  url.hostname = mirror.hostname
  url.port = mirror.port
  return url.toString()
}

function rehostPayloadUrls(
  value: unknown,
  mirrorOrigin: string,
  canonicalHostnames: ReadonlySet<string>,
  state: { rewritten: boolean },
): unknown {
  if (typeof value === "string") {
    const next = rehostCanonicalApiUrl(value, mirrorOrigin, canonicalHostnames)
    if (next !== value) {
      state.rewritten = true
    }
    return next
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      value[index] = rehostPayloadUrls(value[index], mirrorOrigin, canonicalHostnames, state)
    }
    return value
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    for (const key of Object.keys(record)) {
      record[key] = rehostPayloadUrls(record[key], mirrorOrigin, canonicalHostnames, state)
    }
    return value
  }

  return value
}

function appendVary(headers: Headers, field: string): void {
  const existing = (headers.get("Vary") ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
  if (!existing.some((item) => item.toLowerCase() === field.toLowerCase())) {
    headers.set("Vary", [...existing, field].join(", "))
  }
}

// Single emission boundary for the request-host mirror. Stored absolute media
// refs (post media_refs, song cover art, community avatar/banner, song
// artifact content URLs, materialized feed bodies) keep the canonical
// api.pirate.sc host in storage; when the request arrived via an allowlisted
// HNS hostname, JSON responses are rehosted to that same hostname at emit
// time. Requests without an allowlisted host return the original Response
// object untouched, byte-identical to before.
export async function mirrorResponseToRequestHost(input: {
  request: Request
  response: Response
  env: Pick<Env, "PIRATE_API_PUBLIC_ORIGIN">
}): Promise<Response> {
  const mirrorOrigin = resolveRequestMirrorOrigin(input.request)
  if (!mirrorOrigin) {
    return input.response
  }

  const contentType = input.response.headers.get("content-type") ?? ""
  if (!contentType.toLowerCase().includes("application/json")) {
    return input.response
  }

  let payload: unknown
  try {
    payload = await input.response.clone().json()
  } catch {
    return input.response
  }

  const state = { rewritten: false }
  const rehosted = rehostPayloadUrls(payload, mirrorOrigin, canonicalApiHostnames(input.env), state)
  if (!state.rewritten) {
    return input.response
  }

  const headers = new Headers(input.response.headers)
  headers.delete("content-length")
  // The rewritten body differs from the canonical one; an etag computed over
  // the canonical payload must not describe it.
  headers.delete("etag")
  // A mirrored variant must never enter a cache shared with canonical-host
  // traffic (zone CDN cache, Workers entrypoint cache, or the gateway): a
  // cached api.pirate body would break media for api.pirate.sc clients.
  headers.set("cloudflare-cdn-cache-control", "no-store")
  headers.set("cdn-cache-control", "no-store")
  headers.set("cache-control", "private, no-store")
  appendVary(headers, MIRROR_REQUEST_HOST_HEADER)

  return new Response(JSON.stringify(rehosted), {
    status: input.response.status,
    statusText: input.response.statusText,
    headers,
  })
}
