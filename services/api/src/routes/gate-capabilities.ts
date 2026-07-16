import { Hono } from "hono"
import { authenticateAdminOrUser, type AuthenticatedEnv } from "../lib/auth-middleware"
import { badRequestError, notFoundError, rateLimited } from "../lib/errors"
import {
  CourtyardCatalogUnavailableError,
  getNftGateCapabilitySource,
  listNftGateCapabilitySources,
  searchNftGateFacetValues,
} from "../lib/communities/gate-capabilities/courtyard-catalog-adapter"

const gateCapabilities = new Hono<AuthenticatedEnv>()
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX = 60
const rateLimitByActor = new Map<string, { count: number; resetAtMs: number }>()

export function resetGateCapabilityRateLimitForTests(): void {
  rateLimitByActor.clear()
}

function enforceRateLimit(actorId: string, nowMs = Date.now()): void {
  const current = rateLimitByActor.get(actorId)
  if (!current || current.resetAtMs <= nowMs) {
    rateLimitByActor.set(actorId, { count: 1, resetAtMs: nowMs + RATE_LIMIT_WINDOW_MS })
    return
  }
  if (current.count >= RATE_LIMIT_MAX) {
    throw rateLimited("NFT gate catalog request limit exceeded. Try again shortly.")
  }
  current.count += 1
}

function requireBoundedPathValue(value: string, field: string, maxLength: number): string {
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > maxLength) throw badRequestError(`Invalid ${field}`)
  return trimmed
}

function parseLimit(value: string | undefined): number {
  if (value == null || value === "") return 25
  if (!/^\d+$/u.test(value)) throw badRequestError("Invalid limit")
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 50) throw badRequestError("Invalid limit")
  return parsed
}

gateCapabilities.use("/nft/*", authenticateAdminOrUser)

gateCapabilities.get("/nft/sources", (c) => {
  enforceRateLimit(c.get("actor").userId)
  return c.json({ sources: listNftGateCapabilitySources() }, 200)
})

gateCapabilities.get("/nft/sources/:source_id/facets/:facet_key/values", async (c) => {
  enforceRateLimit(c.get("actor").userId)
  const sourceId = requireBoundedPathValue(c.req.param("source_id"), "source_id", 128)
  const facetKey = requireBoundedPathValue(c.req.param("facet_key"), "facet_key", 64)
  const source = getNftGateCapabilitySource(sourceId)
  if (!source) throw notFoundError("NFT gate capability source not found")
  if (!source.descriptor.facet_keys.includes(facetKey)) throw notFoundError("NFT gate capability facet not found")

  const query = (c.req.query("q") ?? "").trim()
  if (query.length > 120) throw badRequestError("Invalid q")
  const cursor = c.req.query("cursor")
  if (cursor != null && cursor.length > 512) throw badRequestError("Invalid cursor")

  try {
    const page = await searchNftGateFacetValues({
      env: c.env,
      source,
      facetKey,
      query,
      cursor,
      limit: parseLimit(c.req.query("limit")),
    })
    return c.json(page, 200)
  } catch (error) {
    if (error instanceof TypeError && error.message === "Invalid cursor") {
      throw badRequestError("Invalid cursor")
    }
    if (error instanceof CourtyardCatalogUnavailableError) {
      return c.json({
        code: "nft_gate_catalog_unavailable" as const,
        message: "NFT gate catalog is temporarily unavailable",
        retryable: true as const,
      }, 503)
    }
    throw error
  }
})

export default gateCapabilities
