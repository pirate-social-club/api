import { Hono } from "hono"
import {
  PUBLIC_READ_CACHE_CANARY_HEADER,
  PUBLIC_READ_CACHE_CANARY_TAG,
} from "../lib/public-read-cache-canary"
import type { RequestCorrelationEnv } from "../lib/request-correlation"
import { setPublicReadCacheHeaders } from "./cache-headers"

const publicReadCacheCanary = new Hono<RequestCorrelationEnv>()

publicReadCacheCanary.get("/", (c) => {
  const value = c.req.header(PUBLIC_READ_CACHE_CANARY_HEADER)?.slice(0, 256) ?? "missing"
  setPublicReadCacheHeaders(c, { cacheTags: [PUBLIC_READ_CACHE_CANARY_TAG] })
  return c.json({ value })
})

export default publicReadCacheCanary
