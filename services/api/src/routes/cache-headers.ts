import type { Context } from "hono"

const PUBLIC_READ_CDN_CACHE_CONTROL = "public, s-maxage=60, stale-while-revalidate=300"
const PUBLIC_READ_CACHE_CONTROL = "public, max-age=0, s-maxage=60, stale-while-revalidate=300"
const PUBLIC_READ_CACHE_KEY_HEADER_NAMES = ["origin", "accept", "accept-language"]

function appendVaryHeader(c: Context, fields: string[]): void {
  const existingFields = (c.res.headers.get("Vary") ?? "")
    .split(",")
    .map((field) => field.trim())
    .filter(Boolean)
  const existingFieldSet = new Set(existingFields.map((field) => field.toLowerCase()))
  const nextFields = [...existingFields]

  for (const field of fields) {
    if (!existingFieldSet.has(field.toLowerCase())) {
      nextFields.push(field)
      existingFieldSet.add(field.toLowerCase())
    }
  }

  if (nextFields.length > 0) {
    c.header("Vary", nextFields.join(", "))
  }
}

export function setPublicReadCacheHeaders(c: Context, options?: { vary?: string[] }): void {
  c.header("CDN-Cache-Control", PUBLIC_READ_CDN_CACHE_CONTROL)
  c.header("Cache-Control", PUBLIC_READ_CACHE_CONTROL)
  appendVaryHeader(c, options?.vary ?? [])
}

export function isPublicReadCacheRequest(request: Request): boolean {
  if (request.method !== "GET") {
    return false
  }

  const url = new URL(request.url)
  if (url.pathname === "/feed/home") {
    return !request.headers.has("authorization")
  }

  return (
    url.pathname.startsWith("/public-posts/")
    || url.pathname.startsWith("/public-comments/")
    || url.pathname.startsWith("/public-communities/")
  )
}

export function buildPublicReadCacheKey(request: Request): Request {
  const url = new URL(request.url)
  for (const headerName of PUBLIC_READ_CACHE_KEY_HEADER_NAMES) {
    const headerValue = request.headers.get(headerName)
    if (headerValue) {
      url.searchParams.set(`__cache_${headerName}`, headerValue)
    }
  }
  return new Request(url.toString(), { method: "GET" })
}

export function isPublicReadCacheResponse(response: Response): boolean {
  return (
    response.status === 200
    && response.headers.get("CDN-Cache-Control") === PUBLIC_READ_CDN_CACHE_CONTROL
    && !response.headers.has("Set-Cookie")
  )
}
