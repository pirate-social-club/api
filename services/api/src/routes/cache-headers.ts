import type { Context } from "hono"

export const PUBLIC_READ_CACHE_FRESH_SECONDS = 600
export const PUBLIC_READ_CACHE_STALE_SECONDS = 3600
export const PUBLIC_READ_CDN_CACHE_CONTROL = `public, max-age=${PUBLIC_READ_CACHE_FRESH_SECONDS}, stale-while-revalidate=${PUBLIC_READ_CACHE_STALE_SECONDS}`
export const PUBLIC_READ_CACHE_CONTROL = "public, max-age=0"
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

function normalizeCacheTag(tag: string): string | null {
  const normalized = tag.trim()
  if (!normalized) {
    return null
  }
  return normalized.replace(/[^A-Za-z0-9_:-]/gu, "_").slice(0, 128)
}

export function setPublicReadCacheHeaders(c: Context, options?: { vary?: string[]; cacheTags?: string[] }): void {
  c.header("Cloudflare-CDN-Cache-Control", PUBLIC_READ_CDN_CACHE_CONTROL)
  c.header("CDN-Cache-Control", PUBLIC_READ_CDN_CACHE_CONTROL)
  c.header("Cache-Control", PUBLIC_READ_CACHE_CONTROL)
  const cacheTags = (options?.cacheTags ?? [])
    .map(normalizeCacheTag)
    .filter((tag): tag is string => tag !== null)
  if (cacheTags.length > 0) {
    c.header("Cache-Tag", [...new Set(cacheTags)].join(","))
  }
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

function publicReadVaryHeaders(request: Request): string[] {
  const url = new URL(request.url)
  if (url.pathname === "/feed/home" || url.pathname === "/feed/home/public") {
    return []
  }
  return DEFAULT_PUBLIC_READ_VARY_HEADER_NAMES
}
