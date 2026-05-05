import type { Context } from "hono"

const PUBLIC_READ_CDN_CACHE_CONTROL = "public, s-maxage=60, stale-while-revalidate=300"
const PUBLIC_READ_CACHE_CONTROL = "public, max-age=0, s-maxage=60, stale-while-revalidate=300"

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
