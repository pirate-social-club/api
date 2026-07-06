import type { Context } from "hono"

export const PUBLIC_READ_CACHE_FRESH_SECONDS = 60
export const PUBLIC_READ_CACHE_STALE_SECONDS = 300
export const PUBLIC_READ_CDN_CACHE_CONTROL = `public, s-maxage=${PUBLIC_READ_CACHE_FRESH_SECONDS}, stale-while-revalidate=${PUBLIC_READ_CACHE_STALE_SECONDS}`
export const PUBLIC_READ_CACHE_CONTROL = `public, max-age=0, s-maxage=${PUBLIC_READ_CACHE_FRESH_SECONDS}, stale-while-revalidate=${PUBLIC_READ_CACHE_STALE_SECONDS}`
const DEFAULT_PUBLIC_READ_CACHE_KEY_HEADER_NAMES = ["accept"]
const DEFAULT_PUBLIC_READ_VARY_HEADER_NAMES = ["Accept"]

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
  appendVaryHeader(c, [...publicReadVaryHeaders(c.req.raw), ...(options?.vary ?? [])])
}

export function isPublicReadCacheRequest(request: Request): boolean {
  if (request.method !== "GET") {
    return false
  }

  const url = new URL(request.url)
  if (url.pathname === "/feed/home") {
    return !request.headers.has("authorization")
  }
  if (url.pathname === "/feed/home/public") {
    return true
  }

  return (
    url.pathname.startsWith("/public-posts/")
    || url.pathname.startsWith("/public-comments/")
    || url.pathname.startsWith("/public-communities/")
  )
}

export function buildPublicReadCacheKey(request: Request): Request {
  const url = new URL(request.url)
  for (const headerName of publicReadCacheKeyHeaderNames(request)) {
    const headerValue = request.headers.get(headerName)
    if (headerValue) {
      url.searchParams.set(`__cache_${headerName}`, headerValue)
    }
  }
  url.searchParams.sort()
  return new Request(url.toString(), { method: "GET" })
}

export function isPublicReadCacheResponse(response: Response): boolean {
  return (
    response.status === 200
    && response.headers.get("CDN-Cache-Control") === PUBLIC_READ_CDN_CACHE_CONTROL
    && !response.headers.has("Set-Cookie")
  )
}

function publicReadCacheKeyHeaderNames(request: Request): string[] {
  const url = new URL(request.url)
  if (url.pathname === "/feed/home" || url.pathname === "/feed/home/public") {
    return []
  }
  return DEFAULT_PUBLIC_READ_CACHE_KEY_HEADER_NAMES
}

function publicReadVaryHeaders(request: Request): string[] {
  const url = new URL(request.url)
  if (url.pathname === "/feed/home" || url.pathname === "/feed/home/public") {
    return []
  }
  return DEFAULT_PUBLIC_READ_VARY_HEADER_NAMES
}
