import { Hono } from "hono"
import { authenticate, type AuthenticatedEnv } from "../lib/auth-middleware"
import { badRequestError, providerUnavailable } from "../lib/errors"

type GeoPlace = {
  label: string
  address?: string
  lat: number
  lon: number
  source: "geoapify"
  providerPlaceId?: string
  countryCode?: string
  city?: string
}

type GeoapifyFeature = {
  geometry?: {
    coordinates?: unknown
  }
  properties?: {
    address_line1?: unknown
    address_line2?: unknown
    city?: unknown
    country_code?: unknown
    formatted?: unknown
    lat?: unknown
    lon?: unknown
    name?: unknown
    place_id?: unknown
    town?: unknown
    village?: unknown
  }
}

type GeoapifyResponse = {
  features?: GeoapifyFeature[]
}

const geo = new Hono<AuthenticatedEnv>()

geo.use("*", authenticate)

function cleanString(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : ""
  return text || undefined
}

function numberValue(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""))
  return Number.isFinite(parsed) ? parsed : null
}

function parseLimit(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "", 10)
  if (!Number.isFinite(parsed)) return 5
  return Math.min(10, Math.max(1, parsed))
}

function normalizeCountryCode(value: string | undefined): string | null {
  const country = value?.trim().toLowerCase()
  if (!country) return null
  if (!/^[a-z]{2}$/u.test(country)) {
    throw badRequestError("country must be a two-letter country code")
  }
  return country
}

function normalizeGeoapifyPlace(feature: GeoapifyFeature): GeoPlace | null {
  const properties = feature.properties ?? {}
  const coordinates = Array.isArray(feature.geometry?.coordinates)
    ? feature.geometry?.coordinates
    : null
  const lon = numberValue(properties.lon) ?? numberValue(coordinates?.[0])
  const lat = numberValue(properties.lat) ?? numberValue(coordinates?.[1])
  if (lat === null || lon === null) return null

  const addressLine1 = cleanString(properties.address_line1)
  const addressLine2 = cleanString(properties.address_line2)
  const formatted = cleanString(properties.formatted)
  const label = cleanString(properties.name) ?? formatted ?? addressLine1
  if (!label) return null

  const address = [addressLine1, addressLine2]
    .filter((part) => part && part !== label)
    .join(", ")
    || (formatted !== label ? formatted : undefined)

  return {
    label,
    ...(address ? { address } : {}),
    lat,
    lon,
    source: "geoapify",
    ...(cleanString(properties.place_id) ? { providerPlaceId: cleanString(properties.place_id) } : {}),
    ...(cleanString(properties.country_code) ? { countryCode: cleanString(properties.country_code)?.toLowerCase() } : {}),
    ...(cleanString(properties.city) ?? cleanString(properties.town) ?? cleanString(properties.village)
      ? { city: cleanString(properties.city) ?? cleanString(properties.town) ?? cleanString(properties.village) }
      : {}),
  }
}

geo.get("/search", async (c) => {
  const apiKey = c.env.GEOAPIFY_API_KEY?.trim()
  if (!apiKey) {
    throw providerUnavailable("Geoapify is not configured")
  }

  const text = c.req.query("text")?.trim() ?? c.req.query("q")?.trim() ?? ""
  if (text.length < 2) {
    throw badRequestError("text must be at least 2 characters")
  }

  const limit = parseLimit(c.req.query("limit"))
  const country = normalizeCountryCode(c.req.query("country"))
  const biasLat = numberValue(c.req.query("biasLat"))
  const biasLon = numberValue(c.req.query("biasLon"))
  if ((biasLat === null) !== (biasLon === null)) {
    throw badRequestError("biasLat and biasLon must be provided together")
  }

  const url = new URL("https://api.geoapify.com/v1/geocode/autocomplete")
  url.searchParams.set("text", text)
  url.searchParams.set("limit", String(limit))
  url.searchParams.set("apiKey", apiKey)
  if (country) {
    url.searchParams.set("filter", `countrycode:${country}`)
  }
  if (biasLat !== null && biasLon !== null) {
    url.searchParams.set("bias", `proximity:${biasLon},${biasLat}`)
  }

  const response = await fetch(url.href, {
    headers: {
      accept: "application/json",
      "user-agent": "Pirate geo autocomplete",
    },
  })
  if (!response.ok) {
    throw providerUnavailable("Geoapify autocomplete failed", {
      status: response.status,
    })
  }

  const body = await response.json() as GeoapifyResponse
  const places = (body.features ?? [])
    .map(normalizeGeoapifyPlace)
    .filter((place): place is GeoPlace => Boolean(place))
    .slice(0, limit)

  return c.json({ places }, 200)
})

export default geo
